import assert from 'node:assert/strict';
import {test} from 'node:test';

import {blendWithWords, isUnusable, pageView, stripReasoning} from '../src/agent/agent.js';
import {isTransient, withRetry} from '../src/agent/retry.js';
import {ChatStore, MemoryStorage, chatTitle, contextFor} from '../src/chat/chat.js';
import {HttpError} from '../src/http.js';
import {buildCandidates, normalizeUrl, topPassages} from '../src/agent/candidates.js';
import type {PageSnapshot} from '../src/browser/snapshot.js';
import {parseJsonReply} from '../src/llm/llm_client.js';
import {SseParser} from '../src/http.js';
import {CATALOG, findModel, recommendForMemory, routerPresetIni} from '../src/models/catalog.js';
import {defaultSettings} from '../src/models/settings.js';
import {aboutOpenPage, commits, keywords, splitText} from '../src/agent/agent.js';
import {MemoryStore} from '../src/memory/memory.js';
import {isAdUrl, isHijacked} from '../src/browser/ads.js';

test('catalog ids are unique and roles are covered', () => {
  const ids = CATALOG.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(CATALOG.some(m => m.role === 'llm' && m.family === 'LFM3'));
  assert.ok(CATALOG.some(m => m.role === 'llm' && m.family === 'Qwen3.5'));
  assert.ok(CATALOG.some(m => m.role === 'decider' && m.family === 'd1'));
  assert.ok(CATALOG.some(m => m.role === 'decider' && m.runtime === 'strands'));
});

test('small Macs get the small starter models and a safe budget', () => {
  const eight = recommendForMemory(8 * 1024);
  assert.equal(eight.llm, 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M');
  assert.equal(eight.decider, 'LiquidAI/d1-omni-600M-GGUF:Q8_0');
  // 8 GB: leave 5 GB to macOS and the browser.
  assert.equal(eight.modelBudgetMB, 3 * 1024);
  const llm = findModel(eight.llm)!;
  const decider = findModel(eight.decider)!;
  assert.ok(llm.ramMB + decider.ramMB <= eight.modelBudgetMB);

  const sixteen = recommendForMemory(16 * 1024);
  assert.equal(sixteen.llm, 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M');
  assert.equal(sixteen.decider, 'LiquidAI/d1-2B-GGUF:Q4_K_M');
  assert.equal(sixteen.modelBudgetMB, 8 * 1024);
  assert.ok(findModel(sixteen.llm)!.ramMB + findModel(sixteen.decider)!.ramMB <=
            sixteen.modelBudgetMB);
});

test('default settings use hybrid mode', () => {
  const settings = defaultSettings(16 * 1024);
  assert.equal(settings.mode, 'hybrid');
  assert.ok(settings.escalateBelow < settings.doneAbove);
});

test('router preset holds only shared settings', () => {
  // Per-model sections break not-yet-downloaded models in llama.cpp's router.
  const ini = routerPresetIni();
  assert.equal(ini.match(/^\[/gm)?.length, 1);
  assert.match(ini, /^\[\*\]\nctx-size = 16384\nbatch-size = 4096\nubatch-size = 4096$/m);
  assert.doesNotMatch(ini, /dedup-cache-models/);
});

test('SSE parser handles events split across chunks', () => {
  const events: string[] = [];
  const parser = new SseParser(data => events.push(data));
  parser.push('data: {"a"');
  parser.push(':1}\n\ndata: [DO');
  parser.push('NE]\n\n');
  parser.flush();
  assert.deepEqual(events, ['{"a":1}', '[DONE]']);
});

test('JSON replies are recovered from surrounding prose', () => {
  assert.deepEqual(parseJsonReply('```json\n{"done": true}\n```'), {done: true});
  assert.throws(() => parseJsonReply('no json here'));
});

function snapshot(elements: PageSnapshot['elements'], extra: Partial<PageSnapshot> = {}):
    PageSnapshot {
  return {
    url: 'https://shop.test/',
    status: 200,
    title: 'Shop',
    headings: [],
    elements,
    text: '',
    scrollY: 0,
    scrollHeight: 800,
    viewportHeight: 800,
    ...extra,
  };
}

test('candidates rank goal matches first and skip visited pages', () => {
  const page = snapshot([
    {id: 1, kind: 'link', label: 'About', href: 'https://shop.test/about', inViewport: true},
    {id: 2, kind: 'link', label: 'Pricing plans', href: 'https://shop.test/pricing',
     inViewport: true},
    {id: 3, kind: 'link', label: 'Blog', href: 'https://shop.test/blog', inViewport: true},
    {id: 4, kind: 'textbox', label: 'Search', inViewport: true},
  ]);
  const candidates = buildCandidates(page, {
    goal: 'what are the prices',
    visited: new Set(['https://shop.test/blog']),
    canGoBack: false,
  });
  assert.equal(candidates[0]!.key, 'e2');
  assert.ok(!candidates.some(c => c.key === 'e3'), 'visited link offered again');
  assert.ok(!candidates.some(c => c.key === 'e4'), 'textbox offered with nothing to type');
  assert.ok(!candidates.some(c => c.key === 'scroll_down'), 'page fits the viewport');

  const withQuery = buildCandidates(snapshot(page.elements, {scrollHeight: 3000}), {
    goal: 'prices', visited: new Set(), typeText: 'prices', canGoBack: true,
  });
  const search = withQuery.find(c => c.key === 'e4')!;
  assert.deepEqual(search.action, {kind: 'type', id: 4, text: 'prices', submit: true});
  assert.ok(withQuery.some(c => c.key === 'scroll_down'));
  assert.ok(withQuery.some(c => c.key === 'go_back'));
});

test('top passages keep the goal-relevant text in page order', () => {
  const text = 'Intro text about the company. '.repeat(20) +
      'The Widget Pro costs $49. ' + 'Shipping is free. '.repeat(30);
  const passages = topPassages(text, 'widget pro price costs', 1, 200);
  assert.equal(passages.length, 1);
  assert.match(passages[0]!, /Widget Pro costs \$49/);
  assert.equal(normalizeUrl('https://a.test/x#y'), 'https://a.test/x');
  assert.equal(normalizeUrl('https://a.test/shop/index.html'), 'https://a.test/shop/');
});

test('error pages are unusable; small real pages are not', () => {
  const page = (extra: Partial<PageSnapshot>) => snapshot([], {status: 200, ...extra});
  assert.ok(isUnusable(page({status: 404, title: 'Not found', text: 'x'.repeat(500)})));
  assert.ok(isUnusable(page({url: 'chrome-error://chromewebdata/'})));
  assert.ok(isUnusable(page({title: '', text: 'not found'})));
  // A tiny product page with no links (seen with the real-model run).
  assert.ok(!isUnusable(page({title: 'Widget Mini', text: 'The Widget Mini weighs 80 g. Price: $19.'})));
});

test('retries only transient errors, with backoff', async () => {
  assert.ok(isTransient(new HttpError(503, {}, 'x')));
  assert.ok(isTransient(new HttpError(0, '', 'x')));
  assert.ok(isTransient(new TypeError('fetch failed')));
  assert.ok(!isTransient(new HttpError(400, {}, 'x')));
  assert.ok(!isTransient(new Error('bad input')));
  let calls = 0;
  const retried: number[] = [];
  const value = await withRetry(async () => {
    if (++calls < 3) {
      throw new HttpError(503, {}, 'x');
    }
    return 'ok';
  }, {baseDelayMs: 1, onRetry: attempt => retried.push(attempt)});
  assert.equal(value, 'ok');
  assert.deepEqual(retried, [1, 2]);
  await assert.rejects(withRetry(async () => { throw new HttpError(400, {}, 'bad'); },
                                 {baseDelayMs: 1}), /HTTP 400/);
});

test('chats keep history, titles and survive a reload', () => {
  const storage = new MemoryStorage();
  const store = new ChatStore(storage);
  const chat = store.create(1000);
  const turn = (question: string, answer: string, at: number) => ({
    question, answer, at, trace: [],
    sources: [{url: 'https://a.test/', title: 'A', passages: ['x'.repeat(5000)]}],
  });
  store.addTurn(chat.id, turn('What is the price of the Acme Widget Pro?', '$49 [1]', 2000));
  store.addTurn(chat.id, turn('And the Mini?', '$19 [1]', 3000));
  store.create(4000);  // empty chats are not saved

  const reloaded = new ChatStore(storage);
  assert.equal(reloaded.list().length, 1);
  const saved = reloaded.get(chat.id)!;
  assert.equal(saved.title, 'What is the price of the Acme Widget Pro?');
  assert.equal(saved.turns.length, 2);
  assert.equal(saved.turns[0]!.sources[0]!.passages[0]!.length, 600, 'passages are capped');
  assert.equal(chatTitle('x '.repeat(80)).length, 58);

  const context = contextFor(saved);
  assert.deepEqual(context.history.map(h => h.question),
                   ['What is the price of the Acme Widget Pro?', 'And the Mini?']);
  assert.equal(context.sources[0]!.url, 'https://a.test/');
  // A tight budget keeps the newest turns.
  assert.deepEqual(contextFor(saved, 20).history.map(h => h.answer), ['$19 [1]']);
  reloaded.remove(chat.id);
  assert.equal(new ChatStore(storage).list().length, 0);
});

test('models see addresses without query strings, and no leaked reasoning', () => {
  const page = snapshot([], {url: 'https://shop.test/search.html?q=What+is+the+price#top',
                             title: 'Search'});
  const view = pageView(page, 'price');
  assert.match(view, /^URL: https:\/\/shop\.test\/search\.html$/m);
  assert.doesNotMatch(view, /What\+is/);
  assert.equal(stripReasoning('I think the sources lack it.</think>The price is $49 [1]'),
               'The price is $49 [1]');
  assert.equal(stripReasoning('<think>hmm</think>  $49 [1]'), '$49 [1]');
  assert.equal(stripReasoning('Open 9\u202fam to 7\u00a0pm [1]'), 'Open 9 am to 7 pm [1]');
  assert.equal(stripReasoning('$49 [1]'), '$49 [1]');
  // Seen from LFM3 1.7B: a recap of the sources, then the answer.
  assert.equal(stripReasoning('[2] Search - Acme <http://x/search>\nSearch results Widget Pro\n\n' +
                              'The first source [1] states the price.\n\n' +
                              'Answer: The price of the Acme Widget Pro is $49. [1]'),
               'The price of the Acme Widget Pro is $49. [1]');
  assert.equal(stripReasoning('**Answer:** $49 [1]'), '**Answer:** $49 [1]', 'nothing before it');
});

test('requests about the open page are told from things to look up', () => {
  for (const task of ['tldr', 'TL;DR of this video', 'summarize', 'summarize this article',
                      'what is this about?', 'key points', 'explain this page']) {
    assert.ok(aboutOpenPage(task), task);
  }
  for (const task of ['What is the price of the Acme Widget Pro?',
                      'summarize the reviews of the best budget tents in 2026',
                      'tldr https://example.com/post']) {
    assert.ok(!aboutOpenPage(task), task);
  }
});

test('long text splits at sentence ends', () => {
  const text = Array.from({length: 50}, (_, i) => `Sentence number ${i}.`).join(' ');
  const parts = splitText(text, 200);
  assert.ok(parts.every(p => p.length <= 200));
  assert.ok(parts.every(p => p.endsWith('.')));
  assert.equal(parts.join(' '), text);
});

test('ad hosts, click trackers and hijacked links', () => {
  assert.ok(isAdUrl('https://ad.doubleclick.net/clk?id=1'));
  assert.ok(isAdUrl('https://www.google.com/aclk?sa=l&ai=x'));
  assert.ok(!isAdUrl('https://www.google.com/search?q=ads'));
  assert.ok(!isAdUrl('https://example.com/adventures'));
  // An internal link that lands on a site it never named.
  assert.ok(isHijacked('https://shop.com/a', 'https://shop.com/b', 'https://win-prize.xyz/'));
  // Redirectors name their target; subdomains are the same site.
  assert.ok(!isHijacked('https://www.google.com/search?q=x',
                        'https://www.google.com/url?q=https://example.com/', 'https://example.com/'));
  assert.ok(!isHijacked('https://shop.com/a', 'https://shop.com/b', 'https://www.shop.com/b'));
  assert.ok(!isHijacked('https://shop.com/a', 'https://other.com/', 'https://other.com/'));
});


test('memory: repeats refresh, relevance picks notes, sites are counted', () => {
  let saved = '';
  const memory = new MemoryStore('', json => { saved = json; });
  assert.ok(memory.add('User lives in Seattle.', 'learned', 1000));
  assert.equal(memory.add('User lives in Seattle', 'told', 2000), null, 'same note');
  assert.equal(memory.notes().length, 1);
  assert.equal(memory.notes()[0]!.source, 'told');
  memory.add('User prefers metric units.', 'learned', 3000);
  memory.add('User owns a Subaru Outback.', 'learned', 4000);
  const profile = memory.profileFor('best hikes near Seattle', 8, 5000);
  assert.ok(profile.notes.includes('User lives in Seattle'));
  // General preferences come along; unrelated facts do not.
  assert.ok(profile.notes.includes('User prefers metric units.'));
  assert.ok(!profile.notes.includes('User owns a Subaru Outback.'));
  memory.visited(['https://www.rei.com/a', 'https://rei.com/b', 'https://example.com/']);
  assert.deepEqual(memory.profileFor('x').sites, ['rei.com']);
  assert.equal(memory.forget('Subaru'), 1);
  const reloaded = new MemoryStore(saved, () => {});
  assert.equal(reloaded.notes().length, 2);
  memory.setLearning(false);
  assert.equal(new MemoryStore(saved, () => {}).learning, false);
});

test('actions that commit the user are recognized', () => {
  const click = (description: string) =>
      ({key: 'e1', description, action: {kind: 'click' as const, id: 1}, score: 0});
  for (const label of ['button "Place order"', 'button "Buy now"', 'button "Pay $49"',
                       'link "Checkout"', 'button "Confirm purchase"', 'button "Delete"']) {
    assert.ok(commits(click(label)), label);
  }
  for (const label of ['link "Widget Pro"', 'button "Add to cart"', 'link "Payment options"',
                       'button "Show more"']) {
    assert.ok(!commits(click(label)), label);
  }
  assert.deepEqual(keywords('Where can I buy the Acme Widget Pro?', 3), ['widget', 'acme', 'pro']);
});

test('a thin decider pick yields to the option whose words match the goal', () => {
  const option = (key: string, score: number) =>
      ({key, description: key, action: {kind: 'click' as const, id: 1}, score});
  const candidates = [option('about', 0.25), option('widgets', 3.25), option('journal', 0.25)];
  const thin = {choice: 'about', confidence: 0.3,
                probabilities: {about: 0.3, widgets: 0.25, journal: 0.2}};
  const words = blendWithWords(candidates, thin);
  assert.equal(words.next?.key, 'widgets');
  assert.equal(words.confidence, 0.25, 'the decider was not sure of it: unsure');
  // A sure decider keeps its pick, and agreement makes it surer.
  const sure = blendWithWords(candidates, {choice: 'about', confidence: 0.9,
                                           probabilities: {about: 0.9, widgets: 0.05}});
  assert.equal(sure.next?.key, 'about');
  const agreed = blendWithWords(candidates, {choice: 'widgets', confidence: 0.5,
                                             probabilities: {widgets: 0.5, about: 0.3}});
  assert.equal(agreed.next?.key, 'widgets');
  assert.ok(agreed.confidence > 0.5);
});
