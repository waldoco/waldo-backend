import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../guards/run-all.mjs', import.meta.url));
const KEPT = ['guard-health-leak.mjs', 'guard-setalarm.mjs', 'guard-do-only-runtime.mjs', 'guard-wrangler-observability-regression.mjs', 'guard-do-migration-lineage.mjs'];

// A guards folder holding the five kept guards and one other, each exiting with the code given.
const withGuards = (exits, work) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-runner-'));
  try {
    for (const [file, code] of Object.entries(exits)) if (code !== undefined) writeFileSync(join(dir, file), `process.exit(${code});\n`);
    return work(spawnSync(process.execPath, [runner, dir], { encoding: 'utf8' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const passing = Object.fromEntries(KEPT.map(file => [file, 0]));

test('a failing guard outside the kept five warns and the run passes', () => withGuards({ ...passing, 'guard-other.mjs': 3 }, result => {
  assert.equal(result.status, 0);
  assert.match(result.stderr, /warn: guard-other\.mjs exited 3/);
}));

for (const file of KEPT) {
  test(`a failing ${file} fails the run after every guard has run`, () => withGuards({ ...passing, [file]: 2, 'guard-zzz.mjs': 1 }, result => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`block: ${file.replaceAll('.', '\\.')} exited 2`));
    assert.match(result.stderr, /warn: guard-zzz\.mjs exited 1/);
  }));
}

test('a missing kept guard fails the run before any guard runs', () => withGuards({ ...passing, 'guard-setalarm.mjs': undefined, 'guard-other.mjs': 0 }, result => {
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required guard is missing: guard-setalarm\.mjs/);
}));
