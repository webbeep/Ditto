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

// What the LLM writes for a plan. Where to start is decided by the agent
// (see BrowserAgent.plan): small models invent URLs and misjudge whether the
// open page is the right place.
export interface PlanReply {
  searchQuery: string;
  goal: string;
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    searchQuery: {type: 'string'},
    goal: {type: 'string'},
  },
  required: ['searchQuery', 'goal'],
};

export interface PastTurn {
  question: string;
  answer: string;
}

function historyText(history: PastTurn[]): string {
  return history.map(t => `User: ${t.question}\nYou: ${t.answer}`).join('\n\n');
}

export function planMessages(task: string, currentUrl: string, currentTitle: string,
                             history: PastTurn[] = []): ChatMessage[] {
  const earlier = history.length ? `Earlier in this chat:\n${historyText(history)}\n\n` : '';
  return [
    {
      role: 'system',
      content: 'You plan web browsing for a user. Reply with JSON only.\n' +
          '- goal: one standalone sentence saying what the final page must ' +
          'show (resolve words like "it" or "that one" using the chat).\n' +
          '- searchQuery: a short web search query for the goal.',
    },
    {
      role: 'user',
      content: `${earlier}Open page: ${currentTitle || '(none)'} <${currentUrl}>\n` +
          `Request: ${task}`,
    },
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
                               history: PastTurn[] = []): ChatMessage[] {
  const sources = evidence.map((e, i) =>
      `[${i + 1}] ${e.title} <${e.url}>\n${e.passages.join('\n')}`).join('\n\n');
  const earlier = history.length ? `Earlier in this chat:\n${historyText(history)}\n\n` : '';
  return [
    {
      role: 'system',
      content: 'Answer the user using only the sources. Cite sources as [1], ' +
          '[2]. If the sources do not contain the answer, say so briefly and ' +
          'say what you found instead. Be concise.',
    },
    {role: 'user', content: `${earlier}Sources:\n${sources}\n\nRequest: ${task}`},
  ];
}
