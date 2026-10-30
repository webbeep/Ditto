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

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    start: {type: 'string', enum: ['current', 'url', 'search']},
    url: {type: 'string'},
    searchQuery: {type: 'string'},
    goal: {type: 'string'},
  },
  required: ['start', 'url', 'searchQuery', 'goal'],
};

export function planMessages(task: string, currentUrl: string,
                             currentTitle: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You plan web browsing for a user. Reply with JSON only.\n' +
          '- start: "current" if the open page can answer the request, ' +
          '"url" if you know the exact site to open, otherwise "search".\n' +
          '- url: the page to open when start is "url", else "".\n' +
          '- searchQuery: a short web search query (always fill it in).\n' +
          '- goal: one sentence saying what the final page must show.',
    },
    {
      role: 'user',
      content: `Open page: ${currentTitle || '(none)'} <${currentUrl}>\n` +
          `Request: ${task}`,
    },
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

export function answerMessages(task: string, evidence: Evidence[]): ChatMessage[] {
  const sources = evidence.map((e, i) =>
      `[${i + 1}] ${e.title} <${e.url}>\n${e.passages.join('\n')}`).join('\n\n');
  return [
    {
      role: 'system',
      content: 'Answer the user using only the sources. Cite sources as [1], ' +
          '[2]. If the sources do not contain the answer, say so briefly and ' +
          'say what you found instead. Be concise.',
    },
    {role: 'user', content: `Sources:\n${sources}\n\nRequest: ${task}`},
  ];
}
