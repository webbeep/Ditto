// OpenAI-compatible chat client for llama-server (router mode: `model`
// selects the instance; the router loads it on demand).

import {ensureOk} from '../http.js';
import type {HttpTransport} from '../http.js';
import {findModel} from '../models/catalog.js';

export interface ChatMessage {
  role: 'system'|'user'|'assistant';
  content: string|ChatContentPart[];
}

export type ChatContentPart =
    {type: 'text', text: string}|
    {type: 'image_url', image_url: {url: string}};

export interface ChatOptions {
  // JSON schema the reply must satisfy (grammar-constrained by llama.cpp).
  schema?: object;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
}

interface ChatCompletion {
  choices?: Array<{message?: {content?: string}}>;
}

interface ChatChunk {
  choices?: Array<{delta?: {content?: string}}>;
}

export class LlmClient {
  private readonly http: HttpTransport;
  readonly modelId: string;

  constructor(http: HttpTransport, modelId: string) {
    this.http = http;
    this.modelId = modelId;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      ...findModel(this.modelId)?.requestDefaults,
      model: this.modelId,
      messages,
      max_tokens: options.maxTokens ?? 1024,
      // Reuse the KV cache for the shared prefix (system prompt, goal):
      // consecutive steps differ only in the page text at the end.
      cache_prompt: true,
    };
    if (options.schema) {
      // OpenAI's shape, which llama-server reads; a top-level `schema` next
      // to `type: 'json_schema'` is silently ignored (any object allowed).
      body['response_format'] = {
        type: 'json_schema',
        json_schema: {name: 'reply', strict: true, schema: options.schema},
      };
    }
    if (options.onToken) {
      body['stream'] = true;
      let text = '';
      await this.http.stream('/v1/chat/completions', body, data => {
        if (data === '[DONE]') {
          return;
        }
        const piece = (JSON.parse(data) as ChatChunk).choices?.[0]?.delta?.content;
        if (piece) {
          text += piece;
          options.onToken!(piece);
        }
      }, options.signal);
      return text;
    }
    const reply = ensureOk(
        await this.http.request('POST', '/v1/chat/completions', body,
                                options.signal),
        `chat with ${this.modelId}`) as ChatCompletion;
    return reply.choices?.[0]?.message?.content ?? '';
  }

  // Loads the model (or wakes it) and primes its prompt cache with a
  // one-token reply, so the next real request starts generating at once.
  async warm(): Promise<void> {
    await this.chat([{role: 'system', content: 'You help a user browse the web.'},
                     {role: 'user', content: 'ready'}], {maxTokens: 1});
  }

  async json<T>(messages: ChatMessage[], schema: object,
                options: Omit<ChatOptions, 'schema'|'onToken'> = {}): Promise<T> {
    const text = await this.chat(messages, {...options, schema});
    return parseJsonReply<T>(text);
  }
}

// Small models sometimes wrap JSON in prose or fences even under a grammar
// (e.g. when the server falls back to unconstrained decoding).
export function parseJsonReply<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error(`Model reply is not JSON: ${trimmed.slice(0, 120)}`);
  }
}
