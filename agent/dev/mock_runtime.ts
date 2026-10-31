// A stand-in for llama-server in router mode, for tests and for running the
// agent on machines without models. It speaks the same HTTP API Ditto uses
// (`/models*`, `/v1/chat/completions`, `/v1/systemone`) and answers with
// simple lexical heuristics, so behaviour is deterministic.

import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

import {tokens} from '../src/agent/candidates.js';
import {CATALOG} from '../src/models/catalog.js';

interface MockModel {
  id: string;
  status: string;
}

export interface MockRuntime {
  // Fail the next N requests to a path with HTTP 503 (a model still loading).
  failNext(path: string, times: number): void;
  url: string;
  apiKey: string;
  requests: Array<{method: string, path: string, body: any}>;
  models: Map<string, MockModel>;
  close(): Promise<void>;
}

function goalOf(instructions: string): string[] {
  const colon = instructions.indexOf(':');
  return tokens(colon >= 0 ? instructions.slice(colon + 1) : instructions);
}

// Like a model, the mock knows a few words mean the same thing.
const SAME = new Map([['cost', 'price'], ['open', 'hour'], ['heavy', 'kg'], ['weigh', 'kg']]);

function coverage(goal: string[], text: string): number {
  goal = goal.map(w => SAME.get(w) ?? w);
  if (!goal.length) {
    return 0;
  }
  const have = new Set(tokens(text));
  return goal.filter(t => have.has(t)).length / goal.length;
}

function pageText(state: unknown): string {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  const at = text.indexOf('Text:');
  return at >= 0 ? text.slice(at + 5) : text;
}

function scoreOptions(goal: string[], options: Record<string, string|null>) {
  const keys = Object.keys(options);
  const raw = keys.map(k => coverage(goal, `${k} ${options[k] ?? ''}`) * 6);
  const max = Math.max(...raw);
  const exp = raw.map(r => Math.exp(r - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, exp[i]! / sum]));
  const best = keys[raw.indexOf(max)]!;
  const top = probabilities[best]!;
  const n = keys.length;
  return {
    choice: best,
    probabilities,
    confidence: n > 1 ? Math.max(0, (top - 1 / n) / (1 - 1 / n)) : 1,
  };
}

function systemOne(body: any, rejecting: {left: number}) {
  const answers: Record<string, unknown> = {};
  const text = pageText(body.state);
  for (const [id, q] of Object.entries<any>(body.questions ?? {})) {
    const goal = goalOf(String(q.instructions));
    if (q.type === 'noul' && /^Does the answer give/.test(q.instructions) && rejecting.left > 0) {
      --rejecting.left;
      answers[id] = {type: 'noul', noul: 0.02};
    } else if (q.type === 'noul') {
      const c = coverage(goal, text);
      // "done" needs the whole goal on the page; "relevant" needs part of it.
      const p = /already show/.test(q.instructions) ? c ** 3 : c;
      answers[id] = {type: 'noul', noul: Number(p.toFixed(4))};
    } else if (q.type === 'choice') {
      answers[id] = {type: 'choice', ...scoreOptions(goal, q.criteria)};
    } else if (q.type === 'score') {
      const levels: string[] = q.criteria;
      answers[id] = {type: 'score', score: 0, confidence: 0,
                     probabilities: levels.map((_, i) => (i === 0 ? 1 : 0)),
                     legend: Object.fromEntries(levels.map((l, i) => [String(i), l]))};
    }
  }
  return {answers, usage: {input_tokens: Math.ceil(text.length / 4), output_tokens: 0}};
}

// The JSON schema a request constrains the reply to, read the way
// llama-server (b11960, server-common.cpp) reads it.
function requestSchema(body: any): any {
  const format = body.response_format;
  if (format?.type === 'json_schema') {
    return format.json_schema?.schema;
  }
  if (format?.type === 'json_object') {
    return format.schema;
  }
  return body.json_schema;
}

function chatReply(body: any, neverDone = false): string {
  const schema = requestSchema(body);
  const messages: Array<{content: string}> = body.messages ?? [];
  const user = String(messages.at(-1)?.content ?? '');
  if (schema?.properties?.goal) {
    const task = user.slice(user.indexOf('Request:') + 8).trim();
    if (!schema.properties.startPage) {
      return JSON.stringify({searchQuery: task, goal: task});
    }
    // Start on the user's page whose title covers the request best.
    const asked = tokens(task);
    const pages = user.slice(user.indexOf("The user's own pages:"), user.indexOf('Open page:'))
                      .split('\n').filter(l => /^\d+\. /.test(l));
    const scored = pages.map((line, i) => ({i: i + 1, c: coverage(asked, line)}))
                        .sort((a, b) => b.c - a.c)[0];
    return JSON.stringify({searchQuery: task, goal: task,
                           startPage: scored && scored.c >= 0.5 ? scored.i : 0});
  }
  if (schema?.properties?.quote) {
    // Reading the answer off a page: the line that covers the request and
    // states a value (a small model's "found").
    const request = tokens(user.slice(user.indexOf('Request:') + 8, user.indexOf('\n')));
    const lines = user.slice(user.indexOf('Page:')).split('\n').slice(1);
    const best = lines.map(l => ({l, c: coverage(request, l)}))
                      .filter(x => /\d/.test(x.l))
                      .sort((a, b) => b.c - a.c)[0];
    return best && best.c >= 0.5 ?
        JSON.stringify({found: true, answer: best.l.trim(), quote: best.l.trim()}) :
        JSON.stringify({found: false, answer: '', quote: ''});
  }
  if (schema?.properties?.option) {
    // A dropdown: the option sharing most words with the goal.
    const goal = tokens(user.slice(user.indexOf('Goal:') + 5, user.indexOf('\n')));
    const options: string[] = schema.properties.option.enum;
    // Like a model, it knows "tent" when it reads "Tents".
    const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, '') : w);
    const goalStems = goal.map(stem);
    const fit = (o: string) => tokens(o).map(stem).filter(w => goalStems.includes(w)).length;
    const best = [...options].sort((a, b) => fit(b) - fit(a))[0];
    return JSON.stringify({option: best});
  }
  if (schema?.properties?.notes) {
    // Notes: the request's sentences about the user.
    const task = user.slice(user.indexOf('Request:') + 8, user.indexOf('\nAnswer:'));
    const notes = task.split(/(?<=[.!?])\s+/)
                      .filter(s => /\b(I'm|I am|my|I prefer|I like|I live)\b/i.test(s))
                      .map(s => `User: ${s.trim()}`);
    return JSON.stringify({notes});
  }
  if (schema?.properties?.action) {
    const goal = tokens(user.slice(user.indexOf('Goal:') + 5, user.indexOf('\n')));
    const options: Record<string, string> = {};
    for (const line of user.slice(user.indexOf('Options:') + 8).trim().split('\n')) {
      const colon = line.indexOf(':');
      options[line.slice(0, colon)] = line.slice(colon + 1);
    }
    const {choice} = scoreOptions(goal, options);
    const page = user.slice(user.indexOf('Page:') + 5, user.indexOf('Options:'));
    return JSON.stringify({done: !neverDone && coverage(goal, pageText(page)) >= 0.99, action: choice});
  }
  const system = String(messages[0]?.content ?? '');
  // Notes on one part of a long text: its first sentence.
  if (system.startsWith('You read one part')) {
    const part = user.slice(user.indexOf(':\n', user.indexOf(' part ')) + 2).trim();
    return `- ${part.split('. ')[0]}.`;
  }
  // A summary of the open page: what the source says first.
  if (system.includes('tl;dr')) {
    const source = user.slice(user.indexOf('Source:') + 7, user.lastIndexOf('Request:'));
    const body = source.split('\n').slice(2).join(' ').replace(/\s+/g, ' ').trim();
    return `Summary: ${body.slice(0, 300)} [1]`;
  }
  // Answer: quote the source sentence that best matches the request.
  const request = tokens(user.slice(user.lastIndexOf('Request:') + 8));
  // Only the sources, not the earlier chat turns before them.
  const sources = user.slice(user.indexOf('Sources:'), user.lastIndexOf('Request:'));
  const lines = sources.split('\n').filter(l => l && !l.startsWith('['));
  const best = lines
      .filter(l => !l.startsWith('Sources:') && !l.startsWith('Request:'))
      .map(l => ({l, c: coverage(request, l)}))
      .sort((a, b) => b.c - a.c)[0];
  return best ? `${best.l.trim()} [1]` : 'I could not find that. [1]';
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}

export async function startMockRuntime(
    options: {apiKey?: string, preloaded?: string[], port?: number,
              // Behave like a small LLM that never says it is done.
              llmNeverDone?: boolean,
              // Judge the first N answers as not answering the question.
              rejectAnswers?: number} = {}):
    Promise<MockRuntime> {
  const apiKey = options.apiKey ?? 'test-key';
  const models = new Map<string, MockModel>();
  for (const id of options.preloaded ?? []) {
    models.set(id, {id, status: 'unloaded'});
  }
  const requests: MockRuntime['requests'] = [];
  const failures = new Map<string, number>();
  const rejecting = {left: options.rejectAnswers ?? 0};

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      send(res, 401, {error: {code: 401, message: 'Invalid API Key'}});
      return;
    }
    const body = await readBody(req);
    requests.push({method: req.method ?? 'GET', path: url.pathname + url.search, body});
    const failing = failures.get(url.pathname) ?? 0;
    if (failing > 0) {
      failures.set(url.pathname, failing - 1);
      send(res, 503, {error: {code: 503, message: 'Loading model'}});
      return;
    }
    const known = (id: string) => CATALOG.some(m => m.id === id);

    if (url.pathname === '/models' && req.method === 'GET') {
      send(res, 200, {data: [...models.values()].map(m => ({
        id: m.id,
        status: {value: m.status},
        memory: m.status === 'loaded' ? {effective: {devices: [
          {kind: 'device', model: 1024 ** 3, context: 256 * 1024 ** 2, compute: 0},
        ]}} : {status: 'unmeasured'},
      }))});
    } else if (url.pathname === '/models' && req.method === 'POST') {
      if (!known(body.model)) {
        send(res, 400, {error: {code: 400, message: 'model validation failed'}});
        return;
      }
      models.set(body.model, {id: body.model, status: 'unloaded'});
      send(res, 200, {success: true});
    } else if (url.pathname === '/models' && req.method === 'DELETE') {
      models.delete(url.searchParams.get('model') ?? '');
      send(res, 200, {success: true});
    } else if (url.pathname === '/models/load') {
      const model = models.get(body.model);
      if (!model) {
        send(res, 400, {error: {code: 400, message: 'model not found'}});
        return;
      }
      model.status = 'loaded';
      send(res, 200, {success: true});
    } else if (url.pathname === '/models/unload') {
      const model = models.get(body.model);
      if (model) {
        model.status = 'unloaded';
      }
      send(res, 200, {success: true});
    } else if (url.pathname === '/v1/systemone') {
      send(res, 200, {model: body.model, ...systemOne(body, rejecting)});
    } else if (url.pathname === '/v1/chat/completions') {
      const text = chatReply(body, options.llmNeverDone);
      if (body.stream) {
        res.writeHead(200, {'content-type': 'text/event-stream'});
        for (const piece of text.match(/.{1,12}/gs) ?? []) {
          res.write(`data: ${JSON.stringify({choices: [{delta: {content: piece}}]})}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      } else {
        send(res, 200, {choices: [{message: {role: 'assistant', content: text}}]});
      }
    } else {
      send(res, 404, {error: {code: 404, message: 'not found'}});
    }
  });
  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  return {
    failNext: (path, times) => failures.set(path, times),
    url: `http://127.0.0.1:${port}`,
    apiKey,
    requests,
    models,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
