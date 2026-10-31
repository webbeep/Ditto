import WebKit

// Links in Ditto's chat (sources, list items, pictures of pages) open as
// tabs, shown beside the chat; the chat's own page never navigates away.
@MainActor
final class PanelLinks: NSObject, WKNavigationDelegate, WKUIDelegate {
  private weak var browser: Browser?

  init(browser: Browser) {
    self.browser = browser
  }

  private func open(_ url: URL?) {
    guard let url, ["http", "https"].contains(url.scheme ?? "") else { return }
    browser?.newTab(url)
  }

  // target=_blank and window.open.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    open(navigationAction.request.url)
    return nil
  }

  // A plain link: a tab too; the chat stays where it is. (New windows,
  // with no target frame, come through createWebViewWith.)
  func webView(_ webView: WKWebView,
               decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    if navigationAction.targetFrame?.isMainFrame == true,
       navigationAction.request.url?.scheme != "ditto" {
      open(navigationAction.request.url)
      return .cancel
    }
    return .allow
  }
}
