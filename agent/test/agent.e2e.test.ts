// End to end: the real PageDriver in a real Chromium (Playwright), on a
// local fixture site, with the mock runtime standing in for the models.

import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {startMockRuntime, type MockRuntime} from '../dev/mock_runtime.js';
import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';
import {BrowserAgent, type AgentEvent} from '../src/agent/agent.js';
import {PageDriver} from '../src/browser/page_driver.js';
import {DeciderClient} from '../src/decider/decider_client.js';
import {FetchTransport} from '../src/http.js';
import {LlmClient} from '../src/llm/llm_client.js';
import {defaultSettings, type AgentMode} from '../src/models/settings.js';

const TASK = 'What is the price of the Acme Widget Pro?';

let runtime: MockRuntime;
let site: {url: string, close(): Promise<void>};
let browser: DevBrowser;

before(async () => {
  runtime = await startMockRuntime();
  site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
  browser = await launchDevBrowser();
});
after(async () => {
  await browser.close();
  await site.close();
  await runtime.close();
});

async function runAgent(mode: AgentMode, task = TASK, start = site.url) {
  const http = new FetchTransport(runtime.url, runtime.apiKey);
  const settings = {...defaultSettings(16 * 1024), mode};
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: start});
  const agent = new BrowserAgent({
    driver,
    settings,
    ...(mode !== 'decider-only' ? {llm: new LlmClient(http, settings.llmId)} : {}),
    ...(mode !== 'llm-only' ? {decider: new DeciderClient(http, settings.deciderId)} : {}),
  });
  const events: AgentEvent[] = [];
  const result = await agent.run(task, e => events.push(e));
  return {result, events};
}

for (const mode of ['hybrid', 'decider-only', 'llm-only'] as const) {
  test(`${mode}: navigates two hops to the product page and answers`, async () => {
    const {result, events} = await runAgent(mode);
    assert.match(result.finalUrl, /widget-pro\.html$/);
    assert.match(result.answer, /\$49/);
    // Read from <main>, not the navigation bar.
    assert.doesNotMatch(result.answer, /Home|Widget series/);
    assert.match(result.sources[0]!, /widget-pro\.html$/);
    assert.equal(result.steps, 2);
    const steps = events.filter(e => e.type === 'step');
    assert.deepEqual(steps.map(s => s.type === 'step' && s.option.startsWith('e')),
                     [true, true]);
    if (mode === 'decider-only') {
      assert.ok(steps.every(s => s.type === 'step' && s.by === 'decider'));
    }
    if (mode === 'llm-only') {
      assert.ok(steps.every(s => s.type === 'step' && s.by === 'llm'));
    }
  });
}

test('hybrid escalates low-confidence decider steps to the LLM', async () => {
  const {events} = await runAgent('hybrid');
  const steps = events.filter(e => e.type === 'step');
  // On the home page every link matches the goal poorly, so the decider is
  // unsure and the LLM decides; on the widget list the decider is sure.
  assert.equal(steps[0]?.type === 'step' && steps[0].by, 'llm');
  assert.equal(steps[1]?.type === 'step' && steps[1].by, 'decider');
});

test('a dead start page ends with an honest answer, not a model guess', async () => {
  const before = runtime.requests.length;
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'no-such-page.html');
  assert.match(result.answer, /could not load a usable page .*no-such-page\.html/);
  assert.deepEqual(result.sources, []);
  assert.ok(events.some(e => e.type === 'warning'));
  // Only the plan was requested from the LLM; no answer was generated.
  const chats = runtime.requests.slice(before).filter(r => r.path === '/v1/chat/completions');
  assert.equal(chats.length, 1);
  assert.ok(chats[0]!.body.response_format, 'the one LLM call is the plan');
});

test('a broken link is backed out of and the agent still finds the answer', async () => {
  const {result, events} = await runAgent('decider-only', TASK, site.url + 'parts.html');
  const warnings = events.filter(e => e.type === 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.type === 'warning' ? warnings[0]!.message : '', /missing-price-list/);
  assert.match(result.finalUrl, /widget-pro\.html$/);
  assert.match(result.answer, /\$49/);
});

test('page text falls back to the body when <main> is empty', async () => {
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: site.url + 'empty-main.html'});
  const page = await driver.snapshot();
  assert.match(page.text, /price is \$49/);
});

test('typing into a search box uses trusted input and submits', async () => {
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: site.url});
  const page = await driver.snapshot();
  const box = page.elements.find(e => e.kind === 'textbox')!;
  assert.equal(box.label, 'Search the store');
  await driver.perform({kind: 'type', id: box.id, text: 'widget pro', submit: true});
  const results = await driver.snapshot();
  assert.match(results.url, /search\.html\?q=widget\+pro$/);
  assert.ok(results.elements.some(e => e.label === 'Widget Pro'));
});

test('the agent refuses to run with every model disabled', () => {
  const driver = new PageDriver(browser.cdp);
  assert.throws(() => new BrowserAgent({driver, settings: {...defaultSettings(8192), mode: 'off'}}),
                /all models are disabled/);
});
