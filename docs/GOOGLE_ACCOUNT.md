# Google account, history and bookmarks in Ditto

## What works

Ditto is Chromium, so everything Chrome stores **locally** works the same
way: history, bookmarks, the bookmarks bar, saved passwords (in the macOS
Keychain), autofill, multiple profiles, extensions from the Chrome Web Store,
and site sign-ins. The profile lives in `~/Library/Application Support/Ditto`
(patch `0009`), separate from Chrome's and Chromium's.

Signing in to Google **websites** (Gmail, YouTube, Drive, Docs) is ordinary
cookie-based sign-in and works as in any browser.

## What does not work, and why

The Chrome profile menu's **"Turn on sync"** and browser-level Google sign-in
use Google's private Chrome Sync and OAuth APIs. On 15 March 2021 Google
restricted those APIs to Google Chrome. Chromium builds cannot get API keys
that allow sync, and neither can Brave, Vivaldi, Arc or any other
Chromium-based browser. Ditto therefore builds with
`use_official_google_api_keys = false` and no Google API keys, so these
features stay off rather than half-working.

## Moving from Chrome

- **Bookmarks:** Chrome → Bookmark Manager → ⋮ → *Export bookmarks*, then in
  Ditto *Settings → Import bookmarks and settings → Bookmarks HTML file*.
- **Passwords:** Chrome → Password Manager → Settings → *Export passwords*
  (CSV), then in Ditto *Password Manager → Settings → Import passwords*.
- **History:** not yet. A direct importer that reads Chrome's local profile
  is on the roadmap.

## Roadmap: sync without Google

Planned: optional sync between Ditto installs, end-to-end encrypted, using
Chromium's sync engine against a self-hostable server.
