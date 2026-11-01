import Foundation

// What the new tab page shows: the user's top sites, what is trending
// (Google Trends' daily feed for the user's region), and the trends that
// match what the user reads ("for you"), ranked on this Mac from local
// history and Ditto's notes. Nothing about the user is sent anywhere.
@MainActor
final class HomeFeed {
  static let shared = HomeFeed()

  struct Trend {
    var title = ""
    var traffic = ""
    var picture = ""
    var newsTitle = ""
    var newsURL = ""
    var source = ""
  }

  private var trends: [Trend] = []
  private var fetched = Date.distantPast

  func home() async -> [String: Any] {
    let trends = await trending()
    let interests = Self.interests()
    var forYou: [(trend: Trend, score: Int, reason: String)] = []
    for trend in trends {
      let words = Self.words("\(trend.title) \(trend.newsTitle)")
      let shared = words.filter { interests[$0] != nil }
      if let top = shared.max(by: { interests[$0]! < interests[$1]! }) {
        forYou.append((trend, shared.reduce(0) { $0 + interests[$1]! }, top))
      }
    }
    forYou.sort { $0.score > $1.score }
    let picked = Set(forYou.prefix(4).map(\.trend.title))
    return [
      "topSites": topSites(),
      "forYou": forYou.prefix(4).map { Self.json($0.trend, reason: $0.reason) },
      "trending": trends.filter { !picked.contains($0.title) }.prefix(8).map { Self.json($0, reason: "") },
    ]
  }

  // Sites the user visits most, one tile per site.
  private func topSites() -> [[String: Any]] {
    var bySite: [String: (url: String, title: String, visits: Int)] = [:]
    for (page, visits) in Services.shared.history.mostVisited(limit: 300) {
      guard let url = URL(string: page.url), let host = url.host(), url.scheme?.hasPrefix("http") == true
      else { continue }
      let site = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
      let current = bySite[site] ?? ("\(url.scheme!)://\(host)/", page.title, 0)
      bySite[site] = (current.url, current.title, current.visits + visits)
    }
    return bySite.sorted { $0.value.visits > $1.value.visits }.prefix(8).map {
      ["host": $0.key, "url": $0.value.url, "title": $0.value.title] as [String: Any]
    }
  }

  private func trending() async -> [Trend] {
    if Date().timeIntervalSince(fetched) < 30 * 60, !trends.isEmpty {
      return trends
    }
    let region = Locale.current.region?.identifier ?? "US"
    guard let url = URL(string: "https://trends.google.com/trending/rss?geo=\(region)"),
          let (data, _) = try? await URLSession.shared.data(from: url) else { return trends }
    let parser = TrendsParser()
    let xml = XMLParser(data: data)
    xml.delegate = parser
    xml.parse()
    if !parser.items.isEmpty {
      trends = parser.items
      fetched = Date()
    }
    return trends
  }

  // What the user reads about: words from the last weeks' page titles and
  // from Ditto's notes, weighted by how often they come up.
  private static func interests() -> [String: Int] {
    var counts: [String: Int] = [:]
    let recent = Services.shared.history.recent(limit: 400)
      .filter { Date().timeIntervalSince($0.date) < 30 * 86_400 }
    for page in recent {
      for word in Set(words(page.title)) {
        counts[word, default: 0] += 1
      }
    }
    if let data = UserData.read("memory.json").data(using: .utf8),
       let memory = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let notes = memory["notes"] as? [[String: Any]] {
      for note in notes {
        for word in Set(words(note["text"] as? String ?? "")) {
          counts[word, default: 0] += 3
        }
      }
    }
    // Words on most pages are site names and boilerplate, not interests.
    let common = max(8, recent.count / 5)
    return counts.filter { $0.value >= 2 && $0.value < common }
  }

  private static let stopwords: Set<String> = [
    "this", "that", "with", "from", "your", "have", "what", "when", "where", "about", "will",
    "news", "home", "page", "login", "sign", "search", "google", "youtube", "official", "site",
    "user", "said", "more", "after", "over", "into", "than", "they", "their", "watch", "video",
  ]

  static func words(_ text: String) -> [String] {
    text.lowercased()
      .components(separatedBy: CharacterSet.letters.inverted)
      .filter { $0.count >= 4 && !stopwords.contains($0) }
  }

  private static func json(_ trend: Trend, reason: String) -> [String: Any] {
    ["title": trend.title, "traffic": trend.traffic, "picture": trend.picture,
     "newsTitle": trend.newsTitle, "newsUrl": trend.newsURL, "source": trend.source,
     "reason": reason]
  }
}

// Google Trends' RSS: <item><title>, <ht:approx_traffic>, <ht:picture>, and
// the first <ht:news_item>.
private final class TrendsParser: NSObject, XMLParserDelegate {
  var items: [HomeFeed.Trend] = []
  private var current: HomeFeed.Trend?
  private var text = ""

  func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?,
              qualifiedName: String?, attributes: [String: String] = [:]) {
    if element == "item" {
      current = HomeFeed.Trend()
    }
    text = ""
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    text += string
  }

  func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?,
              qualifiedName: String?) {
    let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var trend = current else { return }
    switch element {
    case "title": trend.title = value
    case "ht:approx_traffic": trend.traffic = value
    case "ht:picture": trend.picture = value
    case "ht:news_item_title" where trend.newsTitle.isEmpty: trend.newsTitle = value
    case "ht:news_item_url" where trend.newsURL.isEmpty: trend.newsURL = value
    case "ht:news_item_source" where trend.source.isEmpty: trend.source = value
    case "item":
      if !trend.title.isEmpty { items.append(trend) }
      current = nil
      return
    default: break
    }
    current = trend
  }
}

// Search suggestions as the user types, from Google's suggest service (the
// same one Chrome uses).
enum SearchSuggest {
  static func fetch(_ query: String) async -> [String] {
    let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.count >= 2,
          var components = URLComponents(string: "https://suggestqueries.google.com/complete/search")
    else { return [] }
    components.queryItems = [URLQueryItem(name: "client", value: "firefox"),
                             URLQueryItem(name: "q", value: text)]
    guard let url = components.url,
          let (data, _) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 2)),
          let json = try? JSONSerialization.jsonObject(with: data) as? [Any],
          json.count > 1, let list = json[1] as? [String] else { return [] }
    return Array(list.prefix(6))
  }
}
