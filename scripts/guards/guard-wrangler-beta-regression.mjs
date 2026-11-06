#!/usr/bin/env node
// Adversarial config regression for env.beta: each copy-paste from staging that would join beta testers to staging's
// resources, or send their text to traces, must be refused by guard-wrangler-local-bindings.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../jsonc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(root, 'packages/runtime/wrangler.jsonc'), 'utf8');
const guard = join(root, 'scripts/guards/guard-wrangler-local-bindings.mjs');
const directory = mkdtempSync(join(tmpdir(), 'waldo-beta-config-'));

const check = (config) => {
  const file = join(directory, 'wrangler.jsonc');
  writeFileSync(file, config);
  return spawnSync(process.execPath, [guard], { cwd: root, env: { ...process.env, WRANGLER_CONFIG_PATH: file }, encoding: 'utf8' });
};

const MUTATIONS = [
  ['shared bucket', (c) => { c.env.beta.r2_buckets[0].bucket_name = c.env.staging.r2_buckets[0].bucket_name; }, 'must name its own bucket'],
  ['shared limiter', (c) => { c.env.beta.ratelimits[0].namespace_id = c.env.staging.ratelimits[0].namespace_id; }, 'must use its own namespace_id'],
  ['preview limiter', (c) => { c.env.beta.ratelimits[0].namespace_id = c.previews.ratelimits[0].namespace_id; }, 'must use its own namespace_id'],
  ['missing limiter', (c) => { c.env.beta.ratelimits = []; }, 'must use its own namespace_id'],
  ['staging owner namespace', (c) => { c.env.beta.vars.WALDO_OWNER_DO_NAMESPACE = c.env.staging.vars.WALDO_OWNER_DO_NAMESPACE; }, "reuse staging's WALDO_OWNER_DO_NAMESPACE"],
  ['staging WhatsApp number', (c) => { c.env.beta.vars.WHATSAPP_WALDO_NUMBER = c.env.staging.vars.WHATSAPP_WALDO_NUMBER; }, "reuse staging's WHATSAPP_WALDO_NUMBER"],
  ['text capture', (c) => { c.env.beta.vars.LANGFUSE_CAPTURE_TEXT = 'true'; }, 'LANGFUSE_CAPTURE_TEXT'],
  ['environment name', (c) => { c.env.beta.vars.WALDO_ENVIRONMENT = 'staging'; }, 'WALDO_ENVIRONMENT must be "beta"'],
  ['missing var', (c) => { delete c.env.beta.vars.MEDICATIONS; }, 'env.beta missing var "MEDICATIONS"'],
  ['browser', (c) => { c.env.beta.browser = { binding: 'BROWSER' }; }, 'must not bind a browser'],
  ['vectorize', (c) => { c.env.beta.vectorize = c.env.staging.vectorize; }, 'must not bind vectorize'],
  ['durable objects', (c) => { c.env.beta.durable_objects.bindings.pop(); }, 'does not mirror top-level "durable_objects"'],
  ['missing block', (c) => { delete c.env.beta; }, 'env.beta missing'],
];

try {
  if (check(source).status !== 0) throw new Error('current beta config rejected');
  const config = parseJsonc(source);
  for (const [name, mutate, expected] of MUTATIONS) {
    const changed = structuredClone(config);
    mutate(changed);
    const result = check(JSON.stringify(changed));
    if (result.status !== 1 || !result.stderr.includes(expected)) throw new Error(`guard accepted beta mutation: ${name}`);
  }
  console.log('guard-wrangler-beta-regression: ok');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
