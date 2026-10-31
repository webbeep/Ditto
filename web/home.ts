// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// The new tab page: one field for everything (an address opens, a question
// goes to Ditto, a suggestion searches), the user's top sites, what is
// trending (the part that matches what they read first), and recent chats.

import {loadChatStore} from './chat_storage.js';
import {icon} from './icons.js';
import {BrowserProxy} from './transports.js';
import type {HomeFeed, Trend} from './bridge.js';
import {h, hostOf, readJson, relativeTime, writeJson} from './ui.js';

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
  $('recent-section').hidden = !chats.length;
  $('recent').replaceChildren(...chats.map(chat =>
      h('li', {onclick: () => proxy.handler.showAgentPanel('', chat.id)},
        icon('history', 14),
        h('span', {class: 'name'}, chat.title),
        h('span', {class: 'when'}, relativeTime(chat.updatedAt)))));
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' :
      hour < 18 ? 'Good afternoon' : 'Good evening';
}

// The site's icon, or its first letter while (or if) there is none; a
// globe for addresses that are numbers.
function siteIcon(host: string, size: number): HTMLElement {
  const numeric = /^(localhost|[\d.:]+|\[[\da-f:]+\])$/i.test(host);
  const letter = numeric ? h('span', {class: 'letter'}, icon('globe', 18)) :
      h('span', {class: 'letter'}, host.slice(0, 1).toUpperCase());
  const img = h('img', {src: `https://${host}/favicon.ico`, alt: '', width: String(size),
                        height: String(size), loading: 'lazy'});
  img.addEventListener('load', () => letter.remove());
  img.addEventListener('error', () => img.remove());
  return h('span', {class: 'site-icon'}, letter, img);
}

function renderSites(feed: HomeFeed) {
  $('sites').replaceChildren(...feed.topSites.map(site =>
      h('a', {class: 'site', href: site.url, title: site.title || site.host},
        siteIcon(site.host, 22), h('span', {}, site.host))));
}

function trendCard(trend: Trend, forYou: boolean): HTMLElement {
  const ask = () => proxy.handler.showAgentPanel(`What's the latest on ${trend.title}?`, '');
  const card = h('article', {class: `card${forYou ? ' for-you' : ''}`, tabindex: '0'},
      h('div', {class: 'card-top'},
        h('span', {class: 'topic'}, trend.title),
        trend.traffic ? h('span', {class: 'traffic'}, trend.traffic) : null),
      trend.newsTitle ? h('p', {class: 'headline'}, trend.newsTitle) : null,
      h('div', {class: 'card-foot'},
        forYou && trend.reason ?
            h('span', {class: 'reason'}, icon('sparkle', 11), `You read about ${trend.reason}`) :
            h('span', {class: 'source'}, trend.source || hostOf(trend.newsUrl)),
        h('span', {class: 'actions'},
          trend.newsUrl ? h('a', {class: 'chip', href: trend.newsUrl,
                                  onclick: (e: Event) => e.stopPropagation()}, 'Read') : null,
          h('button', {class: 'chip accent', type: 'button'}, icon('sparkle', 11), 'Ask'))));
  card.addEventListener('click', ask);
  card.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Enter') {
      ask();
    }
  });
  return card;
}

async function renderFeed() {
  let feed: HomeFeed;
  try {
    feed = await proxy.handler.getHome();
  } catch {
    return;
  }
  renderSites(feed);
  $('for-you-section').hidden = !feed.forYou.length;
  $('for-you').replaceChildren(...feed.forYou.map(t => trendCard(t, true)));
  $('trending-section').hidden = !feed.trending.length;
  $('trending').replaceChildren(...feed.trending.map(t => trendCard(t, false)));
}

// ---- The field: suggestions under it, arrow keys to choose ----------------

interface Choice {
  icon: Parameters<typeof icon>[0];
  text: string;
  detail: string;
  run: () => void;
  accent?: boolean;
}

let choices: Choice[] = [];
let chosen = 0;

function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function choicesFor(text: string, suggestions: string[]): Choice[] {
  const value = text.trim();
  if (!value) {
    return [];
  }
  const address = asAddress(value);
  if (address) {
    return [{icon: 'globe', text: value, detail: 'Open', run: () => { location.href = address; }}];
  }
  return [
    {icon: 'sparkle', text: value, detail: 'Ask Ditto', accent: true,
     run: () => proxy.handler.showAgentPanel(value, '')},
    {icon: 'search', text: value, detail: 'Search Google',
     run: () => { location.href = searchUrl(value); }},
    ...suggestions.filter(s => s.toLowerCase() !== value.toLowerCase()).slice(0, 5)
        .map(s => ({icon: 'search' as const, text: s, detail: 'Search',
                    run: () => { location.href = searchUrl(s); }})),
  ];
}

function renderChoices() {
  const list = $('suggest');
  list.hidden = choices.length === 0;
  list.replaceChildren(...choices.map((choice, i) => {
    const row = h('li', {role: 'option', 'aria-selected': String(i === chosen),
                         class: choice.accent ? 'accent' : ''},
                  icon(choice.icon, 14),
                  h('span', {class: 'text'}, choice.text),
                  h('span', {class: 'detail'}, choice.detail));
    row.addEventListener('mousedown', event => {
      event.preventDefault();
      choice.run();
    });
    row.addEventListener('mouseenter', () => {
      chosen = i;
      renderChoices();
    });
    return row;
  }));
}

let typing = 0;
let warmedAt = 0;

// About to ask: Ditto loads its models while the question is typed (once a
// minute at most; asking for nothing costs nothing).
function warmUp() {
  if (Date.now() - warmedAt > 60_000) {
    warmedAt = Date.now();
    proxy.handler.warmUp();
  }
}

function onInput(input: HTMLInputElement) {
  const text = input.value;
  if (text.trim().length > 2 && !asAddress(text.trim())) {
    warmUp();
  }
  chosen = 0;
  choices = choicesFor(text, []);
  renderChoices();
  window.clearTimeout(typing);
  if (!text.trim() || asAddress(text.trim())) {
    return;
  }
  // A short pause, so not every keystroke goes out for suggestions.
  typing = window.setTimeout(async () => {
    const {suggestions} = await proxy.handler.getSuggestions(text).catch(() => ({suggestions: []}));
    if (input.value === text) {
      choices = choicesFor(text, suggestions);
      renderChoices();
    }
  }, 140);
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
  $('logo').replaceChildren(icon('logo', 40));
  $('greeting').textContent = greeting();
  $('command-icon').replaceChildren(icon('sparkle', 18));
  $('for-you-icon').replaceChildren(icon('sparkle', 13));
  $('trending-icon').replaceChildren(icon('trending', 13));
  $('recent-icon').replaceChildren(icon('history', 13));
  const input = $<HTMLInputElement>('query');
  input.addEventListener('input', () => onInput(input));
  input.addEventListener('keydown', event => {
    if (!choices.length) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      chosen = (chosen + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      renderChoices();
    } else if (event.key === 'Escape') {
      choices = [];
      renderChoices();
    }
  });
  input.addEventListener('blur', () => window.setTimeout(() => {
    choices = [];
    renderChoices();
  }, 100));
  $<HTMLFormElement>('command').addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    // The highlighted choice; by default an address opens and anything
    // else goes to Ditto.
    const choice = choices[chosen] ?? choicesFor(text, [])[0];
    choice?.run();
    if (choice && !asAddress(text) && choice.detail === 'Ask Ditto') {
      input.value = '';
      choices = [];
      renderChoices();
    }
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
  void renderFeed();
  renderMove();
}

init();
