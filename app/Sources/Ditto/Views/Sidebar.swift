import AppKit
import SwiftUI

// The left column: the address, favourites, Ditto's tabs and the user's
// tabs (navigation and Ditto's controls are in the top bar).
struct Sidebar: View {
  @EnvironmentObject private var browser: Browser
  @ObservedObject private var bookmarks = Services.shared.bookmarks

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      AddressPill()
      if !bookmarks.favorites.isEmpty {
        Favorites(items: bookmarks.favorites)
      }
      // Ditto's tabs: one per chat working (or recently done).
      ForEach(browser.agentTabList) { tab in
        AgentTabRow(tab: tab)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
      ScrollView(showsIndicators: false) {
        VStack(spacing: 2) {
          ForEach(browser.userTabs) { tab in
            TabRow(tab: tab)
              .transition(.asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
                removal: .opacity.combined(with: .scale(scale: 0.94))))
          }
          if let last = browser.userTabs.last {
            NewTabSlot(last: last)
          } else {
            NewTabRow()
          }
        }
      }
      Spacer(minLength: 0)
      HStack(spacing: 2) {
        IconButton(symbol: "arrow.down.circle", label: "Downloads") {
          NSWorkspace.shared.open(Paths.downloads)
        }
        Spacer()
      }
    }
    .padding(.horizontal, 2)
    .padding(.bottom, 2)
  }
}

// Back, forward and reload (in the top bar).
struct NavigationButtons: View {
  @ObservedObject var tab: BrowserTab

  var body: some View {
    IconButton(symbol: "chevron.left", label: "Back (⌘[)") { tab.webView.goBack() }
      .opacity(tab.canGoBack ? 1 : 0.35)
      .disabled(!tab.canGoBack)
    IconButton(symbol: "chevron.right", label: "Forward (⌘])") { tab.webView.goForward() }
      .opacity(tab.canGoForward ? 1 : 0.35)
      .disabled(!tab.canGoForward)
    IconButton(symbol: tab.isLoading ? "xmark" : "arrow.clockwise",
               label: tab.isLoading ? "Stop" : "Reload (⌘R)") {
      if tab.isLoading { tab.webView.stopLoading() } else { tab.webView.reload() }
    }
  }
}

// Where the current tab is; click (or ⌘L) to go somewhere else.
struct AddressPill: View {
  @EnvironmentObject private var browser: Browser
  @State private var hovering = false

  var body: some View {
    Button {
      browser.showCommandBar(newTab: false)
    } label: {
      HStack(spacing: 8) {
        if let tab = browser.selected, !tab.isHome {
          Image(systemName: tab.url?.scheme == "https" ? "lock.fill" : "globe")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Theme.secondary)
          Text(tab.host)
            .lineLimit(1)
            .foregroundStyle(Theme.text)
        } else {
          Image(systemName: "sparkle.magnifyingglass")
            .foregroundStyle(Theme.secondary)
          Text("Search or ask")
            .foregroundStyle(Theme.secondary)
        }
        Spacer(minLength: 0)
      }
      .font(.system(size: 13))
      .padding(.horizontal, 10)
      .frame(height: 34)
      .background(RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(hovering ? Theme.raised : Theme.hover))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle())
    .help("Open location (⌘L)")
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
  }
}

struct Favorites: View {
  @EnvironmentObject private var browser: Browser
  let items: [Bookmark]

  var body: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4),
              spacing: 6) {
      ForEach(items) { bookmark in
        FavoriteTile(bookmark: bookmark)
      }
    }
  }
}

struct FavoriteTile: View {
  @EnvironmentObject private var browser: Browser
  let bookmark: Bookmark
  @State private var hovering = false

  var body: some View {
    let host = URL(string: bookmark.url)?.host() ?? ""
    Button {
      if let url = URL(string: bookmark.url) {
        browser.selected?.load(url)
      }
    } label: {
      Favicon(host: host, size: 18)
        .frame(maxWidth: .infinity)
        .frame(height: 40)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(hovering ? Theme.raised : Theme.hover))
    }
    .buttonStyle(PressStyle())
    .help(bookmark.title)
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
    .contextMenu {
      Button("Open in New Tab") {
        if let url = URL(string: bookmark.url) { browser.newTab(url) }
      }
      Button("Remove Bookmark") { Services.shared.bookmarks.remove(bookmark) }
    }
  }
}

struct TabRow: View {
  @EnvironmentObject private var browser: Browser
  @ObservedObject var tab: BrowserTab
  @State private var hovering = false

  private var selected: Bool { browser.selected?.id == tab.id }

  var body: some View {
    HStack(spacing: 8) {
      icon
        .frame(width: 16, height: 16)
      Text(tab.displayTitle)
        .font(.system(size: 13, weight: selected ? .medium : .regular))
        .foregroundStyle(selected ? Theme.text : Theme.secondary)
        .lineLimit(1)
      Spacer(minLength: 0)
      if tab.isPlayingAudio || tab.isMuted {
        Button {
          tab.setMuted(!tab.isMuted)
        } label: {
          Image(systemName: tab.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(tab.isMuted ? Theme.secondary : Theme.accent)
            .symbolEffect(.variableColor.iterative, isActive: tab.isPlayingAudio && !tab.isMuted)
            .frame(width: 18, height: 18)
        }
        .buttonStyle(PressStyle())
        .help(tab.isMuted ? "Unmute tab" : "Mute tab")
      }
      if hovering {
        Button {
          browser.close(tab)
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(Theme.secondary)
            .frame(width: 18, height: 18)
            .background(Circle().fill(Theme.hover))
        }
        .buttonStyle(PressStyle())
        .help("Close tab (⌘W)")
        .transition(.opacity)
      }
    }
    .padding(.horizontal, 8)
    .frame(height: 32)
    .opacity(tab.isAsleep && !selected ? 0.62 : 1)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(selected ? Theme.raised : (hovering ? Theme.hover : .clear))
        .shadow(color: .black.opacity(selected ? 0.07 : 0), radius: 2, y: 1))
    .contentShape(Rectangle())
    .onTapGesture { browser.select(tab) }
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
    .contextMenu {
      Button("Close Tab") { browser.close(tab) }
      if let url = tab.url, !tab.isHome {
        Button("Duplicate Tab") { browser.newTab(url) }
        Button("Copy Link") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(url.absoluteString, forType: .string)
        }
      }
    }
  }

  @ViewBuilder private var icon: some View {
    if tab.agentInControl {
      PulsingSparkle()
    } else if tab.isLoading && !tab.isHome {
      ProgressView()
        .controlSize(.small)
        .scaleEffect(0.6)
    } else if tab.isHome {
      Image(systemName: "sparkle")
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Theme.secondary)
    } else {
      Favicon(host: tab.host, image: tab.favicon)
    }
  }
}

// The agent is working in this tab.
struct PulsingSparkle: View {
  @State private var on = false

  var body: some View {
    Image(systemName: "sparkles")
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(LinearGradient(colors: [Theme.accent, Theme.accent2],
                                      startPoint: .topLeading, endPoint: .bottomTrailing))
      .scaleEffect(on ? 1.12 : 0.9)
      .opacity(on ? 1 : 0.6)
      .onAppear {
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { on = true }
      }
  }
}

// "New Tab" under the tabs, unless the last tab already is one.
struct NewTabSlot: View {
  @ObservedObject var last: BrowserTab

  var body: some View {
    if !last.isHome {
      NewTabRow()
    }
  }
}

struct NewTabRow: View {
  @EnvironmentObject private var browser: Browser
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "plus")
        .font(.system(size: 11, weight: .semibold))
        .frame(width: 16, height: 16)
      Text("New Tab")
        .font(.system(size: 13))
      Spacer(minLength: 0)
    }
    .foregroundStyle(Theme.secondary)
    .padding(.horizontal, 8)
    .frame(height: 32)
    .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
      .fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onTapGesture { browser.showCommandBar(newTab: true) }
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
    .help("New tab (⌘T)")
  }
}

// Ditto's own tab, above the user's: what it is on and whether it is
// working. Click to watch it in the window.
struct AgentTabRow: View {
  @EnvironmentObject private var browser: Browser
  @ObservedObject var tab: BrowserTab
  @State private var hovering = false

  private var selected: Bool { browser.selected?.id == tab.id }
  private var working: Bool { browser.isWorking(tab) }
  // What it is doing, not just where.
  private var status: String {
    let blank = tab.isHome || tab.url?.scheme == "about"
    if working {
      return blank ? "Starting" : "Browsing \(tab.host)"
    }
    return blank ? "Done" : "Done · \(tab.host)"
  }

  var body: some View {
    HStack(spacing: 8) {
      ZStack {
        Circle()
          .fill(LinearGradient(colors: [Theme.accent, Theme.accent2],
                               startPoint: .topLeading, endPoint: .bottomTrailing))
          .frame(width: 18, height: 18)
        Image(systemName: "sparkles")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(.white)
      }
      .shadow(color: Theme.accent.opacity(working ? 0.6 : 0), radius: 6)
      VStack(alignment: .leading, spacing: 0) {
        Text(tab.label.isEmpty ? (working ? "Ditto is browsing" : "Ditto’s tab") : tab.label)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Theme.text)
          .lineLimit(1)
        Text(status)
          .font(.system(size: 11))
          .foregroundStyle(Theme.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if working {
        PulsingSparkle()
      }
    }
    .padding(.horizontal, 8)
    .frame(height: 40)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(selected ? Theme.raised : (hovering ? Theme.hover : Theme.accent.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(Theme.accent.opacity(working ? 0.35 : 0.12), lineWidth: 1)))
    .contentShape(Rectangle())
    .onTapGesture { browser.select(tab) }
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
    .help("Show Ditto’s tab")
    .contextMenu {
      Button("Close Ditto’s Tab") { browser.close(tab) }
    }
  }
}
