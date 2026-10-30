// Development stand-in for the bindings mojom_ts generates from
// //ditto/browser/ui/webui/ditto_agent.mojom. Same classes and method
// shapes, but each call goes over HTTP to agent/dev/webui_harness.ts, which
// plays the browser-process page handler. Lets the real chrome://ditto-agent
// page run in any Chromium.

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
  onTabDetached = new Listeners<() => void>();

  constructor() {
    router = this;
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

  getSearchUrl(): Promise<{urlTemplate: string}> {
    return call('getSearchUrl');
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

  attachToActiveTab(): Promise<{target: TabTarget}> {
    return call('attachToActiveTab');
  }

  detachFromTab(): void {
    call('detachFromTab');
  }

  sendCdp(method: string, paramsJson: string): Promise<{ok: boolean, resultJson: string}> {
    return call('sendCdp', [method, paramsJson]);
  }
}

export class PageHandlerFactory {
  static getRemote() {
    return {createPageHandler(_page: unknown, _handler: unknown) {}};
  }
}
