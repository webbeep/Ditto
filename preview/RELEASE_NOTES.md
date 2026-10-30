## Install

1. Download **Ditto-mac-arm64.dmg** (Apple silicon, M1 and later) or
   **Ditto-mac-x64.dmg** (Intel), open it and drag **Ditto** to
   **Applications**.
2. This preview is not notarized by Apple yet, so the first launch is
   blocked. Open Ditto once, then go to **System Settings → Privacy &
   Security** and click **Open Anyway**. (Or, in Terminal:
   `xattr -dr com.apple.quarantine /Applications/Ditto.app`.)
3. Click the Ditto Agent button in the toolbar (pin it from the puzzle-piece
   menu) to open the agent side panel. Open **Models** and download a
   responder and a decider; the defaults are picked for your Mac's memory.

## What this preview is

- **Browser:** an official open-source Chromium build (version below), with
  Ditto's defaults on first run: vertical tabs, Memory Saver, Gemini and
  Lens surfaces off. Profile in `~/Library/Application Support/Ditto`.
- **Agent:** the Ditto agent as a built-in side-panel extension. A decider
  model navigates and an LLM plans and answers; all models run on your Mac.
- **Models:** downloaded from Hugging Face on demand into your profile.
  Nothing runs until you use the agent; *Disable all models* stops the
  runtime completely.
- **Runtime:** llama.cpp b11960 (`llama-server` in router mode).

Not in this preview: Ditto's Chromium patches and native agent page (the
full build, `scripts/build.sh`), automatic updates, notarization, and Chrome
Sync (Google allows it only in Google Chrome).
