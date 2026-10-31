# Your Google account, bookmarks and history in Ditto

## What works

Signing in to Google **websites** (Gmail, YouTube, Drive, Docs, Google
search) is ordinary cookie-based sign-in and works as in Safari. Ditto
stays signed in across launches.

Ditto keeps its own history (`history.sqlite`) and bookmarks
(`bookmarks.json`) in `~/Library/Application Support/Ditto`. The command
bar searches both, and the agent can start a task on one of your pages.

## Moving from Chrome

*Ditto → Import from Chrome* (or *Import from Chrome* on the new tab page)
reads your last-used Chrome profile on this Mac:

- **Bookmarks:** the bookmarks bar and other bookmarks, with their folders.
- **History:** the 5,000 most recent pages.
- **Google account:** the address signed in to Chrome; the new tab page
  offers to sign in to it on google.com.

Chrome can stay open: Ditto only reads its files (history from a copy).

## What does not work, and why

**Chrome Sync** uses Google's private sync service, which Google limits to
Google Chrome; no other browser can use it. Your Chrome data comes over with
the import above instead.

**Passwords** are not saved by Ditto yet. Sites you are signed in to keep
you signed in. Saved passwords and autofill are on the roadmap.
