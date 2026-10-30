// Turns a page snapshot into the short list of options the decider chooses
// from. Decision models answer over a fixed option set in one pass, so the
// quality of this list bounds the agent's navigation quality: keep the
// likely-useful elements, drop what was already tried.

import type {PageElement, PageSnapshot} from '../browser/snapshot.js';
import type {PageAction} from '../browser/page_driver.js';

export interface Candidate {
  key: string;
  description: string;
  action: PageAction;
  score: number;
}

const STOPWORDS = new Set((
    'a an and are as at be by for from has have how i in is it its of on or ' +
    'that the this to was what when where which who why will with you your ' +
    'me my find show tell get give please can could would about').split(' '));

export function tokens(text: string): string[] {
  return text.toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function overlap(goal: Set<string>, text: string): number {
  let score = 0;
  for (const token of tokens(text)) {
    if (goal.has(token)) {
      score += 1;
    } else {
      for (const g of goal) {
        // Cheap stemming: "prices" ~ "pricing" ~ "price".
        if (g.length >= 4 && token.length >= 4 && g.slice(0, 4) === token.slice(0, 4)) {
          score += 0.5;
          break;
        }
      }
    }
  }
  return score;
}

function describe(element: PageElement): string {
  let text = `${element.kind} "${element.label || '(no label)'}"`;
  if (element.href) {
    try {
      const url = new URL(element.href);
      text += ` -> ${url.host}${url.pathname}`.replace(/\/$/, '');
    } catch {
      // Keep the label only.
    }
  }
  return text;
}

export interface CandidateOptions {
  goal: string;
  visited: ReadonlySet<string>;
  // Text to type when a textbox is chosen; textboxes are only offered when
  // there is something to type.
  typeText?: string;
  canGoBack: boolean;
  limit?: number;
}

export function buildCandidates(page: PageSnapshot,
                                options: CandidateOptions): Candidate[] {
  const goal = new Set(tokens(options.goal));
  const current = stripHash(page.url);
  const candidates: Candidate[] = [];
  for (const element of page.elements) {
    if (element.href) {
      const target = stripHash(element.href);
      if (target === current || options.visited.has(target)) {
        continue;
      }
    }
    let score = overlap(goal, element.label) * 2;
    if (element.href) {
      score += overlap(goal, element.href);
    }
    if (element.inViewport) {
      score += 0.25;
    }
    let action: PageAction;
    if (element.kind === 'textbox' || element.kind === 'searchbox') {
      if (!options.typeText) {
        continue;
      }
      action = {kind: 'type', id: element.id, text: options.typeText, submit: true};
      // A search box is the best first move on a page with no matching links.
      score += /search|query|q\b/i.test(element.label) ? 1.5 : 0.5;
    } else {
      action = {kind: 'click', id: element.id};
    }
    candidates.push({key: `e${element.id}`, description: describe(element), action, score});
  }
  candidates.sort((a, b) => b.score - a.score);
  const limited = candidates.slice(0, options.limit ?? 24);

  if (page.scrollY + page.viewportHeight < page.scrollHeight - 40) {
    limited.push({
      key: 'scroll_down',
      description: 'scroll down to see more of this page',
      action: {kind: 'scroll', direction: 'down'},
      score: 0,
    });
  }
  if (options.canGoBack) {
    limited.push({
      key: 'go_back',
      description: 'go back to the previous page',
      action: {kind: 'back'},
      score: 0,
    });
  }
  return limited;
}

export function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

// Splits page text into passages and keeps the ones closest to the goal; used
// to keep decider state and LLM context small.
export function topPassages(text: string, goal: string, count: number,
                            size = 400): string[] {
  const goalTokens = new Set(tokens(goal));
  const sentences = text.split(/(?<=[.!?])\s+/);
  const passages: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > size) {
      passages.push(current);
      current = '';
    }
    current += (current ? ' ' : '') + sentence;
  }
  if (current) {
    passages.push(current);
  }
  return passages
      .map((passage, index) => ({passage, index, score: overlap(goalTokens, passage)}))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, count)
      .sort((a, b) => a.index - b.index)
      .map(p => p.passage);
}
