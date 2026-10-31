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
