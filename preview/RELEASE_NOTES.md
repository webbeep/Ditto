## Install

1. Download **Ditto-mac-arm64.dmg** (Apple silicon, M1 and later) or
   **Ditto-mac-x64.dmg** (Intel), open it and drag **Ditto** to
   **Applications**.
2. This preview is not yet signed with an Apple Developer ID, so macOS
   refuses to open it ("Apple could not verify…" or "…is damaged").
   Allow it once: open **Terminal** (⌘-Space, type Terminal) and paste

   ```sh
   xattr -dr com.apple.quarantine /Applications/Ditto.app && open /Applications/Ditto.app
   ```

   After that, Ditto opens normally from the Dock or Launchpad.
   (Alternative: try to open Ditto, then within the next few minutes go to
   **System Settings → Privacy & Security** and click **Open Anyway** next
   to the Ditto message.)
3. Open a new tab and type a question, or click the Ditto button in the
   toolbar (pin it from the puzzle-piece menu). On first use, open
   **Models** (chip icon) and download an LLM and a decider; the defaults
   suit your Mac's memory.

## What this preview is

- **Browser:** an official open-source Chromium build (version below), with
  Ditto's defaults on first run: vertical tabs, Memory Saver, Gemini and
  Lens surfaces off. Profile in `~/Library/Application Support/Ditto`.
- **Agent:** a side panel with chats (history, new chat, follow-ups that
  reuse earlier sources), and a new tab page with one command bar. A decider
  model navigates, an LLM plans and answers; failures are retried and
  reported to the models. While the agent works, the page shows its cursor
  and what it is doing.
- **Models:** downloaded from Hugging Face on demand into your profile.
  Nothing loads until you start typing; the power icon (models off) stops
  the runtime completely.
- **Runtime:** llama.cpp b11960 (`llama-server` in router mode).

Not in this preview: Ditto's Chromium patches and native agent page (the
full build, `scripts/build.sh`), automatic updates, notarization, and Chrome
Sync (Google allows it only in Google Chrome).
