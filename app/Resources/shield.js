// Ditto's shield, injected into every page (Shield.swift) in an isolated
// world, so pages cannot see or undo it: hides ad slots by the markers ad
// networks put on them, and sends a click that an invisible layer over the
// page would catch (a common trick to open an ad) to what the user saw
// under it. Ad requests themselves are blocked by ad-rules.json.
(() => {
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
    // YouTube's ad slots (the lists ad blockers keep). Not #player-ads: the
    // player needs it.
    'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
    'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)',
    'ytd-promoted-sparkles-web-renderer', 'ytd-banner-promo-renderer',
    'ytd-display-ad-renderer', 'ytd-search-pyv-renderer', 'ytd-merch-shelf-renderer',
    '#shopping-timely-shelf', 'yt-overlay-product-sticker', '#masthead-ad',
    'ad-slot-renderer', 'ytm-companion-ad-renderer', '.ytp-ad-overlay-container',
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
})();
