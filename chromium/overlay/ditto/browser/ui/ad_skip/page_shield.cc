// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/ad_skip/page_shield.h"

#include "base/functional/callback_helpers.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ditto {

BASE_FEATURE(kDittoPageShield, base::FEATURE_ENABLED_BY_DEFAULT);

namespace {

// Tested in agent/test/shield.e2e.test.ts, which runs this exact text.
constexpr char16_t kShield[] = uR"js((() => {
  const root = document.documentElement;
  if (!root || root.hasAttribute('data-ditto-shield')) { return; }
  root.setAttribute('data-ditto-shield', '');

  // Ad slots, by the markers ad networks put on them.
  const style = document.createElement('style');
  style.textContent = [
    'ins.adsbygoogle', '[data-ad-slot]', '[data-google-query-id]', '[data-text-ad]',
    'div[id^="div-gpt-ad"]', 'iframe[id^="google_ads_iframe"]',
    'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]',
    'iframe[src*="amazon-adsystem.com"]', 'iframe[src*="taboola.com"]',
    'iframe[src*="outbrain.com"]', '.OUTBRAIN', 'div[id^="taboola-"]',
    'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer', 'ytd-banner-promo-renderer',
    '#masthead-ad', '#player-ads',
  ].join(', ') + ' { display: none !important; }';
  (document.head || root).append(style);

  // A layer that covers much of the page, shows nothing, and takes clicks.
  const isTrap = el => {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 0.3 * innerWidth * innerHeight) { return false; }
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') { return false; }
    const clear = Number(s.opacity) <= 0.05 ||
        (/^(transparent|rgba\(0, 0, 0, 0\))$/.test(s.backgroundColor) &&
         s.backgroundImage === 'none' && !el.textContent.trim() &&
         !el.querySelector('img, video, canvas, svg, iframe'));
    const clickable = el.tagName === 'A' || el.hasAttribute('onclick') ||
        s.cursor === 'pointer';
    return clear && clickable;
  };
  addEventListener('click', event => {
    const layer = event.target;
    if (!(layer instanceof Element) || !isTrap(layer)) { return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    layer.style.setProperty('pointer-events', 'none', 'important');
    const under = document.elementFromPoint(event.clientX, event.clientY);
    if (under && under !== layer) { under.click(); }
  }, true);
})())js";

}  // namespace

PageShield::PageShield(content::WebContents* web_contents)
    : content::WebContentsObserver(web_contents),
      content::WebContentsUserData<PageShield>(*web_contents) {}

PageShield::~PageShield() = default;

// static
void PageShield::MaybeCreateForWebContents(content::WebContents* web_contents) {
  if (base::FeatureList::IsEnabled(kDittoPageShield)) {
    CreateForWebContents(web_contents);
  }
}

void PageShield::DOMContentLoaded(content::RenderFrameHost* frame) {
  if (!frame->IsInPrimaryMainFrame() ||
      !frame->GetLastCommittedURL().SchemeIsHTTPOrHTTPS()) {
    return;
  }
  frame->ExecuteJavaScriptInIsolatedWorld(kShield, base::DoNothing(),
                                          ISOLATED_WORLD_ID_CHROME_INTERNAL);
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(PageShield);

}  // namespace ditto
