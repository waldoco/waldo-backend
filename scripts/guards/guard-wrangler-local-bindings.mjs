#!/usr/bin/env node
// Guard: two wrangler.jsonc contract checks.
// 1. Remote-only bindings (Workers AI, Vectorize) must never sit at top level:
//    vitest-pool-workers starts a remote proxy for them and the whole runtime
//    test pool dies demanding wrangler auth (2026-09-25, c76f7cd).
// 2. Bindings/vars/secrets are NON-INHERITABLE into named environments (official
//    wrangler docs): env.staging must mirror every top-level binding block
//    (durable_objects, ratelimits, migrations, ...) plus its own ai/vectorize.
//    The 2026-09-25 deploy shipped staging with ONLY ai+vectorize and healthz 404'd.
import { readFileSync } from 'node:fs';

const path = process.env.WRANGLER_CONFIG_PATH ?? 'packages/runtime/wrangler.jsonc';
const raw = readFileSync(path, 'utf8');
const bad = [];
for (const key of ['"ai"', '"vectorize"']) {
  if (new RegExp(`^  ${key}\\s*:`, 'm').test(raw)) bad.push(`${key} at top level`);
}

// comment/trailing-comma-tolerant parse for the structural checks
const text = raw.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1');
const cfg = JSON.parse(text);
const staging = cfg?.env?.staging;
if (!staging || staging.name !== 'waldo-runtime-staging') {
  bad.push('env.staging missing or name != waldo-runtime-staging');
} else {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ['durable_objects', 'ratelimits', 'migrations', 'kv_namespaces', 'r2_buckets', 'd1_databases', 'queues', 'services', 'vars']) {
    if (cfg[key] !== undefined && !eq(cfg[key], staging[key])) {
      bad.push(`env.staging does not mirror top-level "${key}"`);
    }
  }
  if (!staging.ai) bad.push('env.staging missing ai binding');
  if (!staging.vectorize) bad.push('env.staging missing vectorize binding');
}

if (bad.length) {
  process.stderr.write(`guard-wrangler-local-bindings: ${bad.join('; ')}\n`);
  process.exit(1);
}
console.log('guard-wrangler-local-bindings: ok');
