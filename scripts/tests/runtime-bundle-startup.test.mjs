import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('the default staging Worker bundle starts without browser activation or Node compatibility', { timeout: 120000 }, async () => {
  const runtime = resolve('packages/runtime');
  const { Miniflare } = createRequire(resolve(realpathSync(resolve(runtime, 'node_modules/@cloudflare/vitest-pool-workers')), 'package.json'))('miniflare');
  const config = JSON.parse(readFileSync(resolve(runtime, 'wrangler.jsonc'), 'utf8').replace(/\/\/[^\n]*/g, ''));
  const staging = config.env.staging;
  const dir = mkdtempSync(resolve(tmpdir(), 'waldo-bundle-startup-'));
  let worker;
  try {
    execFileSync('pnpm', ['--filter', '@waldo/dashboard-app', 'build'], { encoding: 'utf8', timeout: 60000 });
    execFileSync('pnpm', ['exec', 'wrangler', 'versions', 'upload', '--env', 'staging', '--dry-run', '--outdir', dir], { cwd: runtime, encoding: 'utf8', timeout: 60000 });
    worker = new Miniflare({ workers: [{
      modules: true, modulesRoot: dir, scriptPath: resolve(dir, 'index.js'),
      compatibilityDate: staging.compatibility_date ?? config.compatibility_date,
      compatibilityFlags: staging.compatibility_flags ?? config.compatibility_flags ?? [],
      bindings: { WALDO_RELEASE: 'bundle-regression' },
      durableObjects: Object.fromEntries(staging.durable_objects.bindings.map(binding => [binding.name, { className: binding.class_name, useSQLite: true }])),
    }] });
    const response = await worker.dispatchFetch('https://worker.invalid/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, release: 'bundle-regression' });
  } finally {
    await worker?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
