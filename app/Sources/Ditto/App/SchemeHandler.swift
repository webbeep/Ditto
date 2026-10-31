import Foundation
import WebKit

// Serves Ditto's own pages at ditto://app/... from the app bundle (web/,
// built from the repository's web/ folder).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
  private static let types = [
    "html": "text/html; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "svg": "image/svg+xml",
    "png": "image/png",
  ]

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    guard let url = urlSchemeTask.request.url, url.host == "app" else {
      urlSchemeTask.didFailWithError(URLError(.badURL))
      return
    }
    let path = url.path.isEmpty || url.path == "/" ? "home.html" : String(url.path.dropFirst())
    let root = Paths.web.standardizedFileURL
    let file = root.appendingPathComponent(path).standardizedFileURL
    guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
      urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    let type = Self.types[file.pathExtension] ?? "application/octet-stream"
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": type,
                                                  "Cache-Control": "no-cache"])!
    urlSchemeTask.didReceive(response)
    urlSchemeTask.didReceive(data)
    urlSchemeTask.didFinish()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
