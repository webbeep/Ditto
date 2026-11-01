import AppKit
import SwiftUI
import WebKit

// One window: its tabs, the agent panel, and what the chrome shows.
@MainActor
final class Browser: ObservableObject {
  // The search engine (the self-test points it at its test site).
  static var searchTemplate = "https://www.google.com/search?q=%s"

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
  // Ditto's own tabs, one per session (a chat, or a watch being checked),
  // where it browses while the user keeps theirs; several at once.
  @Published private(set) var agentTabs: [String: BrowserTab] = [:]
  // Sessions whose tab the agent is driving right now.
  @Published private(set) var workingSessions: Set<String> = []
  // The session whose chat the panel shows (its tab is the one shown live).
  @Published var focusedSession = ""

  // Browse: the page leads, Ditto's chat beside it. Ditto: the chat leads,
  // with what Ditto is looking at beside it.
  enum Layout: String {
    case browse, ditto
  }

  @Published var layout = Layout(rawValue: UserDefaults.standard.string(forKey: "layout") ?? "")
    ?? .browse {
    didSet {
      UserDefaults.standard.set(layout.rawValue, forKey: "layout")
      // The chat page lays itself out for it (an answer page when leading).
      notifyAgent("onLayout", layout.rawValue)
    }
  }

  func setLayout(_ next: Layout) {
    withAnimation(Theme.spring) {
      layout = next
      agentViewMade = true
      if next == .browse {
        agentVisible = true
      }
    }
  }
  private var lastSession = ""

  // The Ditto tab to show: the chat in view's, else the latest.
  var agentTab: BrowserTab? {
    agentTabs[focusedSession] ?? agentTabs[lastSession]
  }

  var agentWorking: Bool {
    !workingSessions.isEmpty
  }

  // Whether the page card shows this tab. Ditto's tabs not shown there stay
  // in the window invisibly (WebKit throttles web views off screen) and are
  // never moved between views while Ditto works: previews of them are
  // snapshots.
  func inPageCard(_ tab: BrowserTab) -> Bool {
    layout == .browse && selected?.id == tab.id
  }

  // The chat is on screen (beside the page, or leading).
  var panelOnScreen: Bool {
    layout == .ditto || agentVisible
  }

  func isWorking(_ tab: BrowserTab) -> Bool {
    workingSessions.contains(tab.session)
  }

  // Ditto's tabs, in tab order.
  var agentTabList: [BrowserTab] {
    tabs.filter(\.isAgentTab)
  }
  private var sleepTimer: Timer?
  // Questions (or chats to open) for the panel, in order: several may come
  // before it takes them, and each is its own chat.
  private var pendingHandOffs: [(query: String, chatID: String)] = []
  private var closed: [URL] = []
  private var toastTask: Task<Void, Never>?

  // The agent panel's page, made when first opened.
  private(set) lazy var agentView: WKWebView = {
    let view = WKWebView(frame: .zero, configuration: Services.shared.makeConfiguration())
    view.isInspectable = true
    view.underPageBackgroundColor = .clear
    view.navigationDelegate = panelLinks
    view.uiDelegate = panelLinks
    view.load(URLRequest(url: URL(string: "ditto://app/ditto_agent.html")!))
    return view
  }()
  // Links in the chat (sources, answers, pictures) open as tabs.
  private lazy var panelLinks = PanelLinks(browser: self)
  @Published private(set) var agentViewMade = false
  // Bumped to put the panel page back in the window if it fell out.
  @Published private(set) var panelStage = 0

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
        showPage()
      }
    }
  }

  func select(_ tab: BrowserTab) {
    selected?.lastActive = Date()
    tab.wake()
    withAnimation(Theme.quick) {
      selectedID = tab.id
      showPage()
    }
  }

  // Choosing a page means seeing it: from the Ditto layout, back to Browse
  // (the chat beside the page).
  private func showPage() {
    if layout == .ditto {
      layout = .browse
      agentVisible = true
    }
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
    if tab.isAgentTab {
      if isWorking(tab) {
        notifyAgent("onTabDetached", tab.session)
      }
      workingSessions.remove(tab.session)
      agentTabs[tab.session] = nil
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

  // The same page, whichever part of it is in view.
  static func withoutFragment(_ url: URL) -> String {
    url.absoluteString.components(separatedBy: "#")[0]
  }

  // "example.com", "localhost:3000", "https://…": an address, not a question.
  static func address(_ text: String) -> URL? {
    if text.contains(" ") { return nil }
    if text.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) != nil {
      // Never script or data addresses, typed or pasted.
      let scheme = text.prefix { $0 != ":" }.lowercased()
      return ["javascript", "data", "vbscript", "blob"].contains(scheme) ? nil : URL(string: text)
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
    // In the Ditto layout the chat is already in front: ⌘J goes back to
    // the page, with the chat beside it.
    if layout == .ditto {
      setLayout(.browse)
      return
    }
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
    pendingHandOffs.append((query, chatID))
    let wasMade = agentViewMade
    withAnimation(Theme.spring) {
      agentViewMade = true
      // Asked from a new tab, the answer leads (there is no page to sit
      // beside); asked from a page, the chat opens beside it.
      if selected?.isHome ?? true {
        layout = .ditto
      } else if layout == .browse {
        agentVisible = true
      }
    }
    // A panel that is already loaded is told; a new one asks on load.
    if wasMade {
      notifyAgent("onHandOff")
    } else {
      _ = agentView
    }
  }

  func takeHandOff() -> (query: String, chatID: String) {
    pendingHandOffs.isEmpty ? ("", "") : pendingHandOffs.removeFirst()
  }

  // The agent works in its own tab, next to the user's: opened on the page
  // the user is on (so "this page" and the site's context carry over),
  // never stealing focus, and never playing media on its own.
  func attachAgent(start requested: URL? = nil, session: String = "",
                   label: String = "") async -> BrowserTab? {
    let tab: BrowserTab
    if let existing = agentTabs[session], tabs.contains(where: { $0 === existing }) {
      tab = existing
    } else {
      tab = BrowserTab(browser: self, agent: true, session: session)
      withAnimation(Theme.spring) { tabs.insert(tab, at: 0) }
      agentTabs[session] = tab
    }
    if !label.isEmpty {
      tab.label = label
    }
    lastSession = session
    // Working from the start: while its page loads, another question
    // finishing must not take it for idle and close it.
    withAnimation(Theme.spring) { _ = workingSessions.insert(session) }
    // Each request starts where the user is: their page ("this page" means
    // theirs, not the one the last task ended on), or a blank page when
    // they ask from a new tab. Asked while watching Ditto's tab, it stays.
    if let requested {
      if tab.webView.url.map(Self.withoutFragment) != Self.withoutFragment(requested) {
        tab.load(requested)
      }
    } else if let user = selected, !user.isAgentTab {
      let start = user.isHome ? URL(string: "about:blank")! : user.url!
      if tab.webView.url.map(Self.withoutFragment) != Self.withoutFragment(start) {
        tab.load(start)
      }
    } else if tab.url == nil {
      tab.load(URL(string: "about:blank")!)
    }
    var waited = 0
    while waited < 80, tab.webView.isLoading || tab.webView.url == nil {
      try? await Task.sleep(nanoseconds: 50_000_000)
      waited += 1
    }
    withAnimation(Theme.spring) { tab.agentInControl = true }
    return tab
  }

  func detachAgent(session: String = "") {
    withAnimation(Theme.spring) {
      _ = workingSessions.remove(session)
      agentTabs[session]?.agentInControl = false
    }
    pruneAgentTabs()
  }

  // Idle Ditto tabs beyond a few close (oldest first): each is a page in
  // memory, and the chat keeps what they found.
  private func pruneAgentTabs(keep: Int = 3) {
    let idle = agentTabList.filter {
      !isWorking($0) && $0.session != focusedSession && $0.id != selectedID
    }
    for tab in idle.sorted(by: { $0.lastActive < $1.lastActive }).dropLast(keep) {
      close(tab)
    }
  }

  // The user is about to ask (typing in a new tab's field): the panel page
  // gets ready and warms the models, so the answer starts sooner.
  func prepareToAsk() {
    guard agentViewMade else {
      agentViewMade = true
      _ = agentView
      return
    }
    notifyAgent("onWarmUp")
  }

  // Time to look at the pages Ditto watches. The panel page does it, also
  // while the panel is closed (it then waits in the window, invisibly).
  func checkWatches() {
    guard agentViewMade else {
      agentViewMade = true
      _ = agentView  // It checks once loaded.
      return
    }
    if agentView.window == nil {
      panelStage += 1
    }
    notifyAgent("onCheckWatches")
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

  // Tells this window's panel, unless it is the page the news came from.
  func notifyPanel(_ event: String, _ args: [Any], except page: WKWebView) {
    guard agentViewMade, agentView !== page else { return }
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
