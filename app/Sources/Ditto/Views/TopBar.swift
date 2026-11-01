import SwiftUI

// One bar across the window: the window controls' corner, the sidebar and
// navigation on the left; on the right, always in the same place whether
// the sidebar shows or not, Ditto's panel and the Browse/Ditto switch.
struct TopBar: View {
  @EnvironmentObject private var browser: Browser

  var body: some View {
    HStack(spacing: 2) {
      Spacer().frame(width: 72)
      IconButton(symbol: "sidebar.left",
                 label: browser.sidebarVisible ? "Hide sidebar (⌘S)" : "Show sidebar (⌘S)") {
        browser.toggleSidebar()
      }
      if browser.layout == .browse, let tab = browser.selected {
        NavigationButtons(tab: tab)
        PageTitle(tab: tab)
      } else if browser.layout == .ditto {
        Text(browser.agentWorking ? "Ditto is working" : "Ditto")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Theme.secondary)
          .padding(.leading, 6)
      }
      Spacer(minLength: 12)
      if browser.layout == .browse {
        IconButton(symbol: "sidebar.right",
                   label: browser.agentVisible ? "Hide Ditto (⌘J)" : "Ask Ditto (⌘J)") {
          browser.toggleAgent()
        }
      }
      LayoutSwitch()
    }
    .padding(.trailing, 10)
    .frame(height: 40)
  }
}

// The open page's title; click (or ⌘L) to go elsewhere.
struct PageTitle: View {
  @EnvironmentObject private var browser: Browser
  @ObservedObject var tab: BrowserTab
  @State private var hovering = false

  var body: some View {
    Button {
      browser.showCommandBar(newTab: false)
    } label: {
      HStack(spacing: 6) {
        if !tab.isHome {
          Favicon(host: tab.host, image: tab.favicon, size: 12)
        }
        Text(tab.isHome ? "New Tab" : tab.displayTitle)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(hovering ? Theme.text : Theme.secondary)
          .lineLimit(1)
      }
      .padding(.horizontal, 8)
      .frame(maxWidth: 420, minHeight: 26)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(hovering ? Theme.hover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle())
    .help("Open location (⌘L)")
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
  }
}

// Browse (the page leads) or Ditto (the chat leads); a dot on Ditto while
// it works out of view.
struct LayoutSwitch: View {
  @EnvironmentObject private var browser: Browser
  @Namespace private var pill

  var body: some View {
    HStack(spacing: 0) {
      segment(.browse, symbol: "globe", title: "Browse", help: "The page leads")
      segment(.ditto, symbol: "sparkles", title: "Ditto", help: "The chat leads (⇧⌘J)")
    }
    .padding(2)
    .background(Capsule().fill(Theme.hover))
  }

  private func segment(_ layout: Browser.Layout, symbol: String, title: String,
                       help: String) -> some View {
    let on = browser.layout == layout
    let ditto = layout == .ditto
    return Button {
      browser.setLayout(layout)
    } label: {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(title)
          .font(.system(size: 12, weight: .semibold))
        if ditto && !on && browser.agentWorking {
          Circle().fill(Theme.accent).frame(width: 6, height: 6)
            .shadow(color: Theme.accent.opacity(0.8), radius: 3)
        }
      }
      .foregroundStyle(on ? (ditto ? Color.white : Theme.text) : Theme.secondary)
      .padding(.horizontal, 10)
      .frame(height: 24)
      .background {
        if on {
          Capsule()
            .fill(ditto ?
                  AnyShapeStyle(LinearGradient(colors: [Theme.accent, Theme.accent2],
                                               startPoint: .leading, endPoint: .trailing)) :
                  AnyShapeStyle(Theme.raised))
            .shadow(color: (ditto ? Theme.accent : .black).opacity(ditto ? 0.35 : 0.08),
                    radius: ditto ? 8 : 2, y: 1)
            .matchedGeometryEffect(id: "pill", in: pill)
        }
      }
      .contentShape(Capsule())
    }
    .buttonStyle(PressStyle())
    .help(help)
  }
}

// Beside the chat in the Ditto layout: what Ditto is looking at, live (its
// tabs, working ones first), or before it has any, the user's page.
struct DittoCanvas: View {
  @EnvironmentObject private var browser: Browser

  var body: some View {
    let tabs = browser.agentTabList.sorted {
      (browser.isWorking($0) ? 0 : 1, $1.lastActive) < (browser.isWorking($1) ? 0 : 1, $0.lastActive)
    }
    ScrollView(showsIndicators: false) {
      VStack(spacing: 8) {
        if tabs.isEmpty {
          if let page = browser.selected, !page.isHome {
            LiveView(tab: page, height: 300)
          } else {
            VStack(spacing: 8) {
              Image(systemName: "sparkles")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(Theme.accent)
              Text("Ditto’s tabs show here, live, while it works.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 240)
            .card()
          }
        }
        // Working: live. Done: a row each (the answer shows where it read;
        // a finished page shrunk to a tile says nothing).
        ForEach(tabs.filter(browser.isWorking)) { tab in
          LiveView(tab: tab, height: tab.session == browser.focusedSession ? 300 : 200)
        }
        let done = tabs.filter { !browser.isWorking($0) }
        if !done.isEmpty {
          Text("Done")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.top, 4)
          ForEach(done) { tab in
            AgentTabRow(tab: tab)
          }
        }
      }
    }
  }
}
