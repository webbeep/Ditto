import AppKit
import WebKit

// What all windows share: the profile's stores, one WebKit setup (data
// store, process pool, scripts, ad rules, the ditto:// pages) and the list
// of open windows.
@MainActor
final class Services {
  static let shared = Services()

  let history = HistoryStore(url: Paths.file("history.sqlite"))
  let bookmarks = BookmarkStore(file: Paths.file("bookmarks.json"))
  let contentController = WKUserContentController()
  let processPool = WKProcessPool()
  private let schemeHandler = SchemeHandler()
  private var windows: [WeakBrowser] = []

  private init() {
    Shield.install(into: contentController)
    contentController.addScriptMessageHandler(AgentBridge.shared, contentWorld: .page, name: "ditto")
  }

  // Every web view (tabs, popups, the agent panel) is made from this.
  func makeConfiguration() -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    configuration.processPool = processPool
    configuration.websiteDataStore = .default()
    configuration.userContentController = contentController
    configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "ditto")
    configuration.preferences.isElementFullscreenEnabled = true
    configuration.preferences.isFraudulentWebsiteWarningEnabled = true
    // Sites (Google sign-in among them) expect a browser's product token.
    configuration.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15"
    return configuration
  }

  func register(_ browser: Browser) {
    windows.removeAll { $0.browser == nil }
    windows.append(WeakBrowser(browser: browser))
  }

  var browsers: [Browser] {
    windows.compactMap(\.browser)
  }

  // The window a web view belongs to (a tab or its agent panel).
  func browser(owning webView: WKWebView) -> Browser? {
    browsers.first { $0.owns(webView) }
  }

  // The window in front, for links opened from other apps.
  var front: Browser? {
    browsers.first { $0.window?.isKeyWindow == true } ?? browsers.last
  }

  var agentVisibleSomewhere: Bool {
    browsers.contains { $0.agentVisible }
  }
}

private struct WeakBrowser {
  weak var browser: Browser?
}
