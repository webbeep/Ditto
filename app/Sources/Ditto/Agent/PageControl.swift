import AppKit
import WebKit

// The agent's hands on a tab: the subset of Chrome DevTools Protocol
// commands its page driver uses (agent/src/browser/page_driver.ts), done
// with WebKit. Clicks and keys are real AppKit events sent through the
// window, so pages see them as user input. Keep the list in sync with
// ALLOWED_CDP in agent/dev/webui_harness.ts.
@MainActor
struct PageControl {
  static let allowed: Set<String> = [
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.captureScreenshot",
    "Page.navigate",
    "Runtime.evaluate",
  ]

  struct Failure: LocalizedError {
    var errorDescription: String?
  }

  let webView: WKWebView

  func send(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    guard Self.allowed.contains(method) else {
      throw Failure(errorDescription: "\(method) is not allowed")
    }
    switch method {
    case "Runtime.evaluate":
      return await evaluate(params["expression"] as? String ?? "")
    case "Input.dispatchMouseEvent":
      try mouse(type: params["type"] as? String ?? "",
                x: number(params["x"]), y: number(params["y"]),
                clicks: Int(number(params["clickCount"], default: 1)))
      return [:]
    case "Input.insertText":
      try await insert(params["text"] as? String ?? "")
      return [:]
    case "Input.dispatchKeyEvent":
      try key(type: params["type"] as? String ?? "", key: params["key"] as? String ?? "")
      return [:]
    case "Page.navigate":
      guard let url = URL(string: params["url"] as? String ?? ""),
            ["http", "https"].contains(url.scheme ?? "") else {
        throw Failure(errorDescription: "Only http(s) pages can be opened")
      }
      webView.load(URLRequest(url: url))
      return ["frameId": "main"]
    case "Page.captureScreenshot":
      let image = try await webView.takeSnapshot(configuration: nil)
      guard let tiff = image.tiffRepresentation,
            let jpeg = NSBitmapImageRep(data: tiff)?
              .representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
        throw Failure(errorDescription: "Could not capture the page")
      }
      return ["data": jpeg.base64EncodedString()]
    default:
      throw Failure(errorDescription: "\(method) is not supported")
    }
  }

  // A full click at a point in CSS pixels.
  func click(x: Double, y: Double) async throws {
    try mouse(type: "mouseMoved", x: x, y: y, clicks: 0)
    try mouse(type: "mousePressed", x: x, y: y, clicks: 1)
    try await Task.sleep(nanoseconds: 40_000_000)
    try mouse(type: "mouseReleased", x: x, y: y, clicks: 1)
  }

  // Runs in the page's own world, like Runtime.evaluate; a promise is
  // awaited, and the value comes back as JSON.
  private func evaluate(_ expression: String) async -> [String: Any] {
    do {
      let value = try await webView.callAsyncJavaScript(
        "return await (\n\(expression)\n);", arguments: [:], in: nil, contentWorld: .page)
      let wrapped: [String: Any] = ["value": value ?? NSNull()]
      let fallback: [String: Any] = ["value": String(describing: value ?? "")]
      return ["result": JSONSerialization.isValidJSONObject(wrapped) ? wrapped : fallback]
    } catch {
      let text = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String ??
        error.localizedDescription
      let details: [String: Any] = ["text": text, "exception": ["description": text]]
      return ["exceptionDetails": details]
    }
  }

  private func mouse(type: String, x: Double, y: Double, clicks: Int) throws {
    guard let window = webView.window else {
      throw Failure(errorDescription: "The tab is not on screen")
    }
    let kind: NSEvent.EventType
    switch type {
    case "mousePressed": kind = .leftMouseDown
    case "mouseReleased": kind = .leftMouseUp
    default: kind = .mouseMoved
    }
    let zoom = webView.pageZoom * webView.magnification
    let local = NSPoint(x: x * zoom,
                        y: webView.isFlipped ? y * zoom : webView.bounds.height - y * zoom)
    let point = webView.convert(local, to: nil)
    guard let event = NSEvent.mouseEvent(
      with: kind, location: point, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: clicks,
      pressure: kind == .leftMouseDown ? 1 : 0) else {
      throw Failure(errorDescription: "Could not make a mouse event")
    }
    window.sendEvent(event)
  }

  private func key(type: String, key: String) throws {
    guard let window = webView.window else {
      throw Failure(errorDescription: "The tab is not on screen")
    }
    guard key == "Enter" else {
      throw Failure(errorDescription: "Only Enter is supported")
    }
    window.makeFirstResponder(webView)
    guard let event = NSEvent.keyEvent(
      with: type == "keyUp" ? .keyUp : .keyDown, location: .zero, modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
      isARepeat: false, keyCode: 36) else {
      throw Failure(errorDescription: "Could not make a key event")
    }
    window.sendEvent(event)
  }

  // Into the focused field, as typing would (input events fire).
  private func insert(_ text: String) async throws {
    _ = try await webView.callAsyncJavaScript("""
      const el = document.activeElement;
      if (!el) { return false; }
      if (document.execCommand('insertText', false, text)) { return true; }
      if ('value' in el) {
        el.value += text;
        el.dispatchEvent(new Event('input', {bubbles: true}));
        return true;
      }
      return false;
      """, arguments: ["text": text], in: nil, contentWorld: .page)
  }

  private func number(_ value: Any?, default fallback: Double = 0) -> Double {
    (value as? NSNumber)?.doubleValue ?? fallback
  }
}
