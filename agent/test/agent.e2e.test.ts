// End to end: the real PageDriver in a real Chromium (Playwright), on a
// local fixture site, with the mock runtime standing in for the models.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {startMockRuntime, type MockRuntime} from '../dev/mock_runtime.js';
import {launchDevBrowser, type DevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';
import {BrowserAgent, type AgentEvent} from '../src/agent/agent.js';
import {PageDriver, type PageAction} from '../src/browser/page_driver.js';
import {DeciderClient} from '../src/decider/decider_client.js';
import {FetchTransport} from '../src/http.js';
import {LlmClient} from '../src/llm/llm_client.js';
import {defaultSettings, type AgentMode, type AgentSettings} from '../src/models/settings.js';

const TASK = 'What is the price of the Acme Widget Pro?';

let runtime: MockRuntime;
let site: {url: string, close(): Promise<void>};
let browser: DevBrowser;

before(async () => {
  runtime = await startMockRuntime();
  site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
  browser = await launchDevBrowser();
});
after(async () => {
  await browser.close();
  await site.close();
  await runtime.close();
});

async function runAgent(mode: AgentMode, task = TASK, start = site.url,
                        searchUrl = site.url + 'search.html?q=%s',
                        overrides: Partial<AgentSettings> = {}) {
  const http = new FetchTransport(runtime.url, runtime.apiKey);
  const settings = {...defaultSettings(16 * 1024), mode, ...overrides};
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: start});
  const agent = new BrowserAgent({
    driver,
    settings,
    searchUrl,
    ...(mode !== 'decider-only' ? {llm: new LlmClient(http, settings.llmId)} : {}),
    ...(mode !== 'llm-only' ? {decider: new DeciderClient(http, settings.deciderId)} : {}),
  });
  const events: AgentEvent[] = [];
  const result = await agent.run(task, e => events.push(e));
  return {result, events};
}

for (const mode of ['hybrid', 'decider-only', 'llm-only'] as const) {
  test(`${mode}: navigates two hops to the product page and answers`, async () => {
    const {result, events} = await runAgent(mode);
    assert.match(result.finalUrl, /widget-pro\.html$/);
    assert.match(result.answer, /\$49/);
    // Read from <main>, not the navigation bar.
    assert.doesNotMatch(result.answer, /Home|Widget series/);
    assert.match(result.sources[0]!, /widget-pro\.html$/);
    assert.equal(result.steps, 2);
    const steps = events.filter(e => e.type === 'step');
    assert.deepEqual(steps.map(s => s.type === 'step' && s.option.startsWith('e')),
                     [true, true]);
    if (mode === 'decider-only') {
      assert.ok(steps.every(s => s.type === 'step' && s.by === 'decider'));
    }
    if (mode === 'llm-only') {
      assert.ok(steps.every(s => s.type === 'step' && s.by === 'llm'));
    }
  });
}

test('hybrid hands steps below the confidence threshold to the LLM', async () => {
  const bySource = async (escalateBelow: number) => {
    const {result, events} = await runAgent('hybrid', TASK, site.url,
                                            site.url + 'search.html?q=%s', {escalateBelow});
    assert.match(result.answer, /\$49/);
    return events.flatMap(e => (e.type === 'step' ? [e.by] : []));
  };
  // Never sure enough: every step goes to the LLM.
  assert.deepEqual(await bySource(1.01), ['llm', 'llm']);
  // Always sure enough: the decider keeps every step.
  assert.deepEqual(await bySource(0), ['decider', 'decider']);
});

test('a dead start page falls back to a search and still answers', async () => {
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'no-such-page.html');
  assert.ok(events.some(e => e.type === 'warning' && /no-such-page/.test(e.message)));
  assert.match(result.finalUrl, /widget-pro\.html$/);
  assert.match(result.answer, /\$49/);
});

test('a dead-end site falls back to a search', async () => {
  // tents.html has no links at all: nothing to try on this site.
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'tents.html');
  assert.ok(events.some(e => e.type === 'step' && e.option === 'search'));
  assert.match(result.finalUrl, /widget-pro\.html$/);
  assert.match(result.answer, /\$49/);
});

test('without a decider, the best page answers even if the LLM never says done', async () => {
  const stubborn = await startMockRuntime({llmNeverDone: true});
  try {
    const http = new FetchTransport(stubborn.url, stubborn.apiKey);
    const settings = {...defaultSettings(16 * 1024), mode: 'llm-only' as const, maxSteps: 8};
    const driver = new PageDriver(browser.cdp);
    await driver.perform({kind: 'navigate', url: site.url});
    const agent = new BrowserAgent({
      driver, settings, llm: new LlmClient(http, settings.llmId),
      searchUrl: site.url + 'search.html?q=%s',
    });
    const result = await agent.run(TASK);
    assert.equal(result.steps, 8, 'it explored until the step limit');
    assert.match(result.sources[0]!, /widget-pro\.html$/);
    assert.match(result.answer, /\$49/);
  } finally {
    await stubborn.close();
  }
});

test('when nothing loads, the answer says so instead of guessing', async () => {
  const before = runtime.requests.length;
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'no-such-page.html',
                                          site.url + 'no-search-here?q=%s');
  assert.match(result.answer, /could not load a usable page .*no-search-here/);
  assert.deepEqual(result.sources, []);
  assert.ok(events.some(e => e.type === 'warning'));
  // Only the plan was requested from the LLM; no answer was generated.
  const chats = runtime.requests.slice(before).filter(r => r.path === '/v1/chat/completions');
  assert.equal(chats.length, 1);
  assert.ok(chats[0]!.body.response_format, 'the one LLM call is the plan');
});

test('a broken link is backed out of and the agent still finds the answer', async () => {
  const {result, events} = await runAgent('decider-only', TASK, site.url + 'parts.html');
  const warnings = events.filter(e => e.type === 'warning');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.type === 'warning' ? warnings[0]!.message : '', /missing-price-list/);
  assert.match(result.finalUrl, /widget-pro\.html$/);
  assert.match(result.answer, /\$49/);
});

test('page text falls back to the body when <main> is empty', async () => {
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: site.url + 'empty-main.html'});
  const page = await driver.snapshot();
  assert.match(page.text, /price is \$49/);
});

test('transient runtime errors are retried', async () => {
  runtime.failNext('/v1/systemone', 2);
  const {result, events} = await runAgent('decider-only');
  assert.match(result.answer, /\$49/);
  const retries = events.filter(e => e.type === 'retry');
  assert.equal(retries.length, 2);
  assert.ok(retries.every(e => e.type === 'retry' && e.what === 'decider' && /503/.test(e.error)));
});

test('a failed action is reported to the models and not offered again', async () => {
  class FlakyDriver extends PageDriver {
    failedOnce = false;
    override async perform(action: PageAction): Promise<void> {
      if (action.kind === 'click' && !this.failedOnce) {
        this.failedOnce = true;
        throw new Error('Element 3 is no longer on the page');
      }
      return super.perform(action);
    }
  }
  const driver = new FlakyDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: site.url});
  const http = new FetchTransport(runtime.url, runtime.apiKey);
  const settings = {...defaultSettings(16 * 1024), mode: 'decider-only' as const};
  const before = runtime.requests.length;
  const events: AgentEvent[] = [];
  const result = await new BrowserAgent({
    driver, settings, decider: new DeciderClient(http, settings.deciderId),
  }).run(TASK, e => events.push(e));
  assert.match(result.answer, /\$49/);
  const retry = events.find(e => e.type === 'retry');
  assert.ok(retry && retry.type === 'retry' && /no longer on the page/.test(retry.error));
  // The next decision saw the failure, and the failed link was not offered.
  const next = runtime.requests.slice(before).filter(r => r.path === '/v1/systemone')[1]!;
  assert.match(next.body.state, /Last action failed: link "Widget series".*no longer on the page/);
  assert.ok(!Object.values(next.body.questions.next.criteria).some(
      (d: any) => /Widget series/.test(d)));
});

test('a follow-up the last sources answer is answered without browsing', async () => {
  const first = await runAgent('hybrid');
  const http = new FetchTransport(runtime.url, runtime.apiKey);
  const settings = {...defaultSettings(16 * 1024), mode: 'hybrid' as const};
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: site.url + 'about.html'});
  const result = await new BrowserAgent({
    driver, settings, llm: new LlmClient(http, settings.llmId),
    decider: new DeciderClient(http, settings.deciderId),
  }).run('What is the Widget Pro price?', () => {}, {
    context: {history: [{question: TASK, answer: first.result.answer}],
              sources: first.result.evidence},
  });
  assert.equal(result.fromHistory, true);
  assert.equal(result.steps, 0);
  assert.match(result.answer, /\$49/);
  // The earlier turn reached the LLM as context.
  const chat = runtime.requests.filter(r => r.path === '/v1/chat/completions').at(-1)!;
  assert.match(JSON.stringify(chat.body.messages), /Earlier in this chat/);
});

test('the page shows the agent while it works and is left clean after', async () => {
  const seen: boolean[] = [];
  const checks: Promise<void>[] = [];
  const {result} = await (async () => {
    const http = new FetchTransport(runtime.url, runtime.apiKey);
    const settings = {...defaultSettings(16 * 1024), mode: 'decider-only' as const};
    const driver = new PageDriver(browser.cdp);
    await driver.perform({kind: 'navigate', url: site.url});
    const agent = new BrowserAgent({driver, settings,
                                    decider: new DeciderClient(http, settings.deciderId)});
    const result = await agent.run(TASK, e => {
      if (e.type === 'step') {
        checks.push(browser.page.evaluate(() => !!(window as any).__dittoOverlay)
                        .then((v: boolean) => { seen.push(v); }));
      }
    });
    return {result};
  })();
  await Promise.all(checks);
  assert.match(result.answer, /\$49/);
  assert.ok(seen.length >= 2 && seen.every(Boolean), `overlay during steps: ${seen}`);
  assert.equal(await browser.page.evaluate(() => document.querySelector('[data-ditto-overlay]')), null);
});

test('an answer that says "not found" sends the agent looking further', async () => {
  // The decoy page has every word of the question but not the price; the
  // first answer is judged as not answering, so the agent keeps going.
  const picky = await startMockRuntime({rejectAnswers: 1});
  try {
    const http = new FetchTransport(picky.url, picky.apiKey);
    const settings = {...defaultSettings(16 * 1024), mode: 'hybrid' as const};
    const driver = new PageDriver(browser.cdp);
    await driver.perform({kind: 'navigate', url: site.url + 'decoy.html'});
    const events: AgentEvent[] = [];
    const result = await new BrowserAgent({
      driver, settings, llm: new LlmClient(http, settings.llmId),
      decider: new DeciderClient(http, settings.deciderId),
    }).run(TASK, e => events.push(e));
    assert.ok(events.some(e => e.type === 'retry' && e.what === 'answer'));
    assert.ok(events.some(e => e.type === 'answer-reset'));
    assert.match(result.finalUrl, /widget-pro\.html$/);
    assert.match(result.answer, /\$49/);
    assert.ok(!result.sources.some(s => /decoy/.test(s)), 'the decoy is not cited');
  } finally {
    await picky.close();
  }
});

test('typing into a search box uses trusted input and submits', async () => {
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate', url: site.url});
  const page = await driver.snapshot();
  const box = page.elements.find(e => e.kind === 'textbox')!;
  assert.equal(box.label, 'Search the store');
  await driver.perform({kind: 'type', id: box.id, text: 'widget pro', submit: true});
  const results = await driver.snapshot();
  assert.match(results.url, /search\.html\?q=widget\+pro$/);
  assert.ok(results.elements.some(e => e.label === 'Widget Pro'));
});

test('the agent refuses to run with every model disabled', () => {
  const driver = new PageDriver(browser.cdp);
  assert.throws(() => new BrowserAgent({driver, settings: {...defaultSettings(8192), mode: 'off'}}),
                /all models are disabled/);
});

// Reading the open page or video instead of browsing.

const shields = (events: AgentEvent[]) =>
    events.flatMap(e => (e.type === 'shield' ? [e.message] : []));

test('"tldr of this video" reads its captions, not a search', async () => {
  const {result, events} = await runAgent('hybrid', 'tldr of this video', site.url + 'talk.html');
  assert.equal(result.steps, 0);
  assert.match(result.answer, /^Summary: .*waggle dance/);
  assert.deepEqual(result.sources, [site.url + 'talk.html']);
  assert.ok(events.some(e => e.type === 'step' && e.description === 'read the video transcript'));
  assert.ok(!events.some(e => e.type === 'step' && e.option === 'search'), 'no search');
});

test('a long transcript is read in parts, then summarized from the notes', async () => {
  const before = runtime.requests.length;
  const {result} = await runAgent('hybrid', 'summarize this video', site.url + 'long-talk.html');
  const notes = runtime.requests.slice(before).filter(
      r => String(r.body?.messages?.[0]?.content ?? '').startsWith('You read one part'));
  assert.ok(notes.length >= 2, `${notes.length} parts`);
  // The summary is written from the notes on every part.
  assert.match(result.answer, /^Summary: - Ptolemy/);
  assert.equal(result.answer.match(/ - /g)?.length, notes.length);
});

test('a YouTube video: the caption track, else the transcript panel', async () => {
  const watch = readFileSync(
      fileURLToPath(new URL('../../test/fixtures/youtube/watch.html', import.meta.url)), 'utf8');
  let captions = JSON.stringify({events: [
    {segs: [{utf8: 'Today we bake sourdough with a starter that is five days old, '}]},
    {segs: [{utf8: 'we mix flour, water and salt, fold the dough four times, '}]},
    {segs: [{utf8: 'and bake it at 250 degrees for forty minutes until it sounds hollow.'}]},
  ]});
  await browser.page.route('https://www.youtube.com/**', (route: any) => {
    const url = new URL(route.request().url());
    return url.pathname === '/api/timedtext' ?
        route.fulfill({body: captions, contentType: 'application/json'}) :
        route.fulfill({body: watch, contentType: 'text/html'});
  });
  try {
    const video = 'https://www.youtube.com/watch?v=sourdough';
    let {result} = await runAgent('hybrid', 'tl;dr', video);
    assert.match(result.answer, /five days old/);
    // Caption files that need the player's token come back empty.
    captions = '';
    ({result} = await runAgent('hybrid', 'what is this video about?', video));
    assert.match(result.answer, /Feed the starter/);
  } finally {
    await browser.page.unrouteAll();
  }
});

test('questions that name something else still browse', async () => {
  const {result} = await runAgent('hybrid', TASK, site.url + 'talk.html');
  assert.ok(result.steps > 0);
});

// Ads.

test('ads are never offered to the models', async () => {
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'ads.html');
  assert.match(result.finalUrl, /widget-pro\.html$/);
  assert.ok(!events.some(e => e.type === 'step' && /70% off/.test(e.description)));
  assert.ok(shields(events).some(m => /Ignored 1 ad/.test(m)));
});

test('a click under an invisible overlay reaches the link, not the overlay', async () => {
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'overlay.html');
  assert.match(result.finalUrl, /widget-pro\.html$/);
  assert.ok(shields(events).some(m => /Stepped around an overlay/.test(m)));
});

test('a link a script redirects elsewhere is undone and not tried again', async () => {
  const {result, events} = await runAgent('hybrid', TASK, site.url + 'hijack.html');
  assert.match(result.finalUrl, /widget-pro\.html\?from=list$/);
  assert.ok(shields(events).some(m => /Went back from an ad \(localhost/.test(m)));
});
