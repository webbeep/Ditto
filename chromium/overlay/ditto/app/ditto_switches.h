// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_APP_DITTO_SWITCHES_H_
#define DITTO_APP_DITTO_SWITCHES_H_

// Header-only on purpose: chrome_main_delegate.cc is compiled into several
// targets (//chrome:*, //chrome/app:*), and keeping this inline avoids
// patching every one of them with a new dependency. It is intentionally not
// listed in any GN target's `sources`, so `gn check` does not require one.

#include <string>
#include <string_view>
#include <vector>

#include "base/command_line.h"
#include "base/containers/contains.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"

namespace ditto {

// Everything a minimal agent browser does not need: Google's cloud
// assistant and AI surfaces (Ditto's agent is local), shopping, Cast, ad
// APIs, on-device Gemini downloads and promo pages. Each would add UI,
// background work or network traffic. Names a Chromium version does not
// know are ignored.
inline constexpr std::string_view kDisabledFeatures[] = {
    // Gemini, Lens and other cloud AI.
    "Glic",
    "GlicActor",
    "GlicRollout",
    "LensOverlay",
    "LensStandalone",
    "ContextualTasks",
    "AIModeOmniboxEntryPoint",
    "HistoryEmbeddings",
    "TabOrganization",
    "Compose",
    "OptimizationGuideOnDeviceModel",
    // Shopping, Cast, promos.
    "ShoppingList",
    "MediaRouter",
    "ChromeWhatsNewUI",
    // Ad APIs (Privacy Sandbox).
    "BrowsingTopics",
    "InterestGroupStorage",
    "Fledge",
    "PrivacySandboxAdsAPIsOverride",
};

inline void AppendFeatureList(base::CommandLine* command_line,
                              std::string_view switch_name,
                              std::string_view features) {
  std::string value = command_line->GetSwitchValueASCII(switch_name);
  // A user-supplied flag keeps priority: features they listed come first,
  // and base::FeatureList ignores later duplicates.
  base::StrAppend(&value, {value.empty() ? "" : ",", features});
  command_line->AppendSwitchASCII(switch_name, value);
}

inline void AppendDefaultSwitches(base::CommandLine* command_line) {
  // Child processes get their features from the browser process.
  if (command_line->HasSwitch("type")) {
    return;
  }
  const std::string enabled =
      command_line->GetSwitchValueASCII("enable-features");
  const std::vector<std::string_view> user_enabled = base::SplitStringPiece(
      enabled, ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  std::string disabled;
  for (std::string_view feature : kDisabledFeatures) {
    // Respect an explicit --enable-features=<feature> from the user.
    if (base::Contains(user_enabled, feature)) {
      continue;
    }
    base::StrAppend(&disabled, {disabled.empty() ? "" : ",", feature});
  }
  if (!disabled.empty()) {
    AppendFeatureList(command_line, "disable-features", disabled);
  }
}

}  // namespace ditto

#endif  // DITTO_APP_DITTO_SWITCHES_H_
