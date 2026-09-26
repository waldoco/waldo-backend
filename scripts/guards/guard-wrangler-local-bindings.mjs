#!/usr/bin/env node
// Guard: wrangler.jsonc deploy contracts.
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
// Even custom log metadata can include request URLs. OAuth callback code/state must have
// query redaction pinned for every deploy. The remaining /c/<ticket> path cannot be
// redacted by that setting, so automatic traces stay off until #205's cutover and proof.
for (const [name, node] of [['top level', cfg], ['env.staging', staging]]) {
  const observability = node?.observability;
  if (observability?.enabled !== true || observability.logs?.enabled !== true) {
    bad.push(`${name} must retain structured Workers logs`);
  }
  if (observability?.logs?.invocation_logs !== false) {
    bad.push(`${name} must disable full-URL invocation logs until #205`);
  }
  if (observability?.redact_query_string !== true) {
    bad.push(`${name} must redact request query strings in logs and traces`);
  }
  if (observability?.traces?.enabled !== false) {
    bad.push(`${name} must disable automatic traces until #205`);
  }
}
if (!staging || staging.name !== 'waldo-runtime-staging') {
  bad.push('env.staging missing or name != waldo-runtime-staging');
} else {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ['durable_objects', 'ratelimits', 'migrations', 'kv_namespaces', 'r2_buckets', 'd1_databases', 'queues', 'services']) {
    if (cfg[key] !== undefined && !eq(cfg[key], staging[key])) {
      bad.push(`env.staging does not mirror top-level "${key}"`);
    }
  }
  // vars mirror by KEY SET, not value: trace identity (WALDO_ENVIRONMENT) must differ per
  // environment or staging traces pollute production. Every top-level var key must exist in
  // staging and vice versa, and both sides must pin the trace identity vars.
  const topVars = cfg.vars ?? {};
  const stagingVars = staging.vars ?? {};
  for (const k of Object.keys(topVars)) if (!(k in stagingVars)) bad.push(`env.staging missing var "${k}"`);
  for (const k of Object.keys(stagingVars)) if (!(k in topVars)) bad.push(`top level missing var "${k}" present in env.staging`);
  if (topVars.WALDO_ENVIRONMENT !== 'production') bad.push('top-level WALDO_ENVIRONMENT must be "production"');
  if (stagingVars.WALDO_ENVIRONMENT !== 'staging') bad.push('env.staging WALDO_ENVIRONMENT must be "staging"');
  if (!('WALDO_RELEASE' in topVars) || !('WALDO_RELEASE' in stagingVars)) bad.push('WALDO_RELEASE must exist at top level and in env.staging (deploy wrapper restamps it)');
  if (!staging.ai) bad.push('env.staging missing ai binding');
  if (!staging.vectorize) bad.push('env.staging missing vectorize binding');
}

// 3. The public console signup FAILS CLOSED when RESPONSIBILITY_RATE_LIMITER is absent
//    (owner decision 2026-09-25 16:39): the binding must exist at top level and in every
//    named env, so no deployable environment can serve signup unthrottled.
const hasLimiter = (cfgNode) =>
  Array.isArray(cfgNode?.ratelimits) && cfgNode.ratelimits.some((b) => b?.name === 'RESPONSIBILITY_RATE_LIMITER');
if (!hasLimiter(cfg)) bad.push('top-level ratelimits missing RESPONSIBILITY_RATE_LIMITER (console signup fails closed without it)');
for (const [envName, envCfg] of Object.entries(cfg?.env ?? {})) {
  if (!hasLimiter(envCfg)) bad.push(`env.${envName} missing RESPONSIBILITY_RATE_LIMITER (console signup fails closed without it)`);
}

if (bad.length) {
  process.stderr.write(`guard-wrangler-local-bindings: ${bad.join('; ')}\n`);
  process.exit(1);
}
console.log('guard-wrangler-local-bindings: ok');
