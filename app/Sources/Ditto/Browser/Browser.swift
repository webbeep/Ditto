import AppKit
import SwiftUI
import WebKit

// One window: its tabs, the agent panel, and what the chrome shows.
@MainActor
final class Browser: ObservableObject {
  static let searchTemplate = "https://www.google.com/search?q=%s"

  @Published private(set) var tabs: [BrowserTab] = []
  @Published var selectedID: UUID?
  @Published var sidebarVisible = true
  @Published var agentVisible = false
  @Published var commandBarVisible = false
  // Whether the command bar opens its pick in a new tab.
  @Published var commandOpensTab = true
  @Published var findVisible = false
  @Published private(set) var toast: String?

  weak var window: NSWindow?
  // Ditto's own tab, where it browses while the user keeps theirs.
  @Published private(set) var agentTab: BrowserTab?
  // The agent is driving its tab right now.
  @Published private(set) var agentWorking = false
  // The page the agent's tab was last opened on from the user's tabs.
  private var agentSeed: URL?
  private var sleepTimer: Timer?
  private var pendingHandOff: (query: String, chatID: String)?
  private var closed: [URL] = []
  private var toastTask: Task<Void, Never>?

  // The agent panel's page, made when first opened.
  private(set) lazy var agentView: WKWebView = {
    let view = WKWebView(frame: .zero, configuration: Services.shared.makeConfiguration())
    view.isInspectable = true
    view.underPageBackgroundColor = .clear
    view.load(URLRequest(url: URL(string: "ditto://app/ditto_agent.html")!))
    return view
  }()
  private var agentViewMade = false

  init(restore: Bool) {
    Services.shared.register(self)
    let urls = restore ? SessionStore.load().compactMap(URL.init(string:)) : []
    if urls.isEmpty {
      newTab()
    } else {
      // Restored tabs sleep until shown: launching loads one page, not all.
      for url in urls {
        let tab = BrowserTab(browser: self, sleeping: (url, url.host() ?? url.absoluteString))
        tabs.append(tab)
      }
      selectedID = tabs.first?.id
      tabs.first?.wake()
    }
    // Tabs not looked at for a while sleep (sound playing excepted).
    sleepTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.sleepBackgroundTabs(olderThan: 20 * 60)
      }
    }
  }

  // The user's tabs (Ditto's own tab is listed on its own).
  var userTabs: [BrowserTab] {
    tabs.filter { !$0.isAgentTab }
  }

  func sleepBackgroundTabs(olderThan seconds: TimeInterval) {
    let now = Date()
    for tab in tabs where tab.id != selected?.id && !tab.isPlayingAudio && !tab.isAgentTab &&
      now.timeIntervalSince(tab.lastActive) >= seconds {
      tab.sleep()
    }
  }

  var selected: BrowserTab? {
    tabs.first { $0.id == selectedID } ?? tabs.first
  }

  func owns(_ webView: WKWebView) -> Bool {
    (agentViewMade && agentView === webView) || tabs.contains { $0.webView === webView }
  }

  // MARK: Tabs

  @discardableResult
  func newTab(_ url: URL? = nil, select: Bool = true) -> BrowserTab {
    let tab = BrowserTab(browser: self)
    insert(tab, select: select)
    if let url {
      tab.load(url)
    } else {
      tab.loadHome()
    }
    return tab
  }

  // For popups: WebKit supplies the configuration.
  func newTab(configuration: WKWebViewConfiguration) -> BrowserTab {
    let tab = BrowserTab(browser: self, configuration: configuration)
    insert(tab, select: true)
    return tab
  }

  private func insert(_ tab: BrowserTab, select: Bool) {
    let index = tabs.firstIndex { $0.id == selectedID }.map { $0 + 1 } ?? tabs.count
    withAnimation(Theme.spring) {
      tabs.insert(tab, at: min(index, tabs.count))
      if select {
        selectedID = tab.id
      }
    }
  }

  func select(_ tab: BrowserTab) {
    selected?.lastActive = Date()
    tab.wake()
    withAnimation(Theme.quick) { selectedID = tab.id }
  }

  func select(index: Int) {
    let list = userTabs
    guard !list.isEmpty else { return }
    select(index >= 9 ? list[list.count - 1] : list[min(index - 1, list.count - 1)])
  }

  func cycle(_ step: Int) {
    let list = userTabs
    guard let current = list.firstIndex(where: { $0.id == selected?.id }) ?? list.indices.first
    else { return }
    select(list[(current + step + list.count) % list.count])
  }

  func close(_ tab: BrowserTab) {
    guard let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
    if let url = tab.url, !tab.isHome {
      closed.append(url)
    }
    if agentTab === tab {
      if agentWorking {
        notifyAgent("onTabDetached")
      }
      detachAgent()
      agentTab = nil
    }
    tab.webView.stopLoading()
    withAnimation(Theme.spring) {
      tabs.remove(at: index)
      if selectedID == tab.id {
        let rest = userTabs
        selectedID = rest.isEmpty ? nil : rest[min(index, rest.count - 1)].id
      }
    }
    // The window stays: closing the last tab opens a fresh one.
    if userTabs.isEmpty {
      newTab()
    }
    saveSession()
  }

  func closeSelected() {
    if let tab = selected {
      close(tab)
    }
  }

  func reopenClosed() {
    if let url = closed.popLast() {
      newTab(url)
    }
  }

  // MARK: Opening things

  // What the user typed: an address opens, anything else goes to the agent
  // (or, with `search`, to Google).
  func open(_ input: String, newTab inNewTab: Bool, search: Bool = false) {
    let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    if let url = Self.address(text) {
      if inNewTab || selected == nil {
        newTab(url)
      } else {
        selected?.load(url)
      }
    } else if search {
      let query = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? text
      let url = URL(string: Self.searchTemplate.replacingOccurrences(of: "%s", with: query))!
      if inNewTab || selected == nil { newTab(url) } else { selected?.load(url) }
    } else {
      handOff(query: text, chatID: "")
    }
  }

  // "example.com", "localhost:3000", "https://…": an address, not a question.
  static func address(_ text: String) -> URL? {
    if text.contains(" ") { return nil }
    if text.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) != nil {
      return URL(string: text)
    }
    if text.range(of: #"^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(/.*)?$"#,
                  options: .regularExpression) != nil {
      return URL(string: "http://\(text)")
    }
    if text.range(of: #"^[\w-]+(\.[\w-]+)*\.[a-zA-Z]{2,}(:\d+)?(/.*)?$"#,
                  options: .regularExpression) != nil {
      return URL(string: "https://\(text)")
    }
    return nil
  }

  func showCommandBar(newTab: Bool) {
    commandOpensTab = newTab
    withAnimation(Theme.spring) { commandBarVisible = true }
  }

  func hideCommandBar() {
    withAnimation(Theme.quick) { commandBarVisible = false }
  }

  // MARK: The agent

  func toggleAgent() {
    withAnimation(Theme.spring) {
      agentVisible.toggle()
      agentViewMade = true
    }
  }

  func toggleSidebar() {
    withAnimation(Theme.spring) { sidebarVisible.toggle() }
  }

  // A question (or a chat to open) for the agent panel of this window.
  func handOff(query: String, chatID: String) {
    pendingHandOff = (query, chatID)
    let wasMade = agentViewMade
    withAnimation(Theme.spring) {
      agentVisible = true
      agentViewMade = true
    }
    // A panel that is already loaded is told; a new one asks on load.
    if wasMade {
      notifyAgent("onHandOff")
    } else {
      _ = agentView
    }
  }

  func takeHandOff() -> (query: String, chatID: String) {
    defer { pendingHandOff = nil }
    return pendingHandOff ?? ("", "")
  }

  // The agent works in its own tab, next to the user's: opened on the page
  // the user is on (so "this page" and the site's context carry over),
  // never stealing focus, and never playing media on its own.
  func attachAgent() async -> BrowserTab? {
    let tab: BrowserTab
    if let existing = agentTab, tabs.contains(where: { $0 === existing }) {
      tab = existing
    } else {
      tab = BrowserTab(browser: self, agent: true)
      withAnimation(Theme.spring) { tabs.insert(tab, at: 0) }
      agentTab = tab
      agentSeed = nil
    }
    // A new page in the user's tab since last time: start there.
    if let user = selected, !user.isAgentTab, !user.isHome, let url = user.url,
       url != agentSeed {
      agentSeed = url
      tab.load(url)
    } else if tab.url == nil {
      tab.load(URL(string: "about:blank")!)
    }
    var waited = 0
    while waited < 80, tab.webView.isLoading || tab.webView.url == nil {
      try? await Task.sleep(nanoseconds: 50_000_000)
      waited += 1
    }
    withAnimation(Theme.spring) {
      agentWorking = true
      tab.agentInControl = true
    }
    return tab
  }

  func detachAgent() {
    withAnimation(Theme.spring) {
      agentWorking = false
      agentTab?.agentInControl = false
    }
  }

  // Shows Ditto's tab in the window (to watch or take over).
  func showAgentTab() {
    if let tab = agentTab {
      select(tab)
    }
  }

  // Calls the agent panel's page (window.__ditto.<event>.dispatch).
  func notifyAgent(_ event: String, _ args: Any...) {
    guard agentViewMade else { return }
    Self.dispatch(agentView, event, args)
  }

  static func call(_ page: WKWebView, _ event: String, _ args: Any...) {
    dispatch(page, event, args)
  }

  private static func dispatch(_ page: WKWebView, _ event: String, _ args: [Any]) {
    let list = AgentBridge.json(args)
    page.evaluateJavaScript(
      "window.__ditto && window.__ditto.\(event).dispatch(...\(list))", completionHandler: nil)
  }

  // MARK: Page

  func bookmarkSelected() {
    guard let tab = selected, let url = tab.url, !tab.isHome else { return }
    let added = Services.shared.bookmarks.toggle(url: url.absoluteString, title: tab.title)
    show(toast: added ? "Bookmarked" : "Bookmark removed")
  }

  func zoom(_ step: Double) {
    guard let view = selected?.webView else { return }
    view.pageZoom = step == 0 ? 1 : max(0.5, min(3, view.pageZoom + step))
  }

  func show(toast text: String) {
    toastTask?.cancel()
    withAnimation(Theme.spring) { toast = text }
    toastTask = Task {
      try? await Task.sleep(nanoseconds: 1_800_000_000)
      guard !Task.isCancelled else { return }
      withAnimation(Theme.quick) { toast = nil }
    }
  }

  func saveSession() {
    SessionStore.save(userTabs.compactMap { $0.isHome ? nil : $0.url?.absoluteString })
  }
}
