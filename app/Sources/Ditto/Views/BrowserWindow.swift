import AppKit
import SwiftUI

// A window: the top bar, the sidebar, and either the page with Ditto's chat
// beside it (Browse) or the chat with Ditto's tabs beside it (Ditto), on a
// soft shell, with the command bar and toasts floating above.
struct BrowserWindow: View {
  @StateObject private var browser: Browser

  init(restore: Bool) {
    _browser = StateObject(wrappedValue: Browser(restore: restore))
  }

  var body: some View {
    ZStack {
      VisualEffect(material: .sidebar)
      Theme.shell.opacity(0.55)
      // Ditto's tabs need to be on screen to be driven (WebKit throttles
      // the rest): those the window does not show wait here, invisibly.
      ForEach(browser.agentTabList.filter { !browser.showsLive($0) }) { tab in
        ScaledWebViewHost(webView: tab.webView)
          .frame(width: 320, height: 200)
          .opacity(0.001)
          .allowsHitTesting(false)
      }
      // The panel's page keeps running (watches) while the chat is closed.
      if browser.agentViewMade, !browser.panelOnScreen {
        WebViewHost(webView: browser.agentView)
          .frame(width: 360, height: 640)
          .opacity(0.001)
          .allowsHitTesting(false)
          .id(browser.panelStage)
      }
      VStack(spacing: 0) {
        TopBar()
        HStack(spacing: 8) {
          if browser.sidebarVisible {
            Sidebar()
              .frame(width: 236)
              .transition(.move(edge: .leading).combined(with: .opacity))
          }
          if browser.layout == .ditto {
            // The chat leads; what Ditto looks at sits beside it.
            AgentPanel(showsLive: false)
              .frame(minWidth: 420)
              .transition(.opacity)
            DittoCanvas()
              .frame(width: 380)
              .transition(.move(edge: .trailing).combined(with: .opacity))
          } else {
            ContentCard()
              .background(AgentAura(active: browser.selected.map {
                $0.isAgentTab && browser.isWorking($0)
              } ?? false))
            if browser.agentVisible {
              AgentPanel()
                .frame(width: 380)
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
          }
        }
        .padding(.leading, browser.sidebarVisible ? 0 : 8)
        .padding(.trailing, 8)
        .padding(.bottom, 8)
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
      window.isOpaque = false
      window.backgroundColor = .clear
    })
  }
}
