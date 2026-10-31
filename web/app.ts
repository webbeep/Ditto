// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The agent panel: chats with the agent, chat history, and models.

import {BrowserAgent} from './agent/agent/agent.js';
import type {AgentEvent, AskRequest} from './agent/agent/agent.js';
import {PageDriver} from './agent/browser/page_driver.js';
import {contextFor} from './agent/chat/chat.js';
import type {Chat, ChatStore, Turn} from './agent/chat/chat.js';
import {DeciderClient} from './agent/decider/decider_client.js';
import {LlmClient} from './agent/llm/llm_client.js';
import {CATALOG, findModel, recommendForDevice, routerPresetIni} from './agent/models/catalog.js';
import type {CatalogModel, DeviceAdvice, DeviceInfo} from './agent/models/catalog.js';
import {ModelManager, NotDownloadedError} from './agent/models/model_manager.js';
import type {ModelStatus} from './agent/models/model_manager.js';
import {defaultSettings, usesDecider, usesLlm} from './agent/models/settings.js';
import type {AgentMode, AgentSettings} from './agent/models/settings.js';
import {Warmer} from './agent/models/warmer.js';
import {MemoryStore} from './agent/memory/memory.js';
import {everyLabel, isDue, isWatchRequest, judgeWatch, planWatch} from './agent/agent/watch.js';
import type {Watch} from './agent/agent/watch.js';
import type {AgentResult} from './agent/agent/agent.js';
import {loadChatStore} from './chat_storage.js';
import {Target} from './bridge.js';
import {icon} from './icons.js';
import type {IconName} from './icons.js';
import {BrowserProxy, BridgeCdpTransport, BridgeHttpTransport} from './transports.js';
import {autoGrow, formatMB, h, hostOf, iconButton, readJson, relativeTime,
        writeJson} from './ui.js';

const SETTINGS_KEY = 'ditto.agent.settings';
// MiB the router keeps free on the GPU device (unified memory on Apple
// silicon) on top of Ditto's own model budget.
const ROUTER_MEMORY_MARGIN_MB = 2048;

const MODES: Array<{mode: AgentMode, icon: IconName, label: string}> = [
  {mode: 'hybrid', icon: 'hybrid', label: 'Decider navigates, LLM answers'},
  {mode: 'decider-only', icon: 'decider', label: 'Decider only (fastest)'},
  {mode: 'llm-only', icon: 'llm', label: 'LLM only'},
  {mode: 'off', icon: 'off', label: 'Models off'},
];

const proxy = BrowserProxy.get();
const runtimeHttp = new BridgeHttpTransport(proxy, Target.kRuntime);
const strandsHttp = new BridgeHttpTransport(proxy, Target.kStrandsSidecar);
const models = new ModelManager(runtimeHttp);
let store: ChatStore;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: AgentSettings;
let view: 'chat'|'history'|'models'|'memory'|'setup' = 'chat';
// Whether the models the chosen mode needs are on disk; Ditto answers only
// then (first launch: the setup view offers the right ones for this Mac).
let aiReady = false;
const SETUP_KEY = 'ditto.setup';
let memory: MemoryStore;
let chatId: string|null = null;
let running: AbortController|null = null;
let runtimeReady: Promise<void>|null = null;
let statuses = new Map<string, ModelStatus>();
let refreshTimer = 0;
let warmer: Warmer|null = null;
// Pages Ditto watches, and the check in progress (the user's questions come
// first: asking stops it).
let watches: Watch[] = [];
let checking: {abort: AbortController, done: Promise<void>}|null = null;

// ---- Runtime and models ----------------------------------------------------

function startRuntime(): Promise<void> {
  runtimeReady ??= (async () => {
    const {ok} = await proxy.handler.startRuntime(routerPresetIni(), ROUTER_MEMORY_MARGIN_MB);
    if (!ok) {
      throw new Error('The model runtime could not start.');
    }
    // The router takes a moment to bind its port.
    for (let attempt = 0; attempt < 40; ++attempt) {
      try {
        if ((await runtimeHttp.request('GET', '/models')).status === 200) {
          return;
        }
      } catch {
        // Not up yet.
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The model runtime did not respond.');
  })().catch(error => {
    runtimeReady = null;
    throw error;
  });
  return runtimeReady;
}

function stopRuntime() {
  warmer?.stop();
  warmer = null;
  runtimeReady = null;
  proxy.handler.stopRuntime();
}

async function clients(): Promise<{llm?: LlmClient, decider?: DeciderClient}> {
  await startRuntime();
  const keep = [settings.llmId, settings.deciderId];
  const result: {llm?: LlmClient, decider?: DeciderClient} = {};
  const loads: Promise<void>[] = [];
  if (usesLlm(settings.mode)) {
    loads.push(models.ensureLoaded(settings.llmId, settings.modelBudgetMB, keep));
    result.llm = new LlmClient(runtimeHttp, settings.llmId);
  }
  if (usesDecider(settings.mode)) {
    if (findModel(settings.deciderId)?.runtime === 'strands') {
      proxy.handler.setStrandsEndpoint(settings.strandsEndpoint);
      result.decider = new DeciderClient(strandsHttp, settings.deciderId, false);
    } else {
      loads.push(models.ensureLoaded(settings.deciderId, settings.modelBudgetMB, keep));
      result.decider = new DeciderClient(runtimeHttp, settings.deciderId);
    }
  }
  // Both models load at once.
  await Promise.all(loads);
  return result;
}

// Loads the chat's models as soon as the user starts typing (not on open:
// an untouched panel should cost no memory), and keeps them warm while the
// user is active.
async function warmUp() {
  if (settings.mode === 'off' || running) {
    return;
  }
  try {
    if (!warmer) {
      warmer = new Warmer(await clients());
    }
    warmer.touch();
  } catch {
    // The real run reports runtime problems.
  }
}

// ---- Header ----------------------------------------------------------------

function renderHeader() {
  const chat = chatId ? store.get(chatId) : undefined;
  $('title').textContent = view === 'history' ? 'History' :
                           view === 'models' ? 'Models' :
                           view === 'memory' ? 'Memory' :
                           view === 'setup' ? 'Set up' : (chat?.title ?? '');
  const toggle = (name: typeof view, iconName: IconName, label: string) => {
    const button = iconButton(iconName, label, () => show(view === name ? 'chat' : name));
    button.setAttribute('aria-pressed', String(view === name));
    return button;
  };
  $('header-actions').replaceChildren(
      toggle('history', 'history', 'History'),
      iconButton('newChat', 'New chat', () => newChat()),
      toggle('memory', 'note', 'Memory'),
      toggle('models', 'models', 'Models'));
}

function show(next: typeof view) {
  view = next;
  $('view-chat').hidden = view !== 'chat';
  $('view-history').hidden = view !== 'history';
  $('view-models').hidden = view !== 'models';
  $('view-memory').hidden = view !== 'memory';
  $('view-setup').hidden = view !== 'setup';
  $('composer').hidden = view !== 'chat';
  renderHeader();
  if (view === 'setup') {
    void renderSetup();
  } else if (view === 'history') {
    renderHistory();
  } else if (view === 'memory') {
    renderMemory();
  } else if (view === 'models') {
    void refreshModels();
  } else {
    $('prompt').focus();
  }
}

// ---- Thread ----------------------------------------------------------------

const STEP_ICONS: Record<string, IconName> = {
  link: 'link', button: 'link', textbox: 'type', searchbox: 'type',
  scroll: 'scroll', back: 'back', search: 'search', read: 'text',
};

function stepIcon(option: string, description: string): IconName {
  if (option === 'scroll_down') {
    return 'scroll';
  }
  if (option === 'go_back') {
    return 'back';
  }
  if (option === 'search') {
    return 'search';
  }
  return STEP_ICONS[description.split(' ')[0] ?? ''] ?? 'link';
}

function stepRow(iconName: IconName, text: string, by = '', cls = ''): HTMLLIElement {
  return h('li', {class: cls}, icon(iconName, 14), h('span', {}, text),
           by ? h('span', {class: 'by'}, by) : null);
}

function renderSources(sources: Array<{url: string, title: string}>): HTMLElement|null {
  if (!sources.length) {
    return null;
  }
  return h('div', {class: 'sources'}, ...sources.map((s, i) =>
      h('a', {href: s.url, target: '_blank', title: s.url},
        h('b', {}, String(i + 1)), h('span', {}, s.title || hostOf(s.url)),
        s.title ? h('span', {class: 'host'}, hostOf(s.url)) : null)));
}

function renderTrace(lines: string[], open = false): HTMLElement|null {
  if (!lines.length) {
    return null;
  }
  const details = h('details', {class: 'steps', open},
                    h('summary', {}, `${lines.length} ${lines.length === 1 ? 'step' : 'steps'}`,
                      icon('chevron', 12)),
                    h('ol', {}, ...lines.map(line => {
                      const [kind, text, by] = line.split('\t');
                      return stepRow((kind ?? 'link') as IconName, text ?? '', by ?? '',
                                     kind === 'retry' ? 'retry' : '');
                    })));
  return details;
}

// The answer with its [n] citations as small links to the sources.
function renderAnswer(text: string, sources: Array<{url: string, title: string}>): HTMLElement {
  const box = h('div', {class: 'text'});
  for (const part of text.split(/(\[\d+\])/)) {
    const n = Number(part.match(/^\[(\d+)\]$/)?.[1]);
    const source = sources[n - 1];
    box.append(source ?
        h('sup', {}, h('a', {href: source.url, target: '_blank', title: source.title || source.url},
                       String(n))) :
        part);
  }
  return box;
}

function renderTurn(turn: Turn): HTMLElement[] {
  return [
    h('div', {class: 'question'}, turn.question),
    h('div', {class: `reply${turn.failed ? ' failed' : ''}`},
      renderTrace(turn.trace),
      renderAnswer(turn.answer, turn.sources),
      renderSources(turn.sources)),
  ];
}

// A new chat: what Ditto can do with the page in front of the user.
const STARTERS: Array<{icon: IconName, label: string, run: () => void}> = [
  {icon: 'text', label: 'Summarize this page', run: () => void ask('tl;dr this page')},
  {icon: 'note', label: 'Key facts on this page',
   run: () => void ask('List the key facts on this page')},
  {icon: 'memory', label: 'Remember something…', run: () => {
    const prompt = $<HTMLTextAreaElement>('prompt');
    prompt.value = 'Remember that ';
    prompt.focus();
    renderComposer();
  }},
];

function emptyState(): HTMLElement {
  if (!aiReady) {
    const setUp = h('button', {class: 'button primary', type: 'button'}, 'Set up Ditto');
    setUp.addEventListener('click', () => show('setup'));
    return h('div', {class: 'empty'}, icon('logo', 40),
             h('p', {}, 'Ditto needs its models before it can help.'), setUp);
  }
  return h('div', {class: 'empty'},
           icon('logo', 40),
           h('p', {}, 'Ask about this page, or anything.'),
           h('div', {class: 'starters'}, ...STARTERS.map(starter => {
             const button = h('button', {type: 'button'}, icon(starter.icon, 14), starter.label);
             button.addEventListener('click', starter.run);
             return button;
           })));
}

function renderThread() {
  const chat = chatId ? store.get(chatId) : undefined;
  const thread = $('thread');
  if (!chat?.turns.length) {
    thread.replaceChildren(emptyState());
    return;
  }
  thread.replaceChildren(...chat.turns.flatMap(renderTurn));
  thread.lastElementChild?.scrollIntoView({block: 'end'});
}

function newChat() {
  if (running) {
    return;
  }
  chatId = null;
  show('chat');
  renderThread();
}

function openChat(id: string) {
  if (running || !store.get(id)) {
    return;
  }
  chatId = id;
  show('chat');
  renderThread();
}

// ---- Running the agent -----------------------------------------------------

async function ask(question: string) {
  if (running || !question.trim()) {
    return;
  }
  if (!aiReady && !await checkReady()) {
    $<HTMLTextAreaElement>('prompt').value = question;
    show('setup');
    return;
  }
  if (checking) {
    checking.abort.abort();
    await checking.done;
  }
  const chat: Chat = (chatId && store.get(chatId)) || store.create();
  chatId = chat.id;
  const context = contextFor(chat);
  show('chat');
  if (!chat.turns.length) {
    $('thread').replaceChildren();
  }

  const trace: string[] = [];
  const steps = h('ol');
  const traceBox = h('details', {class: 'steps', open: true},
                     h('summary', {}, 'Steps', icon('chevron', 12)), steps);
  traceBox.hidden = true;
  const statusText = h('span', {class: 'shimmer'}, 'Starting');
  const live = h('div', {class: 'live'}, h('span', {class: 'dot'}), statusText);
  const text = h('div', {class: 'text'});
  const reply = h('div', {class: 'reply'}, traceBox, live, text);
  $('thread').append(h('div', {class: 'question'}, question), reply);
  reply.scrollIntoView({block: 'end'});

  const addStep = (kind: IconName|'retry', line: string, by = '') => {
    trace.push(`${kind}\t${line}\t${by}`);
    steps.append(stepRow(kind === 'retry' ? 'retry' : kind, line, by,
                         kind === 'retry' ? 'retry' : ''));
    traceBox.hidden = false;
  };

  running = new AbortController();
  renderComposer();
  let answer = '';
  let sources: Turn['sources'] = [];
  let learning: Promise<string[]>|undefined;
  let failed = false;
  try {
    if (settings.mode === 'off') {
      throw new Error('Models are off. Choose a mode below to use the agent.');
    }
    statusText.textContent = 'Loading models';
    const {llm, decider} = await clients();
    warmer ??= new Warmer({llm, decider});
    warmer.touch();
    const [{urlTemplate}, {target}] = await Promise.all([
      proxy.handler.getSearchUrl(), proxy.handler.attachToActiveTab()]);
    if (!target.ok) {
      throw new Error('Could not attach to a tab.');
    }
    const signal = running.signal;
    const driver = new PageDriver(new BridgeCdpTransport(proxy));
    const agent = new BrowserAgent({
      driver,
      settings,
      ...(llm ? {llm} : {}),
      ...(decider ? {decider} : {}),
      ...(urlTemplate ? {searchUrl: urlTemplate} : {}),
      memory,
      userPages: async (query: string) => {
        const {pages} = await proxy.handler.searchUserPages(query, 8);
        return pages.map(p => ({url: p.url, title: p.title, timeMs: p.timeMs,
                                bookmark: p.bookmark}));
      },
      ask: request => askUser(reply, request, signal),
    });
    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case 'status':
          statusText.textContent = event.text;
          break;
        case 'step': {
          const by = event.by === 'agent' ? '' :
              `${event.by === 'llm' ? 'LLM' : 'decider'} ${Math.round(event.confidence * 100)}%`;
          addStep(stepIcon(event.option, event.description), event.description, by);
          break;
        }
        case 'retry':
          addStep('retry', `${event.what}: ${event.error}`);
          break;
        case 'warning':
          addStep('alert', event.message);
          break;
        case 'shield':
          addStep('shield', event.message);
          break;
        case 'ask':
          addStep(event.kind === 'approve' ? 'shield' : 'user', event.message);
          break;
        case 'memory':
          // Shown under the answer when learning finishes (below).
          break;
        case 'answer-token':
          live.hidden = true;
          text.textContent += event.text;
          break;
        case 'answer-reset':
          // The answer did not hold up; the agent keeps looking.
          text.textContent = '';
          live.hidden = false;
          break;
      }
    };
    const result = isWatchRequest(question) ?
        await startWatch(question, agent, driver, {llm, decider, signal}, onEvent) :
        await agent.run(question, onEvent, {signal, context});
    answer = result.answer;
    sources = result.evidence;
    learning = result.learning;
    if (result.fromHistory) {
      trace.unshift(`history\tFrom this chat's sources\t`);
    }
  } catch (error) {
    failed = true;
    answer = running.signal.aborted ? 'Stopped.' : (error as Error).message;
    if (error instanceof NotDownloadedError) {
      // A model went missing (deleted in Models): set up again.
      aiReady = false;
      writeJson(SETUP_KEY, {done: false});
      answer += ' Download it to continue.';
    }
  } finally {
    running = null;
    proxy.handler.detachFromTab();
  }
  const at = Date.now();
  store.addTurn(chat.id, {question, answer, sources, trace: [...trace], at, failed});
  // Notes about the user arrive after the answer.
  void learning?.then(notes => {
    if (notes.length) {
      store.annotate(chat.id, at, `note\tNoted: ${notes.join(' · ')}\t`);
      if (chatId === chat.id && view === 'chat') {
        renderThread();
      }
    }
  });
  renderHeader();
  renderThread();
  renderComposer();
}

// ---- Composer --------------------------------------------------------------

function renderComposer() {
  $('composer').classList.toggle('working', !!running);
  $('modes').replaceChildren(...MODES.map(m => {
    const button = iconButton(m.icon, m.label, () => setMode(m.mode));
    button.setAttribute('aria-pressed', String(settings.mode === m.mode));
    button.disabled = !!running;
    return button;
  }));
  const prompt = $<HTMLTextAreaElement>('prompt');
  const send = running ?
      iconButton('stop', 'Stop', () => running?.abort(), 'primary') :
      iconButton('send', 'Send', () => $<HTMLFormElement>('composer').requestSubmit(), 'primary');
  if (!running) {
    send.disabled = settings.mode === 'off' || !aiReady || !prompt.value.trim();
  }
  prompt.placeholder = aiReady || settings.mode === 'off' ? 'Ask anything' :
      'Set up Ditto to ask';
  $('send-slot').replaceChildren(send);
}

function setMode(mode: AgentMode) {
  settings.mode = mode;
  writeJson(SETTINGS_KEY, settings);
  // Another mode may need other models.
  writeJson(SETUP_KEY, {done: false});
  aiReady = false;
  if (mode !== 'off') {
    void checkReady().then(() => renderComposer());
  }
  if (mode === 'off') {
    stopRuntime();
  } else {
    warmer?.stop();
    warmer = null;
  }
  renderComposer();
}

// ---- History ---------------------------------------------------------------

function renderHistory(filter = '') {
  const search = h('input', {class: 'field', type: 'search', placeholder: 'Search',
                             'aria-label': 'Search chats', value: filter});
  search.addEventListener('input', () => {
    renderHistory(search.value);
    const again = $('view-history').querySelector('input');
    again?.focus();
    again?.setSelectionRange(search.value.length, search.value.length);
  });
  const needle = filter.toLowerCase();
  const chats = store.list().filter(c => c.title.toLowerCase().includes(needle) ||
      c.turns.some(t => t.question.toLowerCase().includes(needle)));
  $('view-history').replaceChildren(h('div', {class: 'history'},
      h('div', {class: 'field-wrap'}, icon('search', 14), search),
      chats.length ?
          h('ul', {}, ...chats.map(c => h('li', {
              'aria-current': String(c.id === chatId),
              onclick: () => openChat(c.id),
            },
            h('span', {class: 'name'}, c.title),
            h('span', {class: 'when'}, relativeTime(c.updatedAt)),
            iconButton('trash', 'Delete chat', (e: Event) => {
              e.stopPropagation();
              store.remove(c.id);
              if (chatId === c.id) {
                chatId = null;
                renderThread();
              }
              renderHistory(filter);
            }, 'ghost small danger')))) :
          h('div', {class: 'empty'}, icon('history', 28))));
}

// ---- Asking the user -------------------------------------------------------

// A card under the reply: approve an action that commits the user, or take
// the tab to sign in or pay. Resolves with the user's answer (false when the
// run is stopped).
function askUser(reply: HTMLElement, request: AskRequest,
                 signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const approve = request.kind === 'approve';
    const done = (answer: boolean) => {
      card.remove();
      signal.removeEventListener('abort', stop);
      resolve(answer);
    };
    const stop = () => done(false);
    const go = h('button', {class: 'button primary', type: 'button'},
                 approve ? 'Approve' : 'Continue');
    go.addEventListener('click', () => done(true));
    const card = h('div', {class: 'ask', role: 'alertdialog', 'aria-label': request.message},
                   icon(approve ? 'shield' : 'user', 16),
                   h('span', {class: 'message'}, request.message),
                   h('div', {class: 'actions'},
                     iconButton('stop', 'Stop', stop, 'ghost'), go));
    signal.addEventListener('abort', stop);
    reply.append(card);
    card.scrollIntoView({block: 'end'});
    go.focus();
  });
}

// ---- Watches ---------------------------------------------------------------

function saveWatches() {
  proxy.handler.saveWatches(JSON.stringify(watches));
}

// From disk: another window's panel may have added or removed one.
async function loadWatches() {
  const {json} = await proxy.handler.loadWatches();
  try {
    watches = json ? JSON.parse(json) as Watch[] : [];
  } catch {
    watches = [];
  }
}

const withoutCitations = (text: string) => text.replace(/\s*\[\d+\]/g, '').trim();

// "Tell me when …": read the page now, then again on a schedule the app
// keeps (onCheckWatches).
async function startWatch(question: string, agent: BrowserAgent, driver: PageDriver,
                          judges: {llm?: LlmClient|undefined, decider?: DeciderClient|undefined,
                                   signal: AbortSignal},
                          onEvent: (event: AgentEvent) => void):
    Promise<Pick<AgentResult, 'answer'|'evidence'|'fromHistory'|'learning'>> {
  const page = await driver.snapshot();
  if (!/^https?:/.test(page.url)) {
    return {answer: 'Open the page to watch, then ask again.', evidence: [], fromHistory: false};
  }
  onEvent({type: 'status', text: 'Setting up the watch'});
  const plan = await planWatch(question, {title: page.title, url: page.url},
                               judges.llm, judges.signal);
  const reading = await agent.run(plan.question, onEvent, {signal: judges.signal});
  const now = Date.now();
  const watch: Watch = {
    id: `w${now.toString(36)}`, url: page.url, title: page.title || hostOf(page.url),
    ...plan, createdAt: now, checkedAt: now, last: reading.answer, met: false,
  };
  watch.met = (await judgeWatch({...watch, last: ''}, reading.answer, judges)).met;
  await loadWatches();
  watches.push(watch);
  saveWatches();
  const when = watch.condition ? `when ${watch.condition}` : 'when it changes';
  const already = watch.condition && watch.met ? ' It already does.' : '';
  return {
    answer: `Watching ${watch.title} ${everyLabel(watch.everyMinutes)}: you’ll get a ` +
            `notification ${when}.${already}\n\nNow: ${reading.answer}`,
    evidence: reading.evidence,
    fromHistory: false,
  };
}

// Reads every watch that is due, in Ditto's tab, and notifies on news.
async function checkWatches() {
  if (running || checking || settings.mode === 'off') {
    return;
  }
  await loadWatches();
  if (!watches.some(w => isDue(w))) {
    return;
  }
  const abort = new AbortController();
  let finished = () => {};
  checking = {abort, done: new Promise<void>(resolve => { finished = resolve; })};
  try {
    const {llm, decider} = await clients();
    for (const watch of watches.filter(w => isDue(w))) {
      if (abort.signal.aborted) {
        break;
      }
      await checkWatch(watch, llm, decider, abort.signal);
    }
  } catch {
    // Models not ready, or the user asked something: the next round retries.
  } finally {
    proxy.handler.detachFromTab();
    checking = null;
    finished();
    if (view === 'memory') {
      renderMemory();
    }
  }
}

async function checkWatch(watch: Watch, llm: LlmClient|undefined,
                          decider: DeciderClient|undefined, signal: AbortSignal) {
  const {target} = await proxy.handler.attachToActiveTab(watch.url);
  if (!target.ok) {
    return;
  }
  const agent = new BrowserAgent({
    driver: new PageDriver(new BridgeCdpTransport(proxy)),
    settings,
    ...(llm ? {llm} : {}),
    ...(decider ? {decider} : {}),
    // Nothing that needs the user happens unattended.
    ask: async () => false,
  });
  const reading = await agent.run(watch.question, () => {}, {signal});
  const verdict = await judgeWatch(watch, reading.answer, {llm, decider, signal});
  // Saved onto the list as it is now: it may have been removed meanwhile.
  await loadWatches();
  const current = watches.find(w => w.id === watch.id);
  if (!current) {
    return;
  }
  current.checkedAt = Date.now();
  current.met = verdict.met;
  if (reading.answer.trim()) {
    current.last = reading.answer;
  }
  if (verdict.notify) {
    current.toldAt = current.checkedAt;
    proxy.handler.notify(current.title, withoutCitations(reading.answer), current.url);
  }
  saveWatches();
}

function renderWatches(): HTMLElement|null {
  if (!watches.length) {
    return null;
  }
  return h('section', {class: 'watches'},
           h('h2', {}, icon('eye', 14), 'Watching'),
           h('ul', {}, ...watches.map(watch => h('li', {},
             icon('globe', 14),
             h('span', {class: 'name', title: `${watch.question}\n${withoutCitations(watch.last)}`},
               h('b', {}, watch.title),
               ` · ${watch.condition || 'any change'}`),
             h('span', {class: 'when'}, everyLabel(watch.everyMinutes)),
             iconButton('trash', 'Stop watching', async (e: Event) => {
               e.stopPropagation();
               await loadWatches();
               watches = watches.filter(w => w.id !== watch.id);
               saveWatches();
               renderMemory();
             }, 'ghost small danger')))));
}

// ---- Memory ----------------------------------------------------------------

function renderMemory() {
  const learn = h('input', {type: 'checkbox', checked: memory.learning});
  learn.addEventListener('change', () => memory.setLearning(learn.checked));
  const notes = memory.notes();
  $('view-memory').replaceChildren(h('div', {class: 'history memory'},
      renderWatches(),
      h('div', {class: 'memory-bar'},
        h('label', {class: 'switch'}, learn, h('span', {}, 'Learn from chats')),
        iconButton('trash', 'Forget everything', () => {
          memory.clear();
          renderMemory();
        }, 'ghost small danger')),
      notes.length ?
          h('ul', {}, ...notes.map(note => h('li', {},
            icon(note.source === 'told' ? 'user' : 'note', 14),
            h('span', {class: 'name', title: note.text}, note.text),
            h('span', {class: 'when'}, relativeTime(note.createdAt)),
            iconButton('trash', 'Forget this', (e: Event) => {
              e.stopPropagation();
              memory.remove(note.id);
              renderMemory();
            }, 'ghost small danger')))) :
          h('div', {class: 'empty'}, icon('note', 28))));
}

// ---- Models ----------------------------------------------------------------

function renderModels() {
  const resident = [...statuses.values()].filter(s => s.state === 'loaded' || s.state === 'sleeping');
  const used = resident.reduce((sum, s) => sum + (s.measuredMB ?? findModel(s.id)?.ramMB ?? 0), 0);
  const budget = settings.modelBudgetMB;
  const meter = h('div', {class: 'meter', title: 'Memory used by loaded models'},
                  h('div', {class: 'bar'}, h('i', {style: `width:${Math.min(100, 100 * used / budget)}%`})),
                  h('div', {class: 'legend'},
                    h('span', {}, `${formatMB(used)} of ${formatMB(budget)}`),
                    h('span', {}, `${resident.length} loaded`)));
  const section = (role: 'llm'|'decider', iconName: IconName, label: string) =>
      h('section', {},
        h('h2', {}, icon(iconName, 14), label),
        h('ul', {}, ...CATALOG.filter(m => m.role === role).map(renderModel)));
  $('view-models').replaceChildren(h('div', {class: 'models'},
      meter,
      section('llm', 'llm', 'LLM'),
      section('decider', 'decider', 'Decider'),
      h('div', {}, iconButton('off', 'Unload all models and stop the runtime', () => {
        setMode('off');
        statuses = new Map();
        renderModels();
      }, 'ghost danger'))));
}

function renderModel(model: CatalogModel): HTMLLIElement {
  const status = statuses.get(model.id);
  const current = model.id === settings.llmId || model.id === settings.deciderId;
  const onDisk = model.runtime === 'strands' ||
      (status && !['not-downloaded', 'incomplete', 'downloading'].includes(status.state));
  const choose = () => {
    if (!onDisk || running) {
      return;
    }
    if (model.role === 'llm') {
      settings.llmId = model.id;
    } else {
      settings.deciderId = model.id;
    }
    writeJson(SETTINGS_KEY, settings);
    warmer?.stop();
    warmer = null;
    renderModels();
  };
  const act = (name: IconName, label: string, fn: () => Promise<unknown>, cls = 'ghost small') =>
      iconButton(name, label, async () => {
        try {
          await fn();
        } finally {
          await refreshModels();
        }
      }, cls);

  const actions = h('span', {class: 'actions'});
  if (model.runtime === 'strands') {
    actions.title = 'Runs in the strands-decider sidecar';
  } else if (!status || status.state === 'not-downloaded') {
    actions.append(act('download', `Download ${formatMB(model.downloadMB)}`,
                       () => models.download(model.id)));
  } else if (status.state === 'incomplete') {
    actions.append(act('download', 'Resume download', () => models.download(model.id)));
  } else if (status.state === 'downloading') {
    const progress = h('progress');
    if (status.progress?.total) {
      progress.max = status.progress.total;
      progress.value = status.progress.done;
    }
    actions.append(progress, act('pause', 'Pause', () => models.pauseDownload(model.id)));
  } else {
    if (status.state === 'loaded' || status.state === 'sleeping') {
      actions.append(act('eject', 'Unload from memory', () => models.unload(model.id)));
    }
    actions.append(act('trash', 'Delete from disk', () => models.remove(model.id),
                       'ghost small danger'));
  }
  return h('li', {'aria-current': String(current)},
           h('span', {class: 'radio', role: 'radio', 'aria-checked': String(current),
                      'aria-disabled': String(!onDisk), title: `Use ${model.name}`,
                      'aria-label': `Use ${model.name}`, onclick: choose}),
           h('div', {},
             h('div', {class: 'name'}, model.name),
             h('div', {class: 'meta'}, `${model.params} · ${formatMB(model.downloadMB)} · ` +
               `${formatMB(model.ramMB)} RAM`)),
           actions);
}

async function refreshModels() {
  window.clearTimeout(refreshTimer);
  if (view !== 'models') {
    return;
  }
  if (settings.mode !== 'off') {
    try {
      await startRuntime();
      statuses = new Map((await models.list()).map(s => [s.id, s]));
    } catch {
      statuses = new Map();
    }
    aiReady = neededModels().every(onDisk);
    writeJson(SETUP_KEY, {done: aiReady});
  }
  renderModels();
  if ([...statuses.values()].some(s => s.state === 'downloading' || s.state === 'loading')) {
    refreshTimer = window.setTimeout(refreshModels, 1000);
  }
}

// ---- First launch ----------------------------------------------------------

// The llama.cpp models the current mode needs (strands deciders run in their
// own sidecar).
function neededModels(): string[] {
  return [
    ...(usesLlm(settings.mode) ? [settings.llmId] : []),
    ...(usesDecider(settings.mode) && findModel(settings.deciderId)?.runtime === 'llama' ?
            [settings.deciderId] : []),
  ];
}

const onDisk = (id: string) => {
  const state = statuses.get(id)?.state;
  return !!state && !['not-downloaded', 'incomplete', 'downloading', 'failed'].includes(state);
};

async function refreshStatuses() {
  await startRuntime();
  statuses = new Map((await models.list()).map(s => [s.id, s]));
}

// Whether Ditto can answer: models on disk (checked with the runtime once;
// after that the setup is remembered until a model goes missing).
async function checkReady(): Promise<boolean> {
  if (settings.mode === 'off') {
    aiReady = false;
    return false;
  }
  if (readJson(SETUP_KEY, {done: false}).done) {
    aiReady = true;
    return true;
  }
  try {
    await refreshStatuses();
    aiReady = neededModels().every(onDisk);
  } catch {
    aiReady = false;
  }
  if (aiReady) {
    writeJson(SETUP_KEY, {done: true});
  }
  return aiReady;
}

let device: DeviceInfo|null = null;
let advice: DeviceAdvice|null = null;
let setupTimer = 0;

async function renderSetup() {
  window.clearTimeout(setupTimer);
  device ??= await proxy.handler.getDevice();
  advice ??= recommendForDevice(device);
  try {
    await refreshStatuses();
  } catch {
    // Shown as not downloaded; the button retries.
  }
  const pick = [advice.llm, advice.decider].map(id => findModel(id)!);
  const missing = pick.filter(m => !onDisk(m.id));
  const downloading = pick.some(m => statuses.get(m.id)?.state === 'downloading');
  const gb = (mb: number) => `${(mb / 1024).toFixed(mb < 10240 ? 1 : 0)} GB`;
  const row = (model: CatalogModel) => {
    const status = statuses.get(model.id);
    const done = onDisk(model.id);
    const progress = status?.progress && status.progress.total ?
        status.progress.done / status.progress.total : 0;
    return h('li', {},
             icon(model.role === 'llm' ? 'llm' : 'decider', 16),
             h('div', {class: 'what'},
               h('b', {}, model.name),
               h('span', {}, model.role === 'llm' ? 'Plans and answers, with sources' :
                                                    'Navigates: decides each step in one pass')),
             done ? h('span', {class: 'state done'}, icon('check', 14), 'Ready') :
                 status?.state === 'downloading' ?
                     h('span', {class: 'state'}, h('progress', {value: String(progress)}),
                       `${Math.round(progress * 100)}%`) :
                     h('span', {class: 'state'}, gb(model.downloadMB)));
  };
  const go = h('button', {class: 'button primary wide', type: 'button'},
               missing.length ?
                   (downloading ? 'Downloading…' :
                                  `Download ${gb(missing.reduce((n, m) => n + m.downloadMB, 0))}`) :
                   'Start using Ditto');
  go.disabled = downloading || (advice.lowDisk && missing.length > 0);
  go.addEventListener('click', () => void startDownloads());
  const later = h('button', {class: 'link', type: 'button'}, 'Not now');
  later.addEventListener('click', () => show('chat'));
  const other = h('button', {class: 'link', type: 'button'}, 'Choose other models');
  other.addEventListener('click', () => show('models'));
  $('view-setup').replaceChildren(h('div', {class: 'setup'},
      icon('logo', 40),
      h('h1', {}, 'Set up Ditto'),
      h('p', {class: 'lede'},
        'Ditto’s models run on this Mac: what you browse and ask stays here. ' +
        'Download the pair that suits it to start.'),
      h('div', {class: 'device'},
        h('span', {}, device.chip || (device.arch === 'arm64' ? 'Apple silicon' : 'Intel')),
        h('span', {}, `${Math.round(device.totalMb / 1024)} GB memory`),
        device.freeDiskMb ? h('span', {}, `${gb(device.freeDiskMb)} free`) : null),
      h('h2', {}, 'Recommended for this Mac'),
      h('ul', {class: 'pair'}, ...pick.map(row)),
      h('p', {class: 'why'}, advice.reasons.join(' ')),
      advice.lowDisk && missing.length ?
          h('p', {class: 'warn'}, icon('alert', 14),
            `Not enough free disk: ${gb(advice.downloadMB + 2048)} needed.`) : null,
      go,
      h('div', {class: 'links'}, other, later)));
  if (downloading) {
    setupTimer = window.setTimeout(() => void renderSetup(), 1000);
  } else if (!missing.length && view === 'setup') {
    // Both on disk: the setup is done.
    settings.llmId = advice.llm;
    settings.deciderId = advice.decider;
    writeJson(SETTINGS_KEY, settings);
    writeJson(SETUP_KEY, {done: true});
    aiReady = true;
    renderComposer();
  }
}

async function startDownloads() {
  if (!advice) {
    return;
  }
  if (aiReady) {
    show('chat');
    return;
  }
  settings.llmId = advice.llm;
  settings.deciderId = advice.decider;
  settings.modelBudgetMB = advice.modelBudgetMB;
  if (settings.mode === 'off') {
    settings.mode = 'hybrid';
  }
  writeJson(SETTINGS_KEY, settings);
  try {
    await refreshStatuses();
    for (const id of [advice.llm, advice.decider]) {
      if (!onDisk(id) && statuses.get(id)?.state !== 'downloading') {
        await models.download(id);
      }
    }
  } catch {
    // The view shows what did not start; the button tries again.
  }
  void renderSetup();
}

// ---- Hand-offs from the home page ------------------------------------------

async function takeHandOff() {
  const {query, chatId} = await proxy.handler.takeHandOff();
  if (chatId) {
    openChat(chatId);
  }
  if (query) {
    newChat();
    if (!aiReady && !await checkReady()) {
      // Asked before the models are here: set up first, the question waits.
      $<HTMLTextAreaElement>('prompt').value = query;
      show('setup');
      return;
    }
    void ask(query);
  }
}

// ---- Other windows ---------------------------------------------------------

// Another window's panel saved chats or memory: read them again, keeping
// the chat being asked here (not saved until its first answer).
async function storeChanged(name: string) {
  if (name === 'memory') {
    memory.replace((await proxy.handler.loadMemory()).json);
    if (view === 'memory') {
      renderMemory();
    }
    return;
  }
  if (name === 'chats') {
    const fresh = await loadChatStore(proxy);
    const current = chatId ? store.get(chatId) : undefined;
    if (current && (running || !current.turns.length)) {
      fresh.adopt(current);
    }
    store = fresh;
    if (view === 'history') {
      renderHistory();
    } else if (view === 'chat' && !running) {
      renderThread();
    }
  }
}

// ---- Wiring ----------------------------------------------------------------

async function init() {
  const {totalMb} = await proxy.handler.getSystemMemory();
  settings = readJson(SETTINGS_KEY, defaultSettings(Number(totalMb)));
  store = await loadChatStore(proxy);
  const {json: memoryJson} = await proxy.handler.loadMemory();
  memory = new MemoryStore(memoryJson, json => proxy.handler.saveMemory(json));
  await loadWatches();
  $('logo').replaceChildren(icon('logo', 18));

  const prompt = $<HTMLTextAreaElement>('prompt');
  autoGrow(prompt);
  prompt.addEventListener('input', () => {
    renderComposer();
    if (prompt.value) {
      void warmUp();
    }
  });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $<HTMLFormElement>('composer').requestSubmit();
    }
  });
  $<HTMLFormElement>('composer').addEventListener('submit', event => {
    event.preventDefault();
    const question = prompt.value.trim();
    if (question && !running && settings.mode !== 'off') {
      prompt.value = '';
      prompt.dispatchEvent(new Event('input'));
      void ask(question);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && running) {
      running.abort();
    }
  });

  proxy.callbacks.onMemoryPressure.addListener((critical: boolean) => {
    if (critical) {
      warmer?.stop();
      warmer = null;
    }
    models.relieve(critical ? 'critical' : 'moderate').catch(() => {});
  });
  proxy.callbacks.onTabDetached.addListener(() => {
    running?.abort();
    checking?.abort.abort();
  });
  proxy.callbacks.onCheckWatches.addListener(() => void checkWatches());
  proxy.callbacks.onStoreChanged.addListener(name => void storeChanged(name));
  proxy.callbacks.onHandOff.addListener(() => void takeHandOff());

  // First launch (or models gone): the setup comes first.
  await checkReady();
  show(aiReady || settings.mode === 'off' ? 'chat' : 'setup');
  renderThread();
  renderComposer();
  await takeHandOff();
  // The app also asks every minute; a page opened just for watching
  // starts right away.
  void checkWatches();
}

init();
