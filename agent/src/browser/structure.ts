// Runs inside the page (serialized like collectSnapshot): what the page
// states in structured form, for filling an answer view without a model:
// schema.org JSON-LD (products, recipes, events, places), tables, and lists
// in the main content. Self-contained.

export interface PageStructure {
  jsonld: Array<Record<string, unknown>>;
  tables: Array<{caption: string, rows: string[][]}>;
  lists: Array<{heading: string, ordered: boolean, items: Array<{text: string, href: string}>}>;
}

export function collectStructure(): PageStructure {
  const clip = (s: string | null | undefined, n = 120) =>
      (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const jsonld: Array<Record<string, unknown>> = [];
  for (const script of Array.from(
           document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 8)) {
    try {
      const data = JSON.parse(script.textContent ?? '');
      const graph = Array.isArray(data) ? data : data['@graph'] ?? [data];
      for (const item of graph) {
        if (item && typeof item === 'object' && jsonld.length < 12) {
          jsonld.push(item as Record<string, unknown>);
        }
      }
    } catch {
      // Not JSON: skip.
    }
  }
  // Content, not the site's own navigation.
  const outside = (el: Element) => !!el.closest('nav, header, footer, aside, [role=navigation]');
  const tables: PageStructure['tables'] = [];
  for (const table of Array.from(document.querySelectorAll('table'))) {
    if (tables.length >= 3 || outside(table)) {
      continue;
    }
    const rows = Array.from(table.rows).slice(0, 12)
        .map(row => Array.from(row.cells).slice(0, 6).map(cell => clip(cell.textContent, 80)))
        .filter(row => row.some(Boolean));
    if (rows.length >= 2) {
      tables.push({caption: clip(table.caption?.textContent), rows});
    }
  }
  const lists: PageStructure['lists'] = [];
  for (const list of Array.from(document.querySelectorAll('ul, ol'))) {
    if (lists.length >= 6 || outside(list) || list.closest('li')) {
      continue;
    }
    const items = Array.from(list.children).filter(li => li.tagName === 'LI').slice(0, 15)
        .map(li => ({text: clip(li.textContent, 160),
                     href: (li.querySelector('a[href]') as HTMLAnchorElement | null)?.href ?? ''}))
        .filter(item => item.text);
    if (items.length < 3) {
      continue;
    }
    // The nearest heading before the list names it.
    let heading = '';
    for (let el: Element | null = list; el && !heading; el = el.previousElementSibling ?? el.parentElement) {
      if (/^H[1-4]$/.test(el.tagName) && el !== list) {
        heading = clip(el.textContent, 80);
      }
      if (el === document.body) {
        break;
      }
    }
    lists.push({heading, ordered: list.tagName === 'OL', items});
  }
  return {jsonld, tables, lists};
}

// Marks the sentence an answer was read from and brings it into view, for
// the picture of the page Ditto shows with the answer: the quote, else its
// longest sentence that one block on the page holds. Self-contained.
export function highlightQuote(quote: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = [norm(quote), ...quote.split(/(?<=[.!?])\s+/).map(norm)
      .sort((a, b) => b.length - a.length)]
      .map(s => s.slice(0, 80)).filter(s => s.length >= 12);
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(
      'p, li, td, dd, blockquote, h1, h2, h3, h4'));
  for (const want of wanted) {
    const block = blocks.find(el => norm(el.textContent ?? '').includes(want));
    if (block) {
      block.style.setProperty('background', 'rgba(99, 102, 241, 0.18)');
      block.style.setProperty('box-shadow', '0 0 0 4px rgba(99, 102, 241, 0.18)');
      block.style.setProperty('border-radius', '4px');
      block.scrollIntoView({block: 'center'});
      return true;
    }
  }
  return false;
}
