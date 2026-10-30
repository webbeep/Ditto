// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// chrome://ditto-agent: chat with the agent, pick and download models.

import {BrowserAgent, type AgentEvent} from './agent/agent/agent.js';
import {PageDriver} from './agent/browser/page_driver.js';
import {DeciderClient} from './agent/decider/decider_client.js';
import {LlmClient} from './agent/llm/llm_client.js';
import {CATALOG, findModel, routerPresetIni, type CatalogModel} from './agent/models/catalog.js';
import {ModelManager, type ModelStatus} from './agent/models/model_manager.js';
import {defaultSettings, usesDecider, usesLlm, type AgentMode, type AgentSettings} from './agent/models/settings.js';
import {Target} from './ditto_agent.mojom-webui.js';
import {BrowserProxy, MojoCdpTransport, MojoHttpTransport} from './mojo_transports.js';

const SETTINGS_KEY = 'ditto.agent.settings';
// MiB the router keeps free on the GPU device (unified memory on Apple
// silicon) on top of Ditto's own model budget.
const ROUTER_MEMORY_MARGIN_MB = 2048;

const proxy = BrowserProxy.get();
const runtimeHttp = new MojoHttpTransport(proxy, Target.kRuntime);
const strandsHttp = new MojoHttpTransport(proxy, Target.kStrandsSidecar);
const models = new ModelManager(runtimeHttp);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: AgentSettings;
let running: AbortController|null = null;
let statuses = new Map<string, ModelStatus>();
let refreshTimer = 0;

function loadSettings(totalMB: number): AgentSettings {
  const defaults = defaultSettings(totalMB);
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    return saved ? {...defaults, ...JSON.parse(saved)} : defaults;
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings then last for this session only.
  }
}

async function startRuntime(): Promise<void> {
  const {ok} = await proxy.handler.startRuntime(routerPresetIni(), ROUTER_MEMORY_MARGIN_MB);
  if (!ok) {
    throw new Error('The model runtime could not start.');
  }
  // The router takes a moment to bind its port.
  for (let attempt = 0; attempt < 40; ++attempt) {
    try {
      const response = await runtimeHttp.request('GET', '/models');
      if (response.status === 200) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The model runtime did not respond.');
}

// ---- Models panel --------------------------------------------------------

function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function renderModels() {
  for (const role of ['llm', 'decider'] as const) {
    const list = $(`${role}-list`);
    list.replaceChildren(...CATALOG.filter(m => m.role === role).map(renderModel));
  }
}

function renderModel(model: CatalogModel): HTMLLIElement {
  const li = document.createElement('li');
  const active = model.id === settings.llmId || model.id === settings.deciderId;
  li.classList.toggle('active', active);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = model.name;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${model.params} · ${formatMB(model.downloadMB)} download · ` +
      `~${formatMB(model.ramMB)} RAM · ${model.inputs.join(', ')}`;
  const actions = document.createElement('span');
  actions.className = 'actions';

  const status = statuses.get(model.id);
  const use = () => {
    if (model.role === 'llm') {
      settings.llmId = model.id;
    } else {
      settings.deciderId = model.id;
    }
    saveSettings();
    renderModels();
  };
  const button = (label: string, onClick: () => unknown, cls = 'ghost') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await onClick();
      } finally {
        await refreshModels();
      }
    };
    return b;
  };

  if (model.runtime === 'strands') {
    meta.textContent += ' · strands-decider sidecar';
    if (!active) {
      actions.append(button('Use', use));
    }
  } else if (!status || status.state === 'not-downloaded' || status.state === 'incomplete') {
    actions.append(button(status?.state === 'incomplete' ? 'Resume' : 'Download',
                          () => models.download(model.id), ''));
  } else if (status.state === 'downloading') {
    const progress = document.createElement('progress');
    if (status.progress?.total) {
      progress.max = status.progress.total;
      progress.value = status.progress.done;
    }
    actions.append(progress, button('Pause', () => models.pauseDownload(model.id)));
  } else {
    if (!active) {
      actions.append(button('Use', use));
    }
    if (status.state === 'loaded') {
      actions.append(button('Unload', () => models.unload(model.id)));
    }
    actions.append(button('Delete', () => models.remove(model.id), 'danger'));
  }
  li.append(name, actions, meta);
  return li;
}

async function refreshModels() {
  window.clearTimeout(refreshTimer);
  if (settings.mode === 'off' || $('models').hidden) {
    return;
  }
  try {
    await startRuntime();
    statuses = new Map((await models.list()).map(s => [s.id, s]));
  } catch (error) {
    $('memory').textContent = (error as Error).message;
  }
  renderModels();
  if ([...statuses.values()].some(s => s.state === 'downloading' || s.state === 'loading')) {
    refreshTimer = window.setTimeout(refreshModels, 1000);
  }
}

// ---- Chat ------------------------------------------------------------------

function addMessage(role: 'user'|'agent', text: string): HTMLElement {
  $('thread').querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('thread').append(div);
  div.scrollIntoView({block: 'end'});
  return div;
}

async function run(task: string) {
  addMessage('user', task);
  const reply = addMessage('agent', '');
  const trace = document.createElement('ol');
  trace.className = 'trace';
  reply.before(trace);
  const note = (text: string) => {
    const li = document.createElement('li');
    li.textContent = text;
    trace.append(li);
  };

  running = new AbortController();
  $('send').hidden = true;
  $('stop').hidden = false;
  try {
    if (settings.mode === 'off') {
      throw new Error('All models are disabled. Pick a mode to use the agent.');
    }
    await startRuntime();
    const keep = [settings.llmId, settings.deciderId];
    let llm: LlmClient|undefined;
    if (usesLlm(settings.mode)) {
      note(`Loading ${findModel(settings.llmId)?.name ?? settings.llmId}…`);
      await models.ensureLoaded(settings.llmId, settings.modelBudgetMB, keep);
      llm = new LlmClient(runtimeHttp, settings.llmId);
    }
    let decider: DeciderClient|undefined;
    if (usesDecider(settings.mode)) {
      if (findModel(settings.deciderId)?.runtime === 'strands') {
        proxy.handler.setStrandsEndpoint(settings.strandsEndpoint);
        decider = new DeciderClient(strandsHttp, settings.deciderId, false);
      } else {
        await models.ensureLoaded(settings.deciderId, settings.modelBudgetMB, keep);
        decider = new DeciderClient(runtimeHttp, settings.deciderId);
      }
    }
    const {urlTemplate} = await proxy.handler.getSearchUrl();
    const {target} = await proxy.handler.attachToActiveTab();
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
    const result = await agent.run(task, (event: AgentEvent) => {
      switch (event.type) {
        case 'plan':
          note(event.plan.start === 'search' ? `Searching “${event.plan.searchQuery}”` :
               event.plan.start === 'url'    ? `Opening ${event.plan.url}` :
                                               'Reading this page');
          break;
        case 'step':
          note(`${event.description} (${event.by}, ${Math.round(event.confidence * 100)}%)`);
          break;
        case 'warning':
          note(event.message);
          break;
        case 'answer-token':
          reply.textContent += event.text;
          break;
      }
    }, running.signal);
    reply.textContent = result.answer;
    const sources = document.createElement('div');
    sources.className = 'sources';
    result.sources.forEach((url, i) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.textContent = `[${i + 1}] ${url}`;
      sources.append(a);
    });
    reply.append(sources);
  } catch (error) {
    reply.textContent = running.signal.aborted ? 'Stopped.' : (error as Error).message;
  } finally {
    running = null;
    proxy.handler.detachFromTab();
    $('send').hidden = false;
    $('stop').hidden = true;
  }
}

// ---- Wiring ----------------------------------------------------------------

async function init() {
  const {totalMb, availableMb} = await proxy.handler.getSystemMemory();
  settings = loadSettings(Number(totalMb));
  $('memory').textContent = `${formatMB(Number(totalMb))} RAM, ` +
      `${formatMB(Number(availableMb))} free · models may use up to ` +
      formatMB(Math.round(settings.modelBudgetMB));

  const mode = $<HTMLSelectElement>('mode');
  mode.value = settings.mode;
  mode.onchange = () => {
    settings.mode = mode.value as AgentMode;
    saveSettings();
    if (settings.mode === 'off') {
      proxy.handler.stopRuntime();
    }
    refreshModels();
  };

  $('models-toggle').onclick = () => {
    const panel = $('models');
    panel.hidden = !panel.hidden;
    $('models-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    refreshModels();
  };
  $('disable-all').onclick = () => {
    settings.mode = 'off';
    mode.value = 'off';
    saveSettings();
    proxy.handler.stopRuntime();
    renderModels();
  };

  const prompt = $<HTMLTextAreaElement>('prompt');
  $<HTMLFormElement>('ask').onsubmit = event => {
    event.preventDefault();
    const task = prompt.value.trim();
    if (task && !running) {
      prompt.value = '';
      run(task);
    }
  };
  prompt.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $<HTMLFormElement>('ask').requestSubmit();
    }
  };
  $('stop').onclick = () => running?.abort();

  proxy.callbacks.onMemoryPressure.addListener((critical: boolean) => {
    models.relieve(critical ? 'critical' : 'moderate').catch(() => {});
  });
  proxy.callbacks.onTabDetached.addListener(() => running?.abort());
  renderModels();
}

init();
