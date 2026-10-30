// Drives a running Ditto (scripts/smoke-native.sh) over CDP.
import {createRequire} from 'node:module';

const require = createRequire(process.env.NODE_PATH + '/');
const {chromium} = require('playwright-core');
const browser = await chromium.connectOverCDP(process.argv[2]);
const context = browser.contexts()[0];
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));

async function check(name, run) {
  await run();
  if (errors.length) {
    throw new Error(`${name}: ${errors.join('\n')}`);
  }
  console.log(`ok   ${name}`);
}

await check('web page', async () => {
  await page.goto('https://example.com/');
  if (!/Example Domain/.test(await page.title())) {
    throw new Error(`unexpected title ${await page.title()}`);
  }
});
await check('new tab page is Ditto home', async () => {
  await page.goto('chrome://newtab/');
  // The icon is drawn by home.ts, so the bundle and its bindings loaded.
  await page.locator('#command-icon svg').waitFor({timeout: 15000});
});
await check('agent page', async () => {
  await page.goto('chrome://ditto-agent.top-chrome/');
  await page.locator('#logo svg').waitFor({timeout: 15000});
  await page.locator('#prompt').waitFor({timeout: 15000});
});
await check('version page names Ditto', async () => {
  await page.goto('chrome://version/');
  if (!/Ditto/.test(await page.locator('body').innerText())) {
    throw new Error('chrome://version does not mention Ditto');
  }
});
await browser.close();
