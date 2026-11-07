import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const GUARD = new URL('../guards/guard-import-cycles.mjs', import.meta.url).pathname;
const SRC = 'packages/runtime/src';

// A runtime tree under a temp root: files maps a path under src to its source, baseline lists cycles as src paths.
const guardOn = (files, baseline = []) => {
  const root = mkdtempSync(join(tmpdir(), 'import-cycles-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, SRC, path)), { recursive: true });
      writeFileSync(join(root, SRC, path), source);
    }
    mkdirSync(join(root, 'scripts', 'guards'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'guards', 'guard-import-cycles.baseline.json'), JSON.stringify(baseline.map((cycle) => cycle.map((path) => `${SRC}/${path}`).sort())));
    return spawnSync(process.execPath, [GUARD, '--root', root], { encoding: 'utf8' });
  } finally { rmSync(root, { recursive: true, force: true }); }
};

// The chain that left CONSOLE_PATH undefined at load time.
const B6 = {
  'channels/heartbeat.ts': "import { jobs } from '../prompt/machine-jobs';\nexport const CONSOLE_PATH = '/console';\n",
  'prompt/machine-jobs.ts': "import { lane } from '../tasks/lane';\nexport const jobs = [lane];\n",
  'tasks/lane.ts': "import { brain } from './brain';\nexport const lane = brain;\n",
  'tasks/brain.ts': "import { turn } from '../channels/owner-turn';\nexport const brain = turn;\n",
  'channels/owner-turn.ts': "import { CONSOLE_PATH } from './heartbeat';\nexport const turn = CONSOLE_PATH;\n",
};

test('the tree as it stands in this repository matches its baseline', () => {
  const result = spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a new cycle fails, naming its modules in import order', () => {
  const result = guardOn(B6);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new import cycle \(5 modules\)/);
  for (const module of ['channels/heartbeat.ts', 'prompt/machine-jobs.ts', 'tasks/lane.ts', 'tasks/brain.ts', 'channels/owner-turn.ts']) assert.match(result.stderr, new RegExp(module.replace('.', '\\.')));
  assert.match(result.stderr, /prompt\/machine-jobs\.ts -> packages\/runtime\/src\/tasks\/lane\.ts -> packages\/runtime\/src\/tasks\/brain\.ts/);
});

test('a baselined cycle passes', () => {
  assert.equal(guardOn(B6, [Object.keys(B6)]).status, 0);
});

test('a baselined cycle that is gone fails until the baseline follows', () => {
  const broken = { ...B6, 'channels/owner-turn.ts': "export const turn = '/console';\n" };
  const result = guardOn(broken, [Object.keys(B6)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baselined import cycle is gone or smaller/);
});

test('a baselined cycle that takes in another module fails', () => {
  const grown = { 'a.ts': "import { b } from './b';\nexport const a = 1;\n", 'b.ts': "import { c } from './c';\nexport const b = 1;\n", 'c.ts': "import { a } from './a';\nexport const c = 1;\n" };
  const result = guardOn(grown, [['a.ts', 'b.ts']]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /took in more modules/);
});

test('type-only imports, dynamic imports and import text in strings or comments are not load-time edges', () => {
  const result = guardOn({
    'a.ts': "import type { B } from './b';\nimport { type C } from './c';\nexport const a = 1;\n",
    'b.ts': "export type B = 1;\nconst load = () => import('./a');\n// import { a } from './a';\nconst text = \"import { a } from './a'\";\n",
    'c.ts': "export type { B } from './b';\nexport type C = 1;\n",
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a re-export closes a cycle like an import', () => {
  const result = guardOn({ 'a.ts': "export * from './b';\n", 'b.ts': "export { a } from './a/index';\n", 'a/index.ts': "import './../a';\nexport const a = 1;\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new import cycle/);
});
