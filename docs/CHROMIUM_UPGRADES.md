# Moving to a new Chromium release

Chromium ships a security release roughly every week and a new milestone
every four weeks. Ditto keeps its patch set small so that moving to a new
release is quick.

1. Find the new stable version for macOS:
   `curl -s "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1"`
2. Write it to `chromium/VERSION`.
3. Run `tools/check-patches.sh`. Patches that still apply need nothing.
4. For each failing patch: `scripts/fetch.sh`, then in `build/src` apply it
   with `git apply --3way`, resolve the conflicts, and regenerate it with
   `git diff -- <files> > chromium/patches/<name>.patch`.
5. `scripts/build.sh mac-arm64`. It fails if a GN arg in `chromium/args/` no
   longer exists. Fix the overlay for any API changes (the overlay uses
   `base::MemoryPressureListener`, `network::SimpleURLLoader`,
   `content::DevToolsAgentHost` and `BrowserWindowInterface`).
6. `cd agent && npm test`, then `tools/webui-typecheck/check.sh`.
