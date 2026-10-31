// First launch through the real panel: no models on disk, so Ditto offers
// the pair that suits the Mac, downloads only when asked, and answers only
// once they are here.

import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';

import {startMockRuntime, type MockRuntime} from '../dev/mock_runtime.js';
import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {startWebUIHarness, type WebUIHarness} from '../dev/webui_harness.js';

let runtime: MockRuntime;
let browser: DevBrowser;
let harness: WebUIHarness;
let ui: any;

before(async () => {
  runtime = await startMockRuntime({preloaded: []});
  browser = await launchDevBrowser();
  const tab = await browser.newTab();
  harness = await startWebUIHarness({
    runtimeUrl: runtime.url, apiKey: runtime.apiKey, activeTab: tab.cdp,
    totalMb: 8192, arch: 'arm64', freeDiskMb: 50_000,
  });
  ui = browser.page;
  ui.on('pageerror', (error: Error) => { throw error; });
  await ui.setViewportSize({width: 400, height: 760});
  await ui.goto(harness.url);
});
after(async () => {
  await harness.close();
  await browser.close();
  await runtime.close();
});

test('first launch: the right pair for this Mac, downloaded only when asked', async () => {
  await ui.locator('.setup h1', {hasText: 'Set up Ditto'}).waitFor();
  assert.deepEqual(await ui.locator('.setup .pair b').allTextContents(),
                   ['LFM3 1.7B', 'd1 Omni 600M']);
  assert.match(await ui.textContent('.setup .device'), /Apple M2.*8 GB memory/);
  assert.match(await ui.textContent('.setup .why'), /8 GB of memory/);
  // Nothing was downloaded by looking.
  assert.ok(!runtime.requests.some(r => r.method === 'POST' && r.path === '/models'));

  // Not now: the chat says what is missing and cannot be used.
  await ui.click('.setup .link:has-text("Not now")');
  assert.equal(await ui.getAttribute('#prompt', 'placeholder'), 'Set up Ditto to ask');
  await ui.fill('#prompt', 'What is the price of the Acme Widget Pro?');
  assert.equal(await ui.locator('[aria-label="Send"]').isDisabled(), true);
  await ui.click('.empty .button:has-text("Set up Ditto")');

  await ui.click('.setup .button:has-text("Download")');
  await ui.locator('.setup .button', {hasText: 'Start using Ditto'}).waitFor();
  assert.deepEqual(
      runtime.requests.filter(r => r.method === 'POST' && r.path === '/models')
          .map(r => r.body.model).sort(),
      ['LiquidAI/LFM3-1.7B-GGUF:Q4_K_M', 'LiquidAI/d1-omni-600M-GGUF:Q8_0']);
  await ui.click('.setup .button:has-text("Start using Ditto")');
  assert.equal(await ui.getAttribute('#prompt', 'placeholder'), 'Ask anything');
  assert.equal(await ui.locator('[aria-label="Send"]').isDisabled(), false, 'the question waited');
});
