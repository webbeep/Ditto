// The scripts the Ditto app injects for everyday browsing (app/Resources,
// Shield.swift), run as shipped on fixture pages.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';

const RESOURCES = new URL('../../../app/Resources/', import.meta.url);

const script = (file: string) => readFileSync(fileURLToPath(new URL(file, RESOURCES)), 'utf8');

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
  await page.evaluate(script('shield.js'));
  // Twice is harmless.
  await page.evaluate(script('shield.js'));
  assert.equal(await page.locator('ins.adsbygoogle').isVisible(), false);
  assert.equal(await page.locator('[data-ad-slot]').isVisible(), false);
  // A real mouse click on the link lands on the trap first.
  const box = await page.locator('#real').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(/widget-pro\.html$/);
});

test('the shield leaves an ad-block wall by the site\'s own way out, once it comes up', async () => {
  const page = browser.page;
  await page.goto(site.url + 'site/scores.html');
  // As the app does: at the start, before the wall.
  await page.evaluate(script('shield.js'));
  await page.waitForFunction(() => document.body.dataset['wall'] === 'left', null,
                             {timeout: 5000});
  assert.equal(await page.locator('#wall').count(), 0);
});

test('a wall with no way out is left alone', async () => {
  const page = browser.page;
  await page.goto(site.url + 'site/about.html');
  await page.evaluate(() => {
    const wall = document.createElement('div');
    wall.id = 'nowayout';
    wall.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999';
    wall.innerHTML = '<h2>Please disable your ad blocker</h2><button>Allow ads</button>';
    document.body.append(wall);
  });
  await page.evaluate(script('shield.js'));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#nowayout').count(), 1);
});

test('without the shield the trap wins (the fixture is a real trap)', async () => {
  const page = browser.page;
  await page.goto(site.url + 'site/trap.html');
  const box = await page.locator('#real').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(/decoy\.html$/);
});

test('the YouTube skipper reports the Skip button only once it shows', async () => {
  const page = browser.page;
  // The script only runs on YouTube.
  await page.route('https://www.youtube.com/**', (route: any) => route.fulfill({
    body: readFileSync(fileURLToPath(new URL('../../test/fixtures/youtube/ad.html', import.meta.url)),
                       'utf8'),
    contentType: 'text/html',
  }));
  try {
    await page.goto('https://www.youtube.com/watch?v=ad');
    // Stand in for the app's message handler.
    await page.evaluate(() => {
      (window as any).reports = [];
      (window as any).webkit = {messageHandlers: {dittoSkip: {
        postMessage: (point: unknown) => (window as any).reports.push(point)}}};
    });
    await page.evaluate(script('youtube-skip.js'));
    assert.equal(await page.evaluate(() => (window as any).__dittoFindSkipButton()), null,
                 'not before it is offered');
    await page.waitForFunction(() => (window as any).reports.length > 0, null, {timeout: 5000});
    assert.deepEqual(await page.evaluate(() => (window as any).reports[0]), {x: 100, y: 80});
    // Meanwhile the ad is muted and covered; when it ends, sound and picture return.
    const state = () => page.evaluate(() => ({
      ...(window as any).__dittoAdState(),
      videoMuted: (document.querySelector('video') as HTMLVideoElement).muted,
    }));
    assert.deepEqual(await state(), {ad: true, muted: true, covered: true, videoMuted: true});
    await page.waitForFunction(() => !(window as any).__dittoAdState().ad, null, {timeout: 5000});
    await page.waitForFunction(() => !(window as any).__dittoAdState().covered, null, {timeout: 2000});
    assert.deepEqual(await state(), {ad: false, muted: false, covered: false, videoMuted: false});
  } finally {
    await page.unrouteAll();
  }
});
