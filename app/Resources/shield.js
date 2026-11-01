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

  // Ad-block walls ("Looks like you're using an ad blocker", Admiral and
  // the like) come up a while after the page: take the way out the site
  // itself offers ("Continue without supporting", "No thanks"). A wall with
  // no way out is left alone.
  const WALL = /ad ?-?blocker|ad ?block(ing)?\b|disable (your|the) ad|allow ?list|whitelist|turn off (your )?ad|continue without supporting/i;
  const EXIT = /^(continue (without|anyway)\b.*|no,? thanks|not now|maybe later|i understand|close|dismiss|×|✕)$/i;
  const leaveWall = () => {
    if (!document.body) { return false; }
    for (const point of document.elementsFromPoint(innerWidth / 2, innerHeight / 2)) {
      let wall = point;
      while (wall && wall !== document.body && getComputedStyle(wall).position !== 'fixed') {
        wall = wall.parentElement;
      }
      const text = wall && wall !== document.body ? wall.innerText || '' : '';
      if (!text || text.length > 3000 || !WALL.test(text)) { continue; }
      const exit = [...wall.querySelectorAll('a, button, [role="button"]')]
          .find(b => EXIT.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
      if (exit) { exit.click(); return true; }
      return false;
    }
    return false;
  };
  let looks = 0;
  const watch = setInterval(() => {
    if (leaveWall() || ++looks >= 30) { clearInterval(watch); }
  }, 1000);

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
