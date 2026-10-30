// Type stub of the bindings mojom_ts generates for
// //ditto/browser/ui/webui/ditto_agent.mojom, so the WebUI can be typechecked
// outside a Chromium checkout. Keep in sync with the .mojom.

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

interface Endpoint {
  bindNewPipeAndPassReceiver(): unknown;
  bindNewPipeAndPassRemote(): unknown;
}

interface Listener<F> {
  addListener(listener: F): number;
}

export declare class PageHandlerRemote {
  $: Endpoint;
  startRuntime(presetIni: string, memoryMarginMb: number): Promise<{ok: boolean}>;
  stopRuntime(): void;
  setStrandsEndpoint(url: string): void;
  getSystemMemory(): Promise<{totalMb: bigint, availableMb: bigint}>;
  getSearchUrl(): Promise<{urlTemplate: string}>;
  fetch(target: Target, method: string, path: string, body: string):
      Promise<{response: HttpResponse}>;
  fetchStream(target: Target, path: string, body: string, streamId: number):
      Promise<{response: HttpResponse}>;
  attachToActiveTab(): Promise<{target: TabTarget}>;
  detachFromTab(): void;
  sendCdp(method: string, paramsJson: string): Promise<{ok: boolean, resultJson: string}>;
}

export declare class PageCallbackRouter {
  $: Endpoint;
  onStreamChunk: Listener<(streamId: number, chunk: string) => void>;
  onMemoryPressure: Listener<(critical: boolean) => void>;
  onTabDetached: Listener<() => void>;
}

export declare class PageHandlerFactory {
  static getRemote(): {createPageHandler(page: unknown, handler: unknown): void};
}
