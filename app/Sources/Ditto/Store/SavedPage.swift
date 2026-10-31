import Foundation

// One of the user's pages: a bookmark or a history entry.
struct SavedPage: Hashable {
  var url: String
  var title: String
  var date: Date
  var bookmark: Bool

  var asJSON: [String: Any] {
    ["url": url, "title": title, "timeMs": date.timeIntervalSince1970 * 1000,
     "bookmark": bookmark]
  }
}
