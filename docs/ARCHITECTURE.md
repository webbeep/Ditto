# Architecture

```
┌───────────────────────────── Ditto.app (Swift, SwiftUI) ─────────────────────────────┐
│                                                                                       │
│  Window: Sidebar · ContentCard (tab's WKWebView) · AgentPanel · CommandBar            │
│                                                                                       │
│  Agent panel (ditto://app/ditto_agent.html, web/ + agent/src, TypeScript)             │
│  ┌──────────────────────────────────┐  script messages  ┌───────────────────────────┐ │
│  │ BrowserAgent                     │─────────────────▶ │ AgentBridge (ditto:// only)│ │
│  │  ├ DeciderClient  /v1/systemone  │  fetch, stream    │  ModelRuntime: llama-server│ │
│  │  ├ LlmClient      /v1/chat/...   │                   │   random port + key, idle  │ │
│  │  ├ ModelManager   /models*       │                   │   and pressure shutdown    │ │
│  │  ├ MemoryStore (notes)           │  memory, chats    │  UserData (profile files)  │ │
│  │  └ PageDriver ── page commands ──│─────────────────▶ │  PageControl: 6 commands,  │ │
│  └──────────────────────────────────┘  sendCdp          │   real AppKit input        │ │
│                                                         └─────────────┬─────────────┘ │
│  Every tab: Shield (content blocker, shield.js, youtube-skip.js)      │               │
└───────────────────────────────────────────────────────────────────────┼───────────────┘
                                                                        │ HTTP, Bearer key
                                        ┌───────────────────────────────▼───────────────┐
                                        │ llama-server b11960 (v0.8.0), router mode     │
                                        │  ├ responder (LFM3 / Qwen3.5)                 │
                                        │  └ decider   (d1)                             │
                                        │ models in ~/Library/Application Support/      │
                                        │   Ditto/Models (LLAMA_CACHE)                  │
                                        └───────────────────────────────────────────────┘
```

## Layout

| Path | What |
| --- | --- |
| `app/Sources/Ditto/App` | App entry, menus and shortcuts, shared WebKit setup (`Services`), `ditto://` pages (`SchemeHandler`), theme, self-test |
| `app/Sources/Ditto/Browser` | `Browser` (a window: tabs, panel, command bar, hand-offs) and `BrowserTab` (a web view: navigation, popups, dialogs, downloads, history) |
| `app/Sources/Ditto/Views` | The SwiftUI window: sidebar, page card, command bar, agent panel |
| `app/Sources/Ditto/Agent` | `AgentBridge`, `PageControl`, `ModelRuntime`, `Shield` |
| `app/Sources/Ditto/Store` | History (SQLite), bookmarks, session, chats/memory files, Chrome import, the new tab page's feed and search suggestions (`HomeFeed`) |
| `app/Resources` | `Info.plist`, `shield.js`, `youtube-skip.js`, `media.js`, `ad-rules.json` |
| `web/` | The agent panel and new tab page; `bridges/webkit.ts` (the app) and `bridges/harness.ts` (tests); `build.mjs` |
| `agent/` | The agent (TypeScript): planning, deciding, page driving, memory; tests and the dev harness |

The profile is `~/Library/Application Support/Ditto` (history.sqlite,
bookmarks.json, session.json, chats.json, memory.json, Models/); cookies and
site data are WebKit's default store for the app.

## The agent's link to the app

The pages call `window.webkit.messageHandlers.ditto.postMessage({method,
args})` and get the app's reply as a promise (`WKScriptMessageHandlerWithReply`).
The app calls back with `window.__ditto.<event>.dispatch(...)` (stream
chunks, memory pressure, a detached tab, a hand-off). `AgentBridge` answers
only main-frame messages from `ditto://` pages, and only the app opens those
pages in a tab: a website cannot navigate to them or post to the bridge.

## Ditto's tab

The agent never drives the user's tab. `Browser.attachAgent()` gives it a
tab of its own (made with autoplay off for all media), opened on the page
the user is on when they ask, so "this page" and the site's signed-in
session carry over. The sidebar lists it above the user's tabs; the panel
shows it live (`ScaledWebViewHost` draws it at desktop width and scales it
down; AppKit maps the agent's clicks through the same scaling); when
neither shows it, it waits in the window invisibly, since WebKit throttles
web views that are off screen. Closing it tells the panel, which stops.

## Tabs, sound and memory

`BrowserTab.sleep()` keeps the tab's `interactionState` (back-forward list,
scroll position) and swaps in an empty web view; the old page and its web
content process go. `wake()` restores it. `Browser` sleeps tabs not looked
at for 20 minutes, and every background tab on a memory-pressure warning;
never the selected tab, Ditto's tab, or a tab playing sound. `media.js`
(isolated world) tells the app which tabs play sound and mutes on request.

## The new tab page

`HomeFeed` builds it on the Mac: top sites from history (visit counts per
site), Google Trends' daily RSS for the user's region (cached for 30
minutes), and "for you": the trends whose words match words that recur in
the user's last 30 days of page titles and in Ditto's notes (very common
words are left out). Only the region goes out, in the feed's URL. Search
suggestions come from Google's suggest endpoint as the user types (after a
short pause; never for addresses).

## One agent step

1. `PageDriver.snapshot()` runs `collectSnapshot` in the page (through
   `Runtime.evaluate`, which `PageControl` runs with
   `callAsyncJavaScript` in the page's world). It returns visible
   interactive elements with stable ids, headings and the main text, with
   ads marked and left out of the text.
2. `buildCandidates()` ranks links and fields against the goal (never ads,
   never password or card fields).
3. One decider call asks *done?*, *relevant?* and *which next?*; unsure
   steps go to the LLM.
4. The action runs as real input: `PageControl` turns
   `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` into AppKit
   events sent through the window. Before a click the driver checks what
   the point would hit and steps around invisible layers; after it, a
   landing on an ad network or an unnamed site is undone.
5. Actions that commit the user wait for Approve; sign-in and payment
   fields are handed to the user.

Requests about the open page ("tl;dr this video") read it instead:
YouTube's caption track or transcript panel, a page's captions track, else
the page; long texts in parts.

## Memory and context

`MemoryStore` (`agent/src/memory/memory.ts`, saved by the app as
memory.json) gives each request the notes that bear on it and the user's
usual sites; after a request the LLM may add notes (never secrets).
`searchUserPages` (bookmarks, then history) gives the planner the user's own
pages to start from, by number; it never writes a URL.

## Memory use

| Layer | Mechanism |
| --- | --- |
| Pages | WebKit's process model; tabs sleep after 20 idle minutes or on pressure (see above); restored tabs load when shown. |
| Model budget | `recommendForMemory()`: min(RAM/2, RAM−5 GB) for all loaded models; `ModelManager.ensureLoaded()` evicts responders before deciders. |
| Router | `--models-max 2`, `--models-memory-margin`, `--sleep-idle-seconds 300`. |
| Pressure | `ModelRuntime` listens to the system's memory-pressure source: the panel unloads the responder on a warning, everything on critical; with no panel open, critical pressure stops the runtime. |
| Idle | No requests for 10 minutes and no panel open: the runtime process stops. *Off* never starts it. |

## The shield

`Shield.install` adds to the shared `WKUserContentController`: the
`ad-rules.json` content blocker (ad networks' requests, third-party loads),
and two scripts in an isolated world: `shield.js` (hides ad slots by ad
networks' markers; sends a click caught by an invisible layer to what is
under it) and `youtube-skip.js` (reports YouTube's Skip button once it is
offered; `SkipHandler` clicks it with real input).
