// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The agent runtime (./agent/, copied from //agent/src at build time) is
// transport-agnostic. In Ditto, HTTP to the model runtime and page control
// of the tab both go through the app (./bridge.js), which holds the
// runtime's key and checks every page command.

import type {CdpReply, CdpTransport} from './agent/browser/page_driver.js';
import {SseParser} from './agent/http.js';
import type {HttpResponse, HttpTransport} from './agent/http.js';
import {PageCallbackRouter, PageHandlerFactory, PageHandlerRemote} from './bridge.js';
import type {Target} from './bridge.js';

export class BrowserProxy {
  readonly handler: PageHandlerRemote;
  readonly callbacks: PageCallbackRouter;

  private constructor() {
    this.handler = new PageHandlerRemote();
    this.callbacks = new PageCallbackRouter();
    PageHandlerFactory.getRemote().createPageHandler(
        this.callbacks.$.bindNewPipeAndPassRemote(),
        this.handler.$.bindNewPipeAndPassReceiver());
  }

  private static instance: BrowserProxy|null = null;

  static get(): BrowserProxy {
    return BrowserProxy.instance ??= new BrowserProxy();
  }
}

function parse(body: string): unknown {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return body;
  }
}

export class BridgeHttpTransport implements HttpTransport {
  private readonly proxy: BrowserProxy;
  private readonly target: Target;
  private nextStreamId = 1;
  private readonly streams = new Map<number, SseParser>();

  constructor(proxy: BrowserProxy, target: Target) {
    this.proxy = proxy;
    this.target = target;
    proxy.callbacks.onStreamChunk.addListener((id: number, chunk: string) => {
      this.streams.get(id)?.push(chunk);
    });
  }

  async request(method: 'GET'|'POST'|'DELETE', path: string,
                body?: unknown): Promise<HttpResponse> {
    const {response} = await this.proxy.handler.fetch(
        this.target, method, path, body === undefined ? '' : JSON.stringify(body));
    return {status: response.status, body: parse(response.body)};
  }

  async stream(path: string, body: unknown,
               onData: (data: string) => void): Promise<void> {
    const id = this.nextStreamId++;
    const parser = new SseParser(onData);
    this.streams.set(id, parser);
    try {
      const {response} = await this.proxy.handler.fetchStream(
          this.target, path, JSON.stringify(body), id);
      parser.flush();
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${path} failed with HTTP ${response.status} ${response.body}`);
      }
    } finally {
      this.streams.delete(id);
    }
  }
}

export class BridgeCdpTransport implements CdpTransport {
  private readonly proxy: BrowserProxy;

  constructor(proxy: BrowserProxy) {
    this.proxy = proxy;
  }

  async send(method: string, params: Record<string, unknown> = {}):
      Promise<CdpReply> {
    const {ok, resultJson} = await this.proxy.handler.sendCdp(
        method, JSON.stringify(params));
    const result = parse(resultJson) as CdpReply & {message?: string};
    if (!ok) {
      throw new Error(`${method}: ${result?.message ?? resultJson}`);
    }
    return result;
  }
}
