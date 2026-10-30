// Keeps the chat's models loaded while the user is active, so the next
// question does not wait for a model to load (seconds) or to wake from
// the runtime's idle sleep. Stops after `activeMs` without activity, so an
// idle browser gives the memory back.

import type {DeciderClient} from '../decider/decider_client.js';
import type {LlmClient} from '../llm/llm_client.js';

export interface WarmerOptions {
  // Below the runtime's --sleep-idle-seconds (300).
  intervalMs?: number;
  activeMs?: number;
}

export class Warmer {
  private readonly llm: LlmClient|undefined;
  private readonly decider: DeciderClient|undefined;
  private readonly intervalMs: number;
  private readonly activeMs: number;
  private timer: ReturnType<typeof setInterval>|undefined;
  private lastActive = 0;
  warmed = 0;

  constructor(models: {llm?: LlmClient|undefined, decider?: DeciderClient|undefined},
              options: WarmerOptions = {}) {
    this.llm = models.llm;
    this.decider = models.decider;
    this.intervalMs = options.intervalMs ?? 4 * 60 * 1000;
    this.activeMs = options.activeMs ?? 10 * 60 * 1000;
  }

  // The user did something (focused the composer, sent a message).
  touch(): void {
    this.lastActive = Date.now();
    if (!this.timer) {
      void this.ping();
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.lastActive > this.activeMs) {
      this.stop();
      return;
    }
    await this.ping();
  }

  private async ping(): Promise<void> {
    await Promise.allSettled([
      this.llm?.warm(),
      this.decider?.decide({
        state: 'ready',
        questions: {ready: {type: 'noul', instructions: 'Is this text?'}},
      }),
    ]);
    ++this.warmed;
  }
}
