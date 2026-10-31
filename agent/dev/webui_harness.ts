// Serves the real chrome://ditto-agent page (chromium/overlay/.../resources)
// outside Chromium. This server plays the browser-process side
// (DittoAgentPageHandler + CdpRelay + InferenceSupervisor): it forwards
// runtime HTTP with the API key, and relays CDP to an "active tab" with the
// same method allow-list as cdp_relay.cc.

import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {CdpTransport} from '../src/browser/page_driver.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESOURCES = join(ROOT, 'chromium/overlay/ditto/browser/resources');

// Keep in sync with kAllowedMethods in cdp_relay.cc.
const ALLOWED_CDP = new Set([
  'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.captureScreenshot',
  'Page.getNavigationHistory',
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

// Compiles the WebUI exactly as shipped (app.ts, mojo_transports.ts and the
// agent runtime), against the harness bindings.
function buildPage(): string {
  const work = mkdtempSync(join(tmpdir(), 'ditto-webui-'));
  cpSync(RESOURCES, work, {recursive: true});
  cpSync(join(ROOT, 'tools/webui-harness/ditto_agent.mojom-webui.ts'),
         join(work, 'ditto_agent.mojom-webui.ts'));
  cpSync(join(ROOT, 'agent/src'), join(work, 'agent'), {recursive: true});
  writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], strict: true,
      skipLibCheck: true, outDir: 'out', rootDir: '.',
    },
    include: ['*.ts', 'agent/**/*.ts'],
  }));
  execFileSync(join(ROOT, 'agent/node_modules/.bin/tsc'), ['-p', work], {stdio: 'inherit'});
  for (const file of readdirSync(RESOURCES)) {
    if (/\.(html|css|svg)$/.test(file)) {
      cpSync(join(RESOURCES, file), join(work, 'out', file));
    }
  }
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
