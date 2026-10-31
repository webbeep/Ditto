// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/import/chrome_import.h"

#include <string_view>
#include <utility>

#include "base/base_paths.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/json/json_reader.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "components/bookmarks/browser/bookmark_node.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_MAC)
#include "base/base_paths_mac.h"
#endif

namespace ditto {

namespace {

using bookmarks::BookmarkModel;
using bookmarks::BookmarkNode;

// Chrome's user data directory (the stable channel).
base::FilePath ChromeUserDataDir() {
  base::FilePath dir;
#if BUILDFLAG(IS_MAC)
  if (base::PathService::Get(base::DIR_APP_DATA, &dir)) {
    return dir.Append("Google").Append("Chrome");
  }
#else
  if (base::PathService::Get(base::DIR_HOME, &dir)) {
    return dir.Append(".config").Append("google-chrome");
  }
#endif
  return base::FilePath();
}

// A profile directory name from Local State, used as a path component.
bool IsPlainName(std::string_view name) {
  return !name.empty() && name != "." && name != ".." &&
         name.find_first_of("/\\") == std::string_view::npos;
}

ChromeProfile ReadOnDisk() {
  ChromeProfile profile;
  const base::FilePath user_data = ChromeUserDataDir();
  if (user_data.empty()) {
    return profile;
  }
  std::string dir_name = "Default";
  std::string local_state;
  if (base::ReadFileToString(user_data.Append("Local State"), &local_state)) {
    std::optional<base::DictValue> state =
        base::JSONReader::ReadDict(local_state);
    if (state) {
      const std::string* last_used =
          state->FindStringByDottedPath("profile.last_used");
      if (last_used && IsPlainName(*last_used)) {
        dir_name = *last_used;
      }
      const base::DictValue* info =
          state->FindDictByDottedPath("profile.info_cache");
      const base::DictValue* entry = info ? info->FindDict(dir_name) : nullptr;
      const std::string* user = entry ? entry->FindString("user_name") : nullptr;
      if (user) {
        profile.email = *user;
      }
    }
  }
  std::string bookmarks;
  if (!base::ReadFileToString(
          user_data.Append(dir_name).Append("Bookmarks"), &bookmarks)) {
    return profile;
  }
  std::optional<base::DictValue> file = base::JSONReader::ReadDict(bookmarks);
  if (base::DictValue* roots = file ? file->FindDict("roots") : nullptr) {
    profile.bookmark_roots = std::move(*roots);
  }
  return profile;
}

int CopyChildren(BookmarkModel* model,
                 const base::DictValue& folder,
                 const BookmarkNode* parent) {
  const base::ListValue* children = folder.FindList("children");
  if (!children) {
    return 0;
  }
  int added = 0;
  for (const base::Value& value : *children) {
    const base::DictValue* child = value.GetIfDict();
    if (!child) {
      continue;
    }
    const std::string* type = child->FindString("type");
    const std::string* name = child->FindString("name");
    const std::u16string title =
        name ? base::UTF8ToUTF16(*name) : std::u16string();
    if (type && *type == "url") {
      const std::string* url = child->FindString("url");
      const GURL gurl(url ? *url : std::string());
      if (gurl.is_valid()) {
        model->AddURL(parent, parent->children().size(), title, gurl);
        ++added;
      }
    } else if (type && *type == "folder") {
      added += CopyChildren(
          model, *child,
          model->AddFolder(parent, parent->children().size(), title));
    }
  }
  return added;
}

int CopyRoot(BookmarkModel* model,
             const base::DictValue& roots,
             std::string_view key,
             const BookmarkNode* target) {
  const base::DictValue* root = roots.FindDict(key);
  const base::ListValue* children = root ? root->FindList("children") : nullptr;
  if (!children || children->empty()) {
    return 0;
  }
  if (!target->children().empty()) {
    target = model->AddFolder(target, target->children().size(), u"Chrome");
  }
  return CopyChildren(model, *root, target);
}

}  // namespace

ChromeProfile::ChromeProfile() = default;
ChromeProfile::ChromeProfile(ChromeProfile&&) = default;
ChromeProfile& ChromeProfile::operator=(ChromeProfile&&) = default;
ChromeProfile::~ChromeProfile() = default;

void ReadChromeProfile(base::OnceCallback<void(ChromeProfile)> done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadOnDisk), std::move(done));
}

int AddChromeBookmarks(BookmarkModel* model, const base::DictValue& roots) {
  return CopyRoot(model, roots, "bookmark_bar", model->bookmark_bar_node()) +
         CopyRoot(model, roots, "other", model->other_node());
}

}  // namespace ditto
