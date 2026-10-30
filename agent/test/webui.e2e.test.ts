// End to end through the real chrome://ditto-agent page: its HTML, CSS,
// app.ts and mojo_transports.ts, compiled as shipped, running in Chromium.
// The harness stands in for the C++ page handler (same CDP allow-list).

import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {startMockRuntime, type MockRuntime} from '../dev/mock_runtime.js';
import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';
import {startWebUIHarness, type WebUIHarness} from '../dev/webui_harness.js';

const QWEN = 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M';
const D1 = 'LiquidAI/d1-2B-GGUF:Q4_K_M';
const LFM3 = 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M';

let runtime: MockRuntime;
let site: {url: string, close(): Promise<void>};
let browser: DevBrowser;
let harness: WebUIHarness;
let ui: any;
let tab: any;

before(async () => {
  // As after first-run setup on a 16 GB Mac: the default models are on disk.
  runtime = await startMockRuntime({preloaded: [QWEN, D1]});
  site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
  browser = await launchDevBrowser();
  const agentTab = await browser.newTab();
  tab = agentTab.page;
  await tab.goto(site.url);
  harness = await startWebUIHarness({
    runtimeUrl: runtime.url,
    apiKey: runtime.apiKey,
    activeTab: agentTab.cdp,
    searchUrl: site.url + 'search.html?q=%s',
  });
  ui = browser.page;
  ui.on('pageerror', (error: Error) => { throw error; });
  await ui.goto(harness.url);
});
after(async () => {
  await harness.close();
  await browser.close();
  await site.close();
  await runtime.close();
});

test('shows memory and the model catalog by role', async () => {
  await ui.click('#models-toggle');
  await ui.locator('#llm-list li').first().waitFor();
  assert.match(await ui.textContent('#memory'), /16\.0 GB RAM.*up to 8\.0 GB/);
  const llms = await ui.locator('#llm-list .name').allTextContents();
  const deciders = await ui.locator('#decider-list .name').allTextContents();
  assert.ok(llms.includes('LFM3 1.7B') && llms.includes('Qwen3.5 4B'));
  assert.ok(deciders.includes('d1 2B') && deciders.some((d: string) => d.startsWith('Strands')));
  // The 16 GB defaults are in use; LFM3 is not downloaded yet.
  assert.deepEqual(await ui.locator('li.active .name').allTextContents(),
                   ['Qwen3.5 4B', 'd1 2B']);
  const lfm3 = ui.locator('#llm-list li', {hasText: 'LFM3 1.7B'});
  assert.deepEqual(await lfm3.locator('button').allTextContents(), ['Download']);
});

test('downloads a model and swaps the responder to it', async () => {
  const lfm3 = ui.locator('#llm-list li', {hasText: 'LFM3 1.7B'});
  await lfm3.locator('button', {hasText: 'Download'}).click();
  await lfm3.locator('button', {hasText: 'Use'}).waitFor();
  const download = runtime.requests.find(r => r.method === 'POST' && r.path === '/models');
  assert.deepEqual(download?.body, {model: LFM3});

  await lfm3.locator('button', {hasText: 'Use'}).click();
  await ui.waitForFunction(() =>
      document.querySelector('#llm-list li.active .name')?.textContent === 'LFM3 1.7B');
  const saved = await ui.evaluate(() => localStorage.getItem('ditto.agent.settings'));
  assert.equal(JSON.parse(saved).llmId, LFM3);
});

test('a chat task drives the active tab and answers with sources', async () => {
  await ui.fill('#prompt', 'What is the price of the Acme Widget Pro?');
  await ui.press('#prompt', 'Enter');
  await ui.locator('.msg.agent .sources a').first().waitFor({timeout: 30000});

  assert.match(await ui.textContent('.msg.agent'), /\$49/);
  assert.match(await ui.locator('.sources a').first().textContent(), /widget-pro\.html/);
  assert.match(tab.url(), /widget-pro\.html$/);
  const trace = await ui.locator('.trace li').allTextContents();
  assert.ok(trace.some((t: string) => /Widget Pro/.test(t)), trace.join(' | '));

  // The swapped-in responder did the LLM work.
  const chats = runtime.requests.filter(r => r.path === '/v1/chat/completions');
  assert.ok(chats.length > 0 && chats.every(c => c.body.model === LFM3));
  // Every CDP command the agent sent is allowed by the browser's relay.
  const cdp = harness.calls.filter(c => c.method === 'sendCdp');
  assert.ok(cdp.length > 0);
  assert.ok(await ui.isVisible('#send'));
  assert.ok(harness.calls.some(c => c.method === 'detachFromTab'));
});

test('memory pressure unloads the responder first', async () => {
  const before = runtime.requests.length;
  harness.emit('onMemoryPressure', false);
  for (let i = 0; i < 50 && runtime.requests.length === before; ++i) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  const unloads = runtime.requests.slice(before)
      .filter(r => r.path === '/models/unload').map(r => r.body.model);
  assert.deepEqual(unloads, [LFM3]);
});

test('"Disable all models" stops the runtime and the agent refuses to run', async () => {
  await ui.click('#disable-all');
  assert.equal(await ui.inputValue('#mode'), 'off');
  assert.ok(harness.calls.some(c => c.method === 'stopRuntime'));
  const before = runtime.requests.length;
  await ui.fill('#prompt', 'anything');
  await ui.press('#prompt', 'Enter');
  await ui.locator('.msg.agent', {hasText: 'All models are disabled'}).waitFor();
  assert.equal(runtime.requests.length, before, 'no model request while off');
});
