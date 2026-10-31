import Foundation
import WebKit

// Which tabs are playing sound (media.js reports it), for the speaker on
// the tab and the mute toggle.
@MainActor
enum MediaWatch {
  static func install(into controller: WKUserContentController) {
    if let source = try? String(contentsOf: Paths.resource("media.js"), encoding: .utf8) {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart,
                                            forMainFrameOnly: true, in: .defaultClient))
    }
    controller.add(MediaHandler(), contentWorld: .defaultClient, name: "dittoMedia")
  }
}

final class MediaHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any],
          let playing = body["playing"] as? Bool,
          let webView = message.webView else { return }
    MainActor.assumeIsolated {
      Services.shared.tab(owning: webView)?.isPlayingAudio = playing
    }
  }
}
