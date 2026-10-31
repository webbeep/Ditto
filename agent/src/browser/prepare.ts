// Runs inside the page (serialized like collectSnapshot) before the agent
// reads it: mutes and pauses media (the agent reads transcripts, it does not
// need sound), and dismisses cookie and consent banners, preferring "reject"
// over "accept". Returns what it did, for the agent's trace. Self-contained.

export function preparePage(): string[] {
  const done: string[] = [];
  for (const media of Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))) {
    if (!media.muted) {
      media.muted = true;
      done.push('muted media');
    }
  }

  // Consent managers' containers (OneTrust, Didomi, Quantcast, Sourcepoint,
  // Cookiebot, Usercentrics, TrustArc, and generic ones).
  const containers = Array.from(document.querySelectorAll<HTMLElement>(
      '#onetrust-banner-sdk, #onetrust-consent-sdk, #didomi-host, .qc-cmp2-container, ' +
      '[id^="sp_message_container"], #CybotCookiebotDialog, #usercentrics-root, ' +
      '#truste-consent-track, [id*="cookie" i][role="dialog"], [class*="cookie" i][role="dialog"], ' +
      '[id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [aria-label*="consent" i]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      });
  if (!containers.length) {
    return done;
  }
  const label = (el: Element) =>
      (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '').trim().toLowerCase();
  const buttons = containers.flatMap(c => Array.from(c.querySelectorAll<HTMLElement>(
      'button, [role="button"], a[href="#"], input[type="button"], input[type="submit"]')));
  const preferences = [
    /^(reject|decline|refuse|deny)( all)?( cookies)?$|only (necessary|essential)|necessary only|essential only/,
    /^(close|dismiss|no,? thanks|not now|×|✕)$/,
    /^(accept|agree|allow|ok|okay|got it|i agree|i accept|accept all|allow all|accept cookies)/,
  ];
  for (const pattern of preferences) {
    const button = buttons.find(b => pattern.test(label(b)));
    if (button) {
      button.click();
      done.push(`dismissed a cookie banner (${label(button).slice(0, 30)})`);
      break;
    }
  }
  return done;
}
