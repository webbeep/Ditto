// Preview build: the agent page's browser bindings, implemented with
// extension APIs instead of Mojo. Same classes and methods as the bindings
// generated from //ditto/browser/ui/webui/ditto_agent.mojom, so app.ts and
// the agent runtime are shared unchanged with the full build.
//
//   runtime HTTP   -> fetch to the loopback runtime started by the native host
//   CDP            -> chrome.debugger, limited to the same allow-list as
//                     cdp_relay.cc
//   search         -> chrome.search (the user's default search engine)
//   memory         -> chrome.system.memory, polled

export enum Target {
  kRuntime = 0,
  kStrandsSidecar = 1,
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface TabTarget {
  ok: boolean;
  url: string;
  title: string;
}

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

// Search URLs handed to the agent; resolved by chrome.search.
const SEARCH_SCHEME = 'ditto-search:';

let runtime: {port: number, key: string}|null = null;
let strandsEndpoint = 'http://127.0.0.1:8737';
let attachedTab: number|null = null;
let router: PageCallbackRouter|null = null;

class Listeners<F extends (...args: any[]) => void> {
  private readonly listeners: F[] = [];

  addListener(listener: F): number {
    this.listeners.push(listener);
    return this.listeners.length;
  }

  dispatch(...args: Parameters<F>): void {
    this.listeners.forEach(listener => listener(...args));
  }
}

const endpoint = {
  bindNewPipeAndPassReceiver: () => ({}),
  bindNewPipeAndPassRemote: () => ({}),
};

export class PageCallbackRouter {
  $ = endpoint;
  onStreamChunk = new Listeners<(streamId: number, chunk: string) => void>();
  onMemoryPressure = new Listeners<(critical: boolean) => void>();
  onTabDetached = new Listeners<() => void>();

  constructor() {
    router = this;
    // Lets the service worker know the panel is open (idle shutdown).
    chrome.runtime.connect({name: 'panel'});
    chrome.debugger.onDetach.addListener(source => {
      if (source.tabId === attachedTab) {
        attachedTab = null;
        this.onTabDetached.dispatch();
      }
    });
    let level = 0;
    setInterval(async () => {
      const {capacity, availableCapacity} = await chrome.system.memory.getInfo();
      const free = availableCapacity / capacity;
      const now = free < 0.06 ? 2 : free < 0.12 ? 1 : 0;
      if (now > level) {
        this.onMemoryPressure.dispatch(now === 2);
      }
      level = now;
    }, 10000);
  }
}

function baseUrl(target: Target): string|null {
  if (target === Target.kStrandsSidecar) {
    return strandsEndpoint;
  }
  return runtime ? `http://127.0.0.1:${runtime.port}` : null;
}

function headers(target: Target): Record<string, string> {
  const result: Record<string, string> = {'content-type': 'application/json'};
  if (target === Target.kRuntime && runtime) {
    result['authorization'] = `Bearer ${runtime.key}`;
  }
  return result;
}

function isWebUrl(url: string|undefined): boolean {
  return !!url && /^https?:\/\//.test(url);
}

export class PageHandlerRemote {
  $ = endpoint;

  async startRuntime(_presetIni: string, memoryMarginMb: number): Promise<{ok: boolean}> {
    // The preset ships in the app bundle (generated from the same catalog).
    const reply = await chrome.runtime.sendMessage(
        {type: 'runtime-start', marginMb: memoryMarginMb});
    runtime = reply?.ok ? {port: reply.port, key: reply.key} : null;
    return {ok: !!runtime};
  }

  stopRuntime(): void {
    runtime = null;
    chrome.runtime.sendMessage({type: 'runtime-stop'});
  }

  setStrandsEndpoint(url: string): void {
    // Only loopback: page text must not leave the machine.
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
      strandsEndpoint = url.replace(/\/$/, '');
    }
  }

  async getSystemMemory(): Promise<{totalMb: bigint, availableMb: bigint}> {
    const {capacity, availableCapacity} = await chrome.system.memory.getInfo();
    return {
      totalMb: BigInt(Math.round(capacity / 2 ** 20)),
      availableMb: BigInt(Math.round(availableCapacity / 2 ** 20)),
    };
  }

  async getSearchUrl(): Promise<{urlTemplate: string}> {
    return {urlTemplate: `${SEARCH_SCHEME}%s`};
  }

  showAgentPanel(): void {
    // Called from a key press on the home page, which counts as the user
    // gesture sidePanel.open() needs.
    chrome.windows.getCurrent().then(w => chrome.sidePanel.open({windowId: w.id!}));
  }

  async fetch(target: Target, method: string, path: string, body: string):
      Promise<{response: HttpResponse}> {
    const base = baseUrl(target);
    if (!base || !path.startsWith('/')) {
      return {response: {status: 0, body: 'runtime not running'}};
    }
    try {
      const init: RequestInit = {method, headers: headers(target)};
      if (body) {
        init.body = body;
      }
      const response = await fetch(base + path, init);
      return {response: {status: response.status, body: await response.text()}};
    } catch (error) {
      return {response: {status: 0, body: (error as Error).message}};
    }
  }

  async fetchStream(target: Target, path: string, body: string, streamId: number):
      Promise<{response: HttpResponse}> {
    const base = baseUrl(target);
    if (!base) {
      return {response: {status: 0, body: 'runtime not running'}};
    }
    const response = await fetch(base + path, {method: 'POST', headers: headers(target), body});
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) {
          break;
        }
        router?.onStreamChunk.dispatch(streamId, decoder.decode(value, {stream: true}));
      }
    }
    return {response: {status: response.status, body: ''}};
  }

  // The tab the user is looking at. Pages the debugger cannot drive (the
  // new tab page, settings) are replaced by, or joined by, a blank tab.
  async attachToActiveTab(): Promise<{target: TabTarget}> {
    await this.detachFromTab();
    let [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    if (tab?.id !== undefined && !isWebUrl(tab.url) && tab.url !== 'about:blank') {
      tab = /^chrome:\/\/(newtab|new-tab-page)/.test(tab.url ?? '') ?
          await chrome.tabs.update(tab.id, {url: 'about:blank'}) :
          await chrome.tabs.create({url: 'about:blank', active: true});
    }
    if (tab?.id === undefined) {
      tab = await chrome.tabs.create({url: 'about:blank', active: true});
    }
    try {
      await chrome.debugger.attach({tabId: tab.id!}, '1.3');
    } catch {
      return {target: {ok: false, url: '', title: ''}};
    }
    attachedTab = tab.id!;
    return {target: {ok: true, url: tab.url ?? '', title: tab.title ?? ''}};
  }

  async detachFromTab(): Promise<void> {
    if (attachedTab !== null) {
      const tabId = attachedTab;
      attachedTab = null;
      await chrome.debugger.detach({tabId}).catch(() => {});
    }
  }

  async sendCdp(method: string, paramsJson: string): Promise<{ok: boolean, resultJson: string}> {
    const fail = (message: string) => ({ok: false, resultJson: JSON.stringify({message})});
    if (attachedTab === null) {
      return fail('not attached');
    }
    if (!ALLOWED_CDP.has(method)) {
      return fail('method not allowed');
    }
    const params = paramsJson ? JSON.parse(paramsJson) : {};
    if (method === 'Page.navigate') {
      const url = String(params.url ?? '');
      if (url.startsWith(SEARCH_SCHEME)) {
        await chrome.search.query(
            {text: decodeURIComponent(url.slice(SEARCH_SCHEME.length)), tabId: attachedTab});
        return {ok: true, resultJson: '{}'};
      }
      if (!isWebUrl(url)) {
        return fail('only http(s) URLs');
      }
    }
    try {
      const result = await chrome.debugger.sendCommand({tabId: attachedTab}, method, params);
      return {ok: true, resultJson: JSON.stringify(result ?? {})};
    } catch (error) {
      return fail((error as Error).message);
    }
  }
}

export class PageHandlerFactory {
  static getRemote() {
    return {createPageHandler(_page: unknown, _handler: unknown) {}};
  }
}
