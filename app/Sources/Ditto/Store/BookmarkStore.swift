import Foundation

struct Bookmark: Codable, Identifiable, Hashable {
  var id = UUID()
  var title: String
  var url: String
  // "" for top level; "Chrome/Work" for imported folders.
  var folder: String = ""
  var added = Date()
}

// Bookmarks in bookmarks.json. The first top-level ones are the sidebar's
// favourites.
@MainActor
final class BookmarkStore: ObservableObject {
  @Published private(set) var items: [Bookmark] = []
  private let file: URL

  init(file: URL) {
    self.file = file
    if let data = try? Data(contentsOf: file),
       let saved = try? JSONDecoder().decode([Bookmark].self, from: data) {
      items = saved
    }
  }

  var favorites: [Bookmark] {
    Array(items.filter { $0.folder.isEmpty }.prefix(8))
  }

  func contains(_ url: String) -> Bool {
    items.contains { $0.url == url }
  }

  func toggle(url: String, title: String) -> Bool {
    if contains(url) {
      items.removeAll { $0.url == url }
      save()
      return false
    }
    items.append(Bookmark(title: title.isEmpty ? url : title, url: url))
    save()
    return true
  }

  func remove(_ bookmark: Bookmark) {
    items.removeAll { $0.id == bookmark.id }
    save()
  }

  // Adds bookmarks not already there; returns how many were new.
  func add(_ bookmarks: [Bookmark]) -> Int {
    var known = Set(items.map(\.url))
    var added = 0
    for bookmark in bookmarks where known.insert(bookmark.url).inserted {
      items.append(bookmark)
      added += 1
    }
    save()
    return added
  }

  func search(_ text: String, limit: Int) -> [SavedPage] {
    let needle = text.lowercased()
    let matches = items.filter {
      needle.isEmpty || $0.title.lowercased().contains(needle) ||
        $0.url.lowercased().contains(needle)
    }
    return matches.prefix(limit).map {
      SavedPage(url: $0.url, title: $0.title, date: $0.added, bookmark: true)
    }
  }

  private func save() {
    if let data = try? JSONEncoder().encode(items) {
      try? data.write(to: file, options: .atomic)
    }
  }
}
