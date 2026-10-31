// The agent pages' link to the Ditto app (app/Sources/Ditto/Agent/
// AgentBridge.swift). Calls go to the app as WebKit script messages and
// resolve with its reply; the app calls back through window.__ditto.

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

interface AppChannel {
  postMessage(message: {method: string, args: unknown[]}): Promise<unknown>;
}

function channel(): AppChannel {
  const handlers = (window as unknown as
      {webkit?: {messageHandlers?: {ditto?: AppChannel}}}).webkit?.messageHandlers;
  if (!handlers?.ditto) {
    throw new Error('Not running inside Ditto.');
  }
  return handlers.ditto;
}

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return channel().postMessage({method, args}) as Promise<T>;
}

// Fire and forget; failures only matter to the app.
function send(method: string, ...args: unknown[]): void {
  call(method, ...args).catch(() => {});
}

class Listeners<F extends (...args: never[]) => void> {
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

// App -> page: window.__ditto.<event>.dispatch(...).
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
    (window as unknown as {__ditto: PageCallbackRouter}).__ditto = this;
  }
}

// Page -> app.
export class PageHandlerRemote {
  $ = endpoint;

  startRuntime(presetIni: string, memoryMarginMb: number): Promise<{ok: boolean}> {
    return call('startRuntime', presetIni, memoryMarginMb);
  }

  stopRuntime(): void {
    send('stopRuntime');
  }

  setStrandsEndpoint(url: string): void {
    send('setStrandsEndpoint', url);
  }

  getSystemMemory(): Promise<{totalMb: number, availableMb: number}> {
    return call('getSystemMemory');
  }

  // The Mac, for suggesting models: memory, chip, free disk.
  getDevice(): Promise<{totalMb: number, arch: string, chip: string, freeDiskMb: number}> {
    return call('getDevice');
  }

  getSearchUrl(): Promise<{urlTemplate: string}> {
    return call('getSearchUrl');
  }

  loadChats(): Promise<{json: string}> {
    return call('loadChats');
  }

  saveChats(json: string, removedJson = '[]'): void {
    send('saveChats', json, removedJson);
  }

  loadMemory(): Promise<{json: string}> {
    return call('loadMemory');
  }

  saveMemory(json: string): void {
    send('saveMemory', json);
  }

  searchUserPages(query: string, maxResults: number): Promise<{pages: SavedPage[]}> {
    return call('searchUserPages', query, maxResults);
  }

  getHome(): Promise<HomeFeed> {
    return call('getHome');
  }

  getSuggestions(query: string): Promise<{suggestions: string[]}> {
    return call('getSuggestions', query);
  }

  importFromChrome(): Promise<{found: boolean, bookmarks: number, email: string}> {
    return call('importFromChrome');
  }

  showAgentPanel(query: string, chatId: string): void {
    send('showAgentPanel', query, chatId);
  }

  takeHandOff(): Promise<{query: string, chatId: string}> {
    return call('takeHandOff');
  }

  fetch(target: Target, method: string, path: string, body: string):
      Promise<{response: HttpResponse}> {
    return call('fetch', target, method, path, body);
  }

  fetchStream(target: Target, path: string, body: string, streamId: number):
      Promise<{response: HttpResponse}> {
    return call('fetchStream', target, path, body, streamId);
  }

  // The session's Ditto tab (one per chat or watch, side by side), on the
  // user's page, or on `startUrl` when given; `label` names it in the
  // sidebar.
  attachToActiveTab(startUrl = '', session = '', label = ''): Promise<{target: TabTarget}> {
    return call('attachToActiveTab', startUrl, session, label);
  }

  // The session whose chat is in view: its tab is the one shown live.
  focusSession(session: string): void {
    send('focusSession', session);
  }

  loadWatches(): Promise<{json: string}> {
    return call('loadWatches');
  }

  saveWatches(json: string): void {
    send('saveWatches', json);
  }

  // A macOS notification; clicking it opens `url`.
  notify(title: string, body: string, url: string): void {
    send('notify', title, body, url);
  }

  detachFromTab(session = ''): void {
    send('detachFromTab', session);
  }

  sendCdp(method: string, paramsJson: string, session = ''):
      Promise<{ok: boolean, resultJson: string}> {
    return call('sendCdp', method, paramsJson, session);
  }
}

export class PageHandlerFactory {
  static getRemote() {
    return {createPageHandler(_page: unknown, _handler: unknown) {}};
  }
}
