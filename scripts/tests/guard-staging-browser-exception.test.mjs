import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const guard = new URL('../guards/guard-wrangler-local-bindings.mjs', import.meta.url).pathname;
const realConfig = readFileSync(new URL('../../packages/runtime/wrangler.jsonc', import.meta.url), 'utf8');
const stagingName = '"name": "waldo-runtime-staging",';
const bound = (binding) => realConfig.replace(stagingName, `${stagingName} "browser": { "binding": "${binding}" },`);

function run(wrangler, today) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-browser-'));
  try {
    writeFileSync(join(dir, 'wrangler.jsonc'), wrangler);
    return spawnSync(process.execPath, [guard], { env: { ...process.env, WRANGLER_CONFIG_PATH: join(dir, 'wrangler.jsonc'), GUARD_TODAY: today }, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the committed config binds the staging browser and passes inside the exception window', () => {
  assert.match(realConfig, /"browser":\s*\{\s*"binding":\s*"BROWSER"\s*\}/);
  assert.equal(run(realConfig, '2026-10-12').status, 0);
});

test('the exception lapses on its expiry date', () => {
  const result = run(realConfig, '2026-11-12');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staging browser exception expired/);
});

test('staging may bind only BROWSER', () => {
  const stray = realConfig.replace(/"browser":\s*\{\s*"binding":\s*"BROWSER"\s*\}/, '"browser": { "binding": "OTHER" }');
  const result = run(stray, '2026-10-12');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /env\.staging browser must be exactly/);
});

test('production (top level) never binds a browser', () => {
  const prod = realConfig.replace('"vars": { "WALDO_ENVIRONMENT": "production"', '"browser": { "binding": "BROWSER" }, "vars": { "WALDO_ENVIRONMENT": "production"');
  assert.notEqual(prod, realConfig);
  const result = run(prod, '2026-10-12');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /top level must not bind a browser/);
});

test('removing the exception (no staging binding) also passes', () => {
  const none = realConfig.replace(/"browser":\s*\{\s*"binding":\s*"BROWSER"\s*\},?/, '');
  assert.equal(run(none, '2026-12-01').status, 0);
});
