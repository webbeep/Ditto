// Runs inside the page (via Runtime.evaluate) and returns a compact,
// model-friendly view of it: interactive elements with stable ids, headings,
// and the main readable text. Must stay self-contained: it is serialized
// with Function.prototype.toString().

export interface PageElement {
  id: number;
  kind: string;
  label: string;
  href?: string;
  inputType?: string;
  inViewport: boolean;
  // An ad or sponsored placement (see ads.ts): never followed.
  ad?: boolean;
  // A password or payment-card field: the agent never types into these;
  // the user (or the browser's autofill) fills them.
  secret?: 'password'|'payment';
  // For text fields: whether something is in it (never what).
  filled?: boolean;
}

export interface PageSnapshot {
  url: string;
  // HTTP status of the document; 0 when unknown.
  status: number;
  title: string;
  headings: string[];
  elements: PageElement[];
  text: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
}

export function collectSnapshot(maxElements: number, maxText: number,
                                adHosts: string[], adPath: string): PageSnapshot {
  const ATTR = 'data-ditto-id';
  const SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, ' +
      '[role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], ' +
      '[role=searchbox], [role=textbox], [contenteditable=""], [contenteditable=true], ' +
      'summary, [onclick]';
  const squash = (s: string|null|undefined, max: number) =>
      (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  const doc = document;
  let nextId = 1;
  for (const el of Array.from(doc.querySelectorAll(`[${ATTR}]`))) {
    nextId = Math.max(nextId, Number(el.getAttribute(ATTR)) + 1);
  }

  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return false;
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' &&
        Number(style.opacity) > 0.05 && !el.closest('[aria-hidden=true]');
  };

  const labelOf = (el: Element) => {
    const html = el as HTMLElement;
    const input = el as HTMLInputElement;
    const labelled = el.getAttribute('aria-labelledby');
    const fromLabelledBy = labelled ?
        labelled.split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? '')
            .join(' ') : '';
    const fromLabel = input.labels?.[0]?.textContent ?? '';
    const img = el.querySelector('img[alt]');
    return squash(el.getAttribute('aria-label') || fromLabelledBy ||
                      html.innerText || fromLabel ||
                      (input.type !== 'password' &&
                       !/^cc-/i.test(el.getAttribute('autocomplete') ?? '') ? input.value : '') ||
                      input.placeholder || el.getAttribute('title') ||
                      img?.getAttribute('alt') || el.getAttribute('name'),
                  100);
  };

  // Ad containers by tag, id, class, label or attribute, and links to ad
  // networks or click trackers. Covers display ads, Google's and Bing's
  // sponsored results, DuckDuckGo's, YouTube's promoted slots.
  const adToken = /(^|[\s_-])(ad|ads|advert|advertisement|adslot|adunit|adsbygoogle|sponsor|sponsored|promoted|dfp|gpt-ad|outbrain|taboola)([\s_-]|$)/i;
  const adTag = /^(ins|ytd-(ad-slot|promoted|display-ad|in-feed-ad|banner-promo)[a-z-]*)$/i;
  const adPathRe = new RegExp(adPath, 'i');
  const isAdHref = (href: string) => {
    try {
      const url = new URL(href);
      return adHosts.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`)) ||
          adPathRe.test(url.pathname + url.search);
    } catch {
      return false;
    }
  };
  const isAdNode = (node: Element) => {
    const cls = typeof node.className === 'string' ? node.className : '';
    return adTag.test(node.tagName) || adToken.test(node.id) || adToken.test(cls) ||
        /^(tads|bottomads|tvcap)$/.test(node.id) ||
        node.hasAttribute('data-ad-slot') || node.hasAttribute('data-text-ad') ||
        node.hasAttribute('data-google-query-id') ||
        /^(advertisement|sponsored)\b/i.test(node.getAttribute('aria-label') ?? '');
  };
  const isAd = (el: Element) => {
    const href = (el as HTMLAnchorElement).href;
    if (typeof href === 'string' && href && isAdHref(href)) {
      return true;
    }
    let node: Element|null = el;
    for (let depth = 0; node && depth < 8; node = node.parentElement, ++depth) {
      if (isAdNode(node)) {
        return true;
      }
    }
    return false;
  };

  const kindOf = (el: Element) => {
    const role = el.getAttribute('role');
    if (role) {
      return role;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') {
      return 'link';
    }
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      return ['submit', 'button', 'reset', 'image'].includes(type) ? 'button' :
          ['checkbox', 'radio'].includes(type)                     ? type :
                                                                     'textbox';
    }
    if (tag === 'textarea') {
      return 'textbox';
    }
    if (el.hasAttribute('contenteditable')) {
      return 'textbox';
    }
    return tag === 'select' ? 'select' : tag === 'summary' ? 'button' : tag;
  };

  const elements: PageElement[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll(SELECTOR))) {
    if (elements.length >= maxElements) {
      break;
    }
    if (!visible(el) || (el as HTMLInputElement).disabled) {
      continue;
    }
    const kind = kindOf(el);
    const label = labelOf(el);
    const href = (el as HTMLAnchorElement).href || undefined;
    if (!label && kind !== 'textbox') {
      continue;
    }
    // Repeated identical links (nav duplicated in header and footer, etc.)
    // cost tokens and split the decider's probability mass.
    const key = `${kind}|${label}|${href ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let id = Number(el.getAttribute(ATTR));
    if (!id) {
      id = nextId++;
      el.setAttribute(ATTR, String(id));
    }
    const rect = el.getBoundingClientRect();
    const element: PageElement = {
      id,
      kind,
      label,
      inViewport: rect.bottom > 0 && rect.top < innerHeight,
    };
    if (href && !href.startsWith('javascript:')) {
      element.href = href;
    }
    if (kind === 'textbox') {
      const input = el as HTMLInputElement;
      element.inputType = input.type || 'text';
      element.filled = Boolean(input.value || (el as HTMLElement).isContentEditable &&
                                               (el as HTMLElement).innerText.trim());
      const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
      if (input.type === 'password' || /(current|new)-password/.test(autocomplete)) {
        element.secret = 'password';
      } else if (/^cc-/.test(autocomplete) ||
                 /card ?number|security code|\bcvc\b|\bcvv\b|expir/i.test(label)) {
        element.secret = 'payment';
      }
    }
    if (isAd(el)) {
      element.ad = true;
    }
    elements.push(element);
  }

  // Prefer the main content, but some sites leave <main> empty and render
  // elsewhere; then read the whole body. Ads are hidden while the text is
  // read (in the same task, so nothing repaints): their copy would make a
  // page look like it answers the question.
  const hide = doc.createElement('style');
  hide.textContent = '[data-ditto-ad] { display: none !important; }';
  const ads = Array.from(doc.querySelectorAll(
      '[class], [id], ins, [data-ad-slot], [data-text-ad], [data-google-query-id], ' +
      '[aria-label]')).filter(isAdNode);
  for (const ad of ads) {
    ad.setAttribute('data-ditto-ad', '');
  }
  doc.documentElement?.append(hide);
  const main = doc.querySelector<HTMLElement>('main, article, [role=main]');
  const mainText = main?.innerText ?? '';
  const bodyText = mainText.trim().length >= 40 ? '' : doc.body?.innerText;
  hide.remove();
  for (const ad of ads) {
    ad.removeAttribute('data-ditto-ad');
  }
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
                       .filter(visible)
                       .map(h => squash((h as HTMLElement).innerText, 120))
                       .filter(Boolean)
                       .slice(0, 30);
  const navigation = performance.getEntriesByType('navigation')[0] as
      (PerformanceEntry & {responseStatus?: number}) | undefined;
  return {
    url: location.href,
    status: navigation?.responseStatus ?? 0,
    title: doc.title,
    headings,
    elements,
    text: squash(mainText.trim().length >= 40 ? mainText : bodyText, maxText),
    scrollY: Math.round(scrollY),
    // documentElement can be missing for a moment while a page is replaced.
    scrollHeight: doc.documentElement?.scrollHeight ?? 0,
    viewportHeight: innerHeight,
  };
}
