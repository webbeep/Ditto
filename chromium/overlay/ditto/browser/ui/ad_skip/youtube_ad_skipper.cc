// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/ad_skip/youtube_ad_skipper.h"

#include <optional>
#include <utility>

#include "base/functional/bind.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "ui/events/base_event_utils.h"
#include "ui/gfx/geometry/point_f.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace ditto {

BASE_FEATURE(kDittoYouTubeAdSkip, base::FEATURE_ENABLED_BY_DEFAULT);

namespace {

constexpr base::TimeDelta kCheckEvery = base::Seconds(1);
// After a click, the ad takes a moment to go away.
constexpr base::TimeDelta kAfterClick = base::Seconds(2);

// The skip button's centre (CSS pixels) and the page's devicePixelRatio,
// or null while there is none to press. Covers YouTube's current and
// earlier skip buttons.
constexpr char16_t kFindSkipButton[] = uR"js((() => {
  const button = document.querySelector(
      '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
      '.ytp-ad-skip-button-slot button');
  if (!button || button.disabled) { return null; }
  const r = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  if (r.width < 4 || r.height < 4 || style.display === 'none' ||
      style.visibility === 'hidden' || Number(style.opacity) < 0.5) {
    return null;
  }
  return {x: r.left + r.width / 2, y: r.top + r.height / 2,
          dpr: window.devicePixelRatio};
})())js";

bool IsYouTube(const GURL& url) {
  return url.SchemeIs(url::kHttpsScheme) && url.DomainIs("youtube.com");
}

}  // namespace

YouTubeAdSkipper::YouTubeAdSkipper(content::WebContents* web_contents)
    : content::WebContentsObserver(web_contents),
      content::WebContentsUserData<YouTubeAdSkipper>(*web_contents) {}

YouTubeAdSkipper::~YouTubeAdSkipper() = default;

// static
void YouTubeAdSkipper::MaybeCreateForWebContents(
    content::WebContents* web_contents) {
  if (base::FeatureList::IsEnabled(kDittoYouTubeAdSkip)) {
    CreateForWebContents(web_contents);
  }
}

void YouTubeAdSkipper::DidFinishNavigation(
    content::NavigationHandle* navigation) {
  if (navigation->IsInPrimaryMainFrame() && navigation->HasCommitted()) {
    UpdateTimer();
  }
}

void YouTubeAdSkipper::OnVisibilityChanged(content::Visibility visibility) {
  UpdateTimer();
}

void YouTubeAdSkipper::UpdateTimer() {
  const bool watch =
      IsYouTube(web_contents()->GetLastCommittedURL()) &&
      web_contents()->GetVisibility() == content::Visibility::VISIBLE;
  if (!watch) {
    timer_.Stop();
  } else if (!timer_.IsRunning()) {
    timer_.Start(FROM_HERE, kCheckEvery,
                 base::BindRepeating(&YouTubeAdSkipper::Check,
                                     base::Unretained(this)));
  }
}

void YouTubeAdSkipper::Check() {
  if (base::TimeTicks::Now() - last_click_ < kAfterClick) {
    return;
  }
  content::RenderFrameHost* frame = web_contents()->GetPrimaryMainFrame();
  if (!frame || !frame->IsRenderFrameLive()) {
    return;
  }
  frame->ExecuteJavaScriptInIsolatedWorld(
      kFindSkipButton,
      base::BindOnce(&YouTubeAdSkipper::OnSkipButton,
                     weak_factory_.GetWeakPtr()),
      ISOLATED_WORLD_ID_CHROME_INTERNAL);
}

void YouTubeAdSkipper::OnSkipButton(base::Value button) {
  const base::DictValue* dict = button.GetIfDict();
  if (!dict) {
    return;
  }
  const std::optional<double> x = dict->FindDouble("x");
  const std::optional<double> y = dict->FindDouble("y");
  const std::optional<double> dpr = dict->FindDouble("dpr");
  content::RenderWidgetHostView* view = web_contents()->GetRenderWidgetHostView();
  if (!x || !y || !dpr || !view || view->GetDeviceScaleFactor() <= 0) {
    return;
  }
  // CSS pixels to the view's DIPs: devicePixelRatio is the screen's scale
  // times the page zoom.
  const double zoom = *dpr / view->GetDeviceScaleFactor();
  const gfx::PointF point(*x * zoom, *y * zoom);
  last_click_ = base::TimeTicks::Now();
  for (const auto [type, modifiers] :
       {std::pair(blink::WebInputEvent::Type::kMouseDown,
                  int{blink::WebInputEvent::kLeftButtonDown}),
        std::pair(blink::WebInputEvent::Type::kMouseUp,
                  int{blink::WebInputEvent::kNoModifiers})}) {
    view->GetRenderWidgetHost()->ForwardMouseEvent(blink::WebMouseEvent(
        type, point, point, blink::WebPointerProperties::Button::kLeft,
        /*click_count_param=*/1, modifiers, ui::EventTimeForNow()));
  }
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(YouTubeAdSkipper);

}  // namespace ditto
