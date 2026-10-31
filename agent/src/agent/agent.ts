// The browsing agent. Two models with different jobs:
//
//  - the decider (d1 / strands-decider) runs every navigation step: one
//    forward pass answers "is the goal reached?", "is this page relevant?"
//    and "which option next?" with calibrated probabilities, in tens of ms;
//  - the responder LLM (LFM3 / Qwen3.5) phrases the goal, takes over steps
//    the decider is unsure about, fills in form fields, and writes the
//    answer from page text.
//
// Either model can be switched off (see AgentMode); with neither, the agent
// is unavailable and no model runtime is started at all.
//
// Failures feed back into the loop instead of ending it: model calls retry
// on transient errors, a failed action is reported to the models on the
// next step (and not offered again), and dead pages lead back or to search.

import {isHijacked} from '../browser/ads.js';
import type {PageAction, PageDriver} from '../browser/page_driver.js';
import type {PageSnapshot} from '../browser/snapshot.js';
import type {ChatContext} from '../chat/chat.js';
import {choice, noul} from '../decider/decider_client.js';
import type {ChoiceAnswer, DeciderClient, Question} from '../decider/decider_client.js';
import {parseJsonReply} from '../llm/llm_client.js';
import type {ChatMessage, LlmClient} from '../llm/llm_client.js';
import type {AgentSettings} from '../models/settings.js';
import {usesDecider, usesLlm} from '../models/settings.js';
import {buildCandidates, coverage, normalizeUrl, topPassages} from './candidates.js';
import type {Candidate} from './candidates.js';
import {answerMessages, notesMessages, summaryMessages, CHECK_SCHEMA, checkMessages, EXTRACT_SCHEMA,
    extractMessages, FIELD_SCHEMA, fieldMessages, LEARN_SCHEMA, learnMessages, NO_USER,
    optionMessages, optionSchema, planMessages, planSchema, stepMessages,
    stepSchema} from './prompts.js';
import type {Evidence, Plan, PlanReply, SavedPage, UserContext} from './prompts.js';
import type {MemoryStore} from '../memory/memory.js';
import {describeError, withRetry} from './retry.js';

export type AgentEvent =
    {type: 'plan', plan: Plan, by: 'llm'|'heuristic'}|
    // What the agent is doing right now, in a few words (also shown on the
    // page while the agent is in control).
    {type: 'status', text: string}|
    {type: 'page', url: string, title: string, done: number, relevant: number}|
    {type: 'step', index: number, option: string, description: string,
     // 'agent': the agent's own rule (e.g. searching after a dead end).
     confidence: number, by: 'decider'|'llm'|'agent'}|
    {type: 'retry', what: string, attempt: number, error: string}|
    {type: 'answer-token', text: string}|
    // A streamed answer is being discarded (the agent keeps looking).
    {type: 'answer-reset'}|
    {type: 'answer', text: string, sources: string[]}|
    {type: 'warning', message: string}|
    // The agent kept the user safe on its own: skipped an ad, undid a
    // redirect to one, stepped around an overlay.
    {type: 'shield', message: string}|
    // The agent needs the user: an OK before committing them, or their
    // hands for signing in or payment details.
    {type: 'ask', kind: AskRequest['kind'], message: string}|
    // New notes about the user, learned from this request.
    {type: 'memory', notes: string[]};

export interface AskRequest {
  // 'approve': an action that commits the user (buying, sending, deleting).
  // 'handoff': the page needs the user (sign in, payment details).
  kind: 'approve'|'handoff';
  message: string;
  url: string;
}

export interface AgentResult {
  answer: string;
  sources: string[];
  evidence: Evidence[];
  steps: number;
  finalUrl: string;
  // Answered from the chat's earlier sources, without browsing.
  fromHistory: boolean;
}

export interface AgentDeps {
  driver: PageDriver;
  settings: AgentSettings;
  llm?: LlmClient;
  decider?: DeciderClient;
  // Search URL with `%s` for the query; the user's default search engine.
  searchUrl?: string;
  // Notes about the user: used to tailor plans and answers, and added to
  // after each request (when learning is on).
  memory?: MemoryStore;
  // The user's bookmarks and history matching a query.
  userPages?: (query: string) => Promise<SavedPage[]>;
  // Asks the user and resolves with their answer (true: go ahead). Without
  // it the agent stops wherever it would need to ask.
  ask?: (request: AskRequest) => Promise<boolean>;
}

export interface RunOptions {
  signal?: AbortSignal;
  // Earlier turns of this chat.
  context?: ChatContext;
}

const PAGE_TEXT_FOR_DECIDER = 3000;
const MAX_SOURCES = 4;
// Steps spent on the open site before searching, when nothing relevant shows.
const SITE_STEPS = 6;
// Consecutive failed actions before the agent stops trying.
const MAX_FAILURES = 3;
// Steps of the agent's own path shown to the models.
const TRAJECTORY_STEPS = 6;
// Times the agent keeps looking after an answer that says "not found".
const ANSWER_ROUNDS = 2;
// The same action on the same page, at most this often (going in circles).
const MAX_REPEATS = 2;
// A page or transcript longer than this is read in parts (notes per part,
// then the answer from the notes).
const DIGEST_CHARS = 12000;
const MAX_DIGEST_PARTS = 8;
// The user's own pages offered to the planner.
const MAX_USER_PAGES = 8;
// Actions that commit the user to something: never taken without an OK.
const COMMITS = /\b(buy|purchase|place (your )?order|pay|checkout|check out|complete (your )?(order|purchase)|confirm (order|purchase|payment|booking)|submit (order|payment)|subscribe|donate|transfer|send (money|payment)|book now|reserve|delete|remove account|cancel (subscription|membership|order))\b/i;

interface Judgement {
  done: number;
  relevant: number;
  next?: Candidate;
  confidence: number;
  by: 'decider'|'llm';
}

interface StepNotes {
  trajectory: string[];
  lastError?: string;
}

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
            options: RunOptions = {}): Promise<AgentResult> {
    const {driver} = this.deps;
    const status = (text: string) => {
      onEvent({type: 'status', text});
      void driver.status(text);
    };
    const told = this.memoryCommand(task);
    if (told !== null) {
      onEvent({type: 'answer', text: told, sources: []});
      return {answer: told, sources: [], evidence: [], steps: 0, finalUrl: '', fromHistory: true};
    }
    let result: AgentResult;
    try {
      const user = await this.userContext(task);
      result = await this.handle(task, user, onEvent, status, options);
    } finally {
      await driver.release();
    }
    await this.learn(task, result, onEvent, options.signal);
    return result;
  }

  private async handle(task: string, user: UserContext,
                       onEvent: (event: AgentEvent) => void,
                       status: (text: string) => void,
                       options: RunOptions): Promise<AgentResult> {
    const {driver} = this.deps;
    // A follow-up the last answer's sources already cover needs no browsing.
    const previous = options.context?.sources ?? [];
    if (previous.length && await this.answeredBy(task, previous, onEvent, options.signal)) {
      status('Answering');
      const answer = stripReasoning(await this.answer(
          task, previous, options.context, onEvent, options.signal, false, user));
      onEvent({type: 'answer', text: answer, sources: previous.map(s => s.url)});
      return {
        answer, sources: previous.map(s => s.url), evidence: previous,
        steps: 0, finalUrl: '', fromHistory: true,
      };
    }
    if (aboutOpenPage(task)) {
      const page = await driver.snapshot();
      if (isHttpUrl(page.url)) {
        return this.readOpenPage(task, page, user, onEvent, status, options);
      }
      // "This page" with none open: searching the words would be nonsense.
      if (/\b(this|current|the open) (page|video|article|tab|site)\b|\btl;?\s?dr\b/i.test(task)) {
        const answer = 'There is no page open to read. Open one, then ask again.';
        onEvent({type: 'answer', text: answer, sources: []});
        return {answer, sources: [], evidence: [], steps: 0, finalUrl: page.url,
                fromHistory: false};
      }
    }
    return this.browse(task, user, onEvent, status, options);
  }

  // "Remember that …" and "forget …" go straight to memory.
  private memoryCommand(task: string): string|null {
    const {memory} = this.deps;
    if (!memory) {
      return null;
    }
    const remember = task.match(/^\s*(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i);
    if (remember) {
      memory.add(`User said: “${remember[1]!.trim()}”`, 'told');
      return 'Noted.';
    }
    const forget = task.match(/^\s*(?:please\s+)?forget(?:\s+(?:that|about))?\s+(.+)$/i);
    if (forget) {
      const removed = memory.forget(forget[1]!);
      return removed ? `Forgotten (${removed} note${removed === 1 ? '' : 's'}).` :
                       'There was nothing like that in memory.';
    }
    return null;
  }

  // What the agent knows about the user for this request.
  private async userContext(task: string): Promise<UserContext> {
    const {memory, userPages} = this.deps;
    const profile = memory?.profileFor(task) ?? {notes: [], sites: []};
    const pages = new Map<string, SavedPage & {hits: number}>();
    if (userPages) {
      // Bookmark and history search match every word, so ask per keyword
      // and rank pages by how many keywords they match.
      const terms = keywords(task, 3);
      const found = await Promise.all(terms.map(term => userPages(term).catch(() => [])));
      for (const page of found.flat()) {
        const hit = pages.get(page.url);
        pages.set(page.url, {...page, hits: (hit?.hits ?? 0) + 1});
      }
    }
    const ranked = [...pages.values()]
                       .sort((a, b) => b.hits - a.hits || Number(b.bookmark) - Number(a.bookmark) ||
                                       b.timeMs - a.timeMs)
                       .slice(0, MAX_USER_PAGES)
                       .map(({hits: _hits, ...page}) => page);
    return {...profile, pages: ranked};
  }

  // After a request: the sites it ended on, and (when learning is on) what
  // it showed about the user.
  private async learn(task: string, result: AgentResult,
                      onEvent: (event: AgentEvent) => void,
                      signal?: AbortSignal): Promise<void> {
    const {memory, llm} = this.deps;
    if (!memory || result.fromHistory) {
      return;
    }
    memory.visited(result.sources);
    if (!memory.learning || !llm) {
      return;
    }
    try {
      const reply = await this.json<{notes: string[]}>(
          'learn', learnMessages(task, result.answer, memory.notes().slice(0, 30).map(n => n.text)),
          LEARN_SCHEMA, reply => (Array.isArray(reply.notes) ? null : 'notes is missing'),
          256, onEvent, signal);
      const added = reply.notes
                        // Secrets never go to memory, whatever the model says.
                        .filter(note => !/\d{6,}|password|passcode|\bpin\b|cvv|cvc/i.test(note))
                        .map(note => memory.add(note, 'learned'))
                        .filter(note => note !== null)
                        .map(note => note.text);
      if (added.length) {
        onEvent({type: 'memory', notes: added});
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Learning is best effort.
    }
  }

  private async ask(request: AskRequest,
                    onEvent: (event: AgentEvent) => void): Promise<boolean> {
    onEvent({type: 'ask', kind: request.kind, message: request.message});
    void this.deps.driver.status(request.kind === 'approve' ? 'Waiting for your OK' : 'Your turn');
    return this.deps.ask ? this.deps.ask(request) : false;
  }

  private async browse(task: string, user: UserContext,
                       onEvent: (event: AgentEvent) => void,
                       status: (text: string) => void,
                       options: RunOptions): Promise<AgentResult> {
    const {driver, settings} = this.deps;
    const {signal, context} = options;
    const visited = new Set<string>();
    // Every readable page visited, scored for how well it answers the task.
    const evidence = new Map<string, Evidence & {score: number, order: number}>();
    // Pages whose answer turned out not to be there: never "done" or a
    // convincing source again.
    const notTheAnswer = new Set<string>();

    status('Reading');
    let page = await driver.snapshot();
    const plan = this.initialPlan(task, page);
    // The LLM phrases the goal and query while the agent already works on
    // the open page; the plan is awaited only where it is needed.
    const planned = this.refinePlan(plan, task, page, context, user, onEvent, signal);
    const needPlan = async () => {
      await planned;
      return plan;
    };
    // With the user's own pages to pick from, where to start is the plan's.
    if (plan.start !== 'url' && user.pages.length && this.deps.llm) {
      await planned;
    }

    // What the agent last tried to open; error pages hide the real URL.
    let target = page.url;
    if (plan.start === 'url' && plan.url) {
      target = plan.url;
      status('Opening page');
      await driver.perform({kind: 'navigate', url: target});
    } else if (plan.start === 'search') {
      target = this.searchUrl((await needPlan()).searchQuery);
      status('Searching');
      await driver.perform({kind: 'navigate', url: target});
    }

    const keep = (page: PageSnapshot, score: number, lead: string[] = []) => {
      const key = normalizeUrl(page.url);
      // Back on a page in a worse state (a reload reset a dropdown): keep
      // what it showed before.
      const before = evidence.get(key);
      if (before && before.score > score && !notTheAnswer.has(key) && !lead.length) {
        return;
      }
      const passages = topPassages(page.text, `${task} ${plan.goal}`, 6);
      evidence.set(key, {
        url: page.url,
        title: page.title,
        passages: [...lead, ...passages.filter(p => !lead.includes(p))].slice(0, 7),
        score: notTheAnswer.has(key) ? Math.min(score, 0.2) : score,
        order: evidence.size,
      });
    };

    const trajectory: string[] = [];
    // Keys of actions that failed on a page, never offered there again.
    const failed = new Map<string, Set<string>>();
    let lastError: string|undefined;
    let failures = 0;
    let steps = 0;
    let typed = false;
    let searched = plan.start === 'search';
    // Whether this run has reached a readable page yet; before that, "back"
    // would leave the run for whatever the tab showed earlier.
    let loadedAny = false;
    let bestRelevant = 0;
    // Navigations of this run that "back" can undo; going back further would
    // leave the run for whatever the tab showed before.
    let depth = 0;
    // The page an action left from (a navigation counts only if the address
    // changed: setting a dropdown or scrolling is not a step "back" undoes).
    let leftFrom: string|undefined;
    // The last page that loaded, and error pages in a row since.
    let lastGood = '';
    let unusableInARow = 0;
    // Sites where the user was handed the tab (to sign in, pay) this run.
    const handedOff = new Set<string>();
    // Why the run stopped short, when the user said no.
    let stopped = '';
    // The answer read off a page, with the sentence that states it.
    let extracted: {url: string, answer: string, quote: string}|undefined;
    // A request to do something (buy, book, send) is done by doing it, not
    // by finding something to read.
    const doing = isActionRequest(task);
    // Page states the answer was looked for on.
    const readPages = new Set<string>();
    // How often each action was taken on each page (the watchdog).
    const repeats = new Map<string, number>();
    // An approved action that commits the user was taken: the run reports
    // on it and never goes looking (and acting) again.
    let committed = false;
    // The link the last click followed, to tell a hijacked click.
    let clicked: {from: string, key: string, href?: string}|undefined;
    // The last action that could lead elsewhere, and where actions led:
    // a way to a page already seen, or back out of, is a dead end.
    let moved: {from: string, key: string, description: string}|undefined;
    const ledTo: Array<{from: string, key: string, to: string}> = [];
    const deadEnd = (from: string, key: string) => {
      const blocked = failed.get(from) ?? new Set<string>();
      blocked.add(key);
      failed.set(from, blocked);
    };

    const explore = async () => {
    for (; steps < settings.maxSteps; ++steps) {
      signal?.throwIfAborted();
      page = await driver.snapshot();
      // A click that ended on an ad network, or on a site its link never
      // named (a hidden script swapped the destination): undo it.
      if (clicked && isHijacked(clicked.from, clicked.href, page.url)) {
        const from = normalizeUrl(clicked.from);
        const blocked = failed.get(from) ?? new Set<string>();
        blocked.add(clicked.key);
        failed.set(from, blocked);
        onEvent({type: 'shield', message: `Went back from an ad (${hostOf(page.url)})`});
        trajectory.push(`a link was redirected to an ad on ${hostOf(page.url)}`);
        lastError = `that link led to an ad (${hostOf(page.url)}), not where it said`;
        clicked = undefined;
        await driver.perform({kind: 'back'});
        continue;
      }
      clicked = undefined;
      const here = normalizeUrl(page.url);
      if (leftFrom !== undefined && here !== leftFrom) {
        ++depth;
      }
      leftFrom = undefined;
      for (const note of driver.takeNotes()) {
        onEvent({type: 'shield', message: note});
      }
      if (moved && here !== moved.from) {
        ledTo.push({from: moved.from, key: moved.key, to: here});
        if (visited.has(here)) {
          deadEnd(moved.from, moved.key);
          trajectory.push(`${moved.description} led back to a page already seen`);
        }
      }
      moved = undefined;
      visited.add(here);
      if (isUnusable(page)) {
        if (++unusableInARow > 2) {
          break;
        }
        const what = loadedUrl(page, target);
        onEvent({type: 'warning', message: `Could not load ${what}`});
        trajectory.push(`could not load ${what}`);
        if (!loadedAny) {
          if (searched) {
            break;
          }
          // The start page is down: look for the answer elsewhere.
          searched = true;
          target = this.searchUrl((await needPlan()).searchQuery);
          status('Searching');
          await driver.perform({kind: 'navigate', url: target});
          continue;
        }
        // A link led to an error page: return to where we were (going back
        // only within this run; before it, the tab showed something else).
        lastError = `${what} did not load`;
        if (depth > 0) {
          depth -= 1;
          await driver.perform({kind: 'back'});
        } else if (lastGood) {
          await driver.perform({kind: 'navigate', url: lastGood});
        }
        continue;
      }
      loadedAny = true;
      unusableInARow = 0;
      lastGood = page.url;
      status(`Reading ${page.title || hostOf(page.url)}`);
      if (committed) {
        // The action the user approved is done: this page is its outcome.
        keep(page, 1);
        break;
      }
      // Sign-in and payment fields are the user's: hand them the tab.
      const secret = page.elements.find(e => e.secret && !e.filled && e.inViewport);
      if (secret && !handedOff.has(hostOf(page.url))) {
        handedOff.add(hostOf(page.url));
        const needs = secret.secret === 'password' ? 'sign in' : 'enter payment details';
        const message = secret.secret === 'password' ?
            `Sign in to ${hostOf(page.url)} in this tab, then continue.` :
            `Fill in or autofill the payment details on ${hostOf(page.url)}, then continue.`;
        if (!await this.ask({kind: 'handoff', message, url: page.url}, onEvent)) {
          stopped = `Stopped on ${hostOf(page.url)}: it needs you to ${needs}.`;
          break;
        }
        // Read the page again as the user left it.
        --steps;
        continue;
      }
      const ads = page.elements.filter(e => e.ad).length;
      if (ads) {
        onEvent({type: 'shield',
                 message: `Ignored ${ads} ad${ads === 1 ? '' : 's'} on ${hostOf(page.url)}`});
      }

      const blocked = failed.get(here) ?? new Set<string>();
      const candidates = buildCandidates(page, {
        goal: plan.goal,
        visited,
        // Typing the query once is enough; after that, follow results.
        ...(typed ? {} : {typeText: plan.searchQuery || task}),
        canGoBack: depth > 0,
      }).filter(c => !blocked.has(c.key));

      const notes: StepNotes = {trajectory: trajectory.slice(-TRAJECTORY_STEPS)};
      if (lastError) {
        notes.lastError = lastError;
      }
      const step = await this.judge(plan.goal, page, candidates, notes, onEvent, signal);
      if (notTheAnswer.has(here)) {
        step.done = 0;
      }
      onEvent({type: 'page', url: page.url, title: page.title,
               done: step.done, relevant: step.relevant});
      // The decider's calibrated judgement when there is one. Without it the
      // LLM's yes/no is too coarse (LFM3 1.7B reached the right page and
      // never said so), so pages are scored by how much of the request they
      // cover.
      keep(page, this.deps.decider ? Math.max(step.relevant, step.done) :
                                     Math.max(step.done, coverage(page.text, task)));
      bestRelevant = Math.max(bestRelevant, step.relevant);
      // A very relevant page may hold the answer even when "done" is unsure;
      // reading it off is checked either way. Each page state is read once.
      const readKey = `${here} ${page.text.length}`;
      // About to leave this page for good (nothing left to try here, or the
      // site is giving up): a page that is at all relevant is read first.
      const leaving = !step.next ||
          (!searched && steps + 1 >= SITE_STEPS && bestRelevant < 0.5);
      const worthReading = !doing && (step.done >= settings.doneAbove ||
          ((step.relevant >= 0.75 || (leaving && step.relevant >= 0.4)) &&
           !readPages.has(readKey) && !notTheAnswer.has(here)));
      if (worthReading) {
        readPages.add(readKey);
      }
      if (worthReading && step.done < settings.doneAbove && this.deps.llm && !committed) {
        const found = await this.extract(task, plan.goal, page, onEvent, signal);
        if (found) {
          extracted = {url: page.url, ...found};
          keep(page, 1, [found.quote]);
          break;
        }
      } else if (step.done >= settings.doneAbove && !doing) {
        // "Done" means the answer is on the page: the LLM reads it off with
        // the sentence that states it, and that sentence must really be
        // there. A page that only looks right is not the answer.
        if (!this.deps.llm || committed) {
          break;
        }
        const found = await this.extract(task, plan.goal, page, onEvent, signal);
        if (found) {
          extracted = {url: page.url, ...found};
          keep(page, 1, [found.quote]);
          break;
        }
        notTheAnswer.add(here);
        const kept = evidence.get(here);
        if (kept) {
          kept.score = Math.min(kept.score, 0.2);
        }
        const where = page.title || hostOf(page.url);
        lastError = `${where} looked right but does not state the answer`;
        trajectory.push(`${where}: not the answer`);
        onEvent({type: 'retry', what: 'answer', attempt: 1,
                 error: `${where} does not say it; looking further`});
      }
      // The open site did not pan out (nothing left to try, or several
      // steps without anything relevant): search the web instead.
      if (!searched && (!step.next ||
                        (steps + 1 >= SITE_STEPS && bestRelevant < 0.5))) {
        searched = true;
        const query = (await needPlan()).searchQuery;
        target = this.searchUrl(query);
        onEvent({type: 'step', index: steps, option: 'search',
                 description: `search “${query}”`, confidence: 1, by: 'agent'});
        trajectory.push(`searched “${query}”`);
        status('Searching');
        await driver.perform({kind: 'navigate', url: target});
        ++depth;
        continue;
      }
      if (!step.next) {
        break;
      }

      // The watchdog: the same action on the same page again and again is
      // going in circles; take it off the table and say so.
      const repeatKey = `${here} ${step.next.key}`;
      const times = (repeats.get(repeatKey) ?? 0) + 1;
      repeats.set(repeatKey, times);
      if (times > MAX_REPEATS) {
        blocked.add(step.next.key);
        failed.set(here, blocked);
        lastError = `${step.next.description} was already tried ${MAX_REPEATS} times here`;
        trajectory.push(`${step.next.description} (going in circles)`);
        continue;
      }
      let action = step.next.action;
      if (action.kind === 'select') {
        action = {...action, option: await this.chooseOption(plan.goal, step.next, page, signal)};
      }
      if (action.kind === 'type') {
        if (!this.deps.llm || /search|query/i.test(step.next.description)) {
          // A search box gets the planned query (not the whole question),
          // so wait for the plan if it is still being written.
          action = {...action, text: (await needPlan()).searchQuery || task};
        } else {
          // Other text fields need words that fit the goal.
          action = {...action, text: await this.fieldText(plan.goal, step.next, signal)};
        }
      }
      const commitsUser = commits(step.next);
      if (commitsUser) {
        const what = `${step.next.description} on ${hostOf(page.url)}`;
        if (!await this.ask({kind: 'approve', message: what, url: page.url}, onEvent)) {
          stopped = `Stopped before ${what}. Nothing was submitted.`;
          break;
        }
      }
      onEvent({type: 'step', index: steps, option: step.next.key,
               description: action.kind === 'select' ?
                   `${step.next.description.replace(/ \(now .*$/, '')} → “${action.option}”` :
                   step.next.description,
               confidence: step.confidence, by: step.by});
      status(actionLabel(step.next));
      target = step.next.href ?? page.url;
      try {
        await driver.perform(action);
        committed ||= commitsUser;
        for (const note of driver.takeNotes()) {
          onEvent({type: 'shield', message: note});
        }
        // A dropdown, once set, is not offered again on this page.
        if (action.kind === 'select') {
          blocked.add(step.next.key);
          failed.set(here, blocked);
        }
        if (action.kind === 'click') {
          clicked = {from: page.url, key: step.next.key,
                     ...(step.next.href ? {href: step.next.href} : {})};
        }
        typed ||= action.kind === 'type';
        if (action.kind === 'back') {
          depth = Math.max(0, depth - 1);
          // Backing out of a page: the ways to it are done with.
          for (const way of ledTo.filter(w => w.to === here)) {
            deadEnd(way.from, way.key);
          }
        } else if (action.kind !== 'scroll') {
          leftFrom = here;
          if (action.kind !== 'select') {
            moved = {from: here, key: step.next.key, description: step.next.description};
          }
        }
        trajectory.push(`${page.title || hostOf(page.url)}: ${step.next.description}`);
        lastError = undefined;
        failures = 0;
      } catch (error) {
        // Tell the models what went wrong and offer something else next time.
        lastError = `${step.next.description} failed: ${describeError(error)}`;
        blocked.add(step.next.key);
        failed.set(here, blocked);
        trajectory.push(`${step.next.description} (failed)`);
        onEvent({type: 'retry', what: step.next.description, attempt: ++failures,
                 error: describeError(error)});
        if (failures >= MAX_FAILURES) {
          onEvent({type: 'warning', message: 'Several actions failed in a row; stopping.'});
          break;
        }
      }
    }
    };

    const stoppedResult = (): AgentResult => {
      onEvent({type: 'answer', text: stopped, sources: []});
      return {answer: stopped, sources: [], evidence: [], steps, finalUrl: page.url,
              fromHistory: false};
    };
    await explore();
    await planned;
    if (stopped) {
      return stoppedResult();
    }
    let answer = '';
    let sources: Evidence[] = [];
    for (let round = 0;; ++round) {
      // The pages that answer best (newest first among equals); if none is
      // convincing, the single best one.
      const ranked = [...evidence.values()].sort(
          (a, b) => b.score - a.score || b.order - a.order);
      // Only pages close to the best one: a search results page is not cited
      // next to the page that has the answer.
      const best = ranked[0]?.score ?? 0;
      const convincing = ranked.filter(e => e.score > 0.5 && e.score >= best - 0.3);
      sources = (convincing.length ? convincing : ranked.slice(0, 1))
                    .slice(0, MAX_SOURCES)
                    .map(({url, title, passages}) => ({url, title, passages}));
      // The page the answer was read off comes first.
      if (extracted) {
        const first = normalizeUrl(extracted.url);
        sources.sort((a, b) => Number(normalizeUrl(b.url) === first) -
                               Number(normalizeUrl(a.url) === first));
      }
      status('Answering');
      // Never ask a model to answer from an error page.
      answer = sources.length ?
          await this.answer(task, sources, context, onEvent, signal, false, user) :
          `I could not load a usable page for this request (last tried ${loadedUrl(page, target)}).`;
      // A read-off answer is grounded already; otherwise check the answer.
      if (!sources.length || committed || extracted || round >= ANSWER_ROUNDS ||
          steps >= settings.maxSteps || await this.answers(task, answer, onEvent, signal)) {
        break;
      }
      // The answer says the information is not there: those pages were not
      // the right ones. Tell the models and keep looking.
      for (const source of sources) {
        notTheAnswer.add(normalizeUrl(source.url));
        const kept = evidence.get(normalizeUrl(source.url));
        if (kept) {
          kept.score = Math.min(kept.score, 0.2);
        }
      }
      const where = sources.map(s => s.title || hostOf(s.url)).join(', ');
      lastError = `the answer was not on ${where}`;
      trajectory.push(`answer not found on ${where}`);
      onEvent({type: 'retry', what: 'answer', attempt: round + 1,
               error: `not found on ${where}; looking further`});
      onEvent({type: 'answer-reset'});
      await explore();
      if (stopped) {
        return stoppedResult();
      }
    }
    answer = stripReasoning(answer);
    onEvent({type: 'answer', text: answer, sources: sources.map(s => s.url)});
    return {
      answer, sources: sources.map(s => s.url), evidence: sources, steps,
      finalUrl: page.url, fromHistory: false,
    };
  }

  // The answer on `page`, read off with the sentence that states it; null
  // when the page does not state it (or the quote is not really there).
  private async extract(task: string, goal: string, page: PageSnapshot,
                        onEvent: (event: AgentEvent) => void,
                        signal?: AbortSignal): Promise<{answer: string, quote: string}|null> {
    const passages = topPassages(page.text, `${task} ${goal}`, 10);
    if (!passages.length) {
      return null;
    }
    try {
      const reply = await this.json<{found: boolean, answer: string, quote: string}>(
          'read', extractMessages(task, goal, page.title, passages), EXTRACT_SCHEMA,
          () => null, 256, onEvent, signal);
      if (reply.found && reply.answer.trim() && grounded(reply.quote, page.text)) {
        return {answer: reply.answer.trim(), quote: reply.quote.trim()};
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
    }
    return null;
  }

  // The option of a dropdown that fits the goal.
  private async chooseOption(goal: string, candidate: Candidate, page: PageSnapshot,
                             signal?: AbortSignal): Promise<string> {
    const id = candidate.action.kind === 'select' ? candidate.action.id : -1;
    const options = page.elements.find(e => e.id === id)?.options ?? [];
    if (this.deps.llm && options.length) {
      try {
        const reply = parseJsonReply<{option: string}>(await this.deps.llm.chat(
            optionMessages(goal, candidate.description, options),
            {schema: optionSchema(options), maxTokens: 64, ...(signal ? {signal} : {})}));
        if (options.includes(reply.option)) {
          return reply.option;
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
      }
    }
    // Without an LLM (or a usable reply): the option sharing most words.
    const stems = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
                                     .map(w => (w.length > 3 ? w.replace(/s$/, '') : w));
    const wanted = new Set(stems(goal));
    const score = (o: string) => stems(o).filter(w => wanted.has(w)).length;
    return [...options].sort((a, b) => score(b) - score(a))[0] ?? '';
  }

  // "tl;dr", "summarize this video", "what is this page about": the answer
  // is the open page (or its video), so read it instead of browsing.
  private async readOpenPage(task: string, page: PageSnapshot, user: UserContext,
                             onEvent: (event: AgentEvent) => void,
                             status: (text: string) => void,
                             options: RunOptions): Promise<AgentResult> {
    const {driver} = this.deps;
    const {signal, context} = options;
    status(`Reading ${page.title || hostOf(page.url)}`);
    const media = await driver.readMedia();
    if (media) {
      onEvent({type: 'step', index: 0, option: 'read',
               description: media.kind === 'transcript' ? 'read the video transcript' :
                                                          'read the video description',
               confidence: 1, by: 'agent'});
    }
    // The page text alongside a description: it may hold chapters, comments.
    const text = media?.kind === 'transcript' ? media.text :
                 media ? `${media.text}\n${page.text}` : page.text;
    const source: Evidence = {
      url: page.url,
      title: media?.title || page.title,
      passages: await this.digest(task, media?.title || page.title, text, onEvent, signal),
    };
    status('Answering');
    const answer = stripReasoning(
        await this.answer(task, [source], context, onEvent, signal, true, user));
    onEvent({type: 'answer', text: answer, sources: [page.url]});
    return {
      answer, sources: [page.url], evidence: [source], steps: 0,
      finalUrl: page.url, fromHistory: false,
    };
  }

  // A long text as passages a model can take in one go: short texts as
  // they are; long ones as the LLM's notes on each part (or, without an
  // LLM, the passages closest to the request).
  private async digest(task: string, title: string, text: string,
                       onEvent: (event: AgentEvent) => void,
                       signal?: AbortSignal): Promise<string[]> {
    const parts = splitText(text, DIGEST_CHARS);
    if (parts.length <= 1) {
      return parts;
    }
    const {llm} = this.deps;
    if (!llm) {
      return topPassages(text, task, 8);
    }
    // Spread over the whole text when it is very long.
    const picked = parts.length <= MAX_DIGEST_PARTS ? parts :
        Array.from({length: MAX_DIGEST_PARTS},
                   (_, i) => parts[Math.floor(i * parts.length / MAX_DIGEST_PARTS)]!);
    const notes: string[] = [];
    for (const [i, part] of picked.entries()) {
      signal?.throwIfAborted();
      this.deps.driver.status(`Reading part ${i + 1} of ${picked.length}`).catch(() => {});
      notes.push(await withRetry(
          () => llm.chat(notesMessages(task, title, part, i + 1, picked.length),
                         {maxTokens: 384, ...(signal ? {signal} : {})}),
          this.retrying('notes', onEvent, signal)));
    }
    return notes.map(stripReasoning);
  }

  // Where to start is the agent's call: a URL the user wrote, else the open
  // page if it is a web page, else a search. Small models invent URLs and
  // misjudge whether the open page is the right place.
  private initialPlan(task: string, page: PageSnapshot): Plan {
    const url = task.match(/https?:\/\/\S+/)?.[0];
    return {
      start: url ? 'url' : isHttpUrl(page.url) ? 'current' : 'search',
      url: url ?? '',
      searchQuery: task,
      goal: task,
    };
  }

  // The LLM rewrites the request as a goal and a search query (resolving
  // follow-ups like "and the cheaper one?" against the chat). Failures keep
  // the user's own words.
  private async refinePlan(plan: Plan, task: string, page: PageSnapshot,
                           context: ChatContext|undefined, user: UserContext,
                           onEvent: (event: AgentEvent) => void,
                           signal?: AbortSignal): Promise<void> {
    if (this.deps.llm) {
      try {
        const reply = await this.json<PlanReply>(
            'plan', planMessages(task, page.url, page.title, context?.history ?? [], user),
            planSchema(user.pages.length),
            reply => (reply.goal ? null : 'goal is empty'), 256, onEvent, signal);
        plan.searchQuery = reply.searchQuery || task;
        plan.goal = reply.goal || task;
        // Only the user's own pages can be picked; the model writes no URL.
        const pick = reply.startPage ? user.pages[reply.startPage - 1] : undefined;
        if (pick && plan.start !== 'url') {
          plan.start = 'url';
          plan.url = pick.url;
          onEvent({type: 'step', index: 0, option: 'open',
                   description: `open ${pick.bookmark ? 'your bookmark' : 'from your history'} ` +
                                `“${pick.title || hostOf(pick.url)}”`,
                   confidence: 1, by: 'llm'});
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        onEvent({type: 'warning', message: `Planning failed: ${describeError(error)}`});
      }
    }
    onEvent({type: 'plan', plan: {...plan}, by: this.deps.llm ? 'llm' : 'heuristic'});
  }

  // One navigation step: how close the page is, and what to do next.
  private async judge(goal: string, page: PageSnapshot, candidates: Candidate[],
                      notes: StepNotes, onEvent: (event: AgentEvent) => void,
                      signal?: AbortSignal): Promise<Judgement> {
    const {decider, llm, settings} = this.deps;
    const view = pageView(page, goal, notes);
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
      const result = await withRetry(
          () => decider.decide({state: view, questions}, signal),
          this.retrying('decider', onEvent, signal));
      done = noul(result, 'done');
      relevant = noul(result, 'relevant');
      if (candidates.length === 1) {
        next = candidates[0];
        confidence = 1;
      } else if (candidates.length > 1) {
        ({next, confidence} = blendWithWords(candidates, choice(result, 'next')));
      }
      const sure = confidence >= settings.escalateBelow || !llm;
      if (sure || done >= settings.doneAbove || candidates.length === 0) {
        return {done, relevant, ...(next ? {next} : {}), confidence, by: 'decider'};
      }
    }

    if (llm && candidates.length) {
      const keys = new Set(candidates.map(c => c.key));
      const reply = await this.json<{done: boolean, action: string}>(
          'step', stepMessages(goal, view, candidates), stepSchema(candidates),
          reply => (keys.has(reply.action) ? null :
                    `"${reply.action}" is not one of the option keys`),
          64, onEvent, signal);
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

  // Whether the chat's last sources already answer a follow-up.
  private async answeredBy(task: string, sources: Evidence[],
                           onEvent: (event: AgentEvent) => void,
                           signal?: AbortSignal): Promise<boolean> {
    const {decider, settings} = this.deps;
    if (!decider) {
      return false;
    }
    const state = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.passages.join('\n')}`)
                      .join('\n\n').slice(0, PAGE_TEXT_FOR_DECIDER);
    const result = await withRetry(() => decider.decide({
      state,
      questions: {
        covered: {type: 'noul', instructions: `Do these sources contain the answer to: ${task}`},
      },
    }, signal), this.retrying('decider', onEvent, signal));
    return noul(result, 'covered') >= settings.doneAbove;
  }

  // Whether an answer gives what the user asked for (an answer that says the
  // sources lack it does not).
  private async answers(task: string, answer: string,
                        onEvent: (event: AgentEvent) => void,
                        signal?: AbortSignal): Promise<boolean> {
    const {decider, llm} = this.deps;
    try {
      if (decider) {
        const result = await withRetry(() => decider.decide({
          state: `Question: ${task}\nAnswer: ${stripReasoning(answer)}`,
          questions: {
            answered: {type: 'noul',
                       instructions: `Does the answer give the information asked for in: ${task}`},
          },
        }, signal), this.retrying('decider', onEvent, signal));
        return noul(result, 'answered') >= 0.5;
      }
      if (llm) {
        const reply = await this.json<{answered: boolean}>(
            'check', checkMessages(task, stripReasoning(answer)), CHECK_SCHEMA,
            () => null, 16, onEvent, signal);
        return reply.answered;
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
    }
    return true;
  }

  private async fieldText(goal: string, field: Candidate,
                          signal?: AbortSignal): Promise<string> {
    const fallback = field.action.kind === 'type' ? field.action.text : '';
    try {
      const reply = await this.json<{text: string}>(
          'field', fieldMessages(goal, field.description), FIELD_SCHEMA,
          reply => (reply.text.trim() ? null : 'text is empty'), 64, () => {}, signal);
      return reply.text.trim();
    } catch {
      return fallback;
    }
  }

  private async answer(task: string, sources: Evidence[], context: ChatContext|undefined,
                       onEvent: (event: AgentEvent) => void,
                       signal?: AbortSignal, summary = false,
                       user: UserContext = NO_USER): Promise<string> {
    const {llm, decider} = this.deps;
    if (llm) {
      const messages = (summary ? summaryMessages : answerMessages)(
          task, sources, context?.history ?? [], user);
      return withRetry(() => llm.chat(messages, {
        maxTokens: 768,
        onToken: text => onEvent({type: 'answer-token', text}),
        ...(signal ? {signal} : {}),
      }), this.retrying('answer', onEvent, signal));
    }
    // Decider-only: return the passage the decider picks as the answer.
    const passages = sources.flatMap(
        (s, i) => s.passages.map(p => ({p, source: i + 1})));
    if (!decider || !passages.length) {
      return 'No answer found on the visited pages.';
    }
    const options = passages.slice(0, 24);
    const result = await withRetry(() => decider.decide({
      state: task,
      questions: {
        best: {
          type: 'choice',
          instructions: `Which passage best answers: ${task}`,
          criteria: Object.fromEntries(options.map((o, i) => [`p${i}`, o.p])),
        },
      },
    }, signal), this.retrying('decider', onEvent, signal));
    const best = options[Number(choice(result, 'best').choice.slice(1))];
    return best ? `${best.p} [${best.source}]` : 'No answer found.';
  }

  // A structured LLM call that survives a bad reply: transient errors are
  // retried, and an invalid reply is sent back with what was wrong.
  private async json<T>(what: string, messages: ChatMessage[], schema: object,
                        validate: (reply: T) => string|null, maxTokens: number,
                        onEvent: (event: AgentEvent) => void,
                        signal?: AbortSignal): Promise<T> {
    const llm = this.deps.llm!;
    const conversation = [...messages];
    for (let attempt = 1;; ++attempt) {
      // Network and runtime errors propagate (after retries); only a bad
      // reply is worth a second attempt.
      const raw = await withRetry(
          () => llm.chat(conversation, {schema, maxTokens, ...(signal ? {signal} : {})}),
          this.retrying(what, onEvent, signal));
      let problem: string;
      try {
        const reply = parseJsonReply<T>(raw);
        const invalid = validate(reply);
        if (!invalid) {
          return reply;
        }
        problem = invalid;
      } catch {
        problem = 'the reply was not valid JSON';
      }
      if (attempt >= 2) {
        throw new Error(`${what}: ${problem}`);
      }
      onEvent({type: 'retry', what, attempt, error: problem});
      conversation.push({role: 'assistant', content: raw},
                        {role: 'user', content: `That reply is invalid: ${problem}. ` +
                                                'Reply again with JSON only.'});
    }
  }

  private retrying(what: string, onEvent: (event: AgentEvent) => void,
                   signal?: AbortSignal) {
    return {
      ...(signal ? {signal} : {}),
      onRetry: (attempt: number, error: unknown) =>
          onEvent({type: 'retry', what, attempt, error: describeError(error)}),
    };
  }

  private searchUrl(query: string): string {
    const template = this.deps.searchUrl ?? 'https://html.duckduckgo.com/html/?q=%s';
    return template.replace('%s', encodeURIComponent(query));
  }
}

// Error pages (network errors, HTTP 4xx/5xx) and empty documents: nothing
// to read and nothing to click. Small real pages are fine.
// Whether `quote` is really on the page: verbatim (ignoring case, spacing
// and punctuation), or nearly every word of it in order-free form.
export function grounded(quote: string, text: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}$%.,]+/gu, ' ').trim();
  const q = norm(quote);
  if (q.length < 3) {
    return false;
  }
  const page = norm(text);
  if (page.includes(q)) {
    return true;
  }
  const words = q.split(' ').filter(w => w.length > 1);
  const have = new Set(page.split(' '));
  return words.length >= 4 && words.filter(w => have.has(w)).length / words.length >= 0.9;
}

// Whether taking `candidate` commits the user (buying, paying, sending,
// deleting, subscribing).
export function commits(candidate: Candidate): boolean {
  const {action} = candidate;
  return (action.kind === 'click' || (action.kind === 'type' && action.submit)) &&
      COMMITS.test(candidate.description);
}

const QUESTION_WORDS = new Set([
  'what', 'which', 'who', 'where', 'when', 'why', 'how', 'is', 'are', 'was', 'the',
  'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'my', 'me', 'i', 'it',
  'find', 'show', 'tell', 'get', 'buy', 'order', 'can', 'you', 'please', 'from',
  'with', 'about', 'that', 'this', 'do', 'does', 'price', 'cost', 'much', 'many',
]);

// The words of a request most likely to name a page: longest first.
export function keywords(task: string, max: number): string[] {
  const words = (task.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
                    .filter(w => w.length > 2 && !QUESTION_WORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
}

// "Buy …", "book …", "send …": a request to act, not to find out.
export function isActionRequest(task: string): boolean {
  return /^\s*(please\s+)?(buy|order|purchase|book|reserve|subscribe|unsubscribe|sign up|register|add|send|post|apply|submit|fill|cancel|delete|remove|download|pay|check ?out|follow|like|share|comment|reply|message|email|schedule|rsvp|log ?in|sign ?in|place)\b/i
      .test(task);
}

// Requests about the open page or video rather than something to find.
export function aboutOpenPage(task: string): boolean {
  if (/https?:\/\//.test(task)) {
    return false;
  }
  if (/\btl;?\s?dr\b|\b(this|current|the open) (video|page|article|post|thread|paper|site|talk|episode|podcast|clip|story|tab|doc|document)\b|\bwhat('s| is) (this|it) about\b/i
          .test(task)) {
    return true;
  }
  // A short "summarize" / "key points" names nothing else to look up.
  return task.trim().split(/\s+/).length <= 5 &&
      /\b(summar(y|i[sz]e)|recap|key (points|takeaways)|main points|gist)\b/i.test(task);
}

// Splits text into parts of at most `size` characters at sentence ends.
export function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
    const end = cut > size / 2 ? cut + 1 : size;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) {
    parts.push(rest);
  }
  return parts;
}

export function isUnusable(page: PageSnapshot): boolean {
  if (page.url.startsWith('chrome-error://') || page.url === 'about:blank' ||
      page.status >= 400) {
    return true;
  }
  return page.elements.length === 0 && page.text.trim().length < 20 && !page.title;
}

function loadedUrl(page: PageSnapshot, target: string): string {
  return page.url.startsWith('chrome-error://') ? target : page.url;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

function addressOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

// Small models sometimes think out loud despite the prompt: a reasoning block
// ("…</think>"), or a recap of the sources ending in "Answer: …". The user
// sees only the answer.
// How much the words of an option (its overlap with the goal) count next to
// the decider's probability for it.
const WORD_WEIGHT = 0.3;

// The decider's pick, nudged toward the options whose words match the goal:
// a small decider spreads its probability thin over a long list of links.
// When the two agree the step is sure; when the words win, it is as unsure
// as the decider was about that option (so an LLM, if there is one, decides).
export function blendWithWords(candidates: Candidate[], picked: ChoiceAnswer):
    {next?: Candidate, confidence: number} {
  const probability = (c: Candidate) =>
      picked.probabilities?.[c.key] ?? (c.key === picked.choice ? picked.confidence : 0);
  const top = Math.max(0, ...candidates.map(c => c.score));
  // Only a real match counts (more than being on screen).
  const words = (c: Candidate) => (top > 1 ? Math.max(0, c.score) / top : 0);
  let next: Candidate|undefined;
  let best = -1;
  for (const candidate of candidates) {
    const blended = probability(candidate) + WORD_WEIGHT * words(candidate);
    if (blended > best) {
      next = candidate;
      best = blended;
    }
  }
  if (!next) {
    return {confidence: 0};
  }
  const confidence = next.key === picked.choice ?
      Math.min(1, picked.confidence + WORD_WEIGHT * words(next)) : probability(next);
  return {next, confidence};
}

export function stripReasoning(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const end = withoutBlocks.lastIndexOf('</think>');
  let answer = (end >= 0 ? withoutBlocks.slice(end + '</think>'.length) : withoutBlocks).trim();
  const marked = [...answer.matchAll(/^(?:\*\*)?(?:final )?answer:?(?:\*\*)?:?\s*/gim)].at(-1);
  if (marked?.index !== undefined && marked.index > 0) {
    answer = answer.slice(marked.index + marked[0].length).trim();
  }
  // Models write no-break and thin spaces ("9\u202fam"): plain spaces copy
  // and search as people expect.
  return answer.replace(/[\u00a0\u2007\u2009\u202f]/g, ' ');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function actionLabel(candidate: Candidate): string {
  const action: PageAction = candidate.action;
  switch (action.kind) {
    case 'type':
      return `Typing “${action.text}”`;
    case 'scroll':
      return 'Scrolling';
    case 'back':
      return 'Going back';
    default: {
      const label = candidate.description.match(/"(.*)"/)?.[1];
      return label ? `Opening ${label}` : 'Opening link';
    }
  }
}

// The decider and LLM see the page as short text: where we are, the outline,
// the passages closest to the goal, and what happened so far.
export function pageView(page: PageSnapshot, goal: string,
                         notes: StepNotes = {trajectory: []}): string {
  const passages = topPassages(page.text, goal, 8).join('\n');
  return [
    // Without the query string: a search results URL repeats the question,
    // which made a 2B decider believe the results page held the answer.
    `URL: ${addressOf(page.url)}`,
    `Title: ${page.title}`,
    page.headings.length ? `Headings: ${page.headings.join(' | ')}` : '',
    notes.trajectory.length ? `Steps so far: ${notes.trajectory.join(' → ')}` : '',
    notes.lastError ? `Last action failed: ${notes.lastError}` : '',
    `Text: ${passages.slice(0, PAGE_TEXT_FOR_DECIDER)}`,
  ].filter(Boolean).join('\n');
}
