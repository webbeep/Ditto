// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The agent panel: chats with the agent, chat history, and models.

import {BrowserAgent, reworksLast} from './agent/agent/agent.js';
import type {AgentEvent, AskRequest} from './agent/agent/agent.js';
import {PageDriver} from './agent/browser/page_driver.js';
import {chatTitle, contextFor} from './agent/chat/chat.js';
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
import type {AnswerView} from './agent/agent/views.js';
import type {AgentResult} from './agent/agent/agent.js';
import {loadChatStore} from './chat_storage.js';
import {Target} from './bridge.js';
import type {OpenTab} from './bridge.js';
import {topPassages} from './agent/agent/candidates.js';
import type {Evidence} from './agent/agent/prompts.js';
import {icon} from './icons.js';
import type {IconName} from './icons.js';
import {BrowserProxy, BridgeCdpTransport, BridgeHttpTransport} from './transports.js';
import {autoGrow, formatMB, h, hostOf, iconButton, readJson, relativeTime,
        writeJson} from './ui.js';

const SETTINGS_KEY = 'ditto.agent.settings';
// MiB the router keeps free on the GPU device (unified memory on Apple
// silicon) on top of Ditto's own model budget.
const ROUTER_MEMORY_MARGIN_MB = 2048;

// How Ditto works, chosen in Models (not in the composer: it is a setting,
// not part of asking).
const MODES: Array<{mode: AgentMode, name: string, label: string}> = [
  {mode: 'hybrid', name: 'Hybrid', label: 'Decider navigates, LLM answers'},
  {mode: 'decider-only', name: 'Fastest', label: 'Decider only (fastest)'},
  {mode: 'llm-only', name: 'LLM', label: 'LLM only'},
  {mode: 'off', name: 'Off', label: 'Models off'},
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
// Questions being answered, by chat: each in its own Ditto tab, side by
// side; the live reply is kept here while its chat is out of view.
interface Run {
  abort: AbortController;
  nodes: HTMLElement[];
}
const runs = new Map<string, Run>();
const runOf = (id: string|null) => (id ? runs.get(id) : undefined);
// Questions sent to a chat while it works: asked in turn, as follow-ups,
// once its answer is in (like a message queued in a coding agent).
interface Asked {
  question: string;
  // Tabs it points at (@-mentions): answered from them, without browsing.
  tabs: OpenTab[];
}
const queued = new Map<string, Asked[]>();
// Tabs picked with @ for the next question, and the @ menu while open.
let mentions: OpenTab[] = [];
let menu: {tabs: OpenTab[], active: number}|null = null;
// The open tabs, fetched once when an @ starts; typing filters them at once
// (a menu that came back later could pick from an older list).
let tabCache: OpenTab[]|null = null;
// Questions handed off a moment ago (a double click on a home card asks
// once).
const handedOff = new Map<string, number>();
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
  if (settings.mode === 'off' || runs.size || !aiReady) {
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
    // What is known now, at once; the runtime's word follows.
    renderModels();
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

// The answer with its [n] citations as small links to the sources, and
// the little markdown small models write: tables (a redone answer "in a
// table"), bold, bullets as lines. Built as elements, never as HTML.
function renderAnswer(text: string, sources: Array<{url: string, title: string}>): HTMLElement {
  const box = h('div', {class: 'text'});
  const lines = text.split('\n');
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  for (let i = 0; i < lines.length;) {
    if (isRow(lines[i]!) && i + 1 < lines.length && isRow(lines[i + 1]!)) {
      const rows: string[] = [];
      while (i < lines.length && isRow(lines[i]!)) {
        rows.push(lines[i++]!);
      }
      box.append(markdownTable(rows, sources));
      continue;
    }
    // "* item" and "- item": a bullet.
    const line = lines[i]!.replace(/^(\s*)[*-]\s+/, '$1• ');
    box.append(...inline(line, sources), i < lines.length - 1 ? '\n' : '');
    ++i;
  }
  return box;
}

function inline(text: string, sources: Array<{url: string, title: string}>): Array<Node|string> {
  return text.split(/(\[\d+\]|\*\*[^*\n]+\*\*)/).filter(Boolean).map(part => {
    const n = Number(part.match(/^\[(\d+)\]$/)?.[1]);
    const source = sources[n - 1];
    if (source) {
      return h('sup', {}, h('a', {href: source.url, target: '_blank',
                                  title: source.title || source.url}, String(n)));
    }
    const bold = part.match(/^\*\*([^*\n]+)\*\*$/)?.[1];
    return bold ? h('strong', {}, bold) : part;
  });
}

// "| a | b |" rows: the first is the header; "|---|---|" rows are skipped.
function markdownTable(rows: string[], sources: Array<{url: string, title: string}>): HTMLElement {
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const [head, ...body] = rows.filter(row => !/^[\s|:-]+$/.test(row)).map(cells);
  return h('div', {class: 'table-wrap'}, h('table', {class: 'md-table'},
      h('thead', {}, h('tr', {}, ...(head ?? []).map(c => h('th', {}, ...inline(c, sources))))),
      h('tbody', {}, ...body.map(row =>
          h('tr', {}, ...row.map(c => h('td', {}, ...inline(c, sources))))))));
}

function renderTurn(turn: Turn): HTMLElement[] {
  const lead = !!turn.view && leads(turn.view, turn.answer);
  return [
    h('div', {class: 'question'}, turn.question,
      turn.mentions?.length ? mentioned(turn.mentions) : null),
    h('div', {class: `reply${turn.failed ? ' failed' : ''}${lead ? ' with-lead' : ''}`},
      renderTrace(turn.trace),
      lead ? renderView(turn.view!, true) : null,
      renderAnswer(turn.answer, turn.sources),
      turn.view && !lead ? renderView(turn.view) : null,
      turn.shot ? renderShot(turn.shot, turn.sources) : null,
      renderSources(turn.sources)),
  ];
}

const BY: Record<AnswerView['by'], string> = {
  page: 'From the page', decider: 'Picked from the page', llm: 'Summarized from the sources',
};

// Key facts a short answer states anyway ("The price is $49, and it ships
// within 2 days"): shown as the answer's lead, large, above the sentence
// (which then reads as the detail), not as a card repeating it below.
function leads(view: AnswerView, answer: string): boolean {
  return view.kind === 'facts' && answer.length < 240 &&
      (view.facts ?? []).every(f => answer.includes(f.value));
}

// The answer as a view: key facts, a list to choose from, steps, a table.
function renderView(view: AnswerView, lead = false): HTMLElement {
  let body: HTMLElement;
  switch (view.kind) {
    case 'facts':
      body = h('dl', {class: 'facts'}, ...(view.facts ?? []).map(f =>
          h('div', {}, h('dt', {}, f.label), h('dd', {}, f.value))));
      break;
    case 'list':
      body = h('ul', {class: 'items'}, ...(view.items ?? []).map(item => h('li', {},
          item.url ? h('a', {href: item.url, target: '_blank'}, item.title) : h('b', {}, item.title),
          item.detail ? h('span', {}, item.detail) : null)));
      break;
    case 'steps':
      body = h('ol', {class: 'steps-view'}, ...(view.steps ?? []).map(step => h('li', {}, step)));
      break;
    case 'table': {
      const table = view.table ?? {columns: [], rows: []};
      body = h('div', {class: 'table-wrap'}, h('table', {},
          h('thead', {}, h('tr', {}, ...table.columns.map(c => h('th', {}, c)))),
          h('tbody', {}, ...table.rows.map(row => h('tr', {}, ...row.map(cell => h('td', {}, cell)))))));
      break;
    }
  }
  return h('section', {class: `answer-view answer-${view.kind}${lead ? ' lead' : ''}`}, body,
           h('p', {class: 'by'}, BY[view.by]));
}

// Where the answer was read: the page, with the sentence marked.
function renderShot(shot: NonNullable<Turn['shot']>, sources: Turn['sources']): HTMLElement {
  const source = sources.find(s => s.url === shot.url);
  return h('a', {class: 'shot', href: shot.url, target: '_blank',
                 title: 'Where Ditto read it'},
           h('img', {src: shot.image, alt: ''}),
           h('span', {}, icon('link', 12), source?.title || hostOf(shot.url)));
}

// A picture small enough to keep with the chat: the part of the page around
// the marked sentence (`focus`, CSS pixels), legible at chat size.
async function smaller(dataUrl: string,
                       focus: {x: number, y: number, width: number, height: number,
                               viewWidth: number}|null,
                       width = 560): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  // The screenshot's pixels per CSS pixel.
  const ratio = focus ? image.naturalWidth / focus.viewWidth : 1;
  const cropWidth = Math.min(image.naturalWidth, Math.round(680 * ratio));
  const cropHeight = Math.min(image.naturalHeight, Math.round(cropWidth * 0.5));
  // From the block's left edge (text starts there), its middle mid-height.
  const startX = focus ? (focus.x - 24) * ratio : 0;
  const centreY = focus ? (focus.y + focus.height / 2) * ratio : cropHeight / 2;
  const left = Math.max(0, Math.min(image.naturalWidth - cropWidth, startX));
  const top = Math.max(0, Math.min(image.naturalHeight - cropHeight, centreY - cropHeight / 2));
  const scale = Math.min(1, width / cropWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cropWidth * scale);
  canvas.height = Math.round(cropHeight * scale);
  canvas.getContext('2d')!.drawImage(image, left, top, cropWidth, cropHeight,
                                     0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
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
  const run = runOf(chat?.id ?? null);
  if (!chat?.turns.length && !run) {
    thread.replaceChildren(emptyState());
    return;
  }
  thread.replaceChildren(...(chat?.turns ?? []).flatMap(renderTurn), ...(run?.nodes ?? []),
                         ...queueOf(chat?.id ?? null));
  thread.lastElementChild?.scrollIntoView({block: 'end'});
  proxy.handler.focusSession(chat?.id ?? '');
}

// The questions waiting in a chat, each with a way to take it back.
function queueOf(id: string|null): HTMLElement[] {
  const waiting = id ? queued.get(id) ?? [] : [];
  return waiting.map((item, index) => h('div', {class: 'queued'},
      h('span', {class: 'label'}, 'Next'),
      h('span', {class: 'text'}, item.question),
      iconButton('close', 'Remove from queue', () => {
        waiting.splice(index, 1);
        if (!waiting.length) {
          queued.delete(id!);
        }
        renderThread();
      })));
}

// Other chats keep running while a new one starts.
function newChat() {
  chatId = null;
  show('chat');
  renderThread();
}

function openChat(id: string) {
  if (!store.get(id)) {
    return;
  }
  chatId = id;
  show('chat');
  renderThread();
}

// ---- Running the agent -----------------------------------------------------

// Asks `question` in chat `id` (the one in view by default; null starts a
// new chat). A chat answers one question at a time: asked while it works,
// the question waits its turn. Other chats run alongside, each in its own
// Ditto tab.
async function ask(question: string, id: string|null = chatId, inTurn = false,
                   tabs: OpenTab[] = []) {
  if (!question.trim()) {
    return;
  }
  // Behind a question still working, or others already waiting (unless
  // this is the one whose turn it is).
  if (id && (runs.has(id) || (!inTurn && queued.get(id)?.length))) {
    queued.set(id, [...queued.get(id) ?? [], {question, tabs}]);
    if (chatId === id && view === 'chat') {
      renderThread();
    }
    return;
  }
  const here = id === chatId;
  if (!aiReady && !await checkReady()) {
    $<HTMLTextAreaElement>('prompt').value = question;
    show('setup');
    return;
  }
  const chat: Chat = (id && store.get(id)) || store.create();
  chat.title ||= chatTitle(question);
  const context = contextFor(chat);
  // Asked in the chat on screen (or a new one): it shows. A queued question
  // starting in a chat out of view stays out of view.
  if (here) {
    chatId = chat.id;
    show('chat');
    if (!chat.turns.length) {
      $('thread').replaceChildren();
    }
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
  const asked = h('div', {class: 'question'}, question,
                  tabs.length ? mentioned(tabs) : null);
  if (chatId === chat.id && view === 'chat') {
    const thread = $('thread');
    thread.querySelectorAll(':scope > .queued, :scope > .empty').forEach(node => node.remove());
    thread.append(asked, reply, ...queueOf(chat.id));
    reply.scrollIntoView({block: 'end'});
  }

  const addStep = (kind: IconName|'retry', line: string, by = '') => {
    trace.push(`${kind}\t${line}\t${by}`);
    steps.append(stepRow(kind === 'retry' ? 'retry' : kind, line, by,
                         kind === 'retry' ? 'retry' : ''));
    traceBox.hidden = false;
  };

  const run: Run = {abort: new AbortController(), nodes: [asked, reply]};
  runs.set(chat.id, run);
  renderComposer();
  if (view === 'history') {
    renderHistory();
  }
  // This chat's own Ditto tab: questions in other chats use theirs.
  const session = chat.id;
  proxy.handler.focusSession(session);
  let answer = '';
  let sources: Turn['sources'] = [];
  let learning: Promise<string[]>|undefined;
  let answerView: AnswerView|undefined;
  let shot: Turn['shot'];
  let failed = false;
  let attached = false;
  try {
    if (settings.mode === 'off') {
      throw new Error('Models are off. Choose a mode below to use the agent.');
    }
    statusText.textContent = 'Loading models';
    const {llm, decider} = await clients();
    warmer ??= new Warmer({llm, decider});
    warmer.touch();
    // Pointed at tabs: read as the user has them, and no Ditto tab needed.
    // Nor for redoing the last answer ("put it in a table").
    const from = tabs.length ? await readTabs(tabs, question) : [];
    const lastTurn = chat.turns.at(-1);
    const redo = !from.length && !!lastTurn &&
        reworksLast(question, `${lastTurn.question} ${lastTurn.answer}`);
    if (tabs.length && !from.length) {
      throw new Error('Could not read the tabs you mentioned. Open them again and retry.');
    }
    const [{urlTemplate}, attach] = await Promise.all([
      proxy.handler.getSearchUrl(),
      from.length || redo ? null : proxy.handler.attachToActiveTab('', session, chat.title)]);
    if (attach && !attach.target.ok) {
      throw new Error('Could not attach to a tab.');
    }
    attached = !!attach;
    const signal = run.abort.signal;
    const driver = new PageDriver(new BridgeCdpTransport(proxy, session));
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
        case 'view': {
          const lead = leads(event.view, text.textContent ?? '');
          const arrived = renderView(event.view, lead);
          arrived.classList.add('fresh');
          if (lead) {
            reply.classList.add('with-lead');
            text.before(arrived);
          } else {
            text.after(arrived);
          }
          break;
        }
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
    const result = isWatchRequest(question) && !from.length ?
        await startWatch(question, agent, driver, {llm, decider, signal}, onEvent) :
        await agent.run(question, onEvent, {signal, context, ...(from.length ? {from} : {})});
    answer = result.answer;
    sources = result.evidence;
    learning = result.learning;
    answerView = result.view;
    // A picture of where the answer was read, the sentence marked.
    if (result.found) {
      try {
        const focus = await driver.highlight(result.found.quote);
        shot = {url: result.found.url, image: await smaller(await driver.screenshot(), focus)};
      } catch {
        // No picture: the sources still say where.
      }
    }
    if (result.fromHistory) {
      trace.unshift(`history\tFrom this chat's sources\t`);
    }
  } catch (error) {
    failed = true;
    answer = run.abort.signal.aborted ? 'Stopped.' : (error as Error).message;
    if (error instanceof NotDownloadedError) {
      // A model went missing (deleted in Models): set up again.
      aiReady = false;
      writeJson(SETUP_KEY, {done: false});
      answer += ' Download it to continue.';
    }
  } finally {
    runs.delete(chat.id);
    if (attached) {
      proxy.handler.detachFromTab(session);
    }
  }
  // Stopped: what was queued behind it goes too.
  if (run.abort.signal.aborted) {
    queued.delete(chat.id);
  }
  const at = Date.now();
  store.addTurn(chat.id, {question, answer, sources, trace: [...trace], at, failed,
                          ...(answerView ? {view: answerView} : {}), ...(shot ? {shot} : {}),
                          ...(tabs.length ? {mentions: tabs.map(({title, url}) => ({title, url}))} :
                                            {})});
  // Notes about the user arrive after the answer.
  void learning?.then(notes => {
    if (notes.length) {
      store.annotate(chat.id, at, `note\tNoted: ${notes.join(' · ')}\t`);
      if (chatId === chat.id && view === 'chat') {
        renderThread();
      }
    }
  });
  // The chat may be out of view by now (the user moved on meanwhile).
  if (chatId === chat.id) {
    renderHeader();
    if (view === 'chat') {
      renderThread();
    }
  }
  if (view === 'history') {
    renderHistory();
  }
  renderComposer();
  // The next question waiting in this chat, as a follow-up.
  const next = queued.get(chat.id)?.shift();
  if (!queued.get(chat.id)?.length) {
    queued.delete(chat.id);
  }
  if (next) {
    void ask(next.question, chat.id, true, next.tabs);
  }
}

// The tabs a question points at, read as the user has them (what they
// selected first).
async function readTabs(tabs: OpenTab[], question: string): Promise<Evidence[]> {
  const read = await Promise.all(tabs.map(tab =>
      proxy.handler.readTab(tab.id).catch(() => ({ok: false} as const))));
  return read.flatMap((page, i) => page.ok && 'text' in page && page.text ? [{
    url: page.url || tabs[i]!.url,
    title: page.title || tabs[i]!.title,
    passages: [...(page.selection ? [page.selection] : []), ...topPassages(page.text, question, 8)],
  }] : []);
}

// The tabs a question pointed at, under it.
function mentioned(tabs: Array<{title: string, url: string}>): HTMLElement {
  return h('span', {class: 'mentioned'}, ...tabs.map(tab =>
      h('a', {class: 'chip', href: tab.url, target: '_blank', title: tab.url},
        icon('globe', 11), tab.title || hostOf(tab.url))));
}

// ---- @-mentions -------------------------------------------------------------

// The word after an "@" at the caret, and where the "@" is; null when the
// caret is not in one.
function mentionAtCaret(prompt: HTMLTextAreaElement): {start: number, query: string}|null {
  const before = prompt.value.slice(0, prompt.selectionStart);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? {start: before.length - match[1]!.length - 1, query: match[1]!.toLowerCase()} :
                 null;
}

async function updateMentionMenu() {
  const prompt = $<HTMLTextAreaElement>('prompt');
  if (!mentionAtCaret(prompt)) {
    closeMentionMenu();
    return;
  }
  if (!tabCache) {
    tabCache = (await proxy.handler.listTabs().catch(() => ({tabs: [] as OpenTab[]}))).tabs;
  }
  // As the field is now (typed on while the tabs came).
  const at = mentionAtCaret(prompt);
  if (!at) {
    closeMentionMenu();
    return;
  }
  const fits = tabCache.filter(tab => !mentions.some(m => m.id === tab.id) &&
                                      `${tab.title} ${tab.url}`.toLowerCase().includes(at.query))
      // The tab in front first.
      .sort((a, b) => Number(b.selected) - Number(a.selected)).slice(0, 8);
  menu = {tabs: fits, active: Math.max(0, Math.min(menu?.active ?? 0, fits.length - 1))};
  renderMentionMenu();
}

function renderMentionMenu() {
  const box = $('mention-menu');
  box.hidden = !menu;
  if (!menu) {
    return;
  }
  const open = menu;
  box.replaceChildren(...(open.tabs.length ? open.tabs.map((tab, i) => {
    const option = h('button', {type: 'button', role: 'option', class: 'mention-option',
                                'aria-selected': String(i === open.active)},
                     icon('globe', 12),
                     h('span', {class: 'name'}, tab.title || hostOf(tab.url)),
                     h('span', {class: 'host'}, hostOf(tab.url)));
    // Before the field loses focus.
    option.addEventListener('mousedown', event => {
      event.preventDefault();
      pickMention(tab);
    });
    return option;
  }) : [h('p', {class: 'mention-empty'}, 'No open pages to add')]));
}

function closeMentionMenu() {
  menu = null;
  tabCache = null;
  $('mention-menu').hidden = true;
}

function pickMention(tab: OpenTab) {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const at = mentionAtCaret(prompt);
  if (at) {
    prompt.value = prompt.value.slice(0, at.start) + prompt.value.slice(prompt.selectionStart);
    prompt.selectionStart = prompt.selectionEnd = at.start;
  }
  mentions = [...mentions, tab];
  closeMentionMenu();
  renderMentions();
  prompt.focus();
  prompt.dispatchEvent(new Event('input'));
}

function renderMentions() {
  const row = $('mentions');
  row.hidden = !mentions.length;
  row.replaceChildren(...mentions.map(tab => h('span', {class: 'chip mention'},
      icon('globe', 11), h('span', {class: 'name'}, tab.title || hostOf(tab.url)),
      iconButton('close', `Remove ${tab.title || hostOf(tab.url)}`, () => {
        mentions = mentions.filter(m => m.id !== tab.id);
        renderMentions();
      }))));
}

// ---- Composer --------------------------------------------------------------

function renderComposer() {
  const running = runOf(chatId);
  $('composer').classList.toggle('working', !!running);
  const prompt = $<HTMLTextAreaElement>('prompt');
  // Working: stop it, or, with something typed, queue that behind it.
  const typed = !!prompt.value.trim();
  const send = running && !typed ?
      iconButton('stop', 'Stop', () => running.abort.abort(), 'primary') :
      iconButton('send', running ? 'Queue' : 'Send',
                 () => $<HTMLFormElement>('composer').requestSubmit(), 'primary');
  if (!running || typed) {
    send.disabled = settings.mode === 'off' || !aiReady || !typed;
  }
  prompt.placeholder = aiReady || settings.mode === 'off' ? 'Ask anything · @ adds a tab' :
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
            runs.has(c.id) ? h('span', {class: 'running', title: 'Working'}) : null,
            h('span', {class: 'name'}, c.title),
            h('span', {class: 'when'}, runs.has(c.id) ? 'now' : relativeTime(c.updatedAt)),
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
    // Before committing: what Ditto filled in on the way, to check (the wrong
    // day, a misspelled name) before anything is sent.
    const review = approve && request.review?.length ?
        h('dl', {class: 'review', 'aria-label': 'What Ditto filled in'},
          ...request.review.map(r => h('div', {}, h('dt', {}, r.field), h('dd', {}, r.value)))) :
        null;
    const card = h('div', {class: 'ask', role: 'alertdialog', 'aria-label': request.message},
                   icon(approve ? 'shield' : 'user', 16),
                   h('span', {class: 'message'}, request.message),
                   review,
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
    Promise<Pick<AgentResult, 'answer'|'evidence'|'fromHistory'> & Partial<AgentResult>> {
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
  if (checking || settings.mode === 'off' || !aiReady) {
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
    checking = null;
    finished();
    if (view === 'memory') {
      renderMemory();
    }
  }
}

async function checkWatch(watch: Watch, llm: LlmClient|undefined,
                          decider: DeciderClient|undefined, signal: AbortSignal) {
  // Its own Ditto tab: chats keep theirs.
  const session = `watch:${watch.id}`;
  const {target} = await proxy.handler.attachToActiveTab(watch.url, session,
                                                        `Watching ${watch.title}`);
  if (!target.ok) {
    return;
  }
  const agent = new BrowserAgent({
    driver: new PageDriver(new BridgeCdpTransport(proxy, session)),
    settings,
    ...(llm ? {llm} : {}),
    ...(decider ? {decider} : {}),
    // Nothing that needs the user happens unattended.
    ask: async () => false,
  });
  let reading;
  try {
    reading = await agent.run(watch.question, () => {}, {signal});
  } finally {
    proxy.handler.detachFromTab(session);
  }
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
  // How Ditto works ("Off" unloads every model and stops the runtime).
  const modes = h('div', {class: 'segmented modes', id: 'modes', role: 'group',
                          'aria-label': 'How Ditto works'},
      ...MODES.map(m => {
        const button = h('button', {type: 'button', 'aria-label': m.label, title: m.label,
                                    'aria-pressed': String(settings.mode === m.mode)}, m.name);
        button.disabled = runs.size > 0;
        button.addEventListener('click', () => {
          setMode(m.mode);
          if (m.mode === 'off') {
            statuses = new Map();
          }
          renderModels();
        });
        return button;
      }));
  $('view-models').replaceChildren(h('div', {class: 'models'},
      modes,
      meter,
      section('llm', 'llm', 'LLM'),
      section('decider', 'decider', 'Decider')));
}

function renderModel(model: CatalogModel): HTMLLIElement {
  const status = statuses.get(model.id);
  const current = model.id === settings.llmId || model.id === settings.deciderId;
  const onDisk = model.runtime === 'strands' ||
      (status && !['not-downloaded', 'incomplete', 'downloading'].includes(status.state));
  const choose = () => {
    if (!onDisk || runs.size) {
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

// Every pending hand-off, each question in a chat of its own (they run
// side by side).
async function takeHandOff() {
  for (;;) {
    const {query, chatId} = await proxy.handler.takeHandOff();
    if (!query && !chatId) {
      return;
    }
    if (chatId) {
      openChat(chatId);
    }
    const now = Date.now();
    if (query && now - (handedOff.get(query) ?? 0) < 2000) {
      continue;
    }
    if (query) {
      handedOff.set(query, now);
      newChat();
      if (!aiReady && !await checkReady()) {
        // Asked before the models are here: set up first, the question waits.
        $<HTMLTextAreaElement>('prompt').value = query;
        show('setup');
        return;
      }
      void ask(query, null);
    }
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
    // Chats that only live here so far (working on their first answer,
    // waiting, or the new one on screen) are kept: their answers land in
    // them.
    const fresh = await loadChatStore(proxy);
    const keep = new Set([...runs.keys(), ...queued.keys(), ...(chatId ? [chatId] : [])]);
    for (const id of keep) {
      const chat = store.get(id);
      if (chat && (runs.has(id) || queued.has(id) || !chat.turns.length)) {
        fresh.adopt(chat);
      }
    }
    store = fresh;
    if (view === 'history') {
      renderHistory();
    } else if (view === 'chat') {
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
    void updateMentionMenu();
    renderComposer();
    if (prompt.value) {
      void warmUp();
    }
  });
  prompt.addEventListener('keydown', event => {
    if (menu) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = Math.max(1, menu.tabs.length);
        menu.active = (menu.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
        renderMentionMenu();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && menu.tabs.length) {
        event.preventDefault();
        pickMention(menu.tabs[menu.active]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMentionMenu();
        return;
      }
    }
    // Enter in an @ word before its menu came: wait for it, then pick.
    if (event.key === 'Enter' && !event.shiftKey && !menu && mentionAtCaret(prompt)) {
      event.preventDefault();
      void updateMentionMenu().then(() => {
        if (menu?.tabs.length) {
          pickMention(menu.tabs[menu.active]!);
        }
      });
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $<HTMLFormElement>('composer').requestSubmit();
    }
  });
  $<HTMLFormElement>('composer').addEventListener('submit', event => {
    event.preventDefault();
    // While the chat works, the question is queued behind it.
    const question = prompt.value.trim();
    if (question && settings.mode !== 'off') {
      const tabs = mentions;
      mentions = [];
      renderMentions();
      prompt.value = '';
      prompt.dispatchEvent(new Event('input'));
      void ask(question, chatId, false, tabs);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && runOf(chatId)) {
      runOf(chatId)!.abort.abort();
    }
  });

  proxy.callbacks.onMemoryPressure.addListener((critical: boolean) => {
    if (critical) {
      warmer?.stop();
      warmer = null;
    }
    models.relieve(critical ? 'critical' : 'moderate').catch(() => {});
  });
  // A Ditto tab closed by the user: that question (or watch check) stops.
  proxy.callbacks.onTabDetached.addListener((session: string) => {
    runs.get(session)?.abort.abort();
    if (session.startsWith('watch:')) {
      checking?.abort.abort();
    }
  });
  proxy.callbacks.onCheckWatches.addListener(() => void checkWatches());
  proxy.callbacks.onWarmUp.addListener(() => void warmUp());
  // Leading the window, the chat reads as an answer page.
  const layOut = (layout: string) => { document.documentElement.dataset['layout'] = layout; };
  proxy.callbacks.onLayout.addListener(layOut);
  void proxy.handler.getLayout().then(({layout}) => layOut(layout)).catch(() => {});
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
