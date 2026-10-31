import AppKit
import SwiftUI
import WebKit

// A square icon button: SF Symbol, hover wash, a small press.
struct IconButton: View {
  let symbol: String
  let label: String
  var active = false
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(active ? Theme.accent : Theme.secondary)
        .frame(width: 28, height: 28)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(hovering ? Theme.hover : .clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle())
    .help(label)
    .accessibilityLabel(label)
    .onHover { inside in withAnimation(Theme.quick) { hovering = inside } }
  }
}

struct PressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.92 : 1)
      .animation(.spring(response: 0.2, dampingFraction: 0.6), value: configuration.isPressed)
  }
}

// Sites' icons, shared by tabs, favourites and the command bar.
@MainActor
enum FaviconCache {
  static var images: [String: NSImage] = [:]

  static func image(host: String) async -> NSImage? {
    if let cached = images[host] { return cached }
    guard !host.isEmpty, let url = URL(string: "https://\(host)/favicon.ico"),
          let (data, _) = try? await URLSession.shared.data(from: url),
          let image = NSImage(data: data) else { return nil }
    images[host] = image
    return image
  }
}

struct Favicon: View {
  let host: String
  var image: NSImage?
  var size: CGFloat = 16
  @State private var loaded: NSImage?

  var body: some View {
    Group {
      if let shown = image ?? loaded {
        Image(nsImage: shown)
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
      } else {
        Text(String(host.prefix(1)).uppercased())
          .font(.system(size: size * 0.6, weight: .semibold, design: .rounded))
          .foregroundStyle(Theme.secondary)
          .frame(width: size, height: size)
          .background(RoundedRectangle(cornerRadius: size / 4, style: .continuous)
            .fill(Theme.hover))
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size / 5, style: .continuous))
    .task(id: host) {
      if image == nil {
        loaded = await FaviconCache.image(host: host)
      }
    }
  }
}

// Hosts a WKWebView (tabs swap theirs in and out without reloading).
struct WebViewHost: NSViewRepresentable {
  let webView: WKWebView

  func makeNSView(context: Context) -> NSView {
    let container = NSView()
    attach(to: container)
    return container
  }

  func updateNSView(_ container: NSView, context: Context) {
    if webView.superview !== container {
      container.subviews.forEach { $0.removeFromSuperview() }
      attach(to: container)
    }
  }

  private func attach(to container: NSView) {
    webView.removeFromSuperview()
    webView.frame = container.bounds
    webView.autoresizingMask = [.width, .height]
    container.addSubview(webView)
  }
}

// Gives a SwiftUI window's NSWindow to `configure`.
struct WindowReader: NSViewRepresentable {
  let configure: (NSWindow) -> Void

  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async {
      if let window = view.window {
        configure(window)
      }
    }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {}
}

struct Toast: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(Theme.text)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(.regularMaterial, in: Capsule())
      .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 0.5))
      .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
  }
}

// A web view drawn at a desktop-sized canvas and scaled down to fit (Ditto's
// tab, live in the panel). Clicks the agent sends still land where they
// should: AppKit maps them through the same scaling.
struct ScaledWebViewHost: NSViewRepresentable {
  let webView: WKWebView
  // Wide enough for sites' desktop layouts, narrow enough to read scaled.
  var canvasWidth: CGFloat = 1000

  func makeNSView(context: Context) -> ScaledContainer {
    ScaledContainer(canvasWidth: canvasWidth)
  }

  func updateNSView(_ container: ScaledContainer, context: Context) {
    container.show(webView)
  }
}

final class ScaledContainer: NSView {
  private let canvas = NSView()
  private let canvasWidth: CGFloat

  init(canvasWidth: CGFloat) {
    self.canvasWidth = canvasWidth
    super.init(frame: .zero)
    wantsLayer = true
    layer?.masksToBounds = true
    addSubview(canvas)
  }

  required init?(coder: NSCoder) { nil }

  override var isFlipped: Bool { true }

  func show(_ webView: WKWebView) {
    if webView.superview !== canvas {
      canvas.subviews.forEach { $0.removeFromSuperview() }
      webView.removeFromSuperview()
      canvas.addSubview(webView)
    }
    needsLayout = true
  }

  override func layout() {
    super.layout()
    guard bounds.width > 0 else { return }
    let size = NSSize(width: canvasWidth, height: canvasWidth * bounds.height / bounds.width)
    canvas.frame = bounds
    canvas.bounds = NSRect(origin: .zero, size: size)
    canvas.subviews.first?.frame = NSRect(origin: .zero, size: size)
  }

  // The live view is to watch; clicks go to the SwiftUI layer above.
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// The macOS material behind the window (the sidebar's translucency).
struct VisualEffect: NSViewRepresentable {
  var material: NSVisualEffectView.Material = .sidebar

  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = material
    view.blendingMode = .behindWindow
    view.state = .followsWindowActiveState
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {
    view.material = material
  }
}

// A soft, slowly breathing glow behind a card while Ditto works.
struct AgentAura: View {
  let active: Bool

  var body: some View {
    ZStack {
      if active {
        TimelineView(.animation) { context in
          let t = context.date.timeIntervalSinceReferenceDate
          let breath = 0.5 + 0.5 * sin(t * 1.6)
          RoundedRectangle(cornerRadius: Theme.radius + 4, style: .continuous)
            .fill(AngularGradient(colors: [Theme.accent, Theme.accent2, Color.pink.opacity(0.7),
                                           Theme.accent2, Theme.accent],
                                  center: .center,
                                  angle: .degrees(t.truncatingRemainder(dividingBy: 8) / 8 * 360)))
            .padding(-3)
            .blur(radius: 18)
            .opacity(0.28 + 0.22 * breath)
        }
        .transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.6), value: active)
    .allowsHitTesting(false)
  }
}
