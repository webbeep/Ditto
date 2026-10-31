// Ads, as the agent sees them. The agent never follows an ad: ad elements
// are not offered to the models, a click that a hidden overlay would catch
// is delivered to the element itself, and a click that lands on an ad
// network is undone.

// Ad networks' serving and click hosts.
export const AD_HOSTS = [
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'adservice.google.com', 'adnxs.com', 'taboola.com', 'outbrain.com',
  'criteo.com', 'criteo.net', 'amazon-adsystem.com', 'adsrvr.org',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'moatads.com',
  'zemanta.com', 'revcontent.com', 'mgid.com', 'popads.net',
  'propellerads.com', 'adsterra.com', 'exoclick.com', 'popcash.net',
  'clickadu.com', 'hilltopads.net', 'adcash.com',
];

// Click-tracking paths of search and ad networks (Google's /aclk, /pagead).
export const AD_PATH = String.raw`\/(aclk|pagead|adclick|ads?\/click)\b|[?&](adurl|ad_click)=`;

export function isAdUrl(url: string): boolean {
  try {
    const {hostname, pathname, search} = new URL(url);
    return AD_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`)) ||
        new RegExp(AD_PATH, 'i').test(pathname + search);
  } catch {
    return false;
  }
}

// A click on `href` (a link on `from`) ended on `landed`: was it hijacked?
// Redirectors carry their target in the link (Google's /url?q=…, t.co), so
// only an internal link that leaves for a site it never named counts, and
// any landing on an ad network.
export function isHijacked(from: string, href: string|undefined, landed: string): boolean {
  if (isAdUrl(landed)) {
    return true;
  }
  if (!href) {
    return false;
  }
  try {
    const source = new URL(from).hostname;
    const link = new URL(href);
    const target = new URL(landed).hostname;
    return link.hostname === source && target !== source &&
        !sameSite(target, source) && !href.includes(target);
  } catch {
    return false;
  }
}

function sameSite(a: string, b: string): boolean {
  const site = (host: string) => host.split('.').slice(-2).join('.');
  return site(a) === site(b);
}
