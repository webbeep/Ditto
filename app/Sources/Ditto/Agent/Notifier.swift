import AppKit
import UserNotifications

// Notifications from Ditto's watches: macOS asks the user once, and
// clicking one opens the watched page in a new tab.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Notifier()

  func post(title: String, body: String, url: String) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    Task {
      let allowed = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
      guard allowed else { return }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      content.userInfo = ["url": url]
      try? await center.add(UNNotificationRequest(identifier: UUID().uuidString,
                                                  content: content, trigger: nil))
    }
  }

  // Shown while Ditto is in front, too.
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                          willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                          didReceive response: UNNotificationResponse) async {
    let link = response.notification.request.content.userInfo["url"] as? String ?? ""
    await MainActor.run {
      guard let url = URL(string: link), ["http", "https"].contains(url.scheme ?? "") else { return }
      Services.shared.front?.newTab(url)
      NSApp.activate()
    }
  }
}
