#!/usr/bin/env node
// Adversarial config regression: env.experimental is a second non-production Worker for
// unmerged branches. It must mirror staging's bindings and behaviour, yet never share a
// stateful resource with staging, run the staging-only cron, or claim staging custody.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../jsonc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = parseJsonc(readFileSync(join(root, 'packages/runtime/wrangler.jsonc'), 'utf8'));
const guard = join(root, 'scripts/guards/guard-wrangler-local-bindings.mjs');
const directory = mkdtempSync(join(tmpdir(), 'waldo-experimental-'));

const check = (config) => {
  const file = join(directory, 'wrangler.jsonc');
  writeFileSync(file, JSON.stringify(config));
  return spawnSync(process.execPath, [guard], {
    cwd: root,
    env: { ...process.env, WRANGLER_CONFIG_PATH: file },
    encoding: 'utf8',
  });
};

const attacks = [
  ['experimental reuses the staging R2 bucket', 'shares R2 bucket', (c) => { c.env.experimental.r2_buckets[0].bucket_name = c.env.staging.r2_buckets[0].bucket_name; }],
  ['experimental reuses the staging Vectorize index', 'shares Vectorize index', (c) => { c.env.experimental.vectorize[0].index_name = c.env.staging.vectorize[0].index_name; }],
  ['experimental reuses the staging limiter namespace', 'shares rate-limiter namespace', (c) => { c.env.experimental.ratelimits[0].namespace_id = c.env.staging.ratelimits[0].namespace_id; }],
  ['experimental reuses the preview limiter namespace', 'shares rate-limiter namespace', (c) => { c.env.experimental.ratelimits[0].namespace_id = c.previews.ratelimits[0].namespace_id; }],
  ['experimental drops its R2 binding', 'env.experimental r2_buckets bindings', (c) => { delete c.env.experimental.r2_buckets; }],
  ['experimental drops its Vectorize binding', 'env.experimental vectorize bindings', (c) => { delete c.env.experimental.vectorize; }],
  ['experimental drops the AI binding', 'env.experimental missing ai binding', (c) => { delete c.env.experimental.ai; }],
  ['experimental drops a Durable Object binding', 'env.experimental does not mirror top-level "durable_objects"', (c) => { c.env.experimental.durable_objects.bindings.pop(); }],
  ['experimental diverges from migrations', 'env.experimental does not mirror top-level "migrations"', (c) => { c.env.experimental.migrations.pop(); }],
  ['experimental misses a var key', 'env.experimental missing var "DRIVE_READS"', (c) => { delete c.env.experimental.vars.DRIVE_READS; }],
  ['experimental claims production trace identity', 'env.experimental WALDO_ENVIRONMENT must be "staging"', (c) => { c.env.experimental.vars.WALDO_ENVIRONMENT = 'production'; }],
  ['experimental claims the staging owner namespace', 'env.experimental WALDO_OWNER_DO_NAMESPACE must be empty', (c) => { c.env.experimental.vars.WALDO_OWNER_DO_NAMESPACE = c.env.staging.vars.WALDO_OWNER_DO_NAMESPACE; }],
  ['experimental claims any owner namespace', 'env.experimental WALDO_OWNER_DO_NAMESPACE must be empty', (c) => { c.env.experimental.vars.WALDO_OWNER_DO_NAMESPACE = 'b1946ac92492d2347c6235b4d2611184'; }],
  ['experimental enables the iMessage bridge', 'env.experimental IMESSAGE_CONNECTOR_ENABLED must be "0"', (c) => { c.env.experimental.vars.IMESSAGE_CONNECTOR_ENABLED = '1'; }],
  ['experimental runs the retention cron', 'env.experimental must not declare triggers', (c) => { c.env.experimental.triggers = { crons: ['17 3 * * *'] }; }],
  ['experimental impersonates the staging Worker', 'env.experimental missing or name != waldo-runtime-experimental', (c) => { c.env.experimental.name = 'waldo-runtime-staging'; }],
  ['experimental diverges from the staging entrypoint', 'env.experimental does not mirror env.staging "main"', (c) => { c.env.experimental.main = 'src/index.ts'; }],
  ['experimental drops the browser binding', 'env.experimental does not mirror env.staging "browser"', (c) => { delete c.env.experimental.browser; }],
  ['experimental persists full URLs', 'env.experimental must disable full-URL invocation logs', (c) => { c.env.experimental.observability.logs.invocation_logs = true; }],
  ['experimental enables automatic traces', 'env.experimental must disable automatic traces', (c) => { c.env.experimental.observability.traces.enabled = true; }],
  ['experimental drops the signup limiter', 'env.experimental missing RESPONSIBILITY_RATE_LIMITER', (c) => { delete c.env.experimental.ratelimits; }],
  ['experimental adds a KV namespace shared with staging', 'shares KV namespace', (c) => {
    c.kv_namespaces = [{ binding: 'CACHE', id: 'prod-kv' }];
    c.env.staging.kv_namespaces = [{ binding: 'CACHE', id: 'prod-kv' }];
    c.env.experimental.kv_namespaces = [{ binding: 'CACHE', id: 'prod-kv' }];
  }],
  ['an unchecked named environment appears', 'env.qa is not a recognised environment', (c) => { c.env.qa = structuredClone(c.env.experimental); c.env.qa.name = 'waldo-runtime-qa'; }],
];

try {
  if (!source.env?.experimental) throw new Error('packages/runtime/wrangler.jsonc declares no env.experimental');
  const accepted = check(source);
  if (accepted.status !== 0) throw new Error(`current config rejected: ${accepted.stderr.trim()}`);
  for (const [label, expected, attack] of attacks) {
    const changed = structuredClone(source);
    attack(changed);
    const result = check(changed);
    if (result.status !== 1 || !result.stderr.includes(expected)) {
      throw new Error(`guard accepted or misreported: ${label} (expected "${expected}", got "${result.stderr.trim()}")`);
    }
  }
  console.log(`guard-wrangler-experimental-regression: ok (${attacks.length} attacks rejected)`);
} catch (error) {
  process.stderr.write(`guard-wrangler-experimental-regression: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
