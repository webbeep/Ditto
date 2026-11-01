import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';

import {startMockRuntime, type MockRuntime} from '../dev/mock_runtime.js';
import {DeciderClient, noul} from '../src/decider/decider_client.js';
import {FetchTransport, HttpError} from '../src/http.js';
import {LlmClient} from '../src/llm/llm_client.js';
import {ModelManager} from '../src/models/model_manager.js';

const LLM = 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M';
const SMALL_LLM = 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M';
const DECIDER = 'LiquidAI/d1-2B-GGUF:Q4_K_M';

let runtime: MockRuntime;
let http: FetchTransport;

before(async () => {
  runtime = await startMockRuntime();
  http = new FetchTransport(runtime.url, runtime.apiKey);
});
after(() => runtime.close());

test('requests without the runtime API key are rejected', async () => {
  const anonymous = new ModelManager(new FetchTransport(runtime.url));
  await assert.rejects(anonymous.list(), (e: unknown) =>
      e instanceof HttpError && e.status === 401);
});

test('download, load, swap and delete through the router', async () => {
  const models = new ModelManager(http);
  assert.equal((await models.list()).find(s => s.id === LLM)?.state, 'not-downloaded');

  await models.download(LLM);
  const download = runtime.requests.at(-1)!;
  assert.deepEqual(download.body, {model: LLM, sidecars: ['mmproj']});

  await models.download(DECIDER);
  await models.download(SMALL_LLM);
  await models.ensureLoaded(DECIDER, 8192);
  await models.ensureLoaded(LLM, 8192, [DECIDER]);
  let states = Object.fromEntries((await models.list()).map(s => [s.id, s.state]));
  assert.equal(states[LLM], 'loaded');
  assert.equal(states[DECIDER], 'loaded');

  // Swapping responders inside a tight budget evicts the old responder, not
  // the decider that navigation depends on.
  await models.ensureLoaded(SMALL_LLM, 4000);
  states = Object.fromEntries((await models.list()).map(s => [s.id, s.state]));
  assert.equal(states[SMALL_LLM], 'loaded');
  assert.equal(states[LLM], 'unloaded');
  assert.equal(states[DECIDER], 'loaded');

  await models.remove(LLM);
  assert.equal((await models.list()).find(s => s.id === LLM)?.state, 'not-downloaded');
});

test('questions starting together share one load of a model', async () => {
  const models = new ModelManager(http);
  await models.download(SMALL_LLM);
  await models.relieve('critical');
  const before = runtime.requests.length;
  await Promise.all([1, 2, 3].map(() => models.ensureLoaded(SMALL_LLM, 1e6)));
  const loads = runtime.requests.slice(before)
      .filter(r => r.path === '/models/load' && r.body?.model === SMALL_LLM);
  assert.equal(loads.length, 1);
  // Once loaded, later calls load nothing.
  await models.ensureLoaded(SMALL_LLM, 1e6);
  assert.equal(runtime.requests.slice(before).filter(r => r.path === '/models/load').length, 1);
});

test('memory pressure drops the responder first, then everything', async () => {
  const models = new ModelManager(http);
  await models.download(LLM);
  await models.ensureLoaded(LLM, 1e6);
  await models.ensureLoaded(DECIDER, 1e6);
  const moderate = await models.relieve('moderate');
  assert.ok(moderate.includes(LLM));
  assert.ok(!moderate.includes(DECIDER));
  const critical = await models.relieve('critical');
  assert.deepEqual(critical, [DECIDER]);
});

test('strands deciders are not routed through llama.cpp', async () => {
  const models = new ModelManager(http);
  await assert.rejects(models.download('StrandsAgents/strands-decider-2B-qwen3.5-v1-2610'),
                       /strands-decider sidecar/);
});

test('decider and LLM speak the llama-server wire format', async () => {
  const decider = new DeciderClient(http, DECIDER);
  const result = await decider.decide({
    state: 'Text: The Widget Pro price is $49.',
    questions: {done: {type: 'noul', instructions: 'Does this show: widget pro price'}},
  });
  assert.equal(runtime.requests.at(-1)!.body.model, DECIDER);
  assert.ok(noul(result, 'done') > 0.9);

  const llm = new LlmClient(http, LLM);
  let streamed = '';
  const text = await llm.chat([{role: 'user', content: 'Sources:\nx\n\nRequest: hi'}],
                              {onToken: t => { streamed += t; }});
  assert.equal(text, streamed);
  const body = runtime.requests.at(-1)!.body;
  assert.equal(body.stream, true);
  // Qwen3.5 runs with thinking off: the agent needs short, direct replies.
  assert.deepEqual(body.chat_template_kwargs, {enable_thinking: false});

  // Structured replies use the shape llama-server enforces.
  await llm.json([{role: 'user', content: 'Request: x'}],
                 {type: 'object', properties: {goal: {type: 'string'}}});
  const format = runtime.requests.at(-1)!.body.response_format;
  assert.equal(format.type, 'json_schema');
  assert.deepEqual(format.json_schema.schema.properties.goal, {type: 'string'});
});

test('the warmer keeps both models loaded while the user is active', async () => {
  const {Warmer} = await import('../src/models/warmer.js');
  const llm = new LlmClient(http, LLM);
  const decider = new DeciderClient(http, DECIDER);
  const before = runtime.requests.length;
  const warmer = new Warmer({llm, decider}, {intervalMs: 50, activeMs: 120});
  warmer.touch();
  await new Promise(resolve => setTimeout(resolve, 400));
  const pings = runtime.requests.slice(before);
  assert.ok(pings.some(r => r.path === '/v1/chat/completions' && r.body.max_tokens === 1));
  assert.ok(pings.some(r => r.path === '/v1/systemone'));
  const warmed = warmer.warmed;
  assert.ok(warmed >= 2 && warmed <= 5, `pings: ${warmed}`);
  // Idle past activeMs: it stopped on its own.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(warmer.warmed, warmed);
  warmer.stop();
});
