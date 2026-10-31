import AppKit
import SwiftUI

@main
struct DittoApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    WindowGroup(id: "browser") {
      BrowserWindow(restore: AppDelegate.takeRestore())
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1320, height: 840)
    .commands { DittoCommands() }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private static var restored = false

  // The first window restores the last session; later ones start fresh.
  static func takeRestore() -> Bool {
    defer { restored = true }
    return !restored
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated {
      _ = Services.shared
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    MainActor.assumeIsolated {
      Services.shared.front?.saveSession()
      ModelRuntime.shared.stop()
    }
  }

  // Links opened from other apps (Ditto as the default browser).
  func application(_ application: NSApplication, open urls: [URL]) {
    MainActor.assumeIsolated {
      for url in urls {
        Services.shared.front?.newTab(url)
      }
    }
  }
}

struct DittoCommands: Commands {
  @FocusedObject private var browser: Browser?
  @Environment(\.openWindow) private var openWindow

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("New Tab") { browser?.showCommandBar(newTab: true) }
        .keyboardShortcut("t")
      Button("New Window") { openWindow(id: "browser") }
        .keyboardShortcut("n")
      Button("Open Location…") { browser?.showCommandBar(newTab: false) }
        .keyboardShortcut("l")
      Divider()
      Button("Close Tab") { browser?.closeSelected() }
        .keyboardShortcut("w")
      Button("Reopen Closed Tab") { browser?.reopenClosed() }
        .keyboardShortcut("t", modifiers: [.command, .shift])
    }
    CommandGroup(replacing: .textEditing) {
      Button("Find…") { browser?.findVisible = true }
        .keyboardShortcut("f")
    }
    CommandMenu("Page") {
      Button("Reload") { browser?.selected?.webView.reload() }
        .keyboardShortcut("r")
      Button("Back") { browser?.selected?.webView.goBack() }
        .keyboardShortcut("[")
      Button("Forward") { browser?.selected?.webView.goForward() }
        .keyboardShortcut("]")
      Divider()
      Button("Bookmark This Page") { browser?.bookmarkSelected() }
        .keyboardShortcut("d")
      Divider()
      Button("Zoom In") { browser?.zoom(0.1) }
        .keyboardShortcut("=")
      Button("Zoom Out") { browser?.zoom(-0.1) }
        .keyboardShortcut("-")
      Button("Actual Size") { browser?.zoom(0) }
        .keyboardShortcut("0")
    }
    CommandMenu("Ditto") {
      Button("Ask Ditto") { browser?.toggleAgent() }
        .keyboardShortcut("j")
      Button("Toggle Sidebar") { browser?.toggleSidebar() }
        .keyboardShortcut("s")
      Divider()
      Button("Import from Chrome") {
        let services = Services.shared
        let result = ChromeImport.run(bookmarks: services.bookmarks, history: services.history)
        browser?.show(toast: result.found ?
          "Imported \(result.bookmarks) bookmarks and \(result.history) pages" :
          "No Chrome profile found")
      }
      Button("Show Downloads") { NSWorkspace.shared.open(Paths.downloads) }
        .keyboardShortcut("l", modifiers: [.command, .option])
    }
    CommandGroup(before: .windowList) {
      Button("Next Tab") { browser?.cycle(1) }
        .keyboardShortcut("]", modifiers: [.command, .shift])
      Button("Previous Tab") { browser?.cycle(-1) }
        .keyboardShortcut("[", modifiers: [.command, .shift])
      ForEach(1..<10) { number in
        Button("Tab \(number)") { browser?.select(index: number) }
          .keyboardShortcut(KeyEquivalent(Character(String(number))))
      }
      Divider()
    }
  }
}
