// Downloads models into a llama-server router and waits until they are on
// disk (dev CLI, eval).

import type {ModelManager} from '../src/models/model_manager.js';

export async function downloadAll(models: ModelManager, ids: string[]): Promise<void> {
  const ready = new Set(['unloaded', 'loaded', 'sleeping', 'loading']);
  const deadline = Date.now() + 30 * 60 * 1000;
  for (const id of ids) {
    const state = (await models.list()).find(s => s.id === id)?.state;
    if (state === 'not-downloaded' || state === 'incomplete') {
      console.log(`downloading ${id}`);
      await models.download(id);
    }
  }
  let lastReport = 0;
  for (;;) {
    const statuses = (await models.list()).filter(s => ids.includes(s.id));
    const failed = statuses.find(s => s.state === 'failed');
    if (failed) {
      throw new Error(`download of ${failed.id} failed`);
    }
    if (statuses.length === ids.length && statuses.every(s => ready.has(s.state))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('downloads timed out');
    }
    if (Date.now() - lastReport > 10000) {
      lastReport = Date.now();
      for (const s of statuses) {
        const pct = s.progress?.total ? ` ${Math.round(100 * s.progress.done / s.progress.total)}%` : '';
        console.log(`  ${s.id}: ${s.state}${pct}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
