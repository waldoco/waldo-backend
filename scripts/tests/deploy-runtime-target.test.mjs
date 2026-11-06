import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy-runtime.sh', import.meta.url));

// git, pnpm and npx are stubs: the tree reads clean, the dashboard build succeeds, and npx records what wrangler got.
function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-runtime-'));
  try {
    const record = join(dir, 'npx-args');
    const stub = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
    stub('git', 'case "$1" in rev-parse) echo abc1234 ;; *) ;; esac');
    stub('pnpm', 'exit 0');
    stub('npx', `printf '%s\\n' "$@" > '${record}'`);
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `${dir}:/usr/bin:/bin` } });
    return { status: result.status, stderr: result.stderr, npx: existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('refuses every target but staging before building or reaching wrangler', () => {
  for (const args of [[], ['--env', 'beta'], ['--env', ''], ['--env=staging'], ['--dry-run'], ['--env', 'staging', '--env', 'beta'], ['--env', 'staging', '--env=beta'], ['--env', 'staging', '-e', 'beta']]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.npx, null, JSON.stringify(args));
    assert.match(result.stderr, /only 'scripts\/deploy-runtime\.sh --env staging' deploys/);
  }
});

test('deploys staging with the release stamped and passes later flags through', () => {
  const result = run(['--env', 'staging', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.npx, ['wrangler', 'deploy', '--var', 'WALDO_RELEASE:abc1234', '--env', 'staging', '--dry-run']);
});
