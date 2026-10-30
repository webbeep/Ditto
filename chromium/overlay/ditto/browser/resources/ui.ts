// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// DOM helpers shared by the agent panel and the home page.

import {icon} from './icons.js';
import type {IconName} from './icons.js';

type Child = Node|string|null|undefined|false;

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K, props: Partial<Record<string, string|boolean|((e: Event) => void)>> = {},
    ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (typeof value === 'function') {
      el.addEventListener(key.replace(/^on/, ''), value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child) {
      el.append(child);
    }
  }
  return el;
}

// A square icon button; `label` is its accessible name and tooltip.
export function iconButton(name: IconName, label: string, onClick: (e: Event) => void,
                           cls = 'ghost'): HTMLButtonElement {
  const button = h('button', {class: `icon-button ${cls}`, 'aria-label': label,
                              title: label, type: 'button', onclick: onClick});
  button.append(icon(name));
  return button;
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) {
    return 'now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const hours = Math.round(m / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const d = Math.round(hours / 24);
  return d < 7 ? `${d}d` : new Date(at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function formatMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function autoGrow(textarea: HTMLTextAreaElement, max = 160): void {
  const fit = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  };
  textarea.addEventListener('input', fit);
  fit();
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? {...fallback, ...JSON.parse(raw)} : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Lasts for this session only.
  }
}


// Chat storage and hand-offs over the browser bindings. In the full build
// the browser keeps them; in the preview and the dev harness, localStorage
// (both pages share an origin there).
export const CHATS_KEY = 'ditto.chats';
export const HANDOFF_KEY = 'ditto.handoff';
