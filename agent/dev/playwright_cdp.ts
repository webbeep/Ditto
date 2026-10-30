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
  // Another tab in the same window, with its own CDP session.
  newTab(): Promise<{cdp: CdpTransport, page: any}>;
  close(): Promise<void>;
}

export async function launchDevBrowser(options: {headed?: boolean} = {}): Promise<DevBrowser> {
  const {chromium} = require('playwright');
  // Honour the environment's proxy (CI, corporate networks).
  const proxy = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'];
  const browser = await chromium.launch({
    headless: !options.headed,
    // Loopback (fixture sites, the model runtime) never goes through it.
    ...(proxy ? {proxy: {server: proxy, bypass: '127.0.0.1,localhost'}} : {}),
  });
  const context = await browser.newContext({viewport: {width: 1280, height: 860}});
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  return {
    cdp: {send: (method, params) => session.send(method, params)},
    page,
    newTab: async () => {
      const tab = await context.newPage();
      const tabSession = await context.newCDPSession(tab);
      return {
        cdp: {send: (method: string, params?: Record<string, unknown>) =>
                  tabSession.send(method, params)},
        page: tab,
      };
    },
    close: () => browser.close(),
  };
}
