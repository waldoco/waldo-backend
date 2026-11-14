import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const RUNNER = new URL('../guards/run-all.mjs', import.meta.url);

// The runner runs every guard in its own directory, so a copy beside fake guards runs exactly those.
const runWith = (guards) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-runner-'));
  copyFileSync(RUNNER, join(dir, 'run-all.mjs'));
  for (const [name, body] of Object.entries({ 'guard-do-only-runtime.mjs': 'process.exit(0);\n', ...guards })) writeFileSync(join(dir, name), body);
  const result = spawnSync(process.execPath, [join(dir, 'run-all.mjs')], { encoding: 'utf8' });
  return { result, ran: (marker) => existsSync(join(dir, marker)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const marks = (marker) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./${marker}', import.meta.url), '');\n`;

test('a failing guard does not stop the guards after it, and the run still fails', () => {
  const run = runWith({ 'guard-a-environment.mjs': 'process.exit(3);\n', 'guard-b-violation.mjs': `${marks('b-ran')}process.exit(1);\n`, 'guard-c-clean.mjs': marks('c-ran') });
  try {
    assert.notEqual(run.result.status, 0);
    assert.ok(run.ran('b-ran'), 'the guard after the first failure ran');
    assert.ok(run.ran('c-ran'), 'the last guard ran');
    assert.match(run.result.stderr, /guard-a-environment\.mjs/);
    assert.match(run.result.stderr, /guard-b-violation\.mjs/);
    assert.doesNotMatch(run.result.stderr, /guard-c-clean\.mjs/);
  } finally { run.cleanup(); }
});

test('every guard passing exits zero', () => {
  const run = runWith({ 'guard-a-clean.mjs': marks('a-ran') });
  try {
    assert.equal(run.result.status, 0);
    assert.ok(run.ran('a-ran'));
  } finally { run.cleanup(); }
});

test('a guard that cannot be started is reported, and the rest still run', () => {
  const run = runWith({ 'guard-a-crash.mjs': 'throw new Error("boom");\n', 'guard-b-clean.mjs': marks('b-ran') });
  try {
    assert.notEqual(run.result.status, 0);
    assert.ok(run.ran('b-ran'));
    assert.match(run.result.stderr, /guard-a-crash\.mjs/);
  } finally { run.cleanup(); }
});

test('a missing required guard fails before any guard runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-runner-'));
  try {
    copyFileSync(RUNNER, join(dir, 'run-all.mjs'));
    writeFileSync(join(dir, 'guard-a-clean.mjs'), marks('a-ran'));
    const result = spawnSync(process.execPath, [join(dir, 'run-all.mjs')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required guard is missing/);
    assert.ok(!existsSync(join(dir, 'a-ran')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
