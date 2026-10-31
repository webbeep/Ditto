import Foundation
import WebKit

// The app side of web/bridges/webkit.ts: what the agent panel and the new
// tab page may ask of the app. Only Ditto's own pages (ditto://app, main
// frame) are answered; websites get nothing, whatever they post.
@MainActor
final class AgentBridge: NSObject, WKScriptMessageHandlerWithReply {
  static let shared = AgentBridge()

  struct Refused: LocalizedError {
    var errorDescription: String?
  }

  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage) async -> (Any?, String?) {
    guard message.frameInfo.isMainFrame,
          message.frameInfo.securityOrigin.protocol == "ditto",
          let webView = message.webView,
          let browser = Services.shared.browser(owning: webView),
          let body = message.body as? [String: Any],
          let method = body["method"] as? String else {
      return (nil, "Not allowed")
    }
    let args = Arguments(values: body["args"] as? [Any] ?? [])
    do {
      return (try await handle(method, args, browser: browser, page: webView), nil)
    } catch {
      return (nil, error.localizedDescription)
    }
  }

  private func handle(_ method: String, _ args: Arguments, browser: Browser,
                      page: WKWebView) async throws -> Any? {
    let services = Services.shared
    switch method {
    case "startRuntime":
      ModelRuntime.shared.onMemoryPressure = { critical in
        for browser in Services.shared.browsers {
          browser.notifyAgent("onMemoryPressure", critical)
        }
      }
      return ["ok": await ModelRuntime.shared.start(preset: args.string(0),
                                                     memoryMarginMB: args.int(1))]
    case "stopRuntime":
      ModelRuntime.shared.stop()
      return nil
    case "setStrandsEndpoint":
      ModelRuntime.shared.setStrands(args.string(0))
      return nil
    case "getSystemMemory":
      return ["totalMb": SystemMemory.totalMB, "availableMb": SystemMemory.availableMB]
    case "getDevice":
      return ["totalMb": SystemMemory.totalMB, "arch": Device.arch, "chip": Device.chip,
              "freeDiskMb": Device.freeDiskMB] as [String: Any]
    case "getSearchUrl":
      return ["urlTemplate": Browser.searchTemplate]
    case "loadChats":
      return ["json": UserData.read("chats.json")]
    case "saveChats":
      UserData.write("chats.json", ChatMerge.merge(disk: UserData.read("chats.json"),
                                                   incoming: args.string(0),
                                                   removed: args.string(1)))
      Services.shared.broadcast("onStoreChanged", "chats", except: page)
      return nil
    case "loadMemory":
      return ["json": UserData.read("memory.json")]
    case "saveMemory":
      UserData.write("memory.json", args.string(0))
      Services.shared.broadcast("onStoreChanged", "memory", except: page)
      return nil
    case "loadWatches":
      return ["json": UserData.read("watches.json")]
    case "saveWatches":
      UserData.write("watches.json", args.string(0))
      return nil
    case "notify":
      Notifier.shared.post(title: args.string(0), body: args.string(1), url: args.string(2))
      return nil
    case "searchUserPages":
      let query = args.string(0)
      let limit = max(1, min(args.int(1), 50))
      var seen = Set<String>()
      let pages = (services.bookmarks.search(query, limit: limit) +
                   services.history.search(query, limit: limit))
        .filter { $0.url.hasPrefix("http") && seen.insert($0.url).inserted }
      return ["pages": pages.map(\.asJSON)]
    case "getHome":
      return await HomeFeed.shared.home()
    case "getSuggestions":
      return ["suggestions": await SearchSuggest.fetch(args.string(0))]
    case "importFromChrome":
      let result = ChromeImport.run(bookmarks: services.bookmarks, history: services.history)
      return ["found": result.found, "bookmarks": result.bookmarks,
              "email": result.email] as [String: Any]
    case "showAgentPanel":
      browser.handOff(query: args.string(0), chatID: args.string(1))
      return nil
    case "takeHandOff":
      let handOff = browser.takeHandOff()
      return ["query": handOff.query, "chatId": handOff.chatID]
    case "fetch":
      let response = await ModelRuntime.shared.request(
        ModelRuntime.Target(rawValue: args.int(0)) ?? .runtime,
        method: args.string(1), path: args.string(2), body: args.string(3))
      return ["response": ["status": response.status, "body": response.body] as [String: Any]]
    case "fetchStream":
      let stream = args.int(3)
      let status = await ModelRuntime.shared.stream(
        ModelRuntime.Target(rawValue: args.int(0)) ?? .runtime,
        path: args.string(1), body: args.string(2)) { [weak page] chunk in
          Task { @MainActor in
            page.map { Browser.call($0, "onStreamChunk", stream, chunk) }
          }
        }
      return ["response": ["status": status, "body": ""] as [String: Any]]
    case "attachToActiveTab":
      // A watch starts on its page; anything else where the user is.
      let start = URL(string: args.string(0)).flatMap {
        ["http", "https"].contains($0.scheme ?? "") ? $0 : nil
      }
      let tab = await browser.attachAgent(start: start, session: args.string(1),
                                          label: args.string(2))
      return ["target": ["ok": tab != nil, "url": tab?.url?.absoluteString ?? "",
                         "title": tab?.title ?? ""] as [String: Any]]
    case "detachFromTab":
      browser.detachAgent(session: args.string(0))
      return nil
    case "focusSession":
      browser.focusedSession = args.string(0)
      return nil
    case "sendCdp":
      guard let tab = browser.agentTabs[args.string(2)] else {
        return ["ok": false, "resultJson": #"{"message":"No tab is attached"}"#] as [String: Any]
      }
      let params = (try? JSONSerialization.jsonObject(with: Data(args.string(1).utf8)))
        as? [String: Any] ?? [:]
      do {
        let result = try await PageControl(webView: tab.webView).send(args.string(0), params)
        return ["ok": true, "resultJson": Self.json(result)] as [String: Any]
      } catch {
        return ["ok": false,
                "resultJson": Self.json(["message": error.localizedDescription])] as [String: Any]
      }
    default:
      throw Refused(errorDescription: "Unknown method \(method)")
    }
  }

  static func json(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }
}

// A message's arguments, read leniently (JavaScript numbers arrive as
// NSNumber, absent ones as nothing).
struct Arguments {
  let values: [Any]

  func string(_ index: Int) -> String {
    index < values.count ? values[index] as? String ?? "" : ""
  }

  func int(_ index: Int) -> Int {
    index < values.count ? (values[index] as? NSNumber)?.intValue ?? 0 : 0
  }
}
