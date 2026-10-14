import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./staging-rollback.sh', import.meta.url));
const ID = '22222222-2222-4222-8222-222222222222';

// wrangler falls back to "yes" without a TTY or under CI, so the script itself must refuse.
function run(args, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-'));
  try {
    const record = join(dir, 'npx-args');
    writeFileSync(join(dir, 'npx'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${record}'\n`);
    chmodSync(join(dir, 'npx'), 0o755);
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${dir}:/usr/bin:/bin`, CI: 'true', ...extraEnv },
    });
    return { status: result.status, stderr: result.stderr, npx: existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('refuses without an explicit matching confirmation and never reaches wrangler', () => {
  for (const args of [[ID], [ID, '--confirm'], [ID, '--confirm', '33333333-3333-4333-8333-333333333333'], [ID, '--confirm', 'yes']]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.npx, null, args.join(' '));
  }
  assert.equal(run([ID], { ROLLBACK_CONFIRM: 'yes' }).npx, null);
});

test('refuses a malformed version id or an unknown flag', () => {
  for (const args of [[], ['nope', '--confirm', 'nope'], [ID, '--confirm', ID, '--force']]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.npx, null);
  }
});

test('a matching confirmation rolls back staging only, by flag or env', () => {
  const expected = ['--no-install', 'wrangler', 'rollback', ID, '--env', 'staging', '--message=bad deploy', '--yes'];
  assert.deepEqual(run([ID, '--confirm', ID, '--message', 'bad deploy']).npx, expected);
  assert.deepEqual(run([ID, '--message', 'bad deploy'], { ROLLBACK_CONFIRM: ID }).npx, expected);
});

test('a reason that looks like a flag stays the message', () => {
  assert.deepEqual(run([ID, '--confirm', ID, '--message', '--name=waldo-runtime']).npx, ['--no-install', 'wrangler', 'rollback', ID, '--env', 'staging', '--message=--name=waldo-runtime', '--yes']);
});
