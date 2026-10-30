// Transport to the local inference runtime (llama-server in router mode, or a
// strands-decider sidecar). Inside Ditto the WebUI never talks to localhost
// itself: requests go through the browser process over Mojo, which holds the
// runtime's API key. In dev and tests, FetchTransport talks HTTP directly.

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface HttpTransport {
  request(method: 'GET' | 'POST' | 'DELETE', path: string,
          body?: unknown, signal?: AbortSignal): Promise<HttpResponse>;
  // Server-sent events: calls onData with each `data:` payload, in order.
  stream(path: string, body: unknown, onData: (data: string) => void,
         signal?: AbortSignal): Promise<void>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, what: string) {
    super(`${what} failed with HTTP ${status}: ${describeBody(body)}`);
    this.status = status;
    this.body = body;
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as {error: unknown}).error;
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as {message: unknown}).message);
    }
    return JSON.stringify(error);
  }
  return typeof body === 'string' ? body.slice(0, 200) :
                                    JSON.stringify(body)?.slice(0, 200) ?? '';
}

export function ensureOk(response: HttpResponse, what: string): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(response.status, response.body, what);
  }
  return response.body;
}

export class FetchTransport implements HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string|undefined;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (this.apiKey) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async request(method: 'GET'|'POST'|'DELETE', path: string, body?: unknown,
                signal?: AbortSignal): Promise<HttpResponse> {
    const init: RequestInit = {method, headers: this.headers()};
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    if (signal) {
      init.signal = signal;
    }
    const response = await fetch(this.baseUrl + path, init);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; keep the text.
    }
    return {status: response.status, body: parsed};
  }

  async stream(path: string, body: unknown, onData: (data: string) => void,
               signal?: AbortSignal): Promise<void> {
    const init: RequestInit = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    };
    if (signal) {
      init.signal = signal;
    }
    const response = await fetch(this.baseUrl + path, init);
    if (!response.ok || !response.body) {
      throw new HttpError(response.status, await response.text(), path);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser(onData);
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      parser.push(decoder.decode(value, {stream: true}));
    }
    parser.push(decoder.decode());
    parser.flush();
  }
}

// Incremental parser for `text/event-stream`. Shared with the Mojo transport,
// which receives the raw byte stream in arbitrary chunks.
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private readonly onData: (data: string) => void;

  constructor(onData: (data: string) => void) {
    this.onData = onData;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
  }

  flush(): void {
    if (this.buffer) {
      this.line(this.buffer);
      this.buffer = '';
    }
    this.dispatch();
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  private dispatch(): void {
    if (this.data.length) {
      this.onData(this.data.join('\n'));
      this.data = [];
    }
  }
}
