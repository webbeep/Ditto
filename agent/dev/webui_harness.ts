// Serves Ditto's real agent pages (web/) outside the app. This server plays
// the app (app/Sources/Ditto/Agent): it forwards runtime HTTP with the API
// key, and relays page commands to an "active tab" with the same allow-list
// as PageControl.swift.

import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {CdpTransport} from '../src/browser/page_driver.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Keep in sync with PageControl.swift.
const ALLOWED_CDP = new Set([
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.captureScreenshot',
  'Page.navigate',
  'Runtime.evaluate',
]);

export interface HarnessCall {
  method: string;
  args: unknown[];
}

export interface WebUIHarness {
  url: string;
  calls: HarnessCall[];
  emit(method: 'onMemoryPressure'|'onTabDetached', ...args: unknown[]): void;
  close(): Promise<void>;
}

// Builds the pages exactly as shipped (web/build.mjs), with the harness
// bridge.
function buildPage(): string {
  const work = mkdtempSync(join(tmpdir(), 'ditto-webui-'));
  execFileSync(process.execPath, [join(ROOT, 'web/build.mjs'), 'harness', join(work, 'out')],
               {stdio: 'inherit'});
  return work;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

export async function startWebUIHarness(options: {
  runtimeUrl: string,
  apiKey: string,
  activeTab: CdpTransport,
  searchUrl?: string,
  totalMb?: number,
  // What ImportFromChrome reports.
  chrome?: {found: boolean, bookmarks: number, email: string},
  // What the home page shows, and search suggestions.
  home?: {topSites: unknown[], forYou: unknown[], trending: unknown[]},
  suggestions?: Record<string, string[]>,
  // The user's bookmarks and history, for SearchUserPages.
  userPages?: Array<{url: string, title: string, timeMs: number, bookmark: boolean}>,
}): Promise<WebUIHarness> {
  const work = buildPage();
  const out = join(work, 'out');
  const calls: HarnessCall[] = [];
  const listeners = new Set<ServerResponse>();
  let attached = false;

  const handlers: Record<string, (...args: any[]) => unknown> = {
    startRuntime: () => ({ok: true}),
    stopRuntime: () => undefined,
    setStrandsEndpoint: () => undefined,
    getSystemMemory: () => ({totalMb: options.totalMb ?? 16384, availableMb: 9000}),
    getSearchUrl: () => ({urlTemplate: options.searchUrl ?? ''}),
    showAgentPanel: () => undefined,
    saveMemory: () => undefined,
    getHome: () => options.home ?? {topSites: [], forYou: [], trending: []},
    getSuggestions: (query: string) => ({suggestions: options.suggestions?.[query] ?? []}),
    searchUserPages: (query: string) => ({pages: (options.userPages ?? []).filter(
        p => `${p.title} ${p.url}`.toLowerCase().includes(query.toLowerCase()))}),
    importFromChrome: () => options.chrome ?? {found: false, bookmarks: 0, email: ''},
    fetch: async (target: number, method: string, path: string, body: string) => {
      if (target !== 0) {
        return {response: {status: 0, body: 'no strands sidecar in the harness'}};
      }
      const init: RequestInit = {
        method,
        headers: {'authorization': `Bearer ${options.apiKey}`,
                  'content-type': 'application/json'},
      };
      if (body) {
        init.body = body;
      }
      const response = await fetch(options.runtimeUrl + path, init);
      return {response: {status: response.status, body: await response.text()}};
    },
    attachToActiveTab: () => {
      attached = true;
      return {target: {ok: true, url: '', title: ''}};
    },
    detachFromTab: () => {
      attached = false;
    },
    sendCdp: async (method: string, paramsJson: string) => {
      if (!attached) {
        return {ok: false, resultJson: '{"message":"not attached"}'};
      }
      if (!ALLOWED_CDP.has(method)) {
        return {ok: false, resultJson: '{"message":"method not allowed"}'};
      }
      const params = paramsJson ? JSON.parse(paramsJson) : {};
      if (method === 'Page.navigate' && !/^https?:\/\//.test(params.url ?? '')) {
        return {ok: false, resultJson: '{"message":"only http(s) URLs"}'};
      }
      try {
        return {ok: true, resultJson: JSON.stringify(await options.activeTab.send(method, params))};
      } catch (error) {
        return {ok: false, resultJson: JSON.stringify({message: (error as Error).message})};
      }
    },
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/__mojo/events') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'});
      res.write(':\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (path.startsWith('/__mojo/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const args = JSON.parse(Buffer.concat(chunks).toString() || '[]');
      const method = path.slice('/__mojo/'.length);
      calls.push({method, args});
      if (method === 'fetchStream') {
        const [, streamPath, body] = args;
        const upstream = await fetch(options.runtimeUrl + streamPath, {
          method: 'POST',
          headers: {'authorization': `Bearer ${options.apiKey}`,
                    'content-type': 'application/json'},
          body,
        });
        res.writeHead(200, {'content-type': 'text/plain', 'x-status': String(upstream.status)});
        for await (const chunk of upstream.body as any) {
          res.write(chunk);
        }
        res.end();
        return;
      }
      const handler = handlers[method];
      if (!handler) {
        res.writeHead(404).end();
        return;
      }
      const result = await handler(...args);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(result ?? null));
      return;
    }
    try {
      const file = join(out, path === '/' ? 'ditto_agent.html' : path);
      if (!file.startsWith(out)) {
        throw new Error('outside');
      }
      res.writeHead(200, {'content-type': TYPES[extname(file)] ?? 'application/octet-stream'});
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    calls,
    emit(method, ...args) {
      for (const listener of listeners) {
        listener.write(`data: ${JSON.stringify({method, args})}\n\n`);
      }
    },
    async close() {
      for (const listener of listeners) {
        listener.end();
      }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(work, {recursive: true, force: true});
    },
  };
}
