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
