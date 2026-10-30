// Development CdpTransport: a Playwright CDPSession on a Chromium page. The
// same PageDriver code runs in Ditto over the browser's own DevTools host.

import {createRequire} from 'node:module';

import type {CdpTransport} from '../src/browser/page_driver.js';

// Playwright is preinstalled globally on dev machines and CI images; resolve
// it through NODE_PATH instead of pinning a second copy in this package.
const require = createRequire(import.meta.url);

export interface DevBrowser {
  cdp: CdpTransport;
  page: any;
  close(): Promise<void>;
}

export async function launchDevBrowser(options: {headed?: boolean} = {}): Promise<DevBrowser> {
  const {chromium} = require('playwright');
  const browser = await chromium.launch({headless: !options.headed});
  const context = await browser.newContext({viewport: {width: 1280, height: 860}});
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  return {
    cdp: {send: (method, params) => session.send(method, params)},
    page,
    close: () => browser.close(),
  };
}
