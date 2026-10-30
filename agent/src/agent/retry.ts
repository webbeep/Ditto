// Retrying model calls. A small local runtime hiccups: a model is still
// loading (503), an instance was just swapped out, a socket dropped. Those
// are retried with a short backoff; anything else is the caller's problem.

import {HttpError} from '../http.js';

export function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) {
    // 0: no response at all; 500 covers "model ... failed to load", which a
    // reload usually fixes.
    return error.status === 0 || error.status === 408 || error.status === 429 ||
        error.status >= 500;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }
  // fetch() rejects with TypeError on connection failures.
  return error instanceof TypeError;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetry<T>(fn: () => Promise<T>,
                                   options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 300;
  for (let attempt = 1;; ++attempt) {
    options.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      await new Promise(resolve => setTimeout(resolve, base * 3 ** (attempt - 1)));
    }
  }
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Keep feedback to the models short and free of stack traces.
  return message.split('\n')[0]!.slice(0, 160);
}
