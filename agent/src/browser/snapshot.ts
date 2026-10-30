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

export function collectSnapshot(maxElements: number, maxText: number): PageSnapshot {
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
                      (input.type !== 'password' ? input.value : '') ||
                      input.placeholder || el.getAttribute('title') ||
                      img?.getAttribute('alt') || el.getAttribute('name'),
                  100);
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
      element.inputType = (el as HTMLInputElement).type || 'text';
    }
    elements.push(element);
  }

  // Prefer the main content, but some sites leave <main> empty and render
  // elsewhere; then read the whole body.
  const main = doc.querySelector('main, article, [role=main]') as HTMLElement | null;
  const mainText = main?.innerText ?? '';
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
    text: squash(mainText.trim().length >= 40 ? mainText : doc.body?.innerText, maxText),
    scrollY: Math.round(scrollY),
    scrollHeight: doc.documentElement.scrollHeight,
    viewportHeight: innerHeight,
  };
}
