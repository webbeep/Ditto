// End to end through the real agent panel and home page (HTML, CSS and
// TypeScript compiled as shipped), running in Chromium. The harness stands
// in for the C++ page handler (same CDP allow-list).

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
const TASK = 'What is the price of the Acme Widget Pro?';

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
    chrome: {found: true, bookmarks: 42, email: 'ada@example.com'},
    home: {
      topSites: [{host: 'acme.test', url: site.url + 'about.html', title: 'Acme'}],
      forYou: [{title: 'widget pro launch', traffic: '20K+', picture: '',
                newsTitle: 'Acme ships the Widget Pro', newsUrl: site.url + 'about.html',
                source: 'Acme News', reason: 'widgets'}],
      trending: [{title: 'solar eclipse', traffic: '500K+', picture: '',
                  newsTitle: 'Where to see it', newsUrl: '', source: 'Sky Daily', reason: ''}],
    },
    suggestions: {'weather in': ['weather in paris', 'weather in london']},
  });
  ui = browser.page;
  ui.on('pageerror', (error: Error) => { throw error; });
  await ui.setViewportSize({width: 400, height: 760});
  await ui.goto(harness.url);
});
after(async () => {
  await harness.close();
  await browser.close();
  await site.close();
  await runtime.close();
});

const ask = async (question: string) => {
  const replies = await ui.locator('.reply').count();
  await ui.fill('#prompt', question);
  await ui.press('#prompt', 'Enter');
  await ui.locator('.reply').nth(replies).locator('.text').filter({hasText: /\S/})
      .waitFor({timeout: 30000});
  await ui.locator('[aria-label="Send"]').waitFor();
  return ui.locator('.reply').nth(replies);
};

test('starts empty, with icon controls and the hybrid mode', async () => {
  await ui.locator('.empty > .icon').waitFor();
  // Quick starts for the page in front; "Remember" only fills the field.
  assert.deepEqual(await ui.locator('.starters button').allTextContents(),
                   ['Summarize this page', 'Key facts on this page', 'Remember something…']);
  await ui.click('.starters button:has-text("Remember")');
  assert.equal(await ui.inputValue('#prompt'), 'Remember that ');
  await ui.fill('#prompt', '');
  for (const label of ['History', 'New chat', 'Models', 'Send']) {
    assert.equal(await ui.locator(`[aria-label="${label}"]`).count(), 1, label);
  }
  const modes = ui.locator('#modes button');
  assert.equal(await modes.count(), 4);
  assert.equal(await ui.locator('#modes [aria-pressed="true"]').getAttribute('aria-label'),
               'Decider navigates, LLM answers');
  assert.ok(await ui.locator('[aria-label="Send"]').isDisabled(), 'nothing to send yet');
});

test('models: memory meter, download, and switching the LLM', async () => {
  await ui.click('[aria-label="Models"]');
  await ui.locator('.models li').first().waitFor();
  assert.match(await ui.textContent('.meter .legend'), /of 8\.0 GB/);
  const lfm3 = ui.locator('.models li', {hasText: 'LFM3 1.7B'});
  assert.equal(await lfm3.locator('.radio').getAttribute('aria-disabled'), 'true');
  await lfm3.locator('[aria-label^="Download"]').click();
  await lfm3.locator('[aria-label="Delete from disk"]').waitFor();
  assert.deepEqual(runtime.requests.find(r => r.method === 'POST' && r.path === '/models')?.body,
                   {model: LFM3});
  await lfm3.locator('.radio').click();
  await ui.waitForFunction(() =>
      document.querySelector('.models li[aria-current="true"] .name')?.textContent === 'LFM3 1.7B');
  assert.equal(JSON.parse(await ui.evaluate(() => localStorage.getItem('ditto.agent.settings'))).llmId,
               LFM3);
  await ui.click('[aria-label="Models"]');  // back to the chat
  assert.ok(await ui.isVisible('#prompt'));
});

test('a question drives the open tab, shows its steps and cites sources', async () => {
  const reply = await ask(TASK);
  assert.match(await reply.locator('.text').textContent(), /\$49/);
  assert.match(tab.url(), /widget-pro\.html$/);
  assert.match(await reply.locator('.sources a').first().getAttribute('href'), /widget-pro\.html$/);
  assert.ok(await reply.locator('.steps li').count() >= 2);
  assert.equal(await ui.textContent('#title'), TASK, 'the chat is named after its question');
  // Every CDP command went through the browser's allow-list.
  assert.ok(harness.calls.some(c => c.method === 'sendCdp'));
  // The agent's overlay was cleaned up.
  assert.equal(await tab.evaluate(() => document.querySelector('[data-ditto-overlay]')), null);
  // The swapped-in LLM did the work (warm-up pings are one-token requests).
  const chats = runtime.requests.filter(r => r.path === '/v1/chat/completions' &&
                                             r.body.max_tokens !== 1);
  assert.ok(chats.length && chats.every(c => c.body.model === LFM3));
  // Typing loaded and warmed the models before the question was sent.
  assert.ok(runtime.requests.some(r => r.path === '/v1/chat/completions' && r.body.max_tokens === 1));
});

test('a follow-up uses the chat: answered from its sources without browsing', async () => {
  const navigations = () => harness.calls.filter(
      c => c.method === 'sendCdp' && c.args[0] === 'Page.navigate').length;
  const clicks = () => harness.calls.filter(
      c => c.method === 'sendCdp' && c.args[0] === 'Input.dispatchMouseEvent').length;
  const [navigated, clicked] = [navigations(), clicks()];
  const reply = await ask('What is the Widget Pro price?');
  assert.match(await reply.locator('.text').textContent(), /\$49/);
  assert.match(await reply.locator('.steps').textContent(), /From this chat's sources/);
  assert.equal(navigations(), navigated, 'no navigation');
  assert.equal(clicks(), clicked, 'no clicks');
  const last = runtime.requests.filter(r => r.path === '/v1/chat/completions').at(-1)!;
  assert.match(JSON.stringify(last.body.messages), /Earlier in this chat/);
});

test('history keeps chats; new chat starts clean', async () => {
  await ui.click('[aria-label="New chat"]');
  await ui.locator('.empty').waitFor();
  assert.equal(await ui.textContent('#title'), '');
  await ui.click('[aria-label="History"]');
  const row = ui.locator('.history li');
  assert.equal(await row.count(), 1);
  assert.equal(await row.locator('.name').textContent(), TASK);
  await row.click();
  assert.equal(await ui.locator('.question').count(), 2);
  // It survives a reload.
  await ui.reload();
  await ui.click('[aria-label="History"]');
  assert.equal(await ui.locator('.history li').count(), 1);
  await ui.locator('.history li').click();
});

test('the home page hands questions to the panel and opens addresses', async () => {
  const home = await browser.newTab();
  await home.page.goto(harness.url + 'home.html');
  assert.equal(await home.page.locator('.recent li').count(), 1, 'recent chats');
  await home.page.fill('#query', 'What does the Widget Mini cost?');
  await home.page.press('#query', 'Enter');
  // The panel (another page, same origin) picks it up as a new chat.
  await ui.locator('.question', {hasText: 'What does the Widget Mini cost?'}).waitFor();
  assert.ok(harness.calls.some(c => c.method === 'showAgentPanel'));
  await ui.locator('[aria-label="Send"]').waitFor({timeout: 30000});
  assert.equal(await ui.locator('.question').count(), 1, 'in a new chat');

  await home.page.fill('#query', site.url.replace('http://', '') + 'about.html');
  await home.page.press('#query', 'Enter');
  await home.page.waitForURL(/about\.html$/);
  await home.page.close();
});

test('the home page: top sites, picks for the user, trending', async () => {
  const home = await browser.newTab();
  await home.page.goto(harness.url + 'home.html');
  await home.page.locator('#for-you .card').waitFor();
  assert.equal(await home.page.locator('#sites .site').count(), 1, 'top sites');
  assert.equal(await home.page.locator('#sites .site').getAttribute('href'), site.url + 'about.html');
  assert.match(await home.page.locator('#for-you .reason').textContent(), /You read about widgets/);
  assert.equal(await home.page.locator('#trending .card').count(), 1);
  assert.match(await home.page.locator('#trending .source').textContent(), /Sky Daily/);
  // A trend goes to Ditto as a question.
  await home.page.locator('#trending .card').click();
  await ui.locator('.question', {hasText: "What's the latest on solar eclipse?"}).waitFor();
  await ui.locator('[aria-label="Send"]').waitFor({timeout: 30000});
  await home.page.close();
});

test('the home page suggests searches; arrow keys choose', async () => {
  const home = await browser.newTab();
  await home.page.goto(harness.url + 'home.html');
  await home.page.fill('#query', 'weather in');
  const rows = home.page.locator('#suggest li');
  await rows.filter({hasText: 'weather in london'}).waitFor();
  assert.deepEqual(await rows.locator('.detail').allTextContents(),
                   ['Ask Ditto', 'Search Google', 'Search', 'Search']);
  assert.equal(await rows.first().getAttribute('aria-selected'), 'true', 'Ditto first');
  await home.page.press('#query', 'ArrowDown');
  await home.page.press('#query', 'ArrowDown');
  await home.page.press('#query', 'ArrowDown');
  assert.equal(await rows.nth(3).getAttribute('aria-selected'), 'true');
  await home.page.press('#query', 'Escape');
  assert.equal(await home.page.locator('#suggest').isHidden(), true, 'escape closes');
  // An address is offered as one row, with no suggestions fetched.
  const before = harness.calls.filter(c => c.method === 'getSuggestions').length;
  await home.page.fill('#query', 'example.com');
  await home.page.waitForTimeout(300);
  assert.deepEqual(await rows.locator('.detail').allTextContents(), ['Open']);
  assert.equal(harness.calls.filter(c => c.method === 'getSuggestions').length, before);
  await home.page.close();
});

test('the home page moves bookmarks over from Chrome once', async () => {
  const home = await browser.newTab();
  await home.page.goto(harness.url + 'home.html');
  await home.page.click('.move button');
  await home.page.locator('.move .note', {hasText: '42 bookmarks from Chrome'}).waitFor();
  const signIn = new URL(await home.page.locator('.move a').getAttribute('href'));
  assert.equal(signIn.host, 'accounts.google.com');
  assert.equal(signIn.searchParams.get('Email'), 'ada@example.com');
  assert.ok(harness.calls.some(call => call.method === 'importFromChrome'));
  await home.page.reload();
  await home.page.locator('#command-icon svg').waitFor();
  assert.equal(await home.page.locator('.move button').count(), 0, 'offered once');
  await home.page.close();
});

test('buying waits for Approve in the panel', async () => {
  await ui.click('[aria-label="New chat"]');
  await tab.goto(site.url + 'cart.html');
  await ui.fill('#prompt', 'Buy the Acme Widget Pro');
  await ui.press('#prompt', 'Enter');
  const card = ui.locator('.ask');
  await card.waitFor({timeout: 30000});
  assert.match(await card.textContent(), /Place order/);
  assert.match(tab.url(), /cart\.html$/, 'nothing submitted before the OK');
  await card.locator('button', {hasText: 'Approve'}).click();
  await tab.waitForURL(/order-placed\.html$/);
  await ui.locator('[aria-label="Send"]').waitFor({timeout: 30000});
});

test('memory: a told note shows in Memory and can be forgotten', async () => {
  await ui.click('[aria-label="New chat"]');
  await ui.fill('#prompt', 'remember that I prefer metric units');
  await ui.press('#prompt', 'Enter');
  await ui.locator('.reply .text', {hasText: 'Noted.'}).waitFor();
  await ui.click('[aria-label="Memory"]');
  const note = ui.locator('#view-memory li', {hasText: 'metric units'});
  await note.waitFor();
  await note.locator('[aria-label="Forget this"]').click();
  assert.equal(await ui.locator('#view-memory li').count(), 0);
  await ui.click('[aria-label="Memory"]');
});

test('memory pressure unloads LLMs and keeps the decider', async () => {
  const before = runtime.requests.length;
  harness.emit('onMemoryPressure', false);
  for (let i = 0; i < 50 && !runtime.requests.slice(before).some(r => r.path === '/models/unload'); ++i) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const unloads = runtime.requests.slice(before)
      .filter(r => r.path === '/models/unload').map(r => r.body.model);
  assert.ok(unloads.includes(LFM3));
  assert.ok(!unloads.includes(D1), 'the decider stays loaded');
});

test('models off: the runtime stops and nothing can be sent', async () => {
  await ui.click('[aria-label="Models off"]');
  assert.ok(harness.calls.some(c => c.method === 'stopRuntime'));
  const before = runtime.requests.length;
  await ui.fill('#prompt', 'anything');
  assert.ok(await ui.locator('[aria-label="Send"]').isDisabled());
  await ui.press('#prompt', 'Enter');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(runtime.requests.length, before, 'no model request while off');
});
