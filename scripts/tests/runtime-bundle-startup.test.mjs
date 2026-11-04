import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseJsonc } from '../jsonc.mjs';

// Cloudflare rejects a deploy whose script startup exceeds its CPU limit (error 10021), and the full Worker builds every
// contract schema at module scope. The deployed entry therefore imports only what this set names, statically; the rest
// loads on the first event (src/lazy-entry.ts). A dynamic import is not followed: it runs on first use, not at startup.
const STARTUP_MODULES = ['src/lazy-entry.ts', 'src/retired-durable-objects.ts'];
const staticClosure = (metafile, entry) => {
  const { inputs } = JSON.parse(readFileSync(metafile, 'utf8'));
  const seen = new Set([entry]), queue = [entry];
  while (queue.length) for (const edge of inputs[queue.pop()]?.imports ?? []) {
    if (edge.kind === 'import-statement' && !edge.external && !seen.has(edge.path)) { seen.add(edge.path); queue.push(edge.path); }
  }
  return [...seen].filter((path) => path !== entry).sort();
};

test('the default production Worker bundle starts without browser activation or Node compatibility', { timeout: 120000 }, async () => {
  const runtime = resolve('packages/runtime');
  const { Miniflare } = createRequire(resolve(realpathSync(resolve(runtime, 'node_modules/@cloudflare/vitest-pool-workers')), 'package.json'))('miniflare');
  const config = parseJsonc(readFileSync(resolve(runtime, 'wrangler.jsonc'), 'utf8'));
  const ordinary = config;
  const dir = mkdtempSync(resolve(tmpdir(), 'waldo-bundle-startup-'));
  let worker;
  try {
    execFileSync('pnpm', ['--filter', '@waldo/dashboard-app', 'build'], { encoding: 'utf8', timeout: 60000 });
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--env', '', '--dry-run', '--outdir', dir, '--metafile', resolve(dir, 'meta.json')], { cwd: runtime, encoding: 'utf8', timeout: 60000 });
    assert.deepEqual(staticClosure(resolve(dir, 'meta.json'), ordinary.main), STARTUP_MODULES, 'the production entry statically imports only the startup modules');
    const bundle = readFileSync(resolve(dir, 'entry.js'), 'utf8');
    assert.equal(bundle.includes('cf-brapi-client'), false, 'ordinary production graph must not bundle the browser SDK');
    worker = new Miniflare({ workers: [{
      modules: true, modulesRoot: dir, scriptPath: resolve(dir, 'entry.js'),
      compatibilityDate: ordinary.compatibility_date ?? config.compatibility_date,
      compatibilityFlags: ordinary.compatibility_flags ?? config.compatibility_flags ?? [],
      bindings: { WALDO_RELEASE: 'bundle-regression' },
      durableObjects: Object.fromEntries(ordinary.durable_objects.bindings.map(binding => [binding.name, { className: binding.class_name, useSQLite: true }])),
    }] });
    const response = await worker.dispatchFetch('https://worker.invalid/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, release: 'bundle-regression' });
  } finally {
    await worker?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the staging entry statically imports only the startup modules', { timeout: 120000 }, () => {
  const runtime = resolve('packages/runtime');
  const config = parseJsonc(readFileSync(resolve(runtime, 'wrangler.jsonc'), 'utf8'));
  const dir = mkdtempSync(resolve(tmpdir(), 'waldo-bundle-startup-staging-'));
  try {
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--env', 'staging', '--dry-run', '--outdir', dir, '--metafile', resolve(dir, 'meta.json')], { cwd: runtime, encoding: 'utf8', timeout: 60000 });
    assert.deepEqual(staticClosure(resolve(dir, 'meta.json'), config.env.staging.main), STARTUP_MODULES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the beta entry is the production entry, statically imports only the startup modules and needs no Node compatibility', { timeout: 120000 }, () => {
  const runtime = resolve('packages/runtime');
  const config = parseJsonc(readFileSync(resolve(runtime, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.env.beta.main, config.main);
  assert.equal(config.env.beta.compatibility_flags, undefined);
  const dir = mkdtempSync(resolve(tmpdir(), 'waldo-bundle-startup-beta-'));
  try {
    execFileSync('pnpm', ['exec', 'wrangler', 'deploy', '--env', 'beta', '--dry-run', '--outdir', dir, '--metafile', resolve(dir, 'meta.json')], { cwd: runtime, encoding: 'utf8', timeout: 60000 });
    assert.deepEqual(staticClosure(resolve(dir, 'meta.json'), config.env.beta.main), STARTUP_MODULES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
