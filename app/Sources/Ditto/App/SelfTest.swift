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
    stage("screenshot-home")
    await pause(3.5)

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
      (() => { const a = document.querySelector('a[href]');
               a.scrollIntoView({block: 'center'});
               const r = a.getBoundingClientRect();
               return [r.left + r.width / 2, r.top + r.height / 2]; })()
      """) as? [NSNumber]
    // Count what reaches the page, so a failure says where it stopped.
    _ = try? await tab.webView.evaluateJavaScript("""
      window.__clicks = [];
      document.addEventListener('click', e => {
        window.__clicks.push(e.isTrusted);
        e.preventDefault();
      }, true);
      true
      """)
    var arrived = "no link"
    if let link, link.count == 2 {
      await pause(0.3)
      try? await control.click(x: link[0].doubleValue, y: link[1].doubleValue)
      await pause(0.5)
      arrived = (try? await tab.webView.evaluateJavaScript("JSON.stringify(window.__clicks)")
        as? String) ?? "unknown"
    }
    let key = tab.webView.window?.isKeyWindow == true
    record("trusted_click", arrived == "[true]",
           "clicks \(arrived) at \(link?.map(\.doubleValue) ?? []), key window \(key)")
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

    // The agent on a task, in its own tab, while the user's tab stays in
    // front (scripts/smoke-app.sh runs the mock runtime and the test site).
    let env = ProcessInfo.processInfo.environment
    if let runtime = env["DITTO_TEST_RUNTIME"].flatMap(URL.init(string:)),
       let site = env["DITTO_TEST_SITE"].flatMap(URL.init(string:)) {
      await agentTask(runtime: runtime, key: env["DITTO_TEST_RUNTIME_KEY"] ?? "", site: site,
                      previous: tab)
    } else {
      tab.agentInControl = true
      stage("screenshot-agent")
      await pause(4)
      tab.agentInControl = false
    }

    // Closing every tab leaves the window, with a new tab.
    for open in browser.userTabs {
      browser.close(open)
    }
    await pause(0.5)
    record("last_tab_keeps_window",
           browser.userTabs.count == 1 && browser.window?.isVisible == true,
           "\(browser.userTabs.count) tabs")

    // Screens for review: the command bar, then the page alone.
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

  private func agentTask(runtime: URL, key: String, site: URL, previous: BrowserTab) async {
    ModelRuntime.shared.useExternal(runtime, key: key)
    let page = browser.newTab(site)
    await settle(page)
    browser.handOff(query: "What is the price of the Acme Widget Pro?", chatID: "")
    var sawWorking = false
    var answer = ""
    for _ in 0..<900 {
      await pause(0.1)
      if browser.agentWorking && !sawWorking {
        sawWorking = true
        await pause(1)
        stage("screenshot-working")
      }
      answer = (try? await browser.agentView.evaluateJavaScript("""
        (() => {
          const text = [...document.querySelectorAll('.reply .text')].pop();
          return document.querySelector('[aria-label="Send"]') && text ? text.textContent : '';
        })()
        """) as? String) ?? ""
      if !answer.isEmpty {
        break
      }
    }
    record("agent_task", answer.contains("$49"), String(answer.prefix(160)))
    let agentPage = browser.agentTab?.url?.lastPathComponent ?? "none"
    record("agent_own_tab",
           sawWorking && browser.selected?.id == page.id && agentPage == "widget-pro.html",
           "worked \(sawWorking), ended on \(agentPage), " +
           "user's tab in front \(browser.selected?.id == page.id)")
    stage("screenshot-answer")
    await pause(4)
    browser.showAgentTab()
    stage("screenshot-agent-tab")
    await pause(4)

    // A watch, set up from a question on the product's page, is saved for
    // the app's schedule.
    browser.select(page)
    page.load(site.appendingPathComponent("widget-pro.html"))
    await settle(page)
    browser.handOff(query: "Tell me when the price drops below $40", chatID: "")
    var watching = ""
    for _ in 0..<900 where !watching.hasPrefix("Watching") {
      await pause(0.1)
      watching = (try? await browser.agentView.evaluateJavaScript(
        "[...document.querySelectorAll('.reply .text')].pop()?.textContent ?? ''") as? String) ?? ""
    }
    let saved = UserData.read("watches.json")
    record("watch_created", watching.hasPrefix("Watching") && saved.contains("widget-pro.html"),
           String(watching.prefix(160)))

    // Two questions at once: each in a chat and a Ditto tab of its own,
    // side by side, each with its own answer.
    browser.handOff(query: "What is the price of the Acme Widget Pro?", chatID: "")
    browser.handOff(query: "How much does the Acme Widget Mini cost?", chatID: "")
    var together = false
    for _ in 0..<1200 {
      await pause(0.1)
      together = together || browser.workingSessions.count >= 2
      if together && browser.workingSessions.isEmpty {
        break
      }
    }
    await pause(1)
    let chats = (try? JSONSerialization.jsonObject(with: Data(UserData.read("chats.json").utf8)))
      as? [[String: Any]] ?? []
    let answers = chats.compactMap { ($0["turns"] as? [[String: Any]])?.last?["answer"] as? String }
    let mini = answers.contains { $0.contains("$19") }
    let pros = answers.filter { $0.contains("$49") }.count
    record("parallel_threads", together && mini && pros >= 2 && browser.agentTabList.count >= 2,
           "both at once \(together), Mini answered \(mini), Pro answered \(pros)x, " +
           "Ditto tabs \(browser.agentTabList.count)")

    // The Ditto layout: the chat leads, Ditto's tabs beside it.
    browser.setLayout(.ditto)
    stage("screenshot-ditto")
    await pause(4)
    browser.setLayout(.browse)

    // A tab put to sleep drops its page and comes back where it was.
    previous.sleep()
    let slept = previous.isAsleep
    browser.select(previous)
    await pause(0.5)
    await settle(previous)
    let back = try? await previous.webView.evaluateJavaScript("document.title") as? String
    record("tab_sleep", slept && !previous.isAsleep && back == "Example Domain",
           "slept \(slept), back on \(back ?? "nothing")")
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
