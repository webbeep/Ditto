// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The new tab page: one command bar. An address opens; anything else goes
// to the agent panel as a new chat. Recent chats sit underneath.

import {loadChatStore} from './chat_storage.js';
import {icon} from './icons.js';
import {BrowserProxy} from './transports.js';
import {h, readJson, relativeTime, writeJson} from './ui.js';

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

async function renderRecent() {
  const chats = (await loadChatStore(proxy)).list().slice(0, 5);
  $('recent').replaceChildren(...chats.map(chat =>
      h('li', {onclick: () => proxy.handler.showAgentPanel('', chat.id)},
        icon('history', 14),
        h('span', {class: 'name'}, chat.title),
        h('span', {class: 'when'}, relativeTime(chat.updatedAt)))));
}

// Moving from Chrome: one button until it has been used.
const MOVED_KEY = 'ditto.movedFromChrome';

function renderMove() {
  if (readJson(MOVED_KEY, {done: false}).done) {
    return;
  }
  const button = h('button', {class: 'chip', type: 'button'},
                   icon('download', 14), 'Import from Chrome');
  button.addEventListener('click', () => void moveFromChrome(button));
  $('move').replaceChildren(button);
}

async function moveFromChrome(button: HTMLButtonElement) {
  button.disabled = true;
  const {found, bookmarks, email} = await proxy.handler.importFromChrome();
  if (!found) {
    $('move').replaceChildren(h('span', {class: 'note'}, 'No Chrome profile found'));
    return;
  }
  writeJson(MOVED_KEY, {done: true});
  const done: Node[] = [h('span', {class: 'note'}, icon('check', 14),
                          `${bookmarks} bookmarks from Chrome`)];
  if (email) {
    // Signing in on Google's page also signs the browser in (no sync:
    // Google keeps that to Chrome).
    const signIn = new URL('https://accounts.google.com/ServiceLogin');
    signIn.searchParams.set('Email', email);
    signIn.searchParams.set('continue', 'https://www.google.com/');
    done.push(h('a', {class: 'chip', href: signIn.href},
                icon('user', 14), `Sign in as ${email}`));
  }
  $('move').replaceChildren(...done);
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
    proxy.handler.showAgentPanel(text, '');
    input.value = '';
  });
  document.addEventListener('keydown', event => {
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && document.activeElement !== input)) {
      event.preventDefault();
      input.focus();
    }
  });
  // Chats change in the panel; refresh when this tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void renderRecent();
    }
  });
  void renderRecent();
  renderMove();
}

init();
