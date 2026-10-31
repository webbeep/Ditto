// What the app's self-test (scripts/smoke-app.sh) runs the agent against:
// the mock model runtime, with every model on disk and a pause on each call
// so the run can be watched, and the test site. Prints one JSON line
// ({runtime, key, site}) and serves until it is stopped.

import {fileURLToPath} from 'node:url';

import {CATALOG} from '../src/models/catalog.js';
import {startMockRuntime} from './mock_runtime.js';
import {serveDirectory} from './static_server.js';

const runtime = await startMockRuntime({
  apiKey: 'self-test',
  preloaded: CATALOG.filter(m => m.runtime === 'llama').map(m => m.id),
  delayMs: 900,
});
const site = await serveDirectory(
    fileURLToPath(new URL('../../test/fixtures/site/', import.meta.url)));
console.log(JSON.stringify({runtime: runtime.url, key: runtime.apiKey, site: site.url}));
