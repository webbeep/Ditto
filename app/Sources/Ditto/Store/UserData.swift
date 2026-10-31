import Foundation

// The agent's chats and its notes about the user, as the agent pages write
// them (chats.json, memory.json in the profile).
enum UserData {
  static func read(_ name: String) -> String {
    (try? String(contentsOf: Paths.file(name), encoding: .utf8)) ?? ""
  }

  static func write(_ name: String, _ text: String) {
    try? text.write(to: Paths.file(name), atomically: true, encoding: .utf8)
  }
}

// Open tabs, restored on the next launch.
enum SessionStore {
  static func load() -> [String] {
    guard let data = try? Data(contentsOf: Paths.file("session.json")),
          let urls = try? JSONDecoder().decode([String].self, from: data) else { return [] }
    return urls
  }

  static func save(_ urls: [String]) {
    if let data = try? JSONEncoder().encode(urls) {
      try? data.write(to: Paths.file("session.json"), options: .atomic)
    }
  }
}
