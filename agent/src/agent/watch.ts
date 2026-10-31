// Watches: Ditto reads a page again on a schedule and tells the user when
// what they asked about happens ("tell me when this drops below $40",
// "watch this page for new episodes"). The page is read by the agent in its
// own tab, like any question; this module decides what to read, how often,
// and whether a new reading is news.

import type {DeciderClient} from '../decider/decider_client.js';
import {noul} from '../decider/decider_client.js';
import type {ChatMessage, LlmClient} from '../llm/llm_client.js';

export interface Watch {
  id: string;
  url: string;
  title: string;
  // What to read off the page each time ("What is the price of …?").
  question: string;
  // When to tell the user ("the price is below $40"); empty: on any change.
  condition: string;
  everyMinutes: number;
  createdAt: number;
  checkedAt: number;
  // The last reading, to tell a change.
  last: string;
  // Whether the condition held at the last reading: the user is told when
  // it starts holding, not again while it keeps holding.
  met: boolean;
  toldAt?: number;
}

export interface WatchPlan {
  question: string;
  condition: string;
  everyMinutes: number;
}

export const DEFAULT_MINUTES = 60;
// Pages are not checked more often than this (the models run each time).
export const MIN_MINUTES = 15;

const ASKS = new RegExp(
    '^\\s*(?:please\\s+)?(?:watch|monitor|track|keep (?:an )?eye on|' +
    '(?:notify|alert|ping|tell) me (?:when|if|once|whenever)|' +
    'let me know (?:when|if|once|whenever))\\b', 'i');

export function isWatchRequest(text: string): boolean {
  return ASKS.test(text);
}

const UNITS: Record<string, number> = {minute: 1, min: 1, hour: 60, hr: 60, day: 1440};

// "every 2 hours", "every 30 minutes", "hourly", "daily".
export function intervalOf(text: string): number|undefined {
  if (/\bhourly\b/i.test(text)) {
    return 60;
  }
  if (/\b(daily|every day|once a day)\b/i.test(text)) {
    return 1440;
  }
  const match = text.match(/\bevery\s+(\d+)?\s*(minute|min|hour|hr|day)s?\b/i);
  if (!match) {
    return undefined;
  }
  return Math.max(MIN_MINUTES, Number(match[1] ?? 1) * UNITS[match[2]!.toLowerCase()]!);
}

// The condition in the user's words: what follows "when", "if" or "once".
// "When it changes" is no condition: any change is news.
export function conditionOf(text: string): string {
  const match = text.match(/\b(?:when|if|once|whenever)\s+(.+?)(?:[.?!]|\s+every\s|$)/i);
  const condition = match?.[1]?.trim() ?? '';
  return /^(?:it|this|that|this page|the page)?\s*(?:changes?|updates?|is updated)$/i
      .test(condition) ? '' : condition;
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    question: {type: 'string'},
    condition: {type: 'string'},
  },
  required: ['question', 'condition'],
};

function planMessages(request: string, page: {title: string, url: string}): ChatMessage[] {
  return [
    {role: 'system', content:
        'The user wants to be told when something happens on a web page. Reply in JSON. ' +
        '"question": what to read off the page each time, as one short question ' +
        '(e.g. "What is the price of the Acme Widget Pro?"). "condition": when to tell ' +
        'the user, in a few words (e.g. "the price is below $40"), or "" to tell them ' +
        'whenever it changes.'},
    {role: 'user', content: `Page: ${page.title} <${page.url}>\nRequest: ${request}`},
  ];
}

export async function planWatch(request: string, page: {title: string, url: string},
                                llm?: LlmClient, signal?: AbortSignal): Promise<WatchPlan> {
  const everyMinutes = intervalOf(request) ?? DEFAULT_MINUTES;
  const fallback = {
    question: `What does this page say about this: ${request.trim()}`,
    condition: conditionOf(request),
    everyMinutes,
  };
  if (!llm) {
    return fallback;
  }
  try {
    const reply = await llm.json<{question?: string, condition?: string}>(
        planMessages(request, page), PLAN_SCHEMA,
        {maxTokens: 96, ...(signal ? {signal} : {})});
    const question = reply.question?.trim();
    if (!question) {
      return fallback;
    }
    return {question, condition: reply.condition?.trim() ?? fallback.condition, everyMinutes};
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return fallback;
  }
}

// Amounts in a reading ("$1,299.00" -> 1299), citations left out.
export function amounts(text: string): number[] {
  return [...text.replace(/\[\d+\]/g, '').matchAll(/(\d[\d,]*(?:\.\d+)?)/g)]
      .map(m => Number(m[1]!.replace(/,/g, '')))
      .filter(n => Number.isFinite(n));
}

// Conditions a computer should check rather than a small model: "below $40",
// "over 100", "at least 4.5". Undefined when the condition is not one.
export function compareCondition(condition: string, reading: string): boolean|undefined {
  const match = condition.match(new RegExp(
      '\\b(below|under|less than|cheaper than|lower than|drops? (?:below|under|to)|' +
      'above|over|more than|greater than|higher than|exceeds?|rises? (?:above|over|to)|' +
      'at least|at most|no more than)\\s*(?:[$€£¥]\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)', 'i'));
  if (!match) {
    return undefined;
  }
  const limit = Number(match[2]!.replace(/,/g, ''));
  // The amount the reading is about: a price if there is one, else the first.
  const price = reading.match(/[$€£¥]\s*(\d[\d,]*(?:\.\d+)?)/);
  const value = price ? Number(price[1]!.replace(/,/g, '')) : amounts(reading)[0];
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  const op = match[1]!.toLowerCase();
  if (/at most|no more than/.test(op)) {
    return value <= limit;
  }
  if (/at least/.test(op)) {
    return value >= limit;
  }
  if (/drops? to|rises? to/.test(op)) {
    return /drop/.test(op) ? value <= limit : value >= limit;
  }
  return /below|under|less|cheaper|lower|drop/.test(op) ? value < limit : value > limit;
}

export interface Verdict {
  // Tell the user now.
  notify: boolean;
  met: boolean;
  changed: boolean;
}

interface Judges {
  llm?: LlmClient|undefined;
  decider?: DeciderClient|undefined;
  signal?: AbortSignal|undefined;
}

async function yes(question: string, state: string, judges: Judges): Promise<boolean|undefined> {
  const {llm, decider, signal} = judges;
  try {
    if (decider) {
      const result = await decider.decide(
          {state, questions: {answer: {type: 'noul', instructions: question}}}, signal);
      return noul(result, 'answer') >= 0.5;
    }
    if (llm) {
      const reply = await llm.json<{yes: boolean}>(
          [{role: 'system', content: 'Answer the question about the text in JSON: {"yes": true|false}.'},
           {role: 'user', content: `${state}\n\nQuestion: ${question}`}],
          {type: 'object', properties: {yes: {type: 'boolean'}}, required: ['yes']},
          {maxTokens: 16, ...(signal ? {signal} : {})});
      return reply.yes;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
  }
  return undefined;
}

const words = (text: string) =>
    text.toLowerCase().replace(/\[\d+\]/g, '').replace(/[^\p{L}\p{N}$€£.]+/gu, ' ').trim();

// Whether a new reading is news: the condition starts to hold, or, with no
// condition, the facts changed (the models word the same facts differently
// each time, so amounts decide when there are any).
export async function judgeWatch(watch: Pick<Watch, 'condition'|'last'|'met'>,
                                 reading: string, judges: Judges = {}): Promise<Verdict> {
  // The set of amounts: "episode 3 of 3" and "3 episodes; the latest is 3"
  // say the same.
  const set = (text: string) => [...new Set(amounts(text))].sort((a, b) => a - b).join(' ');
  const before = set(watch.last);
  const now = set(reading);
  let changed: boolean;
  if (before || now) {
    changed = before !== now;
  } else if (words(watch.last) === words(reading)) {
    changed = false;
  } else {
    const same = await yes('Do the two readings say the same thing?',
                           `Before: ${watch.last}\nNow: ${reading}`, judges);
    changed = same === undefined ? true : !same;
  }
  if (!watch.condition) {
    return {notify: changed && !!watch.last, met: false, changed};
  }
  const met = compareCondition(watch.condition, reading) ??
      await yes(`Does this reading meet the condition: ${watch.condition}?`, reading, judges) ??
      false;
  return {notify: met && !watch.met, met, changed};
}

export function everyLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    return minutes === 1440 ? 'daily' : `every ${minutes / 1440} days`;
  }
  if (minutes % 60 === 0) {
    return minutes === 60 ? 'hourly' : `every ${minutes / 60} hours`;
  }
  return `every ${minutes} minutes`;
}

export function isDue(watch: Watch, now = Date.now()): boolean {
  return now - watch.checkedAt >= watch.everyMinutes * 60_000;
}
