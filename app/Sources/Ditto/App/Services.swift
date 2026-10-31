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

  private var pressure: DispatchSourceMemoryPressure?

  private init() {
    Shield.install(into: contentController)
    MediaWatch.install(into: contentController)
    contentController.addScriptMessageHandler(AgentBridge.shared, contentWorld: .page, name: "ditto")
    // Low on memory: background tabs sleep (pages playing sound excepted).
    let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical],
                                                         queue: .main)
    source.setEventHandler {
      MainActor.assumeIsolated {
        for browser in Services.shared.browsers {
          browser.sleepBackgroundTabs(olderThan: 0)
        }
      }
    }
    source.resume()
    pressure = source
  }

  func tab(owning webView: WKWebView) -> BrowserTab? {
    for browser in browsers {
      if let tab = browser.tabs.first(where: { $0.webView === webView }) {
        return tab
      }
    }
    return nil
  }

  enum Autoplay {
    // Muted video may start on its own; sound waits for a click.
    case silent
    // Nothing plays until clicked (Ditto's own tab).
    case none
  }

  // Every web view (tabs, popups, the agent panel) is made from this.
  func makeConfiguration(autoplay: Autoplay = .silent) -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    configuration.mediaTypesRequiringUserActionForPlayback = autoplay == .none ? .all : .audio
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
