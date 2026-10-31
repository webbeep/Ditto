import AppKit
import SwiftUI

// A window: the sidebar, the page card and the agent panel on a soft shell,
// with the command bar and toasts floating above.
struct BrowserWindow: View {
  @StateObject private var browser: Browser

  init(restore: Bool) {
    _browser = StateObject(wrappedValue: Browser(restore: restore))
  }

  var body: some View {
    ZStack {
      Theme.shell
      HStack(spacing: 0) {
        if browser.sidebarVisible {
          Sidebar()
            .frame(width: 244)
            .transition(.move(edge: .leading).combined(with: .opacity))
        }
        VStack(spacing: 0) {
          if !browser.sidebarVisible {
            CollapsedBar()
              .transition(.opacity)
          }
          ContentCard()
        }
        .padding(.top, browser.sidebarVisible ? 8 : 0)
        .padding(.leading, browser.sidebarVisible ? 0 : 8)
        .padding(.trailing, 8)
        .padding(.bottom, 8)
        if browser.agentVisible {
          AgentPanel()
            .frame(width: 380)
            .padding(.vertical, 8)
            .padding(.trailing, 8)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
      if browser.commandBarVisible {
        CommandBar()
          .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
          .zIndex(2)
      }
      if let toast = browser.toast {
        Toast(text: toast)
          .frame(maxHeight: .infinity, alignment: .bottom)
          .padding(.bottom, 24)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .zIndex(3)
      }
    }
    .ignoresSafeArea()
    .frame(minWidth: 760, minHeight: 480)
    .environmentObject(browser)
    .focusedSceneObject(browser)
    .task {
      if let report = ProcessInfo.processInfo.environment["DITTO_SELF_TEST"] {
        await SelfTest(browser: browser, report: URL(fileURLWithPath: report)).run()
      }
    }
    .background(WindowReader { window in
      browser.window = window
      window.isMovableByWindowBackground = true
      window.titlebarAppearsTransparent = true
    })
  }
}

// With the sidebar hidden: room for the window controls, and the way back.
struct CollapsedBar: View {
  @EnvironmentObject private var browser: Browser

  var body: some View {
    HStack(spacing: 2) {
      Spacer().frame(width: 70)
      IconButton(symbol: "sidebar.left", label: "Show sidebar (⌘S)") { browser.toggleSidebar() }
      if let tab = browser.selected {
        NavigationButtons(tab: tab)
        Text(tab.displayTitle)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(Theme.secondary)
          .lineLimit(1)
          .padding(.leading, 6)
      }
      Spacer()
      AgentButton()
    }
    .frame(height: 38)
  }
}
