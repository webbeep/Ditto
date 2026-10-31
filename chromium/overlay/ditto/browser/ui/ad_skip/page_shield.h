// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_AD_SKIP_PAGE_SHIELD_H_
#define DITTO_BROWSER_UI_AD_SKIP_PAGE_SHIELD_H_

#include "base/feature_list.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"

namespace ditto {

BASE_DECLARE_FEATURE(kDittoPageShield);

// Ditto's shield for everyday browsing, in every tab: hides ad slots that
// ad networks mark unambiguously (their tags, frames and attributes), and
// sends a click that an invisible layer over the page would catch (a
// common trick to open an ad) to what the user saw under it. Runs in an
// isolated world, so pages cannot see or undo it.
class PageShield : public content::WebContentsObserver,
                   public content::WebContentsUserData<PageShield> {
 public:
  PageShield(const PageShield&) = delete;
  PageShield& operator=(const PageShield&) = delete;
  ~PageShield() override;

  // Attaches to `web_contents` when the feature is on.
  static void MaybeCreateForWebContents(content::WebContents* web_contents);

  // content::WebContentsObserver:
  void DOMContentLoaded(content::RenderFrameHost* frame) override;

 private:
  friend class content::WebContentsUserData<PageShield>;
  explicit PageShield(content::WebContents* web_contents);

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_AD_SKIP_PAGE_SHIELD_H_
