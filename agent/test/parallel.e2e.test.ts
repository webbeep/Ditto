// Several questions at once through the real panel: each chat runs in its
// own Ditto tab, alongside the others, and gets its own answer.

import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {startMockRuntime, type MockRuntime} from '../dev/mock_runtime.js';
import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';
import {startWebUIHarness, type WebUIHarness} from '../dev/webui_harness.js';

let runtime: MockRuntime;
let site: {url: string, close(): Promise<void>};
let browser: DevBrowser;
let harness: WebUIHarness;
let ui: any;
let tabs = 0;

before(async () => {
  // Slow enough that the two runs overlap.
  runtime = await startMockRuntime({
    preloaded: ['unsloth/Qwen3.5-4B-GGUF:Q4_K_M', 'LiquidAI/d1-2B-GGUF:Q4_K_M'], delayMs: 120});
  site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
  browser = await launchDevBrowser();
  const first = await browser.newTab();
  harness = await startWebUIHarness({
    runtimeUrl: runtime.url, apiKey: runtime.apiKey, activeTab: first.cdp,
    searchUrl: site.url + 'search.html?q=%s',
    // Trending on the home page, each a question for Ditto when clicked.
    home: {
      topSites: [], forYou: [],
      trending: [
        {title: 'Acme Widget Pro price', traffic: '20K+', picture: '', newsTitle: 'Widget Pro',
         newsUrl: '', source: 'Acme News', reason: ''},
        {title: 'Acme Widget Mini price', traffic: '10K+', picture: '', newsTitle: 'Widget Mini',
         newsUrl: '', source: 'Acme News', reason: ''},
      ],
    },
    sessionTab: async () => {
      ++tabs;
      return (await browser.newTab()).cdp;
    },
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

const send = async (question: string) => {
  await ui.fill('#prompt', question);
  await ui.press('#prompt', 'Enter');
};

test('two chats at once, each in its own tab, each with its own answer', async () => {
  await send('What is the price of the Acme Widget Pro?');
  await ui.locator('.live').waitFor();
  // While the first works, a second chat starts.
  await ui.click('[aria-label="New chat"]');
  assert.equal(await ui.locator('.question').count(), 0, 'a fresh chat');
  await send('How much does the Acme Widget Mini cost?');
  await ui.click('[aria-label="History"]');
  assert.equal(await ui.locator('.history .running').count(), 2, 'both working');
  await ui.locator('.history .running').first().waitFor({state: 'detached', timeout: 60000});
  await ui.locator('.history .running').waitFor({state: 'detached', timeout: 60000});
  assert.equal(tabs, 2, 'one Ditto tab per chat');

  const answerOf = async (title: RegExp) => {
    await ui.locator('.history li', {hasText: title}).click();
    const text = await ui.locator('.reply .text').last().textContent();
    await ui.click('[aria-label="History"]');
    return text;
  };
  assert.match(await answerOf(/Widget Pro/), /\$49/);
  const mini = await answerOf(/Widget Mini/);
  assert.match(mini, /\$19/);
  assert.doesNotMatch(mini, /\$49/);
});

test('home cards clicked in a row: each its own chat, all at once, a double click once', async () => {
  const before = tabs;
  const calls = harness.calls.length;
  await ui.click('[aria-label="New chat"]');
  const home = await browser.newTab();
  await home.page.goto(harness.url + 'home.html');
  const cards = home.page.locator('.card');
  await cards.first().waitFor();
  await cards.nth(0).dblclick();
  await cards.nth(1).click();
  // Each question comes to the front as it arrives.
  await ui.locator('.question', {hasText: 'Widget Mini'}).waitFor();
  const since = () => harness.calls.slice(calls).map(c => c.method);
  for (let i = 0; i < 600 && since().filter(m => m === 'detachFromTab').length < 2; ++i) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Both Ditto tabs were working before either finished: side by side.
  const order = since().filter(m => m === 'attachToActiveTab' || m === 'detachFromTab');
  assert.deepEqual(order, ['attachToActiveTab', 'attachToActiveTab', 'detachFromTab',
                           'detachFromTab']);
  assert.equal(tabs - before, 2, 'a Ditto tab each');
  await ui.click('[aria-label="History"]');
  assert.equal(await ui.locator('.history li', {hasText: /latest on Acme Widget/}).count(), 2,
               'two chats, not three');
  // Each answered from its own pages.
  await ui.locator('.history li', {hasText: /Widget Mini/}).first().click();
  const mini = await ui.locator('.reply .text').last().textContent();
  assert.match(mini, /\$19/);
  assert.doesNotMatch(mini, /\$49/);
  await home.page.close();
});

test('a question sent while the chat works waits its turn, then follows up', async () => {
  await ui.click('[aria-label="New chat"]');
  await send('What is the price of the Acme Widget Pro?');
  await ui.locator('.live').waitFor();
  // Typed while it works: the button queues it, Enter too.
  await ui.fill('#prompt', 'How much does the Acme Widget Mini cost?');
  await ui.locator('[aria-label="Queue"]').waitFor();
  await ui.press('#prompt', 'Enter');
  await ui.locator('.queued', {hasText: 'Widget Mini'}).waitFor();
  // One more, taken back again.
  await send('And the Trail Tent?');
  await ui.locator('.queued', {hasText: 'Trail Tent'})
      .locator('[aria-label="Remove from queue"]').click();
  assert.equal(await ui.locator('.queued').count(), 1);
  // The first answer, then the queued question in the same chat.
  await ui.locator('.question').nth(1).filter({hasText: 'Widget Mini'})
      .waitFor({timeout: 60000});
  await ui.locator('[aria-label="Send"]').waitFor({timeout: 60000});
  const answers = await ui.locator('.reply .text').allTextContents();
  assert.equal(answers.length, 2);
  assert.match(answers[0]!, /\$49/);
  assert.match(answers[1]!, /\$19/);
  assert.equal(await ui.locator('.queued').count(), 0);
  assert.equal(await ui.locator('.question', {hasText: 'Trail Tent'}).count(), 0);
});

test('stopping a chat drops what was queued behind it', async () => {
  await ui.click('[aria-label="New chat"]');
  await send('What is the price of the Acme Widget Pro?');
  await ui.locator('.live').waitFor();
  await send('How much does the Acme Widget Mini cost?');
  await ui.locator('.queued').waitFor();
  await ui.locator('[aria-label="Stop"]').click();
  await ui.locator('[aria-label="Send"]').waitFor({timeout: 30000});
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await ui.locator('.queued').count(), 0);
  assert.equal(await ui.locator('.question').count(), 1);
});
