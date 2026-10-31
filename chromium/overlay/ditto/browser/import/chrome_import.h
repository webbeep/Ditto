// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_IMPORT_CHROME_IMPORT_H_
#define DITTO_BROWSER_IMPORT_CHROME_IMPORT_H_

#include <optional>
#include <string>

#include "base/functional/callback_forward.h"
#include "base/values.h"

namespace bookmarks {
class BookmarkModel;
}

namespace ditto {

// What Ditto reads from the user's Google Chrome, to move over in one step.
struct ChromeProfile {
  ChromeProfile();
  ChromeProfile(ChromeProfile&&);
  ChromeProfile& operator=(ChromeProfile&&);
  ~ChromeProfile();

  // The Google account signed in to that profile, if any.
  std::string email;
  // The "roots" of its Bookmarks file; empty if Chrome or the file is absent.
  std::optional<base::DictValue> bookmark_roots;
};

// Reads the last-used profile of Google Chrome on this computer, off the UI
// thread. Chrome may be running: its files are only read.
void ReadChromeProfile(base::OnceCallback<void(ChromeProfile)> done);

// Adds Chrome's bookmarks to `model`: its bookmarks bar to Ditto's, its
// other bookmarks to Ditto's. Where Ditto already has bookmarks, Chrome's
// go into a "Chrome" folder there instead. Returns the bookmarks added.
int AddChromeBookmarks(bookmarks::BookmarkModel* model,
                       const base::DictValue& roots);

}  // namespace ditto

#endif  // DITTO_BROWSER_IMPORT_CHROME_IMPORT_H_
