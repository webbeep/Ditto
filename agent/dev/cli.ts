// Run the agent from a terminal against a real llama-server router or the
// mock runtime.
//
//   node dist/dev/cli.js --mock "What is the price of the Acme Widget Pro?"
//   node dist/dev/cli.js --runtime http://127.0.0.1:8080 --api-key KEY \
//       --start https://example.com "what does this site sell?"

import {totalmem} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {BrowserAgent, type AgentEvent} from '../src/agent/agent.js';
import {PageDriver} from '../src/browser/page_driver.js';
import {DeciderClient} from '../src/decider/decider_client.js';
import {FetchTransport} from '../src/http.js';
import {LlmClient} from '../src/llm/llm_client.js';
import {findModel} from '../src/models/catalog.js';
import {ModelManager} from '../src/models/model_manager.js';
import {defaultSettings, usesDecider, usesLlm, type AgentMode} from '../src/models/settings.js';
import {startMockRuntime} from './mock_runtime.js';
import {launchDevBrowser} from './playwright_cdp.js';
import {serveDirectory} from './static_server.js';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    'mock': {type: 'boolean'},
    'runtime': {type: 'string'},
    'api-key': {type: 'string'},
    'start': {type: 'string'},
    'mode': {type: 'string'},
    'llm': {type: 'string'},
    'decider': {type: 'string'},
    'strands': {type: 'string'},
    'search': {type: 'string'},
    // Serve the test site and start there (implied by --mock).
    'fixture': {type: 'boolean'},
    // Exit with status 1 unless the answer matches this regular expression.
    'expect': {type: 'string'},
    // Download the chosen models through the runtime first (with progress).
    'download': {type: 'boolean'},
    'budget-mb': {type: 'string'},
    // Ask a follow-up in the same chat after the first answer.
    'follow-up': {type: 'string'},
    'expect-follow-up': {type: 'string'},
    'headed': {type: 'boolean'},
  },
});

const task = positionals.join(' ') || 'What is the price of the Acme Widget Pro?';
const settings = defaultSettings(Math.round(totalmem() / (1024 * 1024)));
if (values.mode) {
  settings.mode = values.mode as AgentMode;
}
settings.llmId = values.llm ?? settings.llmId;
settings.deciderId = values.decider ?? settings.deciderId;
if (values['budget-mb']) {
  settings.modelBudgetMB = Number(values['budget-mb']);
}

async function downloadAll(models: ModelManager, ids: string[]): Promise<void> {
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

const cleanups: Array<() => Promise<void>> = [];
try {
  let runtimeUrl = values.runtime;
  let apiKey = values['api-key'];
  let start = values.start;
  if (values.mock) {
    const mock = await startMockRuntime({preloaded: [settings.llmId, settings.deciderId]});
    cleanups.push(mock.close);
    runtimeUrl = mock.url;
    apiKey = mock.apiKey;
  }
  if (values.mock || values.fixture) {
    const site = await serveDirectory(
        fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
    cleanups.push(site.close);
    start ??= site.url;
  }
  if (!runtimeUrl) {
    throw new Error('Pass --runtime <llama-server url> or --mock');
  }
  const http = new FetchTransport(runtimeUrl, apiKey);
  const models = new ModelManager(http);
  const keep = [settings.llmId, settings.deciderId];
  if (values.download) {
    const wanted = [
      ...(usesLlm(settings.mode) ? [settings.llmId] : []),
      ...(usesDecider(settings.mode) && findModel(settings.deciderId)?.runtime === 'llama' ?
              [settings.deciderId] : []),
    ];
    await downloadAll(models, wanted);
  }

  let llm: LlmClient|undefined;
  if (usesLlm(settings.mode)) {
    await models.ensureLoaded(settings.llmId, settings.modelBudgetMB, keep);
    llm = new LlmClient(http, settings.llmId);
  }
  let decider: DeciderClient|undefined;
  if (usesDecider(settings.mode)) {
    if (findModel(settings.deciderId)?.runtime === 'strands') {
      decider = new DeciderClient(
          new FetchTransport(values.strands ?? settings.strandsEndpoint),
          settings.deciderId, false);
    } else {
      await models.ensureLoaded(settings.deciderId, settings.modelBudgetMB, keep);
      decider = new DeciderClient(http, settings.deciderId);
    }
  }

  const browser = await launchDevBrowser({headed: values.headed ?? false});
  cleanups.push(browser.close);
  const driver = new PageDriver(browser.cdp);
  if (start) {
    await driver.perform({kind: 'navigate', url: start});
  }

  console.log(`mode=${settings.mode} llm=${llm?.modelId ?? '-'} ` +
              `decider=${decider?.modelId ?? '-'}\ntask: ${task}\n`);
  const agent = new BrowserAgent({
    driver, settings,
    ...(values.search ? {searchUrl: values.search} : {}),
    ...(llm ? {llm} : {}),
    ...(decider ? {decider} : {}),
  });
  const log = (event: AgentEvent) => {
    switch (event.type) {
      case 'plan':
        console.log(`plan (${event.by}): ${event.plan.start} ` +
                    `${event.plan.url || event.plan.searchQuery} | goal: ${event.plan.goal}`);
        break;
      case 'page':
        console.log(`page: ${event.title} <${event.url}> done=${event.done.toFixed(2)} ` +
                    `relevant=${event.relevant.toFixed(2)}`);
        break;
      case 'step':
        console.log(`  step ${event.index} (${event.by}, conf ${event.confidence.toFixed(2)}): ` +
                    event.description);
        break;
      case 'warning':
        console.log(`  warning: ${event.message}`);
        break;
      case 'retry':
        console.log(`  retry (${event.what}, attempt ${event.attempt}): ${event.error}`);
        break;
    }
  };
  const result = await agent.run(task, log);
  console.log(`\nanswer: ${result.answer}`);
  result.sources.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
  if (values.expect && !new RegExp(values.expect).test(result.answer)) {
    console.error(`\nFAIL: the answer does not match /${values.expect}/`);
    process.exitCode = 1;
  }
  const followUp = values['follow-up'];
  if (followUp) {
    console.log(`\nfollow-up: ${followUp}`);
    const second = await agent.run(followUp, log, {
      context: {history: [{question: task, answer: result.answer}], sources: result.evidence},
    });
    console.log(`answer${second.fromHistory ? ' (from the chat\'s sources)' : ''}: ` +
                second.answer);
    const expected = values['expect-follow-up'];
    if (expected && !new RegExp(expected).test(second.answer)) {
      console.error(`\nFAIL: the follow-up answer does not match /${expected}/`);
      process.exitCode = 1;
    }
  }
} finally {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
}
