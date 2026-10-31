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
  onTabDetached = new Listeners<() => void>();
  onHandOff = new Listeners<() => void>();

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

  getSearchUrl(): Promise<{urlTemplate: string}> {
    return call('getSearchUrl');
  }

  loadChats(): Promise<{json: string}> {
    return call('loadChats');
  }

  saveChats(json: string): void {
    send('saveChats', json);
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

  attachToActiveTab(): Promise<{target: TabTarget}> {
    return call('attachToActiveTab');
  }

  detachFromTab(): void {
    send('detachFromTab');
  }

  sendCdp(method: string, paramsJson: string): Promise<{ok: boolean, resultJson: string}> {
    return call('sendCdp', method, paramsJson);
  }
}

export class PageHandlerFactory {
  static getRemote() {
    return {createPageHandler(_page: unknown, _handler: unknown) {}};
  }
}
