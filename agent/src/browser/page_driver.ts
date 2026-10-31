// Drives one tab through the Chrome DevTools Protocol. Inside Ditto the CDP
// session is a browser-side DevToolsAgentHost relayed over Mojo
// (//ditto/browser/agent/cdp_relay.cc); in development it is a Playwright
// CDPSession. Input is dispatched as trusted events, like a user's.

import {collectStructure, highlightQuote} from './structure.js';
import type {PageStructure} from './structure.js';
import {AD_HOSTS, AD_PATH} from './ads.js';
import {collectMedia} from './media.js';
import {preparePage} from './prepare.js';
import type {MediaText} from './media.js';
import {runOverlay} from './overlay.js';
import type {OverlayCommand} from './overlay.js';
import {collectSnapshot} from './snapshot.js';
import type {PageSnapshot} from './snapshot.js';

// The parts of CDP replies the driver reads.
export interface CdpReply {
  data?: string;
  result?: {value?: unknown};
  exceptionDetails?: {text: string, exception?: {description?: string}};
}

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<CdpReply>;
}

export type PageAction =
    {kind: 'navigate', url: string}|
    {kind: 'click', id: number}|
    {kind: 'type', id: number, text: string, submit: boolean}|
    {kind: 'select', id: number, option: string}|
    {kind: 'scroll', direction: 'down'|'up'}|
    {kind: 'back'};

export interface DriverOptions {
  maxElements?: number;
  maxText?: number;
  settleTimeoutMs?: number;
  // Show the agent's cursor, target ring and status on the page.
  visual?: boolean;
}

// Long enough to see the cursor land on its target, short enough not to
// slow the agent down (the CSS transition is the same length).
const POINT_MS = 170;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A page has settled once it has loaded and kept its address this long
// (checked this often): every step waits for it, so it is kept short.
const SETTLED_MS = 150;
const SETTLE_POLL_MS = 60;

export class PageDriver {
  private readonly cdp: CdpTransport;
  private readonly maxElements: number;
  private readonly maxText: number;
  private readonly settleTimeoutMs: number;
  private readonly visual: boolean;
  // Things the driver did on its own to stay safe (e.g. stepping around a
  // hidden overlay), for the agent to report.
  private notes: string[] = [];

  constructor(cdp: CdpTransport, options: DriverOptions = {}) {
    this.cdp = cdp;
    this.maxElements = options.maxElements ?? 150;
    this.maxText = options.maxText ?? 12000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 10000;
    this.visual = options.visual ?? true;
  }

  // Shows (or updates) the "agent is in control" overlay. Never fails: a
  // page in the middle of navigating simply misses one update.
  async status(text: string): Promise<void> {
    await this.overlay({op: 'status', text});
  }

  // What the driver did on its own since the last call.
  takeNotes(): string[] {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  async release(): Promise<void> {
    await this.overlay({op: 'clear'});
  }

  private async overlay(command: OverlayCommand): Promise<{x: number, y: number}|null> {
    if (!this.visual) {
      return null;
    }
    try {
      return await this.evaluate(
          `(${runOverlay.toString()})(${JSON.stringify(command)})`);
    } catch {
      return null;
    }
  }

  // Retried while a navigation is replacing the document (the evaluation
  // fails or sees an empty one). Each new page is prepared first: media
  // muted, cookie banners dismissed.
  async snapshot(): Promise<PageSnapshot> {
    for (let attempt = 1;; ++attempt) {
      try {
        const done = await this.evaluate<string[]>(`(${preparePage.toString()})()`);
        if (done?.some(d => d.startsWith('dismissed'))) {
          this.notes.push(...done.filter(d => d.startsWith('dismissed'))
                              .map(d => d[0]!.toUpperCase() + d.slice(1)));
          await this.waitForSettled(250);
        }
        return await this.evaluate<PageSnapshot>(
            `(${collectSnapshot.toString()})(${this.maxElements}, ${this.maxText}, ` +
            `${JSON.stringify(AD_HOSTS)}, ${JSON.stringify(AD_PATH)})`);
      } catch (error) {
        if (attempt >= 3) {
          throw error;
        }
        await this.waitForSettled(100);
      }
    }
  }

  // What the page states in structured form (JSON-LD, tables, lists), for
  // answer views; null when it cannot be read.
  async structure(): Promise<PageStructure|null> {
    try {
      return await this.evaluate<PageStructure>(`(${collectStructure.toString()})()`);
    } catch {
      return null;
    }
  }

  // Marks the sentence an answer came from and scrolls to it; where it is
  // in the viewport (CSS pixels), or null when it is not on the page.
  async highlight(quote: string):
      Promise<{x: number, y: number, width: number, height: number, viewWidth: number}|null> {
    try {
      return await this.evaluate(`(${highlightQuote.toString()})(${JSON.stringify(quote)})`);
    } catch {
      return null;
    }
  }

  // The transcript (or description) of the page's video, if it has one.
  async readMedia(maxText = 120000): Promise<MediaText|null> {
    try {
      return await this.evaluate<MediaText|null>(
          `(${collectMedia.toString()})(${maxText})`);
    } catch {
      return null;
    }
  }

  async screenshot(): Promise<string> {
    const {data} = await this.cdp.send(
        'Page.captureScreenshot', {format: 'jpeg', quality: 60});
    return `data:image/jpeg;base64,${data}`;
  }

  async perform(action: PageAction): Promise<void> {
    switch (action.kind) {
      case 'navigate':
        await this.cdp.send('Page.navigate', {url: action.url});
        break;
      case 'click':
        await this.click(action.id);
        break;
      case 'type':
        await this.type(action.id, action.text, action.submit);
        break;
      case 'select':
        await this.select(action.id, action.option);
        break;
      case 'scroll':
        await this.evaluate(
            `scrollBy(0, ${action.direction === 'down' ? '' : '-'}innerHeight * 0.85)`);
        break;
      case 'back':
        try {
          await this.evaluate('history.back()');
        } catch (error) {
          // The page going away mid-call is the back navigation working.
          if (!/navigated|closed|context|destroyed/i.test(String(error))) {
            throw error;
          }
        }
        break;
    }
    await this.waitForSettled(action.kind === 'scroll' ? 0 : 100);
  }

  private async click(id: number): Promise<void> {
    // Let the user see where the agent is about to click.
    if (await this.overlay({op: 'point', id})) {
      await sleep(POINT_MS);
    }
    const point = await this.centerOf(id);
    if (point.covered) {
      // Something is laid over the element (often an invisible link to an
      // ad that catches clicks): deliver the click to the element itself.
      await this.evaluate(`document.querySelector('[data-ditto-id="${id}"]').click()`);
      this.notes.push(`Stepped around an overlay covering ${point.label || 'the target'}`);
      return;
    }
    const base = {x: point.x, y: point.y, button: 'left', clickCount: 1};
    await this.cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved'});
    await this.cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await this.cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased'});
  }

  private async type(id: number, text: string, submit: boolean): Promise<void> {
    await this.click(id);
    // Clear what is there, so a retried step does not append twice.
    await this.evaluate(`(() => {
      const el = document.querySelector('[data-ditto-id="${id}"]');
      el.focus();
      if ('value' in el) { el.value = ''; }
      else if (el.isContentEditable) { el.textContent = ''; }
    })()`);
    await this.cdp.send('Input.insertText', {text});
    if (submit) {
      const enter = {key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
                     nativeVirtualKeyCode: 13};
      await this.cdp.send('Input.dispatchKeyEvent',
                          {...enter, type: 'keyDown', text: '\r'});
      await this.cdp.send('Input.dispatchKeyEvent', {...enter, type: 'keyUp'});
    }
  }

  // Dropdowns are set directly: their native menus are outside the page.
  private async select(id: number, option: string): Promise<void> {
    if (await this.overlay({op: 'point', id})) {
      await sleep(POINT_MS);
    }
    const ok = await this.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-ditto-id="${id}"]');
      if (!el || !el.options) { return false; }
      const want = ${JSON.stringify(option)}.trim().toLowerCase();
      const match = Array.from(el.options).find(o => o.text.trim().toLowerCase() === want) ||
          Array.from(el.options).find(o => o.text.trim().toLowerCase().includes(want));
      if (!match) { return false; }
      el.focus();
      el.value = match.value;
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return true;
    })()`);
    if (!ok) {
      throw new Error(`No option “${option}”`);
    }
  }

  private async centerOf(id: number):
      Promise<{x: number, y: number, covered: boolean, label: string}> {
    const point = await this.evaluate<
        {x: number, y: number, covered: boolean, label: string}|null>(`(() => {
      const el = document.querySelector('[data-ditto-id="${id}"]');
      if (!el) { return null; }
      el.scrollIntoView({block: 'center', inline: 'center'});
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // What a real click there would reach: the element, or a layer above.
      const hit = document.elementFromPoint(x, y);
      const covered = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
      const label = (el.getAttribute('aria-label') || el.innerText || '')
          .replace(/\\s+/g, ' ').trim().slice(0, 60);
      return {x, y, covered, label};
    })()`);
    if (!point) {
      throw new Error(`Element ${id} is no longer on the page`);
    }
    return point;
  }

  // Waits for the document to finish loading and stay put for a moment.
  // Evaluation fails while a navigation swaps the execution context; that
  // just means "not settled yet".
  async waitForSettled(initialDelayMs = 150): Promise<void> {
    await sleep(initialDelayMs);
    const deadline = Date.now() + this.settleTimeoutMs;
    let lastUrl = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate<{ready: string, url: string}>(
            '({ready: document.readyState, url: location.href})');
        if (state.ready === 'complete' && state.url === lastUrl) {
          if (Date.now() - stableSince >= SETTLED_MS) {
            return;
          }
        } else {
          lastUrl = state.url;
          stableSince = Date.now();
        }
      } catch {
        stableSince = Date.now();
      }
      await sleep(SETTLE_POLL_MS);
    }
  }

  private async evaluate<T = unknown>(expression: string): Promise<T> {
    const reply = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description ??
                      reply.exceptionDetails.text);
    }
    return reply.result?.value as T;
  }
}
