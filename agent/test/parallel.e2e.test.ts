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
