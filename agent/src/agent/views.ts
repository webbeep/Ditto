// Answer views: the layout an answer is shown in (key facts, a list to
// pick from, steps, a comparison table, or prose), chosen like a decision
// (one decider question) and filled from what the page states: from its
// own structure (JSON-LD, lists, tables) when it has it, by the decider
// picking among the page's sentences and items when it does not, and by
// the LLM only as a last resort, with every value checked against the
// sources. It runs while the answer streams.

import type {PageStructure} from '../browser/structure.js';
import {choice, noul} from '../decider/decider_client.js';
import type {DeciderClient} from '../decider/decider_client.js';
import type {LlmClient} from '../llm/llm_client.js';
import {tokens} from './candidates.js';
import type {Evidence} from './prompts.js';

export type ViewKind = 'facts'|'list'|'steps'|'table'|'text';

export interface AnswerView {
  kind: Exclude<ViewKind, 'text'>;
  facts?: Array<{label: string, value: string}>;
  items?: Array<{title: string, detail?: string, url?: string}>;
  steps?: string[];
  table?: {columns: string[], rows: string[][]};
  // Where the contents came from.
  by: 'page'|'decider'|'llm';
}

interface Models {
  llm?: LlmClient|undefined;
  decider?: DeciderClient|undefined;
  signal?: AbortSignal|undefined;
}

const KINDS: Record<ViewKind, string> = {
  facts: 'a few key facts or numbers: a price, hours, a size, a date, a rating',
  list: 'several items to choose between: products, places, results, options, ideas',
  steps: 'steps to follow in order: how to do something, a recipe, instructions',
  table: 'a comparison of several things side by side, attribute by attribute',
  text: 'a short explanation or opinion in prose',
};

// Clear cases need no model.
export function obviousKind(task: string): ViewKind|undefined {
  if (/\b(vs\.?|versus|compare|comparison|difference between)\b/i.test(task)) {
    return 'table';
  }
  if (/\b(how (do|to|can)|steps?|recipe|instructions|guide)\b/i.test(task)) {
    return 'steps';
  }
  if (/\b(best|top \d*|options|alternatives|ideas|list|which .* (should|to))\b/i.test(task)) {
    return 'list';
  }
  return undefined;
}

export async function chooseKind(task: string, models: Models): Promise<ViewKind> {
  const known = obviousKind(task);
  if (known) {
    return known;
  }
  if (models.decider) {
    try {
      const result = await models.decider.decide({
        state: `Question: ${task}`,
        questions: {
          layout: {type: 'choice', instructions: `Which layout shows the answer best: ${task}`,
                   criteria: KINDS},
        },
      }, models.signal);
      const picked = choice(result, 'layout');
      return picked.confidence >= 0.2 ? picked.choice as ViewKind : 'text';
    } catch (error) {
      if (models.signal?.aborted) {
        throw error;
      }
    }
  }
  return /\b(price|cost|how much|when|hours|open|weigh|size|rating|date|how (many|long|big|old))\b/i
      .test(task) ? 'facts' : 'text';
}

// ---- Filling ---------------------------------------------------------------

const LABELS: Array<[RegExp, string]> = [
  [/\b(price|costs?|for)\b|[$€£¥]/i, 'Price'],
  [/\bweigh/i, 'Weight'],
  [/\b(open|hours)\b/i, 'Hours'],
  [/\bships?\b|\bdelivery\b/i, 'Shipping'],
  [/\b(started|founded|since|established)\b/i, 'Since'],
  [/\b(rated|rating|stars?)\b/i, 'Rating'],
  [/\b(warranty)\b/i, 'Warranty'],
  [/\b(size|dimensions?|measures?)\b/i, 'Size'],
];

// What a question asks for, as the fact's label: "what does it cost?" wants
// the price, not the weight the same sentence names.
const ASKED: Array<[RegExp, string]> = [
  [/\b(price|prices|cost|costs|how much|pay)\b/i, 'Price'],
  [/\b(weigh|weighs|weight|heavy)\b/i, 'Weight'],
  [/\b(open|opening|hours|close|closes)\b/i, 'Hours'],
  [/\b(ship|ships|shipping|delivery|deliver)\b/i, 'Shipping'],
  [/\b(when did|founded|started|since|established)\b/i, 'Since'],
  [/\b(rating|rated|stars|reviews?)\b/i, 'Rating'],
  [/\bwarranty\b/i, 'Warranty'],
  [/\b(size|dimensions?|how (?:big|long|tall|wide))\b/i, 'Size'],
];

const VALUE = /(?:[$€£¥]\s?\d[\d,.]*|\d[\d,.]*\s?(?:%|kg|g|lb|oz|cm|mm|m|km|in|ft|gb|tb|mb|mph|km\/h|stars?|years?|days?|hours?|minutes?|am|pm)\b|\d{4}\b|\d[\d,.]*)/i;

// "Price: $19", "weighs 80 g", "open from 9 am to 7 pm": a label and a
// value from one sentence, or null.
export function factOf(sentence: string): {label: string, value: string}|null {
  const colon = sentence.match(/([A-Z][\w ]{1,24}):\s*([^.;]{1,40})/);
  if (colon) {
    return {label: colon[1]!.trim(), value: colon[2]!.trim()};
  }
  const hours = sentence.match(/\b(?:from\s+)?(\d{1,2}(?::\d\d)?\s?(?:am|pm)\s*(?:to|-|–)\s*\d{1,2}(?::\d\d)?\s?(?:am|pm))(?:,?\s*([A-Z][a-z]+(?:day)?\s*(?:to|through|-|–)\s*[A-Z][a-z]+day))?/i);
  if (hours) {
    return {label: 'Hours', value: [hours[1], hours[2]].filter(Boolean).join(', ')};
  }
  const value = sentence.match(VALUE);
  if (!value) {
    return null;
  }
  const before = sentence.slice(0, value.index);
  const label = LABELS.find(([pattern]) => pattern.test(`${before.slice(-30)}${value[0]}`))?.[1];
  return label ? {label, value: value[0].trim()} : null;
}

// Sentences, and their clauses ("$49, and it ships within 2 days" holds
// two facts).
function sentencesOf(evidence: Evidence[]): string[] {
  return evidence.flatMap(e => e.passages)
      .flatMap(p => p.split(/(?<=[.!?])\s+|\n+/))
      .flatMap(s => s.split(/,\s+(?:and|but|while)\s+|;\s+/))
      .map(s => s.trim())
      .filter(s => s.length > 3 && s.length < 240);
}

// Whether the sources say it: every word of a value appears in them.
function grounded(value: string, evidence: Evidence[]): boolean {
  const text = evidence.flatMap(e => e.passages).join(' ').toLowerCase();
  return value.toLowerCase().split(/\s+/).filter(w => w.length > 1)
      .every(w => text.includes(w.replace(/[.,;:]$/, '')));
}

// One yes/no per candidate, all at once (the router runs them in parallel).
async function keepAsked(task: string, candidates: string[], models: Models): Promise<boolean[]> {
  if (!models.decider) {
    return candidates.map(() => true);
  }
  const decider = models.decider;
  return Promise.all(candidates.map(async candidate => {
    try {
      const result = await decider.decide({
        state: candidate,
        questions: {asked: {type: 'noul', instructions: `Is this part of what was asked: ${task}`}},
      }, models.signal);
      return noul(result, 'asked') >= 0.5;
    } catch {
      return false;
    }
  }));
}

function jsonLdFacts(structure: PageStructure|null): Array<{label: string, value: string}> {
  const facts: Array<{label: string, value: string}> = [];
  for (const item of structure?.jsonld ?? []) {
    const offers = (Array.isArray(item['offers']) ? item['offers'][0] : item['offers']) as
        Record<string, unknown>|undefined;
    if (offers?.['price'] !== undefined) {
      facts.push({label: 'Price', value: `${offers['priceCurrency'] === 'USD' ? '$' : ''}` +
                                          `${String(offers['price'])}` +
                                          `${offers['priceCurrency'] && offers['priceCurrency'] !== 'USD' ?
                                              ` ${String(offers['priceCurrency'])}` : ''}`});
    }
    const availability = String(offers?.['availability'] ?? '');
    if (availability) {
      facts.push({label: 'Availability', value: availability.replace(/^.*\//, '').replace(/([a-z])([A-Z])/g, '$1 $2')});
    }
    const rating = item['aggregateRating'] as Record<string, unknown>|undefined;
    if (rating?.['ratingValue'] !== undefined) {
      facts.push({label: 'Rating', value: `${String(rating['ratingValue'])}` +
                                           `${rating['reviewCount'] ? ` (${String(rating['reviewCount'])} reviews)` : ''}`});
    }
    for (const [key, label] of [['openingHours', 'Hours'], ['startDate', 'Date'],
                                ['telephone', 'Phone']] as const) {
      if (typeof item[key] === 'string') {
        facts.push({label, value: item[key] as string});
      }
    }
  }
  return facts.slice(0, 6);
}

function overlap(task: string, text: string): number {
  const want = new Set(tokens(task));
  return tokens(text).filter(t => want.has(t)).length;
}

async function fillFacts(task: string, evidence: Evidence[], structure: PageStructure|null,
                         models: Models): Promise<AnswerView|null> {
  const fromPage = jsonLdFacts(structure);
  if (fromPage.length >= 2) {
    return {kind: 'facts', facts: fromPage, by: 'page'};
  }
  // Sentences that state a value, closest to the question first; the
  // decider keeps the ones that answer it.
  // The kind of value asked for first, then the closest sentences.
  const asked = ASKED.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const wanted = (label: string) => Number(asked.includes(label));
  const candidates = sentencesOf(evidence)
      .map(sentence => ({sentence, fact: factOf(sentence)}))
      .filter(c => c.fact)
      .sort((a, b) => wanted(b.fact!.label) - wanted(a.fact!.label) ||
                      overlap(task, b.sentence) - overlap(task, a.sentence))
      .slice(0, 8);
  const keep = await keepAsked(task, candidates.map(c => c.sentence), models);
  // The asked kind is always kept (a decider shown "Price: $19." alone
  // doubted it); other facts follow it.
  const facts = candidates.filter((_, i) => keep[i] || wanted(candidates[i]!.fact!.label))
      .map(c => c.fact!)
      .filter((fact, i, all) => all.findIndex(f => f.label === fact.label) === i)
      .slice(0, 6);
  // Prose says the rest: key facts are never made up by the LLM.
  return facts.length ? {kind: 'facts', facts, by: models.decider ? 'decider' : 'page'} : null;
}

async function fillList(task: string, evidence: Evidence[], structure: PageStructure|null,
                        models: Models): Promise<AnswerView|null> {
  const list = (structure?.lists ?? [])
      .map(l => ({l, score: overlap(task, `${l.heading} ${l.items.map(i => i.text).join(' ')}`)}))
      .sort((a, b) => b.score - a.score)[0];
  if (list && list.score > 0) {
    const items = list.l.items.slice(0, 10);
    const keep = await keepAsked(task, items.map(i => i.text), models);
    const kept = items.filter((_, i) => keep[i]);
    const shown = (kept.length >= 2 ? kept : items).slice(0, 8);
    return {
      kind: 'list',
      items: shown.map(i => {
        const [title, ...rest] = i.text.split(/\s+[—–-]\s+|:\s+|\.\s+/);
        return {title: title!.slice(0, 80), ...(rest.length ? {detail: rest.join(' ').slice(0, 140)} : {}),
                ...(i.href ? {url: i.href} : {})};
      }),
      by: kept.length >= 2 && models.decider ? 'decider' : 'page',
    };
  }
  return fromLlm('list', task, evidence, models);
}

async function fillSteps(task: string, evidence: Evidence[], structure: PageStructure|null,
                         models: Models): Promise<AnswerView|null> {
  for (const item of structure?.jsonld ?? []) {
    const instructions = item['recipeInstructions'] ?? item['step'];
    if (Array.isArray(instructions) && instructions.length >= 2) {
      const steps = instructions.map(s => (typeof s === 'string' ? s : String((s as Record<string, unknown>)['text'] ?? '')))
          .filter(Boolean).slice(0, 12);
      if (steps.length >= 2) {
        return {kind: 'steps', steps, by: 'page'};
      }
    }
  }
  const ordered = (structure?.lists ?? []).filter(l => l.ordered)
      .sort((a, b) => overlap(task, b.heading + b.items.map(i => i.text).join(' ')) -
                      overlap(task, a.heading + a.items.map(i => i.text).join(' ')))[0];
  if (ordered) {
    return {kind: 'steps', steps: ordered.items.map(i => i.text).slice(0, 12), by: 'page'};
  }
  return fromLlm('steps', task, evidence, models);
}

async function fillTable(task: string, evidence: Evidence[], structure: PageStructure|null,
                         models: Models): Promise<AnswerView|null> {
  const table = (structure?.tables ?? [])
      .map(t => ({t, score: overlap(task, t.caption + t.rows.flat().join(' '))}))
      .sort((a, b) => b.score - a.score)[0];
  if (table) {
    const [columns, ...rows] = table.t.rows;
    return {kind: 'table', table: {columns: columns!, rows}, by: 'page'};
  }
  return fromLlm('table', task, evidence, models);
}

const LLM_SCHEMAS: Record<AnswerView['kind'], object> = {
  facts: {type: 'object', required: ['facts'], properties: {facts: {type: 'array', maxItems: 6,
    items: {type: 'object', required: ['label', 'value'],
            properties: {label: {type: 'string'}, value: {type: 'string'}}}}}},
  list: {type: 'object', required: ['items'], properties: {items: {type: 'array', maxItems: 8,
    items: {type: 'object', required: ['title', 'detail'],
            properties: {title: {type: 'string'}, detail: {type: 'string'}}}}}},
  steps: {type: 'object', required: ['steps'], properties: {steps: {type: 'array', maxItems: 12,
    items: {type: 'string'}}}},
  table: {type: 'object', required: ['columns', 'rows'], properties: {
    columns: {type: 'array', items: {type: 'string'}, maxItems: 5},
    rows: {type: 'array', maxItems: 8, items: {type: 'array', items: {type: 'string'}}}}},
};

// The last resort: the LLM fills the view from the sources, and only what
// the sources say is kept. Without an LLM in `models`, nothing.
export async function fromLlm(kind: AnswerView['kind'], task: string, evidence: Evidence[],
                       models: Models): Promise<AnswerView|null> {
  if (!models.llm) {
    return null;
  }
  const sources = evidence.map((e, i) => `[${i + 1}] ${e.title}\n${e.passages.join('\n')}`)
      .join('\n\n').slice(0, 6000);
  try {
    const reply = await models.llm.json<Record<string, any>>([
      {role: 'system', content: `Fill a ${kind} view of the answer to the user's question, ` +
          'using only what the sources state, word for word where you can. Reply with JSON.'},
      {role: 'user', content: `Question: ${task}\n\nSources:\n${sources}`},
    ], LLM_SCHEMAS[kind], {maxTokens: 400, ...(models.signal ? {signal: models.signal} : {})});
    switch (kind) {
      case 'facts': {
        const facts = (reply['facts'] ?? []).filter(
            (f: {value: string}) => f?.value && grounded(f.value, evidence));
        return facts.length ? {kind, facts, by: 'llm'} : null;
      }
      case 'list': {
        const items = (reply['items'] ?? []).filter(
            (i: {title: string}) => i?.title && grounded(i.title, evidence));
        return items.length >= 2 ? {kind, items, by: 'llm'} : null;
      }
      case 'steps': {
        const steps = (reply['steps'] ?? []).filter((s: unknown) => typeof s === 'string' && s);
        return steps.length >= 2 ? {kind, steps, by: 'llm'} : null;
      }
      case 'table': {
        const columns = reply['columns'] ?? [];
        const rows = (reply['rows'] ?? []).filter(
            (r: string[]) => Array.isArray(r) && r.length && grounded(r[0] ?? '', evidence));
        return columns.length >= 2 && rows.length >= 2 ? {kind, table: {columns, rows}, by: 'llm'} :
            null;
      }
    }
  } catch (error) {
    if (models.signal?.aborted) {
      throw error;
    }
  }
  return null;
}

// The view for an answer (null for prose) and the layout chosen. Without
// an LLM in `models` the view comes from the page and the decider alone
// (fast, alongside the answer); `fromLlm` can fill a list, steps or a
// table afterwards.
export async function buildView(task: string, evidence: Evidence[],
                                structure: PageStructure|null,
                                models: Models): Promise<{view: AnswerView|null, kind: ViewKind}> {
  if (!evidence.length) {
    return {view: null, kind: 'text'};
  }
  const kind = await chooseKind(task, models);
  switch (kind) {
    case 'facts': return {view: await fillFacts(task, evidence, structure, models), kind};
    case 'list': return {view: await fillList(task, evidence, structure, models), kind};
    case 'steps': return {view: await fillSteps(task, evidence, structure, models), kind};
    case 'table': return {view: await fillTable(task, evidence, structure, models), kind};
    default: return {view: null, kind};
  }
}
