// The test harness's bridge (agent/dev/webui_harness.ts): same API as the
// app's (webkit.ts), but each call goes over HTTP to the harness, which
// plays the app. Lets the real agent pages run in any browser under test.

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

export interface Trend {
  title: string;
  traffic: string;
  picture: string;
  newsTitle: string;
  newsUrl: string;
  source: string;
  // For "for you": the interest it matched.
  reason: string;
}

export interface HomeFeed {
  topSites: Array<{host: string, url: string, title: string}>;
  forYou: Trend[];
  trending: Trend[];
}

export interface SavedPage {
  url: string;
  title: string;
  timeMs: number;
  bookmark: boolean;
}

const CHATS_KEY = 'ditto.chats';
const MEMORY_KEY = 'ditto.memory';
const WATCHES_KEY = 'ditto.harness.watches';
const HANDOFF_KEY = 'ditto.handoff';

async function call(method: string, args: unknown[] = []): Promise<any> {
  const response = await fetch(`/__mojo/${method}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(args),
  });
  return response.json();
}

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

let router: PageCallbackRouter|null = null;

export class PageCallbackRouter {
  $ = endpoint;
  onStreamChunk = new Listeners<(streamId: number, chunk: string) => void>();
  onMemoryPressure = new Listeners<(critical: boolean) => void>();
  // A Ditto tab was closed (its session: a chat id, or watch:<id>).
  onTabDetached = new Listeners<(session: string) => void>();
  onHandOff = new Listeners<() => void>();
  // Time to look at the pages Ditto watches (the app keeps the schedule).
  onCheckWatches = new Listeners<() => void>();
  // Another window saved chats or memory: read them again.
  onStoreChanged = new Listeners<(name: string) => void>();

  constructor() {
    router = this;
    window.addEventListener('storage', event => {
      if (event.key === HANDOFF_KEY && event.newValue) {
        this.onHandOff.dispatch();
      }
    });
    // Browser -> page calls.
    const events = new EventSource('/__mojo/events');
    events.onmessage = event => {
      const {method, args} = JSON.parse(event.data);
      (this as any)[method].dispatch(...args);
    };
  }
}

export class PageHandlerRemote {
  $ = endpoint;

  startRuntime(presetIni: string, memoryMarginMb: number): Promise<{ok: boolean}> {
    return call('startRuntime', [presetIni, memoryMarginMb]);
  }

  stopRuntime(): void {
    call('stopRuntime');
  }

  setStrandsEndpoint(url: string): void {
    call('setStrandsEndpoint', [url]);
  }

  async getSystemMemory(): Promise<{totalMb: bigint, availableMb: bigint}> {
    const {totalMb, availableMb} = await call('getSystemMemory');
    return {totalMb: BigInt(totalMb), availableMb: BigInt(availableMb)};
  }

  getDevice(): Promise<{totalMb: number, arch: string, chip: string, freeDiskMb: number}> {
    return call('getDevice');
  }

  getSearchUrl(): Promise<{urlTemplate: string}> {
    return call('getSearchUrl');
  }

  // The agent page and the home page share this origin here.
  showAgentPanel(query: string, chatId: string): void {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({query, chatId}));
    call('showAgentPanel', [query, chatId]);
  }

  async loadChats(): Promise<{json: string}> {
    return {json: localStorage.getItem(CHATS_KEY) ?? ''};
  }

  saveChats(json: string, _removedJson = '[]'): void {
    try {
      localStorage.setItem(CHATS_KEY, json);
    } catch {
      // Storage full: the chat lasts for this session.
    }
  }

  async loadMemory(): Promise<{json: string}> {
    return {json: localStorage.getItem(MEMORY_KEY) ?? ''};
  }

  saveMemory(json: string): void {
    localStorage.setItem(MEMORY_KEY, json);
    call('saveMemory', [json]);
  }

  searchUserPages(query: string, maxResults: number): Promise<{pages: SavedPage[]}> {
    return call('searchUserPages', [query, maxResults]);
  }

  getHome(): Promise<HomeFeed> {
    return call('getHome');
  }

  getSuggestions(query: string): Promise<{suggestions: string[]}> {
    return call('getSuggestions', [query]);
  }

  importFromChrome(): Promise<{found: boolean, bookmarks: number, email: string}> {
    return call('importFromChrome');
  }

  async takeHandOff(): Promise<{query: string, chatId: string}> {
    const raw = localStorage.getItem(HANDOFF_KEY);
    localStorage.removeItem(HANDOFF_KEY);
    const handOff = raw ? JSON.parse(raw) : {};
    return {query: handOff.query ?? '', chatId: handOff.chatId ?? ''};
  }


  fetch(target: Target, method: string, path: string, body: string):
      Promise<{response: HttpResponse}> {
    return call('fetch', [target, method, path, body]);
  }

  async fetchStream(target: Target, path: string, body: string, streamId: number):
      Promise<{response: HttpResponse}> {
    const response = await fetch('/__mojo/fetchStream', {
      method: 'POST',
      body: JSON.stringify([target, path, body]),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      router?.onStreamChunk.dispatch(streamId, decoder.decode(value, {stream: true}));
    }
    return {response: {status: Number(response.headers.get('x-status')), body: ''}};
  }

  attachToActiveTab(startUrl = '', session = '', label = ''): Promise<{target: TabTarget}> {
    return call('attachToActiveTab', [startUrl, session, label]);
  }

  focusSession(session: string): void {
    call('focusSession', [session]);
  }

  async loadWatches(): Promise<{json: string}> {
    return {json: localStorage.getItem(WATCHES_KEY) ?? ''};
  }

  saveWatches(json: string): void {
    localStorage.setItem(WATCHES_KEY, json);
    call('saveWatches', [json]);
  }

  notify(title: string, body: string, url: string): void {
    call('notify', [title, body, url]);
  }

  detachFromTab(session = ''): void {
    call('detachFromTab', [session]);
  }

  sendCdp(method: string, paramsJson: string, session = ''):
      Promise<{ok: boolean, resultJson: string}> {
    return call('sendCdp', [method, paramsJson, session]);
  }
}

export class PageHandlerFactory {
  static getRemote() {
    return {createPageHandler(_page: unknown, _handler: unknown) {}};
  }
}
