import SwiftUI
import WebKit

// The page, in a card: progress along the top, find, errors, and a moving
// gradient frame while the agent is in control.
struct ContentCard: View {
  @EnvironmentObject private var browser: Browser

  var body: some View {
    ZStack {
      Theme.card
      if let tab = browser.selected {
        TabContent(tab: tab)
          .id(tab.id)
          .transition(.opacity)
      }
    }
    .card()
  }
}

struct TabContent: View {
  @EnvironmentObject private var browser: Browser
  @ObservedObject var tab: BrowserTab

  var body: some View {
    ZStack(alignment: .top) {
      WebViewHost(webView: tab.webView)
      ProgressLine(progress: tab.progress, visible: tab.isLoading && !tab.isHome)
      if let error = tab.loadError {
        LoadError(message: error) { tab.webView.reload() }
          .transition(.opacity)
      }
      if browser.findVisible {
        FindBar(webView: tab.webView)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .trailing)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .overlay(AgentFrame(active: tab.agentInControl))
    .overlay(alignment: .center) {
      if tab.isAsleep {
        ProgressView().controlSize(.small)
      }
    }
    .animation(Theme.spring, value: browser.findVisible)
  }
}

struct ProgressLine: View {
  let progress: Double
  let visible: Bool

  var body: some View {
    GeometryReader { geometry in
      Capsule()
        .fill(LinearGradient(colors: [Theme.accent.opacity(0.6), Theme.accent],
                             startPoint: .leading, endPoint: .trailing))
        .frame(width: max(24, geometry.size.width * progress), height: 2)
        .animation(.easeOut(duration: 0.25), value: progress)
    }
    .frame(height: 2)
    .opacity(visible ? 1 : 0)
    .animation(.easeOut(duration: visible ? 0.1 : 0.4), value: visible)
    .allowsHitTesting(false)
  }
}

// While the agent drives the tab: a slowly turning gradient frame.
struct AgentFrame: View {
  let active: Bool

  var body: some View {
    ZStack {
      if active {
        TimelineView(.animation) { context in
          let turn = context.date.timeIntervalSinceReferenceDate
            .truncatingRemainder(dividingBy: 4) / 4 * 360
          RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
            .strokeBorder(
              AngularGradient(colors: [Theme.accent, Theme.accent2, Theme.accent.opacity(0.25),
                                       Theme.accent2, Theme.accent],
                              center: .center, angle: .degrees(turn)),
              lineWidth: 2)
            .shadow(color: Theme.accent.opacity(0.35), radius: 10)
        }
        .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.4), value: active)
    .allowsHitTesting(false)
  }
}

struct LoadError: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 28, weight: .light))
        .foregroundStyle(Theme.secondary)
      Text("This page can’t be opened")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Theme.text)
      Text(message)
        .font(.system(size: 12))
        .foregroundStyle(Theme.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
      Button("Try Again", action: retry)
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .padding(.top, 4)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.card)
  }
}

struct FindBar: View {
  @EnvironmentObject private var browser: Browser
  let webView: WKWebView
  @State private var text = ""
  @State private var found = true
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 12))
        .foregroundStyle(Theme.secondary)
        .padding(.leading, 6)
      TextField("Find on page", text: $text)
        .textFieldStyle(.plain)
        .font(.system(size: 13))
        .foregroundStyle(found ? Theme.text : Color.red)
        .frame(width: 180)
        .focused($focused)
        .onSubmit { find(backwards: false) }
        .onChange(of: text) { find(backwards: false) }
      IconButton(symbol: "chevron.up", label: "Previous") { find(backwards: true) }
      IconButton(symbol: "chevron.down", label: "Next") { find(backwards: false) }
      IconButton(symbol: "xmark", label: "Done") { browser.findVisible = false }
    }
    .padding(4)
    .background(.regularMaterial, in: Capsule())
    .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 0.5))
    .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
    .onAppear { focused = true }
    .onExitCommand { browser.findVisible = false }
  }

  private func find(backwards: Bool) {
    guard !text.isEmpty else { return }
    let configuration = WKFindConfiguration()
    configuration.backwards = backwards
    configuration.wraps = true
    webView.find(text, configuration: configuration) { result in
      found = result.matchFound
    }
  }
}

struct AgentPanel: View {
  @EnvironmentObject private var browser: Browser
  // Beside the page, the chat shows Ditto's tab live above it while it
  // works (once done, the answer shows where it read); in the Ditto layout
  // the canvas does.
  var showsLive = true

  var body: some View {
    VStack(spacing: 8) {
      if showsLive, let tab = browser.agentTab, browser.selected?.id != tab.id,
         browser.isWorking(tab) {
        LiveView(tab: tab)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
      WebViewHost(webView: browser.agentView)
        .background(Theme.card)
        .card()
    }
    .background(AgentAura(active: browser.agentWorking))
    .animation(Theme.spring, value: browser.agentTab?.id)
    .animation(Theme.spring, value: browser.agentWorking)
  }
}

// Ditto's tab, live: what it is doing while the user keeps browsing.
// Click to open it in the window.
struct LiveView: View {
  @EnvironmentObject private var browser: Browser
  @ObservedObject var tab: BrowserTab
  var height: CGFloat = 196
  @State private var hovering = false

  private var caption: String {
    if !tab.isAgentTab {
      return "Your page · \(tab.host)"
    }
    let what = tab.label.isEmpty ? "" : "\(tab.label) · "
    return browser.isWorking(tab) ? "\(what)browsing \(tab.host)" : "\(what)\(tab.host)"
  }

  @State private var frame: NSImage?

  var body: some View {
    ZStack(alignment: .topLeading) {
      Theme.card
      if tab.isAgentTab {
        // Ditto's tab stays where it is (driven, invisibly); this shows it.
        // An overlay on a clear view: the picture fills the card without
        // setting its size (a filled image is as wide as its height asks),
        // from the top left, where pages start.
        Color.clear
          .overlay(alignment: .topLeading) {
            if let frame {
              Image(nsImage: frame)
                .resizable()
                .aspectRatio(contentMode: .fill)
            }
          }
          .clipped()
          .padding(.top, 26)
      } else {
        ScaledWebViewHost(webView: tab.webView)
      }
      HStack(spacing: 6) {
        Circle()
          .fill(browser.isWorking(tab) ? Theme.accent : Theme.secondary)
          .frame(width: 6, height: 6)
          .shadow(color: Theme.accent.opacity(browser.isWorking(tab) ? 0.8 : 0), radius: 4)
        Text(caption)
          .font(.system(size: 11, weight: .medium))
          .lineLimit(1)
        Spacer(minLength: 0)
        Image(systemName: "arrow.up.left.and.arrow.down.right")
          .font(.system(size: 10, weight: .semibold))
          .opacity(hovering ? 1 : 0.5)
      }
      .foregroundStyle(Theme.text)
      .padding(.horizontal, 10)
      .frame(height: 26)
      .background(.regularMaterial)
    }
    .frame(maxWidth: .infinity)
    .frame(height: height)
    .clipped()
    .card()
    .overlay(AgentFrame(active: browser.isWorking(tab)))
    .scaleEffect(hovering ? 1.01 : 1)
    .contentShape(Rectangle())
    .onTapGesture {
      // Open it in the window (from the Ditto layout, back to browsing).
      if browser.layout == .ditto {
        browser.setLayout(.browse)
      }
      browser.select(tab)
    }
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
    .help("Open Ditto’s tab")
    .task(id: tab.id) {
      // A fresh frame twice a second while shown.
      guard tab.isAgentTab else { return }
      // Tile-sized: sharp enough to read, light enough to take this often.
      let size = WKSnapshotConfiguration()
      size.snapshotWidth = 480
      while !Task.isCancelled {
        if tab.webView.window != nil,
           let image = try? await tab.webView.takeSnapshot(configuration: size) {
          frame = image
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
      }
    }
  }
}
