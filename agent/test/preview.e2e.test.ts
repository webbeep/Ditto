// End to end for the preview app (preview/): Chromium launched through the
// Ditto launcher, the agent extension loaded by it, the native host starting
// a model runtime on demand. The runtime binary is the mock (same HTTP API
// as llama-server); everything else is what ships.

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
        symlinkSync, writeFileSync, copyFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';

import {serveDirectory} from '../dev/static_server.js';
import {routerPresetIni} from '../src/models/catalog.js';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AGENT_DIST = fileURLToPath(new URL('../', import.meta.url));
const EXTENSION_ID = 'gmnabdkkiapgiceenfljnbpgblepapmo';
const hasCompiler = spawnSync('cc', ['--version']).status === 0;

let work: string;
let app: string;
let state: string;
let site: {url: string, close(): Promise<void>};
let context: any;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 10000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('timed out');
}

const runtimeState = () =>
    existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : null;

// Lays out Ditto.app the way preview/build-app.sh does on macOS, with the
// platform's Chromium in place of Chromium.app's binary.
function assembleApp(): void {
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources/ditto');
  mkdirSync(join(contents, 'MacOS'), {recursive: true});
  mkdirSync(join(resources, 'runtime'), {recursive: true});
  execFileSync('cc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Wall', '-Wextra', '-Werror', '-O2',
                      '-o', join(contents, 'MacOS/Ditto'), join(ROOT, 'preview/launcher.c')]);
  symlinkSync(require('playwright').chromium.executablePath(), join(contents, 'MacOS/Chromium'));
  execFileSync(join(ROOT, 'preview/build-extension.sh'), [join(resources, 'extension')]);
  copyFileSync(join(ROOT, 'preview/runtime-host.sh'), join(resources, 'runtime-host.sh'));
  chmodSync(join(resources, 'runtime-host.sh'), 0o755);
  writeFileSync(join(resources, 'runtime/preset.ini'), routerPresetIni());
  // Stand-in for llama-server: the mock runtime on the port and key the
  // host chose, recording how it was started.
  writeFileSync(join(work, 'fake-server.mjs'), `
    import {writeFileSync} from 'node:fs';
    import {startMockRuntime} from ${JSON.stringify(join(AGENT_DIST, 'dev/mock_runtime.js'))};
    const arg = name => process.argv[process.argv.indexOf(name) + 1];
    const runtime = await startMockRuntime({
      port: Number(arg('--port')), apiKey: arg('--api-key'),
      preloaded: ['unsloth/Qwen3.5-4B-GGUF:Q4_K_M', 'LiquidAI/d1-2B-GGUF:Q4_K_M'],
    });
    writeFileSync(process.env.DITTO_MOCK_STATE, JSON.stringify({
      pid: process.pid, args: process.argv.slice(2), cache: process.env.LLAMA_CACHE,
    }));
    process.on('SIGTERM', () => runtime.close().then(() => process.exit(0)));
  `);
  writeFileSync(join(resources, 'runtime/llama-server'),
                `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ` +
                `${JSON.stringify(join(work, 'fake-server.mjs'))} "$@"\n`);
  chmodSync(join(resources, 'runtime/llama-server'), 0o755);
}

before(async () => {
  if (!hasCompiler) {
    return;
  }
  work = mkdtempSync(join(tmpdir(), 'ditto-preview-'));
  app = join(work, 'Ditto.app');
  state = join(work, 'runtime-state.json');
  assembleApp();
  site = await serveDirectory(fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
  context = await require('playwright').chromium.launchPersistentContext(join(work, 'profile'), {
    executablePath: join(app, 'Contents/MacOS/Ditto'),
    headless: true,
    // Playwright disables extensions by default.
    ignoreDefaultArgs: ['--disable-extensions'],
    env: {...process.env, DITTO_MOCK_STATE: state},
  });
});

after(async () => {
  await context?.close();
  await site?.close();
  if (work) {
    rmSync(work, {recursive: true, force: true});
  }
});

test('the launcher loads the agent extension with its fixed ID', {skip: !hasCompiler}, async () => {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.equal(worker.url(), `chrome-extension://${EXTENSION_ID}/background.js`);
  const host = JSON.parse(readFileSync(
      join(work, 'profile/NativeMessagingHosts/app.ditto.runtime.json'), 'utf8'));
  assert.deepEqual(host.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
});

test('a chat task drives the active tab through the extension and the native host',
     {skip: !hasCompiler}, async () => {
  assert.equal(runtimeState(), null, 'no runtime before the agent is used');
  const panel = await context.newPage();
  panel.on('pageerror', (error: Error) => { throw error; });
  await panel.goto(`chrome-extension://${EXTENSION_ID}/ditto_agent.html`);
  const tab = context.pages()[0];
  await tab.goto(site.url);
  await tab.bringToFront();

  await panel.fill('#prompt', 'What is the price of the Acme Widget Pro?');
  await panel.press('#prompt', 'Enter');
  await panel.locator('.msg.agent .sources a').first().waitFor({timeout: 30000});
  assert.match(await panel.textContent('.msg.agent'), /\$49/);
  assert.match(tab.url(), /widget-pro\.html$/);

  // The host started the runtime with a loopback port, a per-launch key,
  // the bundled preset and the models directory next to the profile.
  const runtime = runtimeState();
  assert.ok(runtime && alive(runtime.pid));
  const args: string[] = runtime.args;
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.match(args[args.indexOf('--api-key') + 1]!, /^[0-9a-f]{48}$/);
  assert.match(args[args.indexOf('--models-preset') + 1]!, /Resources\/ditto\/runtime\/preset\.ini$/);
  assert.equal(args[args.indexOf('--models-memory-margin') + 1], '2048');
  assert.ok(args.includes('--no-webui'));
  assert.match(runtime.cache, /profile\/Ditto Models$/);

  // "Disable all models" stops the runtime process.
  await panel.click('#models-toggle');
  await panel.click('#disable-all');
  await until(() => !alive(runtime.pid));
  await panel.close();
});

test('on a blank tab the agent searches with the default search engine',
     {skip: !hasCompiler}, async () => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/ditto_agent.html`);
  await panel.selectOption('#mode', 'hybrid');
  const tab = await context.newPage();
  await tab.goto('about:blank');
  await tab.bringToFront();
  const navigated = context.waitForEvent('request', (r: any) => /[?&]q=widget\+pro/i.test(r.url()));
  await panel.fill('#prompt', 'widget pro');
  await panel.press('#prompt', 'Enter');
  // chrome.search sends the query to the profile's default engine.
  const request = await navigated;
  assert.match(request.url(), /^https:\/\/[^/]*google\.[^/]+\/search\?/);
  await panel.locator('.msg.agent', {hasText: /could not load|\[1\]/}).waitFor({timeout: 30000});
  await panel.close();
});

test('closing the browser stops the runtime', {skip: !hasCompiler}, async () => {
  const runtime = runtimeState();
  assert.ok(runtime && alive(runtime.pid), 'the previous test restarted the runtime');
  await context.close();
  context = null;
  await until(() => !alive(runtime.pid));
  // First-run defaults survived Chromium rewriting its state files.
  const local = JSON.parse(readFileSync(join(work, 'profile/Local State'), 'utf8'));
  assert.equal(local.performance_tuning.high_efficiency_mode.state, 2);
  const prefs = JSON.parse(readFileSync(join(work, 'profile/Default/Preferences'), 'utf8'));
  assert.equal(prefs.vertical_tabs.enabled, true);
});
