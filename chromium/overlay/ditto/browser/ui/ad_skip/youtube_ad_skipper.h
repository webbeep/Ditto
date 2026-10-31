// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_AD_SKIP_YOUTUBE_AD_SKIPPER_H_
#define DITTO_BROWSER_UI_AD_SKIP_YOUTUBE_AD_SKIPPER_H_

#include "base/feature_list.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"

namespace ditto {

BASE_DECLARE_FEATURE(kDittoYouTubeAdSkip);

// Presses YouTube's "Skip" button as soon as an ad offers it, in every tab
// showing YouTube. Checks once a second while such a tab is visible: a
// small script in an isolated world reports the button once it is shown
// and enabled, and the click is sent as real mouse input, like the user's.
// Ads that cannot be skipped play as usual.
class YouTubeAdSkipper
    : public content::WebContentsObserver,
      public content::WebContentsUserData<YouTubeAdSkipper> {
 public:
  YouTubeAdSkipper(const YouTubeAdSkipper&) = delete;
  YouTubeAdSkipper& operator=(const YouTubeAdSkipper&) = delete;
  ~YouTubeAdSkipper() override;

  // Attaches to `web_contents` when the feature is on.
  static void MaybeCreateForWebContents(content::WebContents* web_contents);

  // content::WebContentsObserver:
  void DidFinishNavigation(content::NavigationHandle* navigation) override;
  void OnVisibilityChanged(content::Visibility visibility) override;

 private:
  friend class content::WebContentsUserData<YouTubeAdSkipper>;
  explicit YouTubeAdSkipper(content::WebContents* web_contents);

  void UpdateTimer();
  void Check();
  void OnSkipButton(base::Value button);

  base::RepeatingTimer timer_;
  base::TimeTicks last_click_;
  base::WeakPtrFactory<YouTubeAdSkipper> weak_factory_{this};

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_AD_SKIP_YOUTUBE_AD_SKIPPER_H_
