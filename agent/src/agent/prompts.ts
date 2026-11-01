// Prompts and output schemas for the responder LLM. Small models follow
// short, concrete instructions and grammar-constrained JSON far better than
// open-ended agent prompts, so each call does exactly one job.

import type {ChatMessage} from '../llm/llm_client.js';
import type {Candidate} from './candidates.js';

export interface Plan {
  start: 'current'|'url'|'search';
  url: string;
  searchQuery: string;
  goal: string;
}

// What the LLM writes for a plan. It never writes a URL (small models
// invent them): it may only pick one of the user's own pages to start on.
export interface PlanReply {
  searchQuery: string;
  goal: string;
  // 1-based index into the user's pages; 0 for none.
  startPage?: number;
}

export function planSchema(pages: number): object {
  return {
    type: 'object',
    properties: {
      searchQuery: {type: 'string'},
      goal: {type: 'string'},
      ...(pages ? {startPage: {type: 'integer', enum: Array.from({length: pages + 1}, (_, i) => i)}} :
                  {}),
    },
    required: ['searchQuery', 'goal', ...(pages ? ['startPage'] : [])],
  };
}

// One of the user's own pages (a bookmark or a history entry).
export interface SavedPage {
  url: string;
  title: string;
  timeMs: number;
  bookmark: boolean;
}

// What the agent knows about the user for one request. Not the sites they
// usually use: a small model handed "Sites the user often uses: …" plans
// and answers with that instead of the request.
export interface UserContext {
  // Notes from memory that bear on the request.
  notes: string[];
  // Bookmarks and history matching the request.
  pages: SavedPage[];
}

export const NO_USER: UserContext = {notes: [], pages: []};

function aboutUser(user: UserContext): string {
  return user.notes.length ?
      `About the user:\n${user.notes.map(n => `- ${n}`).join('\n')}\n\n` : '';
}

// For writing an answer: notes that tailor it (units, language, where they
// live), marked as not a source.
function tailoring(user: UserContext): string {
  return user.notes.length ?
      `To tailor the answer (not a source; never cite or repeat it):\n` +
      `${user.notes.map(n => `- ${n}`).join('\n')}\n\n` : '';
}

export interface PastTurn {
  question: string;
  answer: string;
}

function historyText(history: PastTurn[]): string {
  return history.map(t => `User: ${t.question}\nYou: ${t.answer}`).join('\n\n');
}

export function planMessages(task: string, currentUrl: string, currentTitle: string,
                             history: PastTurn[] = [],
                             user: UserContext = NO_USER): ChatMessage[] {
  const earlier = history.length ? `Earlier in this chat:\n${historyText(history)}\n\n` : '';
  const pages = user.pages.length ?
      `The user's own pages:\n${user.pages.map((p, i) =>
          `${i + 1}. ${p.title || p.url} <${p.url}> (${p.bookmark ? 'bookmark' : 'visited'})`)
          .join('\n')}\n\n` : '';
  return [
    {
      role: 'system',
      content: 'You plan web browsing for a user. Reply with JSON only.\n' +
          '- goal: one standalone sentence saying what the final page must ' +
          'show (resolve words like "it" or "that one" using the chat). Fix ' +
          'misspelled words. Use what you know about the user only to fill ' +
          'in what the request leaves open (their city for "weather"); never ' +
          'mention the user. Name what to find, not where: no page titles or ' +
          'addresses.\n' +
          '- searchQuery: a short web search query for the goal, spelled ' +
          'correctly.' +
          (user.pages.length ?
               '\n- startPage: the number of one of the user\'s own pages to ' +
               'start from when the request is clearly about it or meant to be ' +
               'done there (their store, their account, a page they read); ' +
               'else 0.' : ''),
    },
    {
      role: 'user',
      content: `${earlier}${aboutUser(user)}${pages}` +
          `Open page: ${currentTitle || '(none)'} <${currentUrl}>\nRequest: ${task}`,
    },
  ];
}

export const LEARN_SCHEMA = {
  type: 'object',
  properties: {notes: {type: 'array', items: {type: 'string'}, maxItems: 3}},
  required: ['notes'],
};

// After a task: what it showed about the user that is worth remembering.
export function learnMessages(task: string, answer: string, known: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You keep short notes about a user so their browser can tailor ' +
          'answers and tasks to them. From the request, write lasting facts ' +
          'about the user: preferences, needs, where they live, what they own ' +
          'or use, how they like answers. Only what the user\'s own words ' +
          'show; nothing about the topic itself, nothing one-off, no guesses, ' +
          'no passwords or card numbers. If the user asks you to remember ' +
          'something, note it. One short sentence per note, starting with ' +
          '"User". Reply with JSON only: {"notes": [...]}, empty when there ' +
          'is nothing new.',
    },
    {
      role: 'user',
      content: `${known.length ? `Already noted:\n${known.map(n => `- ${n}`).join('\n')}\n\n` : ''}` +
          `Request: ${task}\nAnswer: ${answer.slice(0, 600)}`,
    },
  ];
}

export const CHECK_SCHEMA = {
  type: 'object',
  properties: {answered: {type: 'boolean'}},
  required: ['answered'],
};

export function checkMessages(question: string, answer: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'Reply with JSON only: "answered" is true if the answer gives the ' +
          'information the question asks for, false if it says it could not find it.',
    },
    {role: 'user', content: `Question: ${question}\nAnswer: ${answer}`},
  ];
}

export const FIELD_SCHEMA = {
  type: 'object',
  properties: {text: {type: 'string'}},
  required: ['text'],
};

export function fieldMessages(goal: string, field: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You fill in one form field for a user. Reply with JSON only: ' +
          '"text" is exactly what to type into the field.',
    },
    {role: 'user', content: `Goal: ${goal}\nField: ${field}`},
  ];
}

export function stepSchema(candidates: Candidate[]): object {
  return {
    type: 'object',
    properties: {
      done: {type: 'boolean'},
      action: {type: 'string', enum: candidates.map(c => c.key)},
    },
    required: ['done', 'action'],
  };
}

export function stepMessages(goal: string, pageView: string,
                             candidates: Candidate[]): ChatMessage[] {
  const options = candidates.map(c => `${c.key}: ${c.description}`).join('\n');
  return [
    {
      role: 'system',
      content: 'You navigate a web page toward a goal. Reply with JSON only: ' +
          '"done" is true if this page already shows what the goal needs; ' +
          '"action" is the key of the option that gets closest to the goal.',
    },
    {
      role: 'user',
      content: `Goal: ${goal}\n\nPage:\n${pageView}\n\nOptions:\n${options}`,
    },
  ];
}

export interface Evidence {
  url: string;
  title: string;
  passages: string[];
}

export function answerMessages(task: string, evidence: Evidence[],
                               history: PastTurn[] = [],
                               user: UserContext = NO_USER,
                               list: boolean|'list'|'insist' = false): ChatMessage[] {
  const sources = evidence.map((e, i) =>
      `[${i + 1}] ${e.title} <${e.url}>\n${e.passages.join('\n')}`).join('\n\n');
  const earlier = history.length ? `Earlier in this chat:\n${historyText(history)}\n\n` : '';
  return [
    {
      role: 'system',
      content: 'Answer the request from the sources. Start with the direct answer in ' +
          'one sentence. If the request asks for several things (a list, a ' +
          'comparison, steps, scores, results), follow with short bullet points, ' +
          'one per item. Use only the sources and cite them as [1], [2]. Read ' +
          'misspelled words as what they clearly mean. No preamble, no repeating ' +
          'the question, no reasoning. If the sources do not contain the answer, ' +
          'say so in one sentence.' +
          // A small model asked for scores described the page ("The source
          // lists the scores for several teams") instead of giving them.
          (list ? ' The request asks for a list (scores, results, headlines): give ' +
                  'the items themselves, one bullet each, read from the sources (a ' +
                  'game: both teams and their scores, e.g. "Lions 98, Tigers 95 ' +
                  '(final)"). Never describe the sources instead.' : '') +
          (list === 'insist' ? ' The sources do list them: write them out.' : ''),
    },
    {role: 'user',
     content: `${earlier}${tailoring(user)}Sources:\n${sources}\n\nRequest: ${task}`},
  ];
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    found: {type: 'boolean'},
    answer: {type: 'string'},
    quote: {type: 'string'},
  },
  required: ['found', 'answer', 'quote'],
};

// Is the answer on this page? `quote` must be copied from the page, so the
// agent can check it is really there.
export function extractMessages(task: string, goal: string, title: string,
                                passages: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'Decide whether this page contains what the request asks for. ' +
          'Reply with JSON only: "found" is true only if the page itself states ' +
          'it; "answer" is the information, in a few words; "quote" is the ' +
          'sentence from the page that states it, copied exactly. If it is not ' +
          'there, found is false and the others are empty.',
    },
    {
      role: 'user',
      content: `Request: ${task}\nGoal: ${goal}\n\nPage: ${title}\n${passages.join('\n')}`,
    },
  ];
}

export function optionSchema(options: string[]): object {
  return {
    type: 'object',
    properties: {option: {type: 'string', enum: options}},
    required: ['option'],
  };
}

export function optionMessages(goal: string, field: string, options: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You choose one option of a form field for a user. Reply with JSON ' +
          'only: "option" is the option that fits the goal.',
    },
    {role: 'user', content: `Goal: ${goal}\nField: ${field}\nOptions:\n${options.join('\n')}`},
  ];
}

// A summary of the open page or video ("tl;dr", "summarize this").
export function summaryMessages(task: string, evidence: Evidence[],
                                history: PastTurn[] = [],
                                user: UserContext = NO_USER): ChatMessage[] {
  const sources = evidence.map((e, i) =>
      `[${i + 1}] ${e.title} <${e.url}>\n${e.passages.join('\n')}`).join('\n\n');
  const earlier = history.length ? `Earlier in this chat:\n${historyText(history)}\n\n` : '';
  return [
    {
      role: 'system',
      content: 'Do what the request asks with the source, which is the page or ' +
          'video the user has open. For a summary or tl;dr: one line on what it ' +
          'is, then three to six short bullet points with the substance (claims, ' +
          'numbers, conclusions), most important first. Use only the source and ' +
          'cite it as [1]. No preamble, no closing remarks.',
    },
    {role: 'user',
     content: `${earlier}${tailoring(user)}Source:\n${sources}\n\nRequest: ${task}`},
  ];
}

// Notes on one part of a long page or transcript, to be summarized later.
export function notesMessages(task: string, title: string, part: string,
                              index: number, total: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You read one part of a long page or video transcript. Write the ' +
          'points in it that matter for the request as short bullet points ' +
          '(facts, claims, numbers, names). Reply with the bullet points only.',
    },
    {
      role: 'user',
      content: `Request: ${task}\n\n${title}, part ${index} of ${total}:\n${part}`,
    },
  ];
}
