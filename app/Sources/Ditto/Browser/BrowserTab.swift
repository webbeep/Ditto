import AppKit
import Combine
import UniformTypeIdentifiers
import WebKit

// One tab: its web view and what the UI shows about it.
@MainActor
final class BrowserTab: NSObject, ObservableObject, Identifiable {
  let id = UUID()
  let webView: WKWebView
  weak var browser: Browser?

  @Published private(set) var title = ""
  @Published private(set) var url: URL?
  @Published private(set) var progress = 0.0
  @Published private(set) var isLoading = false
  @Published private(set) var canGoBack = false
  @Published private(set) var canGoForward = false
  @Published private(set) var favicon: NSImage?
  @Published var agentInControl = false
  @Published var loadError: String?

  private var observations: [NSKeyValueObservation] = []
  // Set when the app itself opens a ditto:// page in this tab.
  private var openingOwnPage = false

  init(browser: Browser, configuration: WKWebViewConfiguration? = nil) {
    self.browser = browser
    webView = WKWebView(frame: .zero,
                        configuration: configuration ?? Services.shared.makeConfiguration())
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsMagnification = true
    webView.isInspectable = true
    webView.underPageBackgroundColor = .clear
    observe()
  }

  var isHome: Bool {
    url == nil || url?.scheme == "ditto"
  }

  var displayTitle: String {
    if isHome { return "New Tab" }
    return title.isEmpty ? (url?.host() ?? "Untitled") : title
  }

  var host: String {
    url?.host()?.replacingOccurrences(of: "www.", with: "") ?? ""
  }

  func load(_ url: URL) {
    loadError = nil
    webView.load(URLRequest(url: url))
  }

  func loadHome() {
    openingOwnPage = true
    load(URL(string: "ditto://app/home.html")!)
  }

  private func observe() {
    observations = [
      webView.observe(\.title) { [weak self] view, _ in
        MainActor.assumeIsolated { self?.title = view.title ?? "" }
      },
      webView.observe(\.url) { [weak self] view, _ in
        MainActor.assumeIsolated { self?.url = view.url }
      },
      webView.observe(\.estimatedProgress) { [weak self] view, _ in
        MainActor.assumeIsolated { self?.progress = view.estimatedProgress }
      },
      webView.observe(\.isLoading) { [weak self] view, _ in
        MainActor.assumeIsolated { self?.isLoading = view.isLoading }
      },
      webView.observe(\.canGoBack) { [weak self] view, _ in
        MainActor.assumeIsolated { self?.canGoBack = view.canGoBack }
      },
      webView.observe(\.canGoForward) { [weak self] view, _ in
        MainActor.assumeIsolated { self?.canGoForward = view.canGoForward }
      },
    ]
  }

  // The site's icon: the page's <link rel=icon>, else /favicon.ico.
  private func loadFavicon() {
    guard let host = webView.url?.host(), !isHome else { return }
    if let cached = FaviconCache.images[host] {
      favicon = cached
      return
    }
    Task {
      let href = try? await webView.evaluateJavaScript("""
        (document.querySelector('link[rel~="icon"][href]') || {}).href ||
          location.origin + '/favicon.ico'
        """) as? String
      guard let href, let iconURL = URL(string: href),
            let (data, _) = try? await URLSession.shared.data(from: iconURL),
            let image = NSImage(data: data) else { return }
      FaviconCache.images[host] = image
      if webView.url?.host() == host {
        favicon = image
      }
    }
  }
}

extension BrowserTab: WKNavigationDelegate {
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy,
                                                             WKWebpagePreferences) {
    if navigationAction.shouldPerformDownload {
      return (.download, preferences)
    }
    // ⌘-click opens a link in a new tab.
    if navigationAction.navigationType == .linkActivated,
       navigationAction.modifierFlags.contains(.command),
       let url = navigationAction.request.url {
      browser?.newTab(url, select: navigationAction.modifierFlags.contains(.shift))
      return (.cancel, preferences)
    }
    // Ditto's own pages can talk to the app: only the app opens them (or
    // going back to one), never a website.
    if navigationAction.request.url?.scheme == "ditto" {
      let allowed = openingOwnPage || navigationAction.navigationType == .backForward ||
        navigationAction.navigationType == .reload
      openingOwnPage = false
      return (allowed ? .allow : .cancel, preferences)
    }
    return (.allow, preferences)
  }

  func webView(_ webView: WKWebView,
               decidePolicyFor navigationResponse: WKNavigationResponse) async
    -> WKNavigationResponsePolicy {
    navigationResponse.canShowMIMEType ? .allow : .download
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction,
               didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse,
               didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    loadError = nil
    favicon = webView.url.flatMap { $0.host() }.flatMap { FaviconCache.images[$0] }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if let url = webView.url, url.scheme == "http" || url.scheme == "https" {
      Services.shared.history.record(url: url.absoluteString, title: webView.title ?? "")
    }
    loadFavicon()
    browser?.saveSession()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
               withError error: Error) {
    let nsError = error as NSError
    // Cancelled loads (a new navigation, a download) are not failures.
    if nsError.code == NSURLErrorCancelled || nsError.code == 102 { return }
    loadError = nsError.localizedDescription
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }
}

extension BrowserTab: WKUIDelegate {
  // Popups and target=_blank links open as tabs, keeping window.opener
  // (sign-in popups need it).
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    browser?.newTab(configuration: configuration).webView
  }

  func webViewDidClose(_ webView: WKWebView) {
    browser?.close(self)
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo) async {
    let alert = NSAlert()
    alert.messageText = frame.securityOrigin.host
    alert.informativeText = message
    alert.runModal()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo) async -> Bool {
    let alert = NSAlert()
    alert.messageText = frame.securityOrigin.host
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
    let alert = NSAlert()
    alert.messageText = frame.securityOrigin.host
    alert.informativeText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    field.stringValue = defaultText ?? ""
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    return panel.runModal() == .OK ? panel.urls : nil
  }
}

extension BrowserTab: WKDownloadDelegate {
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String) async -> URL? {
    let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
    var target = Paths.downloads.appendingPathComponent(name)
    let base = target.deletingPathExtension().lastPathComponent
    let ext = target.pathExtension
    var n = 2
    while FileManager.default.fileExists(atPath: target.path) {
      target = Paths.downloads.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" :
                                                        "\(base) \(n).\(ext)")
      n += 1
    }
    return target
  }

  func downloadDidFinish(_ download: WKDownload) {
    browser?.show(toast: "Downloaded to Downloads")
    NSApp.requestUserAttention(.informationalRequest)
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    browser?.show(toast: "Download failed")
  }
}
