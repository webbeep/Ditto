import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildCandidates, stripHash, topPassages} from '../src/agent/candidates.js';
import type {PageSnapshot} from '../src/browser/snapshot.js';
import {parseJsonReply} from '../src/llm/llm_client.js';
import {SseParser} from '../src/http.js';
import {CATALOG, findModel, recommendForMemory, routerPresetIni} from '../src/models/catalog.js';
import {defaultSettings} from '../src/models/settings.js';

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
  assert.equal(stripHash('https://a.test/x#y'), 'https://a.test/x');
});
