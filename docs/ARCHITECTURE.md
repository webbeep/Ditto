# Architecture

```
┌──────────────────────────── Ditto.app (browser process) ────────────────────────────┐
│                                                                                     │
│  chrome://ditto-agent (WebUI, TypeScript)          InferenceSupervisor (C++)        │
│  ┌────────────────────────────────────┐   Mojo     ┌──────────────────────────────┐ │
│  │ BrowserAgent  (agent/src/agent)    │──────────▶ │ starts llama-server lazily    │ │
│  │  ├ DeciderClient  /v1/systemone    │  Fetch     │ random loopback port + key    │ │
│  │  ├ LlmClient      /v1/chat/...     │  FetchStr. │ memory pressure → observers   │ │
│  │  ├ ModelManager   /models*         │            │ idle 10 min → stop            │ │
│  │  └ PageDriver ──── CDP ────────────│──────────▶ │ CdpRelay: allow-listed CDP    │ │
│  └────────────────────────────────────┘  SendCdp   │ on the active http(s) tab     │ │
│                                                    └───────────────┬──────────────┘ │
└────────────────────────────────────────────────────────────────────┼────────────────┘
                                                                     │ HTTP, Bearer key
                                       ┌─────────────────────────────▼─────────────────┐
                                       │ llama-server b11960 (v0.8.0), router mode     │
                                       │  ├ responder instance (LFM3 / Qwen3.5)        │
                                       │  └ decider instance   (d1)                    │
                                       │ models in <profile>/Ditto Models (LLAMA_CACHE)│
                                       └───────────────────────────────────────────────┘
                                       optional: strands-decider sidecar (:8737)
```

## One agent step

1. `PageDriver.snapshot()` runs `collectSnapshot` in the page. It returns
   visible interactive elements, each tagged with a stable `data-ditto-id`,
   plus the headings and the main text.
2. `buildCandidates()` drops already-visited links, ranks the rest against
   the goal, and keeps the top 24, plus *scroll down* and *go back*. Text
   boxes are offered only when there is a query to type.
3. **One decider call** asks three questions over the same state (URL, title,
   headings and the passages closest to the goal):
   `done` (yes/no), `relevant` (yes/no) and `next` (a choice over the
   candidates). A d1 model answers all three in one forward pass with
   probabilities.
4. `done ≥ 0.7` → stop. If the decider's `next` confidence is below 0.35,
   hybrid mode asks the LLM to pick from the same options, using a JSON
   schema constrained to those option keys.
5. The chosen action runs as trusted input (`Input.dispatchMouseEvent`,
   `Input.insertText`). The driver then waits until the document is
   complete and the URL has stopped changing.

When the loop ends, pages the decider rated relevant become sources. The
responder streams an answer that cites them. In decider-only mode, a final
choice question picks the best passage instead.

## Memory

| Layer | Mechanism |
| --- | --- |
| Tabs | Memory Saver on by default (patch 0003): inactive tabs are discarded. |
| Model budget | `recommendForMemory()`: min(RAM/2, RAM−5 GB) for all loaded models. `ModelManager.ensureLoaded()` evicts responders before deciders, least recently used first. |
| Router | `--models-max 2`, `--models-memory-margin 2048`, `--sleep-idle-seconds 300`: idle models release their weights; LRU unload when a new one does not fit. |
| Pressure | `InferenceSupervisor` listens to `base::MemoryPressureListener`. With the agent UI open: moderate pressure unloads the responder, critical unloads everything. With no UI open: critical pressure stops the runtime. |
| Idle | No agent UI for 10 minutes → runtime process stopped (0 bytes). Mode *Off* → never started. |
| Crash safety | `runtime.pid`: a runtime left behind by a crashed browser is killed on next start. |

## Security model

- The runtime binds `127.0.0.1` on a random port and requires a per-launch
  random API key. The key lives only in the browser process; the WebUI calls
  through Mojo and never sees it. Web pages cannot use the models.
- `CdpRelay` attaches as an untrusted DevTools client. It cannot attach to
  WebUI or `file:` pages, read or write files, or use unsafe operations. It
  allows only eight CDP methods, and `Page.navigate` only to http(s).
  Prompt-injected page text cannot make the agent read cookies, open other
  tabs' targets or reach the filesystem.
- The strands sidecar endpoint is accepted only on loopback, so page text
  never leaves the Mac.

## The full build: Ditto inside Chromium

The agent is part of the browser, not an extension:

- **Agent panel**: `chrome://ditto-agent.top-chrome`, a native side panel
  entry (`SidePanelEntryId::kDittoAgent`) on the right (vertical tabs own
  the left), with a pinned toolbar button. Its page handler starts the model
  runtime, relays CDP to the active tab, and stores chats in the profile
  (`<profile>/Ditto/chats.json`).
- **Home**: `chrome://ditto-agent`, the new tab page for every search
  engine: one command bar (addresses open, anything else goes to the agent
  in the panel) and recent chats.
- **Hand-off**: the home page calls `ShowAgentPanel(query, chat)`; the
  browser opens the panel in that window and the panel takes the hand-off
  (`TakeHandOff`, `Page.OnHandOff`).

| Patch | Change |
| --- | --- |
| 0001 | Branding: name, bundle id `app.ditto.browser` |
| 0002 | Vertical tabs on by default |
| 0003 | Memory Saver on by default |
| 0004 | Default switches: Gemini (Glic) and Lens overlay off |
| 0005 | Compile `//ditto` sources into `//chrome/browser/ui` |
| 0006 | Register `chrome://ditto-agent` and `chrome://ditto-agent.top-chrome` |
| 0007 | Memory pressure listener tag for the runtime supervisor |
| 0008 | Mojo binder for both pages |
| 0009 | Profile directory `~/Library/Application Support/Ditto` |
| 0010 | Side panel entry and action ids for the agent |
| 0011 | The agent's toolbar action |
| 0012 | Register the agent panel in every window |
| 0013 | Ditto home is the new tab page |
| 0014 | Agent button pinned by default (replaces Chrome Labs) |
| 0015 | Ditto's strings (`chrome/app/ditto_strings.grdp`) |
| 0016 | Ditto's palette (`ditto/browser/ui/color`) after Chromium's colour mixers |
| 0017 | Toolbar: back button only, contextual-tasks button unpinned |
| 0018 | The agent pages' resources in `resources.pak` |

GN args also leave out PDF save to Drive, Remote Desktop, the Meet helper,
media remoting, the Reporting API uploads and LAN discovery (Compose is off
by feature)
(`scripts/probe-args.sh` drops any a Chromium version asserts on).

### Design

`ditto_color_mixer.cc` is the last mixer before installed themes. It sets
the Material system tokens (so every derived colour follows) and the
browser-specific ones: frame, toolbar and tab strip share the *shell*
colour; the active tab and the side panel body use the *page* colour;
separators, tab strokes and dividers are transparent. Light and dark use
the same zinc tokens as the agent pages. A theme the user installs, and
high-contrast mode, still take over. The app icon is `branding/`.

## The agent loop

- One decider call per step answers done / relevant / next action.
- Steps the decider is unsure about go to the LLM, which sees the page, the
  path so far and the last failure.
- Model calls retry transient runtime errors (backoff 0.3 s, 0.9 s); an
  invalid LLM reply is sent back once with what was wrong.
- A failed action is reported on the next step and not offered again; three
  failures in a row end the run.
- The LLM phrases goal and query while the agent already reads the page.
- Follow-ups carry earlier turns (about 1.5K tokens); one the last sources
  already answer is answered without browsing.
- While in control, the page shows a frame, a cursor moving to each target
  and a status pill (`src/browser/overlay.ts`), removed afterwards.
- Models load on the first keystroke, stay warm while the user is active
  (`src/models/warmer.ts`), and reuse the prompt cache.
