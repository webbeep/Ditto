import Foundation
import SQLite3

// Moving from Chrome: reads the last-used profile of Google Chrome on this
// Mac (bookmarks, recent history, the signed-in Google account) and adds it
// to Ditto. Chrome may be running: its files are only read (history from a
// copy, since Chrome keeps its database locked).
enum ChromeImport {
  struct Result {
    var found = false
    var bookmarks = 0
    var history = 0
    var email = ""
  }

  @MainActor
  static func run(bookmarks: BookmarkStore, history: HistoryStore) -> Result {
    var result = Result()
    let home = FileManager.default.homeDirectoryForCurrentUser
    let chrome = home.appendingPathComponent("Library/Application Support/Google/Chrome")
    var profile = "Default"
    if let state = json(chrome.appendingPathComponent("Local State")),
       let profiles = state["profile"] as? [String: Any] {
      if let last = profiles["last_used"] as? String, !last.isEmpty, !last.contains("/"),
         last != "..", last != "." {
        profile = last
      }
      let info = (profiles["info_cache"] as? [String: Any])?[profile] as? [String: Any]
      result.email = info?["user_name"] as? String ?? ""
    }
    let dir = chrome.appendingPathComponent(profile)

    if let file = json(dir.appendingPathComponent("Bookmarks")),
       let roots = file["roots"] as? [String: Any] {
      result.found = true
      var found: [Bookmark] = []
      for (key, folder) in [("bookmark_bar", ""), ("other", "Other")] {
        if let root = roots[key] as? [String: Any] {
          collect(root, folder: folder, into: &found)
        }
      }
      result.bookmarks = bookmarks.add(found)
    }

    let pages = readHistory(dir.appendingPathComponent("History"))
    if !pages.isEmpty {
      result.found = true
      history.importPages(pages)
      result.history = pages.count
    }
    return result
  }

  private static func collect(_ node: [String: Any], folder: String, into out: inout [Bookmark]) {
    for child in node["children"] as? [[String: Any]] ?? [] {
      let name = child["name"] as? String ?? ""
      if child["type"] as? String == "url", let url = child["url"] as? String,
         url.hasPrefix("http") {
        out.append(Bookmark(title: name, url: url, folder: folder))
      } else if child["type"] as? String == "folder" {
        collect(child, folder: folder.isEmpty ? name : "\(folder)/\(name)", into: &out)
      }
    }
  }

  private static func readHistory(_ file: URL) -> [(url: String, title: String, date: Date)] {
    let copy = FileManager.default.temporaryDirectory
      .appendingPathComponent("ditto-chrome-history-\(UUID().uuidString)")
    guard (try? FileManager.default.copyItem(at: file, to: copy)) != nil else { return [] }
    defer { try? FileManager.default.removeItem(at: copy) }
    var db: OpaquePointer?
    guard sqlite3_open_v2(copy.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_close(db) }
    var statement: OpaquePointer?
    let sql = """
      SELECT url, title, last_visit_time FROM urls
      WHERE hidden = 0 AND url LIKE 'http%' ORDER BY last_visit_time DESC LIMIT 5000
      """
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(statement) }
    var pages: [(url: String, title: String, date: Date)] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      let url = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
      let title = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
      // Chrome counts microseconds since 1601.
      let micros = Double(sqlite3_column_int64(statement, 2))
      pages.append((url, title, Date(timeIntervalSince1970: micros / 1_000_000 - 11_644_473_600)))
    }
    return pages
  }

  private static func json(_ file: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}
