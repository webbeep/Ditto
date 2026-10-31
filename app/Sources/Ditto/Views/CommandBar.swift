import SwiftUI

// ⌘T / ⌘L: one field for everything. An address opens, a question goes to
// Ditto, and open tabs, bookmarks and history match as you type.
struct CommandBar: View {
  @EnvironmentObject private var browser: Browser
  @State private var text = ""
  @State private var index = 0
  @State private var suggestions: [String] = []
  @FocusState private var focused: Bool

  var body: some View {
    let items = CommandItem.build(text, suggestions: suggestions, browser: browser)
    ZStack(alignment: .top) {
      Color.black.opacity(0.14)
        .ignoresSafeArea()
        .onTapGesture { browser.hideCommandBar() }
      VStack(spacing: 0) {
        HStack(spacing: 10) {
          Image(systemName: "sparkle.magnifyingglass")
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(Theme.secondary)
          TextField("Search, ask Ditto, or enter an address", text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: 18))
            .foregroundStyle(Theme.text)
            .focused($focused)
            .onSubmit { run(items, at: index) }
            .onKeyPress(.downArrow) { move(1, count: items.count); return .handled }
            .onKeyPress(.upArrow) { move(-1, count: items.count); return .handled }
            .onExitCommand { browser.hideCommandBar() }
        }
        .padding(.horizontal, 18)
        .frame(height: 56)
        if !items.isEmpty {
          Rectangle().fill(Theme.border).frame(height: 0.5)
          VStack(spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element.id) { offset, item in
              CommandRow(item: item, selected: offset == index)
                .onTapGesture { run(items, at: offset) }
                .onHover { inside in if inside { index = offset } }
            }
          }
          .padding(6)
        }
        HStack(spacing: 14) {
          Hint(keys: "↑↓", label: "choose")
          Hint(keys: "↩", label: "open")
          Hint(keys: "esc", label: "close")
          Spacer()
          Image(systemName: "sparkles")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.accent)
          Text("Questions go to Ditto")
            .font(.system(size: 11))
            .foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 16)
        .frame(height: 30)
        .background(Theme.hover.opacity(0.5))
      }
      .frame(width: 660)
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(LinearGradient(colors: [Theme.accent.opacity(0.55), Theme.accent2.opacity(0.35),
                                              Theme.border],
                                     startPoint: .topLeading, endPoint: .bottomTrailing),
                      lineWidth: 1))
      .shadow(color: Theme.accent.opacity(0.18), radius: 40, y: 10)
      .shadow(color: .black.opacity(0.22), radius: 30, y: 16)
      .padding(.top, 96)
    }
    .onAppear {
      if !browser.commandOpensTab, let tab = browser.selected, !tab.isHome {
        text = tab.url?.absoluteString ?? ""
      }
      focused = true
    }
    .onChange(of: text) { index = 0 }
    .task(id: text) {
      // A moment's pause, so typing does not send every keystroke.
      try? await Task.sleep(nanoseconds: 140_000_000)
      guard !Task.isCancelled, Browser.address(text) == nil else {
        suggestions = []
        return
      }
      let found = await SearchSuggest.fetch(text)
      if !Task.isCancelled {
        suggestions = found
      }
    }
  }

  private func move(_ step: Int, count: Int) {
    guard count > 0 else { return }
    withAnimation(Theme.quick) { index = (index + step + count) % count }
  }

  private func run(_ items: [CommandItem], at offset: Int) {
    guard items.indices.contains(offset) else { return }
    let newTab = browser.commandOpensTab
    browser.hideCommandBar()
    switch items[offset].kind {
    case .open(let url):
      if newTab || browser.selected == nil { browser.newTab(url) } else { browser.selected?.load(url) }
    case .ask(let question):
      browser.handOff(query: question, chatID: "")
    case .search(let query):
      browser.open(query, newTab: newTab, search: true)
    case .tab(let tab):
      browser.select(tab)
    }
  }
}

struct CommandRow: View {
  let item: CommandItem
  let selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      if let host = item.host {
        Favicon(host: host)
      } else {
        Image(systemName: item.icon)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(item.accent ? Theme.accent : Theme.secondary)
          .frame(width: 16)
      }
      Text(item.title)
        .font(.system(size: 14))
        .foregroundStyle(Theme.text)
        .lineLimit(1)
      Spacer(minLength: 8)
      Text(item.detail)
        .font(.system(size: 12))
        .foregroundStyle(Theme.secondary)
        .lineLimit(1)
      if selected {
        Image(systemName: "return")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Theme.secondary)
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 36)
    .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
      .fill(selected ? (item.accent ? Theme.accent.opacity(0.14) : Theme.hover) : .clear))
    .contentShape(Rectangle())
  }
}

struct CommandItem: Identifiable {
  enum Kind {
    case open(URL)
    case ask(String)
    case search(String)
    case tab(BrowserTab)
  }

  let id = UUID()
  let icon: String
  let title: String
  let detail: String
  let kind: Kind
  var accent = false
  // Shown with the site's icon.
  var host: String?

  @MainActor
  static func build(_ text: String, suggestions: [String], browser: Browser) -> [CommandItem] {
    let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let tabs = browser.userTabs.filter { !$0.isHome }
    if query.isEmpty {
      return tabs.prefix(6).map {
        CommandItem(icon: "square.on.square", title: $0.displayTitle, detail: "Switch to tab",
                    kind: .tab($0), host: $0.host)
      }
    }
    var items: [CommandItem] = []
    var seen = Set<String>()
    if let url = Browser.address(query) {
      items.append(CommandItem(icon: "arrow.up.right", title: query, detail: "Open",
                               kind: .open(url)))
      seen.insert(url.absoluteString)
    } else {
      items.append(CommandItem(icon: "sparkles", title: query, detail: "Ask Ditto",
                               kind: .ask(query), accent: true))
      items.append(CommandItem(icon: "magnifyingglass", title: query, detail: "Search Google",
                               kind: .search(query)))
      for suggestion in suggestions.prefix(4)
      where suggestion.lowercased() != query.lowercased() {
        items.append(CommandItem(icon: "magnifyingglass", title: suggestion, detail: "Search",
                                 kind: .search(suggestion)))
      }
    }
    let needle = query.lowercased()
    for tab in tabs where tab.title.lowercased().contains(needle) ||
      (tab.url?.absoluteString.lowercased().contains(needle) ?? false) {
      items.append(CommandItem(icon: "square.on.square", title: tab.displayTitle,
                               detail: "Switch to tab", kind: .tab(tab), host: tab.host))
      if let url = tab.url {
        seen.insert(url.absoluteString)
      }
    }
    let services = Services.shared
    for page in services.bookmarks.search(query, limit: 4) + services.history.search(query, limit: 8)
    where seen.insert(page.url).inserted {
      guard let url = URL(string: page.url) else { continue }
      let host = url.host()?.replacingOccurrences(of: "www.", with: "") ?? ""
      items.append(CommandItem(icon: page.bookmark ? "star" : "clock",
                               title: page.title.isEmpty ? page.url : page.title,
                               detail: host, kind: .open(url), host: host))
    }
    return Array(items.prefix(10))
  }
}

struct Hint: View {
  let keys: String
  let label: String

  var body: some View {
    HStack(spacing: 4) {
      Text(keys)
        .font(.system(size: 10, weight: .semibold, design: .rounded))
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Theme.hover))
      Text(label)
        .font(.system(size: 11))
    }
    .foregroundStyle(Theme.secondary)
  }
}
