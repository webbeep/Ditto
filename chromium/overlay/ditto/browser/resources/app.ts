// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The agent panel: chats with the agent, chat history, and models.

import {BrowserAgent, type AgentEvent} from './agent/agent/agent.js';
import {PageDriver} from './agent/browser/page_driver.js';
import {contextFor, type Chat, type ChatStore, type Turn} from './agent/chat/chat.js';
import {DeciderClient} from './agent/decider/decider_client.js';
import {LlmClient} from './agent/llm/llm_client.js';
import {CATALOG, findModel, routerPresetIni, type CatalogModel} from './agent/models/catalog.js';
import {ModelManager, type ModelStatus} from './agent/models/model_manager.js';
import {defaultSettings, usesDecider, usesLlm, type AgentMode,
        type AgentSettings} from './agent/models/settings.js';
import {Warmer} from './agent/models/warmer.js';
import {loadChatStore} from './chat_storage.js';
import {Target} from './ditto_agent.mojom-webui.js';
import {icon, type IconName} from './icons.js';
import {BrowserProxy, MojoCdpTransport, MojoHttpTransport} from './mojo_transports.js';
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
const runtimeHttp = new MojoHttpTransport(proxy, Target.kRuntime);
const strandsHttp = new MojoHttpTransport(proxy, Target.kStrandsSidecar);
const models = new ModelManager(runtimeHttp);
let store: ChatStore;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: AgentSettings;
let view: 'chat'|'history'|'models' = 'chat';
let chatId: string|null = null;
let running: AbortController|null = null;
let runtimeReady: Promise<void>|null = null;
let statuses = new Map<string, ModelStatus>();
let refreshTimer = 0;
let warmer: Warmer|null = null;

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
                           view === 'models' ? 'Models' : (chat?.title ?? '');
  const toggle = (name: typeof view, iconName: IconName, label: string) => {
    const button = iconButton(iconName, label, () => show(view === name ? 'chat' : name));
    button.setAttribute('aria-pressed', String(view === name));
    return button;
  };
  $('header-actions').replaceChildren(
      toggle('history', 'history', 'History'),
      iconButton('newChat', 'New chat', () => newChat()),
      toggle('models', 'models', 'Models'));
}

function show(next: typeof view) {
  view = next;
  $('view-chat').hidden = view !== 'chat';
  $('view-history').hidden = view !== 'history';
  $('view-models').hidden = view !== 'models';
  $('composer').hidden = view !== 'chat';
  renderHeader();
  if (view === 'history') {
    renderHistory();
  } else if (view === 'models') {
    void refreshModels();
  } else {
    $('prompt').focus();
  }
}

// ---- Thread ----------------------------------------------------------------

const STEP_ICONS: Record<string, IconName> = {
  link: 'link', button: 'link', textbox: 'type', searchbox: 'type',
  scroll: 'scroll', back: 'back', search: 'search',
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
      h('a', {href: s.url, target: '_blank', title: s.title || s.url},
        h('b', {}, String(i + 1)), h('span', {}, hostOf(s.url)))));
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

function renderThread() {
  const chat = chatId ? store.get(chatId) : undefined;
  const thread = $('thread');
  if (!chat?.turns.length) {
    thread.replaceChildren(h('div', {class: 'empty'}, icon('logo', 40)));
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
  const statusText = h('span', {}, 'Starting');
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
    const agent = new BrowserAgent({
      driver: new PageDriver(new MojoCdpTransport(proxy)),
      settings,
      ...(llm ? {llm} : {}),
      ...(decider ? {decider} : {}),
      ...(urlTemplate ? {searchUrl: urlTemplate} : {}),
    });
    const result = await agent.run(question, (event: AgentEvent) => {
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
        case 'answer-token':
          live.hidden = true;
          text.textContent += event.text;
          break;
      }
    }, {signal: running.signal, context});
    answer = result.answer;
    sources = result.evidence;
    if (result.fromHistory) {
      trace.unshift(`history\tFrom this chat's sources\t`);
    }
  } catch (error) {
    failed = true;
    answer = running.signal.aborted ? 'Stopped.' : (error as Error).message;
  } finally {
    running = null;
    proxy.handler.detachFromTab();
  }
  store.addTurn(chat.id, {question, answer, sources, trace, at: Date.now(), failed});
  renderHeader();
  renderThread();
  renderComposer();
}

// ---- Composer --------------------------------------------------------------

function renderComposer() {
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
    send.disabled = settings.mode === 'off' || !prompt.value.trim();
  }
  $('send-slot').replaceChildren(send);
}

function setMode(mode: AgentMode) {
  settings.mode = mode;
  writeJson(SETTINGS_KEY, settings);
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
  }
  renderModels();
  if ([...statuses.values()].some(s => s.state === 'downloading' || s.state === 'loading')) {
    refreshTimer = window.setTimeout(refreshModels, 1000);
  }
}

// ---- Hand-offs from the home page ------------------------------------------

async function takeHandOff() {
  const {query, chatId} = await proxy.handler.takeHandOff();
  if (chatId) {
    openChat(chatId);
  }
  if (query) {
    newChat();
    void ask(query);
  }
}

// ---- Wiring ----------------------------------------------------------------

async function init() {
  const {totalMb} = await proxy.handler.getSystemMemory();
  settings = readJson(SETTINGS_KEY, defaultSettings(Number(totalMb)));
  store = await loadChatStore(proxy);
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
  proxy.callbacks.onTabDetached.addListener(() => running?.abort());
  proxy.callbacks.onHandOff.addListener(() => void takeHandOff());

  show('chat');
  renderThread();
  renderComposer();
  await takeHandOff();
}

init();
