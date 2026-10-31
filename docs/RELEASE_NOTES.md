## Install

1. Download **Ditto-mac-arm64.dmg** (Apple silicon) or **Ditto-mac-x64.dmg**
   (Intel), open it and drag **Ditto** to **Applications**. macOS 14 or
   later.
2. Ditto is not yet signed with an Apple Developer ID, so macOS refuses to
   open it the first time. Allow it once in **Terminal**:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ditto.app && open /Applications/Ditto.app
   ```

## What this is

A native Mac browser on WebKit with a local browsing agent built in.

- **Window:** tabs, favourites and the address in a sidebar, the page in a
  card, Ditto on the right. ⌘T or ⌘L opens one field for addresses,
  questions, search, tabs, bookmarks and history.
- **Ditto (⌘J):** a decider model navigates, an LLM plans and answers with
  sources, all on your Mac. It reads the open page or video, remembers your
  preferences (you can see and delete every note), starts from your own
  bookmarks and history, and does tasks in your signed-in tabs: it never
  types passwords, and anything that buys, sends or deletes waits for your
  Approve.
- **Shield:** ad networks blocked, ad slots hidden, click traps disarmed,
  YouTube ads skipped as soon as they can be.
- **From Chrome:** bookmarks, history and your Google account in one click.

## New in this release

- **Watches:** "tell me when this drops below $40", "watch this page for
  new episodes". Ditto checks the page on a schedule, in its own tab, and
  sends a notification when it happens. Listed (and stopped) in *Memory*.
- **Panel:** quick starts in a new chat, a live status while Ditto works,
  sources with page titles.

- **Ditto's own tab:** the agent browses in a tab of its own, opened on
  the page you are on, while you keep yours. Watch it live in the panel
  (a glow marks it while it works) or open it in the window. Nothing in it
  plays by itself.
- **Answers it can point to:** Ditto stops only when the answer is on the
  page, with the sentence that says it; pages that only look right are
  passed over. Dropdowns, cookie walls and muted media are handled; it no
  longer loops between pages.
- **Suggestions** as you type, in the command bar and on the new tab page.
- **New tab page:** top sites, trending in your region, and the trends that
  match what you read, worked out on your Mac.
- **Lighter:** idle tabs sleep and wake on click; under memory pressure
  they sleep at once; tabs playing sound show a mute button.
- **Closing the last tab** leaves a new one instead of closing the window.
