// The browsing agent. Two models with different jobs:
//
//  - the decider (d1 / strands-decider) runs every navigation step: one
//    forward pass answers "is the goal reached?", "is this page relevant?"
//    and "which option next?" with calibrated probabilities, in tens of ms;
//  - the responder LLM (LFM3 / Qwen3.5) plans the task, takes over steps the
//    decider is unsure about, and writes the final answer from page text.
//
// Either model can be switched off (see AgentMode); with neither, the agent
// is unavailable and no model runtime is started at all.

import type {PageDriver} from '../browser/page_driver.js';
import type {PageSnapshot} from '../browser/snapshot.js';
import {choice, noul, type DeciderClient, type Question} from '../decider/decider_client.js';
import type {LlmClient} from '../llm/llm_client.js';
import type {AgentSettings} from '../models/settings.js';
import {usesDecider, usesLlm} from '../models/settings.js';
import {buildCandidates, stripHash, topPassages, type Candidate} from './candidates.js';
import {answerMessages, planMessages, PLAN_SCHEMA, stepMessages, stepSchema,
        type Evidence, type Plan} from './prompts.js';

export type AgentEvent =
    {type: 'plan', plan: Plan, by: 'llm'|'heuristic'}|
    {type: 'page', url: string, title: string, done: number, relevant: number}|
    {type: 'step', index: number, option: string, description: string,
     confidence: number, by: 'decider'|'llm'}|
    {type: 'answer-token', text: string}|
    {type: 'answer', text: string, sources: string[]}|
    {type: 'warning', message: string};

export interface AgentResult {
  answer: string;
  sources: string[];
  steps: number;
  finalUrl: string;
}

export interface AgentDeps {
  driver: PageDriver;
  settings: AgentSettings;
  llm?: LlmClient;
  decider?: DeciderClient;
  // Search URL with `%s` for the query; the user's default search engine.
  searchUrl?: string;
}

const PAGE_TEXT_FOR_DECIDER = 3000;
const MAX_SOURCES = 4;

export class BrowserAgent {
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    const {mode} = deps.settings;
    if (mode === 'off') {
      throw new Error('The agent is off: all models are disabled.');
    }
    if (usesLlm(mode) && !deps.llm) {
      throw new Error(`Mode ${mode} needs a responder model.`);
    }
    if (usesDecider(mode) && !deps.decider) {
      throw new Error(`Mode ${mode} needs a decider model.`);
    }
    this.deps = deps;
  }

  async run(task: string, onEvent: (event: AgentEvent) => void = () => {},
            signal?: AbortSignal): Promise<AgentResult> {
    const {driver, settings} = this.deps;
    const visited = new Set<string>();
    const evidence = new Map<string, Evidence>();

    let page = await driver.snapshot();
    const plan = await this.plan(task, page, signal);
    onEvent({type: 'plan', plan, by: this.deps.llm ? 'llm' : 'heuristic'});
    if (plan.start === 'url' && plan.url) {
      await driver.perform({kind: 'navigate', url: plan.url});
    } else if (plan.start === 'search') {
      await driver.perform({kind: 'navigate', url: this.searchUrl(plan.searchQuery)});
    }

    let steps = 0;
    let typed = false;
    for (; steps < settings.maxSteps; ++steps) {
      signal?.throwIfAborted();
      page = await driver.snapshot();
      visited.add(stripHash(page.url));

      const candidates = buildCandidates(page, {
        goal: plan.goal,
        visited,
        // Typing the query once is enough; after that, follow results.
        ...(typed ? {} : {typeText: plan.searchQuery || task}),
        canGoBack: steps > 0,
      });
      const step = await this.judge(plan.goal, page, candidates, signal);
      onEvent({type: 'page', url: page.url, title: page.title,
               done: step.done, relevant: step.relevant});
      if (step.relevant > 0.5 || step.done >= settings.doneAbove) {
        evidence.set(stripHash(page.url), {
          url: page.url,
          title: page.title,
          passages: topPassages(page.text, `${task} ${plan.goal}`, 6),
        });
      }
      if (step.done >= settings.doneAbove || !step.next) {
        break;
      }
      onEvent({type: 'step', index: steps, option: step.next.key,
               description: step.next.description, confidence: step.confidence,
               by: step.by});
      try {
        await driver.perform(step.next.action);
        typed ||= step.next.action.kind === 'type';
      } catch (error) {
        onEvent({type: 'warning', message: `Step failed: ${(error as Error).message}`});
      }
    }

    if (!evidence.size) {
      evidence.set(stripHash(page.url), {
        url: page.url,
        title: page.title,
        passages: topPassages(page.text, `${task} ${plan.goal}`, 6),
      });
    }
    // Newest first: the page the agent stopped on is the best source.
    const sources = [...evidence.values()].reverse().slice(0, MAX_SOURCES);
    const answer = await this.answer(task, sources, onEvent, signal);
    const result = {
      answer,
      sources: sources.map(s => s.url),
      steps,
      finalUrl: page.url,
    };
    onEvent({type: 'answer', text: answer, sources: result.sources});
    return result;
  }

  private async plan(task: string, page: PageSnapshot,
                     signal?: AbortSignal): Promise<Plan> {
    if (this.deps.llm) {
      const plan = await this.deps.llm.json<Plan>(
          planMessages(task, page.url, page.title), PLAN_SCHEMA,
          signal ? {signal, maxTokens: 256} : {maxTokens: 256});
      if (plan.start === 'url' && !isHttpUrl(plan.url)) {
        plan.start = 'search';
      }
      plan.goal ||= task;
      plan.searchQuery ||= task;
      return plan;
    }
    // Decider-only: no generated text, so plan from the request itself.
    const url = task.match(/https?:\/\/\S+/)?.[0];
    const onRealPage = isHttpUrl(page.url);
    return {
      start: url ? 'url' : onRealPage ? 'current' : 'search',
      url: url ?? '',
      searchQuery: task,
      goal: task,
    };
  }

  // One navigation step: how close the page is, and what to do next.
  private async judge(goal: string, page: PageSnapshot, candidates: Candidate[],
                      signal?: AbortSignal): Promise<{
                        done: number, relevant: number, next?: Candidate,
                        confidence: number, by: 'decider'|'llm',
                      }> {
    const {decider, llm, settings} = this.deps;
    const view = pageView(page, goal);
    let done = 0;
    let relevant = 0;
    let next: Candidate|undefined;
    let confidence = 0;

    if (decider) {
      const questions: Record<string, Question> = {
        done: {
          type: 'noul',
          instructions: `Does this page already show what is needed for this goal: ${goal}`,
        },
        relevant: {
          type: 'noul',
          instructions: `Does this page contain information useful for this goal: ${goal}`,
        },
      };
      if (candidates.length > 1) {
        questions['next'] = {
          type: 'choice',
          instructions: `Which action gets closest to this goal: ${goal}`,
          criteria: Object.fromEntries(candidates.map(c => [c.key, c.description])),
        };
      }
      const result = await decider.decide({state: view, questions}, signal);
      done = noul(result, 'done');
      relevant = noul(result, 'relevant');
      if (candidates.length === 1) {
        next = candidates[0];
        confidence = 1;
      } else if (candidates.length > 1) {
        const picked = choice(result, 'next');
        next = candidates.find(c => c.key === picked.choice);
        confidence = picked.confidence;
      }
      const sure = confidence >= settings.escalateBelow || !llm;
      if (sure || done >= settings.doneAbove || candidates.length === 0) {
        return {done, relevant, ...(next ? {next} : {}), confidence, by: 'decider'};
      }
    }

    if (llm && candidates.length) {
      const reply = await llm.json<{done: boolean, action: string}>(
          stepMessages(goal, view, candidates), stepSchema(candidates),
          signal ? {signal, maxTokens: 64} : {maxTokens: 64});
      if (!decider) {
        done = reply.done ? 1 : 0;
        relevant = done;
      }
      const chosen = candidates.find(c => c.key === reply.action);
      return {done, relevant, ...(chosen ? {next: chosen} : {}),
              confidence: chosen ? 1 : 0, by: 'llm'};
    }
    return {done, relevant, confidence, by: 'decider'};
  }

  private async answer(task: string, sources: Evidence[],
                       onEvent: (event: AgentEvent) => void,
                       signal?: AbortSignal): Promise<string> {
    const {llm, decider} = this.deps;
    if (llm) {
      return llm.chat(answerMessages(task, sources), {
        maxTokens: 768,
        onToken: text => onEvent({type: 'answer-token', text}),
        ...(signal ? {signal} : {}),
      });
    }
    // Decider-only: return the passage the decider picks as the answer.
    const passages = sources.flatMap(
        (s, i) => s.passages.map(p => ({p, source: i + 1})));
    if (!decider || !passages.length) {
      return 'No answer found on the visited pages.';
    }
    const options = passages.slice(0, 24);
    const result = await decider.decide({
      state: task,
      questions: {
        best: {
          type: 'choice',
          instructions: `Which passage best answers: ${task}`,
          criteria: Object.fromEntries(options.map((o, i) => [`p${i}`, o.p])),
        },
      },
    }, signal);
    const best = options[Number(choice(result, 'best').choice.slice(1))];
    return best ? `${best.p} [${best.source}]` : 'No answer found.';
  }

  private searchUrl(query: string): string {
    const template = this.deps.searchUrl ?? 'https://html.duckduckgo.com/html/?q=%s';
    return template.replace('%s', encodeURIComponent(query));
  }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

// The decider and LLM see the page as short text: where we are, the outline,
// and the passages closest to the goal.
export function pageView(page: PageSnapshot, goal: string): string {
  const passages = topPassages(page.text, goal, 8).join('\n');
  return [
    `URL: ${page.url}`,
    `Title: ${page.title}`,
    page.headings.length ? `Headings: ${page.headings.join(' | ')}` : '',
    `Text: ${passages.slice(0, PAGE_TEXT_FOR_DECIDER)}`,
  ].filter(Boolean).join('\n');
}
