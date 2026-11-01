import Foundation
import SQLite3

private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// Browsing history in SQLite (history.sqlite in the profile): one row per
// page, with its last title, last visit and visit count.
final class HistoryStore {
  // Enough for years of browsing; the oldest pages go first beyond it.
  private static let maxPages = 100_000
  private var db: OpaquePointer?
  private let queue = DispatchQueue(label: "app.ditto.history")
  private var recorded = 0

  init(url: URL) {
    queue.sync {
      guard sqlite3_open(url.path, &db) == SQLITE_OK else {
        db = nil
        return
      }
      exec("PRAGMA journal_mode=WAL")
      exec("""
        CREATE TABLE IF NOT EXISTS pages (
          url TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          last_visit REAL NOT NULL,
          visits INTEGER NOT NULL DEFAULT 1)
        """)
      exec("CREATE INDEX IF NOT EXISTS pages_by_visit ON pages(last_visit DESC)")
    }
  }

  deinit {
    sqlite3_close(db)
  }

  func record(url: String, title: String, at date: Date = Date()) {
    queue.async { [self] in
      upsert(url: url, title: title, date: date, visits: 1)
      recorded += 1
      if recorded % 200 == 0 { prune() }
    }
  }

  // Imported entries (e.g. from Chrome) keep their own dates.
  func importPages(_ pages: [(url: String, title: String, date: Date)]) {
    queue.sync {
      exec("BEGIN")
      for page in pages {
        upsert(url: page.url, title: page.title, date: page.date, visits: 1)
      }
      exec("COMMIT")
      prune()
    }
  }

  // Pages whose address or title contains `text`, most recent first.
  func search(_ text: String, limit: Int) -> [SavedPage] {
    queue.sync {
      query("""
        SELECT url, title, last_visit FROM pages
        WHERE url LIKE ?1 OR title LIKE ?1
        ORDER BY last_visit DESC LIMIT ?2
        """, bind: { statement in
          sqlite3_bind_text(statement, 1, "%\(text)%", -1, transient)
          sqlite3_bind_int(statement, 2, Int32(limit))
        })
    }
  }

  func recent(limit: Int) -> [SavedPage] {
    queue.sync {
      query("SELECT url, title, last_visit FROM pages ORDER BY last_visit DESC LIMIT ?1",
            bind: { sqlite3_bind_int($0, 1, Int32(limit)) })
    }
  }

  // The most visited pages, with their visit counts.
  func mostVisited(limit: Int) -> [(page: SavedPage, visits: Int)] {
    queue.sync {
      var statement: OpaquePointer?
      let sql = "SELECT url, title, last_visit, visits FROM pages ORDER BY visits DESC LIMIT ?1"
      guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
      defer { sqlite3_finalize(statement) }
      sqlite3_bind_int(statement, 1, Int32(limit))
      var rows: [(page: SavedPage, visits: Int)] = []
      while sqlite3_step(statement) == SQLITE_ROW {
        let url = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
        let title = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
        let date = Date(timeIntervalSince1970: sqlite3_column_double(statement, 2))
        rows.append((SavedPage(url: url, title: title, date: date, bookmark: false),
                     Int(sqlite3_column_int(statement, 3))))
      }
      return rows
    }
  }

  private func upsert(url: String, title: String, date: Date, visits: Int) {
    var statement: OpaquePointer?
    let sql = """
      INSERT INTO pages(url, title, last_visit, visits) VALUES(?1, ?2, ?3, ?4)
      ON CONFLICT(url) DO UPDATE SET
        title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END,
        last_visit = MAX(last_visit, excluded.last_visit),
        visits = visits + excluded.visits
      """
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_text(statement, 1, url, -1, transient)
    sqlite3_bind_text(statement, 2, String(title.prefix(300)), -1, transient)
    sqlite3_bind_double(statement, 3, date.timeIntervalSince1970)
    sqlite3_bind_int(statement, 4, Int32(visits))
    sqlite3_step(statement)
  }

  private func query(_ sql: String, bind: (OpaquePointer?) -> Void) -> [SavedPage] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(statement) }
    bind(statement)
    var pages: [SavedPage] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      let url = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
      let title = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
      let date = Date(timeIntervalSince1970: sqlite3_column_double(statement, 2))
      pages.append(SavedPage(url: url, title: title, date: date, bookmark: false))
    }
    return pages
  }

  private func prune() {
    exec("""
      DELETE FROM pages WHERE url IN (
        SELECT url FROM pages ORDER BY last_visit DESC LIMIT -1 OFFSET \(Self.maxPages))
      """)
  }

  private func exec(_ sql: String) {
    sqlite3_exec(db, sql, nil, nil, nil)
  }
}
