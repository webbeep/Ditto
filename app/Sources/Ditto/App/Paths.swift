import Foundation

// Where Ditto keeps things: the profile in ~/Library/Application Support/
// Ditto, the bundled pages and runtime in the app.
enum Paths {
  static let data: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return ensure(base.appendingPathComponent("Ditto", isDirectory: true))
  }()

  // Downloaded models (the runtime's LLAMA_CACHE).
  static let models = ensure(data.appendingPathComponent("Models", isDirectory: true))

  static func file(_ name: String) -> URL {
    data.appendingPathComponent(name)
  }

  // The agent panel and new tab page (built from web/).
  static var web: URL {
    Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/web", isDirectory: true)
  }

  static func resource(_ name: String) -> URL {
    Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/\(name)")
  }

  // llama.cpp's llama-server and its libraries.
  static var runtime: URL {
    Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/ditto-runtime/llama-server")
  }

  static var downloads: URL {
    FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
  }

  private static func ensure(_ dir: URL) -> URL {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }
}
