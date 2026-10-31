# Ditto

A fast, minimal browser for macOS, built on Chromium, with a private browsing
agent that runs **entirely on your Mac**. Small open-weight models read
pages, navigate for you and answer with sources. Nothing leaves your Mac,
and you can turn every model off.

## Download

| Platform | Download |
| --- | --- |
| macOS, Apple silicon (M1 and later) | [**Ditto-mac-arm64.dmg**](https://github.com/webbeep/Ditto/releases/latest/download/Ditto-mac-arm64.dmg) |
| macOS, Intel | [**Ditto-mac-x64.dmg**](https://github.com/webbeep/Ditto/releases/latest/download/Ditto-mac-x64.dmg) |
| iPhone / iPad | Not yet available (see [iOS](#ios)) |

All releases: <https://github.com/webbeep/Ditto/releases>.

Open the DMG and drag **Ditto** to **Applications**. Ditto is not yet
signed with an Apple Developer ID, so macOS refuses to open it ("Apple could
not verify…" or "…is damaged"). Allow it once by pasting this into
**Terminal**:

```sh
xattr -dr com.apple.quarantine /Applications/Ditto.app && open /Applications/Ditto.app
```

After that it opens normally. (Or: try to open it, then click **Open
Anyway** in *System Settings → Privacy & Security* within a few minutes.)
Requires macOS 13 or later.

> **How the download is built.** [`native-release`](.github/workflows/native-release.yml)
> compiles Chromium with Ditto's patches on GitHub's macOS runners (a chain
> of ~5-hour jobs; a full build takes 15+ hours), bundles the llama.cpp
> runtime, smoke-tests the app and publishes the DMG. The agent is part of
> the browser (`chrome://ditto-agent`), not an extension. Intel Macs: the
> `mac-x64` build of the same workflow, published to the same release.
> Releases before v0.3.0 were extension-based previews; that code is gone.
>
> This repository is private: the links work only for GitHub accounts with
> access to it.

## What's in it

- **Chrome's engine and speed.** Chromium 156 (`chromium/VERSION`), built as
  an official build with ThinLTO and profile-guided optimization, like Google
  Chrome.
- **Its own design.** Ditto's palette is built into Chromium's colour
  pipeline (`ditto/browser/ui/color`), so tabs, toolbar, address bar, menus,
  dialogs and settings share one neutral look in light and dark: the frame,
  toolbar and tab strip are one surface around the page, with no
  separators. Vertical tabs on the left, the agent on the right, back button
  only. Chrome's history, bookmarks, passwords and profiles stay.
- **RAM-aware.** Memory Saver is on by default, so background tabs are
  discarded. Model memory has a budget (half your RAM, and always at least
  5 GB left for macOS). Under memory pressure the responder model is unloaded
  first, and models nobody is using are stopped.
- **Stripped to a browser and an agent.** Kept: Google sign-in, bookmarks,
  history, passwords, autofill, printing, PDF. Removed at build time:
  Remote Desktop, the Meet helper, Family Link, WebXR, LAN and Cast device
  discovery, Reporting API uploads, Google's on-device Gemini, OS-level
  promos (`chromium/args/common.gn`). Off by default: Gemini (Glic), Lens,
  Compose, AI tab organization and history search, contextual tasks,
  shopping, Cast, What's New and the ad APIs (Topics, FLEDGE)
  (`ditto/app/ditto_switches.h`).
- **Move from Chrome in one click.** The new tab page offers *Import from
  Chrome*: Ditto reads your last-used Chrome profile and copies its
  bookmarks bar and other bookmarks, then offers to sign in to the same
  Google account. Passwords move with Chrome's CSV export
  (`chrome://password-manager/settings` → Import).
- **Shield, in every tab:** hides ad slots ad networks mark as such, and a
  click that an invisible layer over the page would catch (a common trick
  to open an ad) goes to what you saw under it. YouTube ads are skipped as
  soon as YouTube offers *Skip* (real mouse input, like pressing it
  yourself; ads that cannot be skipped play as usual).
- **A local agent** in `chrome://ditto-agent` (below).

### Google account, history and bookmarks

History, bookmarks, passwords, autofill and profiles all work as in Chrome
and are stored locally in `~/Library/Application Support/Ditto`. Signing in
to Google **websites** (Gmail, YouTube, Drive) works normally.

**Chrome Sync and browser-level Google sign-in do not work.** Since March
2021, Google lets only Google Chrome use them, and no Chromium-based browser
(Brave, Arc, Vivaldi, Ditto) can. To bring your bookmarks over, export them
from Chrome's Bookmark Manager and import the file in *Settings → Import
bookmarks and settings*. Direct import of Chrome history is on the roadmap.
See [docs/GOOGLE_ACCOUNT.md](docs/GOOGLE_ACCOUNT.md).

## The local agent

Two kinds of model, each doing what it is good at:

| Role | Job | Models (Hugging Face) |
| --- | --- | --- |
| **Decider** | Every navigation step, in one forward pass with calibrated probabilities: *is the goal reached? is this page relevant? which link or field next?* | LiquidAI **d1** (`d1-omni-600M`, `d1-2B`, `d1-Omni-2B`), Amazon **strands-decider** (`2B-qwen3.5`, `E2B-gemma4`) |
| **Responder** | Plans the task, takes over steps the decider is unsure about, and writes the answer from page text, with citations | LiquidAI **LFM3** (`1.7B`, `Omni-2B`), **Qwen3.5** (`2B`, `4B`, `9B`), LFM2.5 `8B-A1B` |

- **Starts small:** 8 GB Macs get LFM3 1.7B and d1 Omni 600M (about 2.4 GB
  of RAM together); 16 GB+ Macs get Qwen3.5 4B and d1 2B.
- **Swap any time:** the *Models* panel downloads, pauses, loads, unloads and
  deletes models. Downloads come straight from Hugging Face to your Mac.
- **Modes:** *Hybrid* (default), *Decider only* (fastest; answers are quoted
  passages), *LLM only*, or *Off*. *Off* (or **Disable all models**) stops
  the model runtime completely, so it uses no memory.
- **Reads what you have open:** "tl;dr", "summarize this video" or "what is
  this page about" works on the open tab instead of searching. For videos it
  reads the transcript (YouTube's captions or transcript panel, or the
  page's captions track); long ones are read in parts.
- **Does not fall for ads:** ads are hidden from the models, an invisible
  layer over a page cannot catch the agent's clicks, and a link that a
  script redirects to an ad is undone and skipped. The panel shows each of
  these with a shield.
- **Knows you, locally:** the agent keeps notes about you (preferences,
  places, habits) learned from your chats or told ("remember that I prefer
  metric units"), plus the sites your tasks end on. Plans and answers use
  them. *Memory* in the panel lists every note; forget one, all, or turn
  learning off. Notes stay in your profile (`Ditto/memory.json`).
- **Uses your bookmarks and history:** for "reorder from my usual store" or
  "that article I read", the planner can start on one of your own pages.
  It can only pick from your bookmarks and history; it never makes up an
  address.
- **Does tasks in your signed-in browser, with you in charge:** it works in
  your real tabs with your existing sessions. It never types passwords or
  card details: when a page needs them it hands you the tab ("Sign in,
  then continue"), and your saved logins and cards fill as usual. Anything
  that commits you (buying, paying, sending, subscribing, deleting) waits
  for **Approve**; without it nothing is submitted.
- **Private and contained:** the runtime listens only on a random loopback
  port and needs a per-launch key held by the browser. The agent can use only
  a fixed set of DevTools commands on http(s) pages. It cannot reach
  `chrome://` pages, local files, cookies or other tabs.

Under the hood, one bundled [llama.cpp](https://github.com/ggml-org/llama.cpp)
`llama-server` (v0.8.0, Metal) runs in router mode. It serves the LLMs over
the OpenAI chat API and the d1 deciders over `/v1/systemone`. Strands
deciders run in the optional
[strands-decider](https://github.com/strands-labs/strands-decider) sidecar
(`scripts/install-strands-decider.sh`), which serves the same `/v1/systemone`
API.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## iOS

Apple requires every iOS browser to use WebKit, so Chromium for iOS is a
different app (`ios/chrome`) on top of WKWebView. `chromium/args/ios-arm64.gn`
and `scripts/fetch.sh --ios` set up that build. iPhone and iPad apps can only
be distributed through the App Store or TestFlight, not as a direct
download. The local agent is not yet ported to iOS.

## Build from source

You need a Mac with Xcode, about 100 GB of free disk, and several hours for
the first build.

```sh
scripts/fetch.sh                 # Chromium 156, shallow, macOS-only deps, test data pruned
scripts/build.sh mac-arm64       # sync overlay, apply patches, gn gen, autoninja, build runtime
scripts/package-mac.sh mac-arm64 # bundle runtime, sign, DMG (+ notarize if configured)
```

How the repository maps onto Chromium:

```
chromium/VERSION        pinned Chromium release
chromium/args/          GN args (common + per platform), checked against that release
chromium/patches/       small patches to Chromium (branding, defaults, hooks)
chromium/overlay/ditto/ copied to src/ditto: inference supervisor, CDP relay, agent WebUI
chromium/prune.list     test data deleted after fetch
agent/                  the agent runtime (TypeScript), shared with the WebUI and tested here
scripts/                fetch / patch / build / package
tools/                  patch check without a checkout; WebUI typecheck
```

Ditto does not copy Chromium's source into this repository. The checkout is
around 30 GB. Ditto keeps a pinned version, GN args and a short list of
patches, as Brave and ungoogled-chromium do, so it can move to new Chromium
releases (and their security fixes) quickly. See
[docs/CHROMIUM_UPGRADES.md](docs/CHROMIUM_UPGRADES.md).

### Agent development (no Chromium needed)

```sh
cd agent
npm install
npm test                               # unit, agent and WebUI end-to-end tests in headless Chromium
npm run demo -- --mock "What is the price of the Acme Widget Pro?"
# Against real models: start llama-server v0.8.0+ in router mode, then
node dist/dev/cli.js --runtime http://127.0.0.1:8080 --start https://example.com "…"
```

## What is verified, and what is not yet

- **Verified:** 65 automated tests (`cd agent && npm test`), all in a real
  headless Chromium:
  - The agent in all three modes, against a mock runtime that speaks
    llama-server's router, chat and `/v1/systemone` APIs.
  - Recovery from a dead start URL and from a broken link.
  - The real `chrome://ditto-agent` page (HTML, CSS, `app.ts`), compiled as
    shipped. A harness stands in for the C++ page handler and enforces the
    same DevTools allow-list. The tests cover model download and swap, a
    chat task driving a second tab to a cited answer, memory-pressure
    unloading, and *Disable all models*.

  The page driver has also been run against live sites (Wikipedia, Bing).
  All patches apply to Chromium 156.0.8078.80 (`tools/check-patches.sh`, run
  in CI), and every GN arg exists in that release.
- **Verified against the real Chromium 156 tree** on GitHub's Mac runners
  ([`verify-native`](.github/workflows/verify-native.yml)): every patch
  applies, `gn gen` and `gn check` pass, and Ditto's colour mixer and every
  Chromium file the patches change compile.
- **Not yet:** a complete compiled browser has not been released; the
  first [`native-release`](.github/workflows/native-release.yml) run is the
  first full build, so expect build fixes. Larger models (Qwen3.5, d1 2B) and the strands
  deciders have not been run yet. Releases are not yet signed with an Apple
  Developer ID or notarized.

## Roadmap

- Host the agent in the side panel (it is a `chrome://` page today).
- Import history and passwords directly from a local Chrome profile.
- Optional end-to-end-encrypted sync between Ditto installs.
- Screenshot input to the decider for pages that are mostly images (d1 2B
  and LFM3 Omni accept images).
- Port the agent to iOS.

## License

Ditto's own code is BSD-3-Clause, like Chromium. Chromium and llama.cpp keep
their licenses. Models have their own licenses (LFM Open License v1.0,
Apache-2.0, Gemma terms), shown in the Models panel before download.
