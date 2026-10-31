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

// What the agent knows about the user for one request.
export interface UserContext {
  // Notes from memory that bear on the request.
  notes: string[];
  // Sites the user's tasks usually end on.
  sites: string[];
  // Bookmarks and history matching the request.
  pages: SavedPage[];
}

export const NO_USER: UserContext = {notes: [], sites: [], pages: []};

function aboutUser(user: UserContext): string {
  const lines: string[] = [];
  if (user.notes.length) {
    lines.push(`About the user:\n${user.notes.map(n => `- ${n}`).join('\n')}`);
  }
  if (user.sites.length) {
    lines.push(`Sites the user often uses: ${user.sites.join(', ')}`);
  }
  return lines.length ? `${lines.join('\n')}\n\n` : '';
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
          'show (resolve words like "it" or "that one" using the chat, and ' +
          'fit it to what you know about the user).\n' +
          '- searchQuery: a short web search query for the goal.' +
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
                               user: UserContext = NO_USER): ChatMessage[] {
  const sources = evidence.map((e, i) =>
      `[${i + 1}] ${e.title} <${e.url}>\n${e.passages.join('\n')}`).join('\n\n');
  const earlier = history.length ? `Earlier in this chat:\n${historyText(history)}\n\n` : '';
  return [
    {
      role: 'system',
      content: 'Answer the request in one or two sentences, using only the ' +
          'sources, and cite them as [1], [2]. Reply with the answer only: do ' +
          'not repeat the sources or explain your reasoning. If the sources ' +
          'do not contain the answer, say so in one sentence.',
    },
    {role: 'user',
     content: `${earlier}${aboutUser(user)}Sources:\n${sources}\n\nRequest: ${task}`},
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
     content: `${earlier}${aboutUser(user)}Source:\n${sources}\n\nRequest: ${task}`},
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
