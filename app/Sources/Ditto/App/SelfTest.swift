import AppKit
import WebKit

// DITTO_SELF_TEST=<report.json> Ditto: checks the built app end to end and
// exits (CI, scripts/smoke-app.sh). Each step's result goes to the report
// as it happens, with a `stage` the CI uses to take screenshots.
@MainActor
struct SelfTest {
  let browser: Browser
  let report: URL
  private static var results: [String: Any] = [:]

  func run() async {
    await pause(2)

    // The new tab page, with its bridge to the app.
    let home = browser.selected
    let homeBridge = try? await home?.webView.evaluateJavaScript("typeof window.__ditto") as? String
    record("home_page_bridge", homeBridge == "object", homeBridge ?? "none")

    // The agent panel, and a round trip to the app.
    browser.toggleAgent()
    await pause(2.5)
    let prompt = try? await browser.agentView.evaluateJavaScript(
      "!!document.querySelector('#prompt')") as? Bool
    record("agent_panel", prompt == true)
    let memory = try? await browser.agentView.callAsyncJavaScript(
      "return (await window.webkit.messageHandlers.ditto.postMessage(" +
      "{method: 'getSystemMemory', args: []})).totalMb",
      arguments: [:], in: nil, contentWorld: .page) as? NSNumber
    record("agent_bridge", (memory?.intValue ?? 0) > 0, "\(memory?.intValue ?? 0) MB")

    // A web page, read and clicked the way the agent does.
    let tab = browser.newTab(URL(string: "https://example.com/")!)
    await settle(tab)
    let control = PageControl(webView: tab.webView)
    let title = try? await control.send("Runtime.evaluate", ["expression": "document.title"])
    let value = (title?["result"] as? [String: Any])?["value"] as? String
    record("page_evaluate", value == "Example Domain", value ?? "none")
    let link = try? await tab.webView.evaluateJavaScript("""
      (() => { const r = document.querySelector('a').getBoundingClientRect();
               return [r.left + r.width / 2, r.top + r.height / 2]; })()
      """) as? [NSNumber]
    if let link, link.count == 2 {
      try? await control.click(x: link[0].doubleValue, y: link[1].doubleValue)
      await pause(1)
      await settle(tab)
    }
    record("trusted_click", tab.url?.host() != "example.com", tab.url?.absoluteString ?? "")
    let shield = try? await tab.webView.evaluateJavaScript(
      "document.documentElement.hasAttribute('data-ditto-shield')") as? Bool
    record("shield_injected", shield == true)

    // The model runtime starts, answers with its key, and stops.
    let started = await ModelRuntime.shared.start(preset: "[*]\nctx-size=4096\n",
                                                  memoryMarginMB: 2048)
    let models = await ModelRuntime.shared.request(.runtime, method: "GET", path: "/models",
                                                   body: "")
    record("runtime", started && models.status == 200, "status \(models.status)")
    ModelRuntime.shared.stop()

    // Screens for review: the agent at work, then the command bar.
    tab.agentInControl = true
    stage("screenshot-agent")
    await pause(4)
    tab.agentInControl = false
    browser.showCommandBar(newTab: true)
    stage("screenshot-command")
    await pause(4)
    browser.hideCommandBar()
    browser.toggleSidebar()
    stage("screenshot-focus")
    await pause(4)

    let passed = Self.results.values.compactMap { ($0 as? [String: Any])?["ok"] as? Bool }
      .allSatisfy { $0 }
    stage(passed ? "passed" : "failed")
    NSApp.terminate(nil)
  }

  private func record(_ name: String, _ ok: Bool, _ detail: String = "") {
    Self.results[name] = ["ok": ok, "detail": detail] as [String: Any]
    write()
  }

  private func stage(_ name: String) {
    Self.results["stage"] = name
    write()
  }

  private func write() {
    if let data = try? JSONSerialization.data(withJSONObject: Self.results,
                                              options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: report, options: .atomic)
    }
  }

  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  private func settle(_ tab: BrowserTab) async {
    var waited = 0
    while waited < 100, tab.isLoading || tab.url == nil {
      await pause(0.1)
      waited += 1
    }
    await pause(0.5)
  }
}
