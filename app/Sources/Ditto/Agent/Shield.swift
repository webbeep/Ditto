import Foundation
import WebKit

// Ditto's shield, in every tab: ad networks' requests are blocked
// (ad-rules.json, a WebKit content blocker), ad slots are hidden and click
// traps disarmed (shield.js), and YouTube ads are skipped as soon as YouTube
// offers it (youtube-skip.js finds the button; the click is real input).
// The scripts run in their own world, so pages cannot see or undo them.
@MainActor
enum Shield {
  static func install(into controller: WKUserContentController) {
    for name in ["shield.js", "youtube-skip.js"] {
      guard let source = try? String(contentsOf: Paths.resource(name), encoding: .utf8) else {
        continue
      }
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd,
                                            forMainFrameOnly: true, in: .defaultClient))
    }
    controller.add(SkipHandler(), contentWorld: .defaultClient, name: "dittoSkip")
    Task {
      guard let rules = try? String(contentsOf: Paths.resource("ad-rules.json"), encoding: .utf8),
            let list = try? await WKContentRuleListStore.default()
              .compileContentRuleList(forIdentifier: "ditto-ads", encodedContentRuleList: rules)
      else { return }
      controller.add(list)
    }
  }
}

extension Shield {
  private static var runtimeRules: WKContentRuleList?

  // Websites cannot reach Ditto's model runtime: its port is blocked for
  // every page, so a site cannot list the models (and the paths that name
  // the user) or probe for it. The app talks to it directly, never through
  // a page. (WebKit's rule syntax has no alternation: a rule per host.)
  static func blockRuntime(port: Int, in controller: WKUserContentController) {
    let rules: [[String: Any]] = ["127\\.0\\.0\\.1", "localhost", "\\[::1\\]"].map { host in
      ["trigger": ["url-filter": "^https?://\(host):\(port)/"], "action": ["type": "block"]]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: rules),
          let json = String(data: data, encoding: .utf8) else { return }
    Task {
      guard let list = try? await WKContentRuleListStore.default()
        .compileContentRuleList(forIdentifier: "ditto-runtime", encodedContentRuleList: json)
      else { return }
      if let old = runtimeRules {
        controller.remove(old)
      }
      runtimeRules = list
      controller.add(list)
    }
  }
}

// youtube-skip.js found a Skip button: press it like the user would.
final class SkipHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage) {
    guard let point = message.body as? [String: Any],
          let x = (point["x"] as? NSNumber)?.doubleValue,
          let y = (point["y"] as? NSNumber)?.doubleValue,
          let webView = message.webView,
          message.frameInfo.isMainFrame,
          message.frameInfo.securityOrigin.host.hasSuffix("youtube.com") else { return }
    Task { @MainActor in
      try? await PageControl(webView: webView).click(x: x, y: y)
    }
  }
}
