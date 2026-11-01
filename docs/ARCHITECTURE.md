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
| `app/Sources/Ditto/Agent` | `AgentBridge`, `PageControl`, `ModelRuntime`, `Shield`, `MediaWatch`, `Notifier` |
| `app/Sources/Ditto/Store` | History (SQLite), bookmarks, session, chats/memory files, Chrome import, the new tab page's feed and search suggestions (`HomeFeed`) |
| `app/Resources` | `Info.plist`, `shield.js`, `youtube-skip.js`, `media.js`, `ad-rules.json` |
| `web/` | The agent panel and new tab page; `bridges/webkit.ts` (the app) and `bridges/harness.ts` (tests); `build.mjs` |
| `agent/` | The agent (TypeScript): planning, deciding, page driving, memory; tests and the dev harness |

The profile is `~/Library/Application Support/Ditto` (history.sqlite,
bookmarks.json, session.json, chats.json, memory.json, watches.json,
Models/); cookies and
site data are WebKit's default store for the app.

## The agent's link to the app

The pages call `window.webkit.messageHandlers.ditto.postMessage({method,
args})` and get the app's reply as a promise (`WKScriptMessageHandlerWithReply`).
The app calls back with `window.__ditto.<event>.dispatch(...)` (stream
chunks, memory pressure, a detached tab, a hand-off). `AgentBridge` answers
only main-frame messages from `ditto://` pages, and only the app opens those
pages in a tab: a website cannot navigate to them or post to the bridge.

## Ditto's tabs and parallel threads

The agent never drives the user's tab. Each session (a chat id, or
`watch:<id>` for a watch being checked) gets a Ditto tab of its own
(`Browser.attachAgent(start:session:label:)`, made with autoplay off for
all media), opened on the page the user is on when they ask, so "this
page" and the site's signed-in session carry over. Every page command
carries its session (`sendCdp(method, params, session)`), so several
questions run side by side without touching each other's pages; the panel
keeps one run per chat and the model runtime serves them in parallel
(llama-server's slots). The sidebar lists Ditto's tabs; idle ones beyond
three close. The tab of the chat in view (`focusSession`) is shown live:
beside the chat in Browse, in the canvas in Ditto. Tabs the window does not
show wait in it invisibly, since WebKit throttles web views that are off
screen. Closing one tells the panel (`onTabDetached(session)`), which
stops that question. A tab counts as working from the moment it is made,
so a question finishing elsewhere never takes one still loading for idle.

A chat answers one question at a time. One sent while it works waits in
that chat's queue (shown under it as "Next", each removable) and is asked
as a follow-up when the answer is in; Stop drops the queue. Hand-offs
queue in the app (`Browser.handOff`), each becoming a chat of its own; the
same question handed off twice within two seconds (a double click) is
asked once. Chats that live only in the panel so far (working, or waiting)
are kept when another window's save reloads the store. Questions starting
together share one load of a model (`ModelManager.ensureLoaded`).

Every web view is shown by a `WebViewSlot`: the newest slot has it, an
older one (SwiftUI keeps a leaving view through its animation) never takes
it back, and a slot that goes hands it to the newest one left. Before
this, switching layouts could leave the chat's page out of every window:
the chat went blank, and WebKit throttled the page running the questions.

## Follow-ups

A follow-up that asks to redo the last answer (`reworksLast`: put it in a
table, sort, shorten, translate, explain, about nothing the last turn did
not name) is answered by `reworkMessages` from the last answer and its
sources, in one LLM call, with no browsing and no Ditto tab. Otherwise a
follow-up whose naming words (`subjectWords`: not "which", "won", "most",
"table") are all in the last turn is checked against its sources by the
decider; anything else is looked up. The panel renders the markdown small
models write (tables, bold) as elements.

Page text keeps a line per block, and a line that is only a number, an
amount, a short code or a parenthetical joins the line before it: grids
that put each cell in a block (ESPN's scoreboard) read a row per team.

## Your tabs as context, and review before commit

`@` in the chat lists the user's open tabs (`listTabs`); each one picked is
read as the user has it (`readTab`: title, address, selection, main text,
in an isolated script world after waking a sleeping tab). The question
then runs with `RunOptions.from`: `BrowserAgent.answerFrom` answers from
those pages and builds the view (a table to compare), with no Ditto tab
and no browsing. Queued questions keep their tabs.

During a run the agent records what it typed and selected (by the field's
label, latest per field, not search boxes); an `approve` request carries it
as `review`, and the panel lists it in the Approve card.

## The window

A question handed off from a new tab (the home page or the command bar on
one) switches the window to the Ditto layout; from a web page it opens the
chat beside the page. Choosing a tab switches back to Browse. The chat
page's links go through `PanelLinks`, which opens them as tabs (the chat
never navigates). Typing a question on the home page sends `warmUp`: the
panel page is made if needed and loads the models.

A top bar spans the window: the sidebar toggle and navigation on the
left; on the right, always in the same place, the chat toggle (⌘J) and the
Browse/Ditto switch (⇧⌘J). In Browse the page card leads with the chat
beside it; in Ditto the chat (the same panel page, laid out as a centred
column) leads, with `DittoCanvas` beside it: Ditto's working tabs live,
finished ones as rows. Beside the page, the live view of Ditto's tab shows
only while it works. The panel page is told the layout (`getLayout` when it loads,
`onLayout` when it changes) and sets `data-layout` on its root: leading,
it reads as an answer page, each question a heading over its answer.

## Answer views

`agent/src/agent/views.ts`, built while the answer streams (the decider
and the LLM are separate model instances, so they work at once):

1. The layout: clear requests by their words (compare → table, how to →
   steps, best → list); otherwise one decider `choice` among facts, list,
   steps, table and prose.
2. The contents, cheapest first: the page's own structure
   (`browser/structure.ts`: schema.org JSON-LD for products, recipes and
   events; tables; lists outside navigation), then the decider keeping the
   sentences or items that answer the question (one yes/no each, all at
   once). Only a list, steps or a table the page has no structure for goes
   to the LLM, after the answer is written (never competing with it), and
   only values the sources contain are kept. Key facts never come from the
   LLM: without a match, the prose answer stands alone.

After the answer the panel marks the sentence it was read from on the page
(`PageDriver.highlight`) and keeps a small picture of it with the turn.

## First launch

The panel opens on Set up until the models the chosen mode needs are on
disk: `getDevice` gives the chip, memory and free disk;
`recommendForDevice` picks the pair (bigger on 16 GB+ Apple silicon, the
smallest on Intel, where the models run on the CPU, or when the disk is
short). `ModelManager.ensureLoaded` refuses a model that is not on disk
(loading it would make the router download it), so downloads happen only
from Set up or Models.

## Chats and memory across windows

Each window has its own panel page. Chat saves go through the app, which
merges them into `chats.json` by chat (the newest version of each, minus
deleted ones) instead of overwriting; a save tells the other panels
(`onStoreChanged`) to read chats or memory again.

## Watches

A request like "tell me when the price drops below $40" becomes a watch
(`agent/src/agent/watch.ts`): the LLM turns it into a question to read off
the page and a condition, the interval comes from the request (hourly by
default, never more often than every 15 minutes), and the first reading is
taken at once. The app keeps the schedule: every minute `Services` asks the
first window's panel page (`onCheckWatches`), which, when the panel is
closed, waits in the window invisibly so WebKit does not throttle it. Due
watches are read in Ditto's tab; a reading is news when the condition
starts to hold (amounts like "below $40" are compared in code; anything
else is a yes/no for the models) or, with no condition, when its amounts
or facts change. News goes to `Notifier` (a macOS notification that opens
the page). Watches are saved in `watches.json`; a question from the user
stops a check in progress.

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
usual sites (never search engines); after a request the LLM may add notes
(never secrets). Only the notes reach the models, never the sites: LFM3
1.7B handed "Sites the user often uses: youtube.com" planned "…,
considering the user often uses youtube.com" and answered "The user often
uses google.com…". The planner may use notes only to fill in what a
request leaves open, and a goal about the user for a request that is not
is dropped for the request's words (`cleanGoal` also strips such clauses
and "find information about …" phrasing). The answer sees notes marked as
tailoring, not a source; an answer about the user when the question is not
(`aboutUserInstead`) is written again without them.

Matching a page to a question (`namesAll`, `coverage`) forgives one typo in
a word of five letters or more (`hasToken`: "scires" is "scores"); short
words and words with digits ("Pro", "S24") must match exactly. A request
for a list (`isCollectionRequest`: scores, results, headlines, a forecast,
also as the page spells the request: `spelledAs`) is answered by the page
that shows it for what was asked about, without the single quoted sentence
a fact needs: when the decider says so, or the page's title and headings
name the request (a small decider rated "League scores" 0.2 for "acme
leage scires"). A search results page (an engine's, or a site's own
`/search?q=`) counts only when the decider is sure, and is never cited
beside the pages it led to.
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
