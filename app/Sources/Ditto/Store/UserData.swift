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

// Chats saved by several windows' panels: each saves the chats it has, and
// the file keeps every chat (the newest version of each) except those
// deleted, so one window never erases another's.
enum ChatMerge {
  static func merge(disk: String, incoming: String, removed: String) -> String {
    func chats(_ json: String) -> [[String: Any]] {
      (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [[String: Any]] ?? []
    }
    func updated(_ chat: [String: Any]) -> Double {
      (chat["updatedAt"] as? NSNumber)?.doubleValue ?? 0
    }
    let gone = Set((try? JSONSerialization.jsonObject(with: Data(removed.utf8))) as? [String] ?? [])
    var byID: [String: [String: Any]] = [:]
    for chat in chats(disk) + chats(incoming) {
      guard let id = chat["id"] as? String, !gone.contains(id) else { continue }
      if let kept = byID[id], updated(kept) > updated(chat) { continue }
      byID[id] = chat
    }
    let newest = byID.values.sorted { updated($0) > updated($1) }.prefix(200)
    guard let data = try? JSONSerialization.data(withJSONObject: Array(newest)) else { return incoming }
    return String(decoding: data, as: UTF8.self)
  }
}
