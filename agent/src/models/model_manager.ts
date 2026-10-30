// Thin client over the llama-server router (`/models*`), plus Ditto's RAM
// policy: never hold more model memory than the budget, and evict the
// responder before the decider (navigation is the hot path).

import {ensureOk, type HttpTransport} from '../http.js';
import {CATALOG, findModel, type CatalogModel} from './catalog.js';

export type ModelState =
    'not-downloaded'|'downloading'|'incomplete'|'unloaded'|'loading'|
    'loaded'|'sleeping'|'failed';

export interface ModelStatus {
  id: string;
  state: ModelState;
  // Bytes done / total while downloading.
  progress?: {done: number, total: number};
  // Router measurement of the loaded footprint, when it has one.
  measuredMB?: number;
}

interface RouterModel {
  id: string;
  status?: {
    value?: string,
    failed?: boolean,
    progress?: Record<string, {done?: number, total?: number}>,
  };
  memory?: {
    effective?: MemoryMeasurement|null,
    max?: MemoryMeasurement,
  };
}

interface MemoryMeasurement {
  n_ctx?: number;
  devices?: Array<{model?: number, context?: number, compute?: number}>;
}

function parseState(model: RouterModel): ModelState {
  const value = model.status?.value;
  switch (value) {
    case 'downloading':
    case 'incomplete':
    case 'loading':
    case 'loaded':
    case 'sleeping':
      return value;
    case 'unloaded':
      return model.status?.failed ? 'failed' : 'unloaded';
    default:
      return 'unloaded';
  }
}

// What a loaded instance actually allocated. On Apple silicon GPU and host
// share one pool, so device and host allocations are both RAM.
function measuredMB(model: RouterModel): number|undefined {
  const devices = model.memory?.effective?.devices;
  if (!devices) {
    return undefined;
  }
  const bytes = devices.reduce(
      (sum, d) => sum + (d.model ?? 0) + (d.context ?? 0) + (d.compute ?? 0), 0);
  return bytes > 0 ? Math.round(bytes / (1024 * 1024)) : undefined;
}

export class ModelManager {
  private readonly http: HttpTransport;
  // Most recently used last.
  private readonly lru: string[] = [];

  constructor(http: HttpTransport) {
    this.http = http;
  }

  async list(): Promise<ModelStatus[]> {
    const body = ensureOk(await this.http.request('GET', '/models'),
                          'list models') as {data?: RouterModel[]};
    const known = new Map((body.data ?? []).map(m => [m.id, m]));
    return CATALOG.filter(m => m.runtime === 'llama').map(entry => {
      const model = known.get(entry.id);
      if (!model) {
        return {id: entry.id, state: 'not-downloaded' as const};
      }
      const status: ModelStatus = {id: entry.id, state: parseState(model)};
      const progress = model.status?.progress;
      if (progress) {
        let done = 0;
        let total = 0;
        for (const file of Object.values(progress)) {
          done += file.done ?? 0;
          total += file.total ?? 0;
        }
        status.progress = {done, total};
      }
      const measured = measuredMB(model);
      if (measured !== undefined) {
        status.measuredMB = measured;
      }
      return status;
    });
  }

  async download(id: string): Promise<void> {
    const model = this.requireLlama(id);
    const body: Record<string, unknown> = {model: id};
    if (model.sidecars) {
      body['sidecars'] = model.sidecars;
    }
    ensureOk(await this.http.request('POST', '/models', body),
             `download ${id}`);
  }

  async pauseDownload(id: string): Promise<void> {
    ensureOk(await this.http.request('POST', '/models/unload', {model: id}),
             `pause ${id}`);
  }

  async remove(id: string): Promise<void> {
    ensureOk(await this.http.request(
                 'DELETE', `/models?model=${encodeURIComponent(id)}`),
             `delete ${id}`);
    this.forget(id);
  }

  async unload(id: string): Promise<void> {
    ensureOk(await this.http.request('POST', '/models/unload', {model: id}),
             `unload ${id}`);
    this.forget(id);
  }

  // Loads `id`, first unloading least-recently-used models until the
  // estimated footprint fits `budgetMB`. `keep` are never evicted (the
  // models the current task is using).
  async ensureLoaded(id: string, budgetMB: number,
                     keep: readonly string[] = []): Promise<void> {
    const model = this.requireLlama(id);
    const statuses = await this.list();
    const resident = statuses.filter(
        s => s.id !== id &&
            (s.state === 'loaded' || s.state === 'loading' ||
             s.state === 'sleeping'));
    const footprint = (s: ModelStatus) =>
        s.measuredMB ?? findModel(s.id)?.ramMB ?? 0;
    let used = resident.reduce((sum, s) => sum + footprint(s), 0);
    for (const victim of this.evictionOrder(resident.map(s => s.id), keep)) {
      if (used + model.ramMB <= budgetMB) {
        break;
      }
      await this.unload(victim);
      used -= footprint(resident.find(s => s.id === victim)!);
    }
    const self = statuses.find(s => s.id === id);
    if (self?.state !== 'loaded' && self?.state !== 'loading') {
      ensureOk(await this.http.request('POST', '/models/load', {model: id}),
               `load ${id}`);
    }
    this.touch(id);
  }

  // Called by the browser on memory pressure. Moderate pressure drops the
  // responder; critical drops everything (the router reloads on next use).
  async relieve(level: 'moderate'|'critical'): Promise<string[]> {
    const loaded = (await this.list()).filter(
        s => s.state === 'loaded' || s.state === 'sleeping');
    const victims = loaded.filter(
        s => level === 'critical' || findModel(s.id)?.role === 'llm');
    for (const victim of victims) {
      await this.unload(victim.id);
    }
    return victims.map(v => v.id);
  }

  touch(id: string): void {
    this.forget(id);
    this.lru.push(id);
  }

  private forget(id: string): void {
    const index = this.lru.indexOf(id);
    if (index >= 0) {
      this.lru.splice(index, 1);
    }
  }

  // Evict responders before deciders, and least recently used first.
  private evictionOrder(resident: string[], keep: readonly string[]): string[] {
    const rank = (id: string) => {
      const used = this.lru.indexOf(id);
      return used < 0 ? -1 : used;
    };
    return resident.filter(id => !keep.includes(id)).sort((a, b) => {
      const roleA = findModel(a)?.role === 'decider' ? 1 : 0;
      const roleB = findModel(b)?.role === 'decider' ? 1 : 0;
      return roleA - roleB || rank(a) - rank(b);
    });
  }

  private requireLlama(id: string): CatalogModel {
    const model = findModel(id);
    if (!model) {
      throw new Error(`Unknown model ${id}`);
    }
    if (model.runtime !== 'llama') {
      throw new Error(`${id} runs in the strands-decider sidecar, not llama.cpp`);
    }
    return model;
  }
}
