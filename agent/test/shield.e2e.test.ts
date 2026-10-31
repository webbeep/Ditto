// The scripts Ditto's browser injects for everyday browsing
// (chromium/overlay/ditto/browser/ui/ad_skip), run exactly as written in
// the C++ sources, in a real Chromium on fixture pages.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';

const AD_SKIP = new URL('../../../chromium/overlay/ditto/browser/ui/ad_skip/', import.meta.url);

// The raw string literal named `name` in a C++ file: uR"js(...)js".
function script(file: string, name: string): string {
  const source = readFileSync(fileURLToPath(new URL(file, AD_SKIP)), 'utf8');
  const start = source.indexOf(`${name}[] = uR"js(`);
  assert.ok(start >= 0, `${name} in ${file}`);
  const body = source.slice(source.indexOf('(', start + name.length + 6) + 1);
  return body.slice(0, body.indexOf(')js"'));
}

let browser: DevBrowser;
let site: {url: string, close(): Promise<void>};

before(async () => {
  site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/', import.meta.url)));
  browser = await launchDevBrowser();
});
after(async () => {
  await browser.close();
  await site.close();
});

test('the shield hides ad slots and sends trapped clicks to what is under them', async () => {
  const page = browser.page;
  await page.goto(site.url + 'site/trap.html');
  await page.evaluate(script('page_shield.cc', 'kShield'));
  // Twice is harmless.
  await page.evaluate(script('page_shield.cc', 'kShield'));
  assert.equal(await page.locator('ins.adsbygoogle').isVisible(), false);
  assert.equal(await page.locator('[data-ad-slot]').isVisible(), false);
  // A real mouse click on the link lands on the trap first.
  const box = await page.locator('#real').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(/widget-pro\.html$/);
});

test('without the shield the trap wins (the fixture is a real trap)', async () => {
  const page = browser.page;
  await page.goto(site.url + 'site/trap.html');
  const box = await page.locator('#real').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(/decoy\.html$/);
});

test('the YouTube skipper finds the Skip button only once it shows', async () => {
  const page = browser.page;
  await page.goto(site.url + 'youtube/ad.html');
  const find = script('youtube_ad_skipper.cc', 'kFindSkipButton');
  assert.equal(await page.evaluate(find), null, 'not before it is offered');
  await page.locator('.ytp-skip-ad-button').waitFor();
  const button = await page.evaluate(find) as {x: number, y: number, dpr: number};
  assert.deepEqual(button, {x: 100, y: 80, dpr: 1});
});
