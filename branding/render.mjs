// Renders icon.svg to the PNGs and .icns Chromium's mac build bundles.
//   node branding/render.mjs   (then commit the outputs)
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(fileURLToPath(new URL('../agent/package.json', import.meta.url)));
const {chromium} = require('playwright');
const here = fileURLToPath(new URL('.', import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1024, height: 1024}});
await page.setContent(`<body style="margin:0;background:transparent">${readFileSync(here + 'icon.svg', 'utf8')}</body>`);
await page.screenshot({path: here + 'icon-1024.png', omitBackground: true, clip: {x: 0, y: 0, width: 1024, height: 1024}});
await browser.close();
