import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const guard = new URL('../guards/guard-wrangler-local-bindings.mjs', import.meta.url).pathname;
const realConfig = readFileSync(new URL('../../packages/runtime/wrangler.jsonc', import.meta.url), 'utf8');
const stagingName = '"name": "waldo-runtime-staging",';
const stagingBrowser = `${stagingName} "browser": { "binding": "BROWSER" },`;
const s0Config = (overrides = {}) => JSON.stringify({
  name: 'waldo-s0-staging', main: 'src/s0-worker.ts', compatibility_date: '2026-09-01',
  compatibility_flags: ['nodejs_compat'], vars: { WALDO_ENVIRONMENT: 'staging' }, browser: { binding: 'BROWSER' }, ...overrides,
});
const passingRecord = JSON.stringify({ passed: true, allowedLoaded: true, terminated: true, worker: 'waldo-s0-staging', probes: [{ reached: false }, { reached: false }, { reached: false }] });

function run(files, wrangler = realConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-wrangler-'));
  try {
    writeFileSync(join(dir, 'wrangler.jsonc'), wrangler);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return spawnSync(process.execPath, [guard], { env: { ...process.env, WRANGLER_CONFIG_PATH: join(dir, 'wrangler.jsonc') }, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const withStagingBrowser = realConfig.replace(stagingName, stagingBrowser);

test('the committed config passes', () => {
  assert.equal(run({}).status, 0);
});

test('env.staging cannot bind a browser, even next to a passing S0 record', () => {
  assert.equal(withStagingBrowser === realConfig, false);
  for (const files of [{}, { 's0-result.json': passingRecord }]) {
    const result = run(files, withStagingBrowser);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /env\.staging must not bind a browser/);
  }
});

test('a well-formed throwaway S0 config passes', () => {
  assert.equal(run({ 'wrangler.s0.jsonc': s0Config() }).status, 0);
});

test('the throwaway S0 config is held to its shape', () => {
  const cases = [
    [{ name: 'waldo-runtime-staging' }, /name must be waldo-s0-staging/],
    [{ vars: { WALDO_ENVIRONMENT: 'production' } }, /WALDO_ENVIRONMENT must be staging/],
    [{ durable_objects: { bindings: [] } }, /must not set durable_objects/],
    [{ ratelimits: [] }, /must not set ratelimits/],
  ];
  for (const [overrides, message] of cases) {
    const result = run({ 'wrangler.s0.jsonc': s0Config(overrides) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test('env.s0 must not exist in the main config', () => {
  const result = run({}, realConfig.replace('"env": {', '"env": { "s0": { "name": "x" },'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /env\.s0 must not exist/);
});
