## Install

1. Download **Ditto-mac-arm64.dmg** (Apple silicon), open it and drag
   **Ditto** to **Applications**.
2. Ditto is not yet signed with an Apple Developer ID, so macOS refuses to
   open it the first time. Allow it once in **Terminal**:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ditto.app && open /Applications/Ditto.app
   ```

## What this is

Ditto compiled from Chromium's source with the agent built in, not an
extension:

- **Agent panel** on the right (toolbar button, or ask from the new tab):
  chats with history, a decider model that navigates, an LLM that plans and
  answers with sources. Models run on your Mac through the bundled
  llama.cpp runtime; *Models off* stops it entirely.
- **New tab** is one command bar: addresses open, questions go to the agent.
  *Import from Chrome* there copies your Chrome bookmarks and offers to sign
  in to the same Google account.
- **Browser design:** Ditto's own palette in Chromium's colour pipeline
  (tabs, toolbar, address bar, menus, settings), vertical tabs on the left,
  back button only, no separators.
- **Lean:** a browser, Google sign-in, bookmarks and the agent. Gemini,
  Lens, Compose, Cast, shopping, contextual tasks, What's New, ad APIs,
  Remote Desktop, the Meet helper, WebXR and LAN discovery
  are out. Memory Saver is on.
- **Kept:** history, bookmarks, passwords and extensions. Chromium builds
  cannot use Google Sync (Google limits it to Google Chrome); see
  docs/GOOGLE_ACCOUNT.md.
