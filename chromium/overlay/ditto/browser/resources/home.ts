// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The new tab page: one command bar. An address opens; anything else goes
// to the agent panel as a new chat. Recent chats sit underneath.

import {ChatStore} from './agent/chat/chat.js';
import {icon} from './icons.js';
import {BrowserProxy} from './mojo_transports.js';
import {h, OPEN_CHAT_KEY, PENDING_KEY, relativeTime, writeJson} from './ui.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const proxy = BrowserProxy.get();

// "example.com", "localhost:3000", "https://…": an address, not a question.
export function asAddress(text: string): string|null {
  const value = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }
  if (/\s/.test(value)) {
    return null;
  }
  // Local hosts and IP addresses are usually plain http.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) {
    return `https://${value}`;
  }
  return null;
}

function renderRecent() {
  const chats = new ChatStore(localStorage).list().slice(0, 5);
  $('recent').replaceChildren(...chats.map(chat =>
      h('li', {onclick: () => {
                 writeJson(OPEN_CHAT_KEY, {id: chat.id});
                 proxy.handler.showAgentPanel();
               }},
        icon('history', 14),
        h('span', {class: 'name'}, chat.title),
        h('span', {class: 'when'}, relativeTime(chat.updatedAt)))));
}

function init() {
  $('logo').replaceChildren(icon('logo', 36));
  $('command-icon').replaceChildren(icon('search', 18));
  const input = $<HTMLInputElement>('query');
  $<HTMLFormElement>('command').addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    const address = asAddress(text);
    if (address) {
      location.href = address;
      return;
    }
    writeJson(PENDING_KEY, {query: text, at: Date.now()});
    proxy.handler.showAgentPanel();
    input.value = '';
  });
  document.addEventListener('keydown', event => {
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && document.activeElement !== input)) {
      event.preventDefault();
      input.focus();
    }
  });
  window.addEventListener('storage', renderRecent);
  renderRecent();
}

init();
