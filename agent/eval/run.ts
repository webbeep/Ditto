// Runs the eval suite (eval/scenarios.ts) and reports how the agent did:
// pass or fail per task, steps, model calls and time, and the pass rate.
//
//   npm run eval                         # against the mock runtime
//   npm run eval -- --runtime http://127.0.0.1:8080 --api-key KEY \
//       --llm LiquidAI/LFM3-1.7B-GGUF:Q4_K_M --decider LiquidAI/d1-omni-600M-GGUF:Q4_K_M \
//       [--download] [--mode hybrid] [--min 0.8] [--report eval-report.md]

import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {downloadAll} from '../dev/download.js';
import {startMockRuntime} from '../dev/mock_runtime.js';
import {launchDevBrowser} from '../dev/playwright_cdp.js';
import {serveDirectory} from '../dev/static_server.js';
import {BrowserAgent} from '../src/agent/agent.js';
import type {AgentEvent} from '../src/agent/agent.js';
import {PageDriver} from '../src/browser/page_driver.js';
import {DeciderClient} from '../src/decider/decider_client.js';
import {FetchTransport} from '../src/http.js';
import type {HttpResponse, HttpTransport} from '../src/http.js';
import {LlmClient} from '../src/llm/llm_client.js';
import {ModelManager} from '../src/models/model_manager.js';
import {defaultSettings, usesDecider, usesLlm} from '../src/models/settings.js';
import type {AgentMode} from '../src/models/settings.js';
import {SCENARIOS} from './scenarios.js';
import type {Scenario} from './scenarios.js';

const {values} = parseArgs({options: {
  'runtime': {type: 'string'},
  'api-key': {type: 'string', default: ''},
  'llm': {type: 'string'},
  'decider': {type: 'string'},
  'mode': {type: 'string', default: 'hybrid'},
  'download': {type: 'boolean'},
  'only': {type: 'string'},
  'min': {type: 'string', default: '0'},
  'report': {type: 'string'},
}});

// Counts the model calls a task makes.
class CountingTransport implements HttpTransport {
  llm = 0;
  decider = 0;

  private readonly inner: HttpTransport;

  constructor(inner: HttpTransport) {
    this.inner = inner;
  }

  private count(path: string) {
    if (path.startsWith('/v1/chat')) { ++this.llm; }
    if (path.startsWith('/v1/systemone')) { ++this.decider; }
  }

  request(method: 'GET'|'POST'|'DELETE', path: string, body?: unknown): Promise<HttpResponse> {
    this.count(path);
    return this.inner.request(method, path, body);
  }

  stream(path: string, body: unknown, onData: (data: string) => void): Promise<void> {
    this.count(path);
    return this.inner.stream(path, body, onData);
  }
}

interface Outcome {
  scenario: Scenario;
  ok: boolean;
  why: string;
  answer: string;
  steps: number;
  llm: number;
  decider: number;
  seconds: number;
  // Where it went and why, for reading a failure.
  trace: string[];
}

// One line per page and per step: enough to see where a run went wrong.
function traceOf(events: AgentEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'plan':
        lines.push(`plan (${event.by}): ${event.plan.start} ` +
                   `${event.plan.url || event.plan.searchQuery || ''} | goal: ${event.plan.goal}`);
        break;
      case 'page':
        lines.push(`page ${event.url.replace(/^https?:\/\/[^/]+/, '')} ` +
                   `done ${event.done.toFixed(2)} relevant ${event.relevant.toFixed(2)}`);
        break;
      case 'step':
        lines.push(`  step ${event.index} ${event.by} ${event.confidence.toFixed(2)}: ` +
                   event.description);
        break;
      case 'warning':
      case 'shield':
        lines.push(`  ${event.type}: ${event.message}`);
        break;
      case 'retry':
        lines.push(`  retry ${event.what}: ${event.error}`);
        break;
    }
  }
  return lines;
}

const mock = values.runtime ? null : await startMockRuntime();
const runtimeUrl = values.runtime ?? mock!.url;
const apiKey = values.runtime ? values['api-key']! : mock!.apiKey;
const mode = values.mode as AgentMode;
const settings = {...defaultSettings(16 * 1024), mode};
settings.llmId = values.llm ?? settings.llmId;
settings.deciderId = values.decider ?? settings.deciderId;

const base = new FetchTransport(runtimeUrl, apiKey);
if (values.runtime) {
  const models = new ModelManager(base);
  const wanted = [usesLlm(mode) ? settings.llmId : '', usesDecider(mode) ? settings.deciderId : '']
                     .filter(Boolean);
  if (values.download) {
    await downloadAll(models, wanted);
  }
  for (const id of wanted) {
    await models.ensureLoaded(id, settings.modelBudgetMB, wanted);
  }
}

const site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
const browser = await launchDevBrowser();
const outcomes: Outcome[] = [];
const scenarios = SCENARIOS.filter(s => !values.only || s.id.includes(values.only));

for (const scenario of scenarios) {
  const http = new CountingTransport(base);
  const driver = new PageDriver(browser.cdp);
  await driver.perform({kind: 'navigate',
                        url: scenario.start === 'about:blank' ? 'about:blank' : site.url + scenario.start});
  const agent = new BrowserAgent({
    driver, settings,
    searchUrl: site.url + 'search.html?q=%s',
    ...(usesLlm(mode) ? {llm: new LlmClient(http, settings.llmId)} : {}),
    ...(usesDecider(mode) ? {decider: new DeciderClient(http, settings.deciderId)} : {}),
    ask: async () => scenario.approve ?? false,
  });
  const started = Date.now();
  const events: AgentEvent[] = [];
  let answer = '';
  let finalUrl = '';
  let sources: string[] = [];
  let steps = 0;
  let error = '';
  try {
    const result = await agent.run(scenario.task, e => events.push(e));
    ({answer, finalUrl, sources, steps} = result);
    finalUrl ||= browser.page.url();
  } catch (e) {
    error = String(e);
  }
  // Models write odd spaces ("9\u202fam"); grade the text as read.
  const plain = answer.replace(/\s+/g, ' ');
  const why = error ? `error: ${error}` :
      scenario.answer && !scenario.answer.test(plain) ? 'answer' :
      scenario.finalUrl && !scenario.finalUrl.test(finalUrl) ? `ended on ${finalUrl}` :
      scenario.cites && !sources.some(s => scenario.cites!.test(s)) ? 'citation' : '';
  outcomes.push({
    scenario, ok: !why, why, answer: plain.slice(0, 120), steps,
    llm: http.llm, decider: http.decider, seconds: (Date.now() - started) / 1000,
    trace: traceOf(events),
  });
  const last = outcomes.at(-1)!;
  console.log(`${last.ok ? 'pass' : 'FAIL'}  ${scenario.id.padEnd(16)} ${String(steps).padStart(2)} steps ` +
              `${String(last.llm).padStart(2)} llm ${String(last.decider).padStart(2)} decider ` +
              `${last.seconds.toFixed(1).padStart(5)}s  ${last.ok ? '' : `(${why}) `}${last.answer}`);
  if (!last.ok) {
    console.log(last.trace.map(line => `      ${line}`).join('\n'));
  }
}

await browser.close();
await site.close();
await mock?.close();

const passed = outcomes.filter(o => o.ok).length;
const rate = passed / Math.max(1, outcomes.length);
const total = (key: 'llm'|'decider'|'seconds') => outcomes.reduce((sum, o) => sum + o[key], 0);
const summary = `${passed}/${outcomes.length} passed (${Math.round(rate * 100)}%), ` +
    `${total('llm')} LLM and ${total('decider')} decider calls, ${total('seconds').toFixed(0)}s`;
console.log(`\n${summary}`);

if (values.report) {
  const runtime = values.runtime ? `${settings.llmId} + ${settings.deciderId}` : 'mock runtime';
  const rows = outcomes.map(o =>
      `| ${o.ok ? '✅' : '❌'} | ${o.scenario.id} | ${o.steps} | ${o.llm} | ${o.decider} | ` +
      `${o.seconds.toFixed(1)}s | ${o.ok ? '' : o.why} | ${o.answer.replace(/\|/g, '\\|')} |`);
  writeFileSync(values.report, [
    `## Agent eval: ${mode}, ${runtime}`, '', summary, '',
    '| | Task | Steps | LLM | Decider | Time | Failed on | Answer |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
    ...outcomes.filter(o => !o.ok).flatMap(o => [
      `<details><summary>${o.scenario.id}: ${o.scenario.task}</summary>`, '',
      '```', ...o.trace, '```', '', '</details>', '',
    ]),
  ].join('\n'));
}
process.exit(rate >= Number(values.min) ? 0 : 1);
