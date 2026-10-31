// Builds Ditto's agent pages (the panel and the new tab page) with one of
// the bridges in ./bridges: `webkit` for the app, `harness` for tests.
//
//   node web/build.mjs webkit <out dir>
//
// The pages and the agent runtime (agent/src) are compiled together with
// tsc, as ES modules; the HTML and CSS are copied next to them.

import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const web = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(web, '..');
const [bridge, outArg] = process.argv.slice(2);
if (!['webkit', 'harness'].includes(bridge) || !outArg) {
  console.error('usage: node web/build.mjs webkit|harness <out dir>');
  process.exit(2);
}
const out = resolve(outArg);

const work = mkdtempSync(join(tmpdir(), 'ditto-web-'));
try {
  for (const file of readdirSync(web)) {
    if (file.endsWith('.ts')) {
      cpSync(join(web, file), join(work, file));
    }
  }
  cpSync(join(web, 'bridges', `${bridge}.ts`), join(work, 'bridge.ts'));
  cpSync(join(root, 'agent/src'), join(work, 'agent'), {recursive: true});
  writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], strict: true,
      noUncheckedIndexedAccess: true, skipLibCheck: true, outDir: out, rootDir: '.',
    },
    include: ['*.ts', 'agent/**/*.ts'],
  }));
  execFileSync(join(root, 'agent/node_modules/.bin/tsc'), ['-p', work], {stdio: 'inherit'});
  mkdirSync(out, {recursive: true});
  for (const file of readdirSync(web)) {
    if (/\.(html|css|svg)$/.test(file)) {
      cpSync(join(web, file), join(out, file));
    }
  }
} finally {
  rmSync(work, {recursive: true, force: true});
}
