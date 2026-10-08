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
// Fetch invocation logs persist the full URL, including /c/<ticket> and OAuth callback
// code/state. Automatic traces also include url.full/url.path. Until #205 removes those
// credentials from URLs and proves query redaction, retain only structured custom logs.
for (const [name, node] of [['top level', cfg], ['env.staging', staging]]) {
  const observability = node?.observability;
  if (observability?.enabled !== true || observability.logs?.enabled !== true) {
    bad.push(`${name} must retain structured Workers logs`);
  }
  if (observability?.logs?.invocation_logs !== false) {
    bad.push(`${name} must disable full-URL invocation logs until #205`);
  }
  if (observability?.traces?.enabled !== false) {
    bad.push(`${name} must disable automatic traces until #205`);
  }
}
if (!staging || staging.name !== 'waldo-runtime-staging') {
  bad.push('env.staging missing or name != waldo-runtime-staging');
} else {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ['assets', 'durable_objects', 'ratelimits', 'migrations', 'kv_namespaces', 'r2_buckets', 'd1_databases', 'queues', 'services']) {
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

// 4. The staging browser binding stays OFF in source until the network-side block is proven
//    (owner decision 2026-10-06, S0 live test). An enabled binding here ships on the next
//    Workers Builds promote. Turn it on only in the PR that records a passing S0 run.
// The record is the checked-in result of the S0 run on the throwaway env.s0 worker.
let s0Record;
try { s0Record = JSON.parse(readFileSync(path.replace(/wrangler\.jsonc$/, 's0-result.json'), 'utf8')); } catch { /* none recorded */ }
const s0Passed = s0Record?.passed === true && s0Record?.allowedLoaded === true && s0Record?.terminated === true
  && Array.isArray(s0Record?.probes) && s0Record.probes.length >= 3 && s0Record.probes.every((p) => p?.reached === false) && s0Record?.worker === 'waldo-s0-staging';
if (staging?.browser !== undefined && !s0Passed) bad.push('env.staging must not bind a browser until the S0 network-block test passes and packages/runtime/s0-result.json records it');
// The S0 worker has its own config (named envs would inherit the dashboard assets). It may bind only a browser.
const s0Cfg = (() => { try { return JSON.parse(readFileSync(path.replace(/wrangler\.jsonc$/, 'wrangler.s0.jsonc'), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return undefined; } })();
if (cfg?.env?.s0) bad.push('env.s0 must not exist in wrangler.jsonc: use wrangler.s0.jsonc (named envs inherit assets)');
if (s0Cfg) {
  if (s0Cfg.name !== 'waldo-s0-staging') bad.push('wrangler.s0.jsonc name must be waldo-s0-staging');
  for (const k of Object.keys(s0Cfg)) if (!['name', 'main', 'compatibility_date', 'compatibility_flags', 'vars', 'browser'].includes(k)) bad.push(`wrangler.s0.jsonc must not set ${k}`);
  if (s0Cfg.vars?.WALDO_ENVIRONMENT !== 'staging') bad.push('wrangler.s0.jsonc WALDO_ENVIRONMENT must be staging');
}

if (bad.length) {
  process.stderr.write(`guard-wrangler-local-bindings: ${bad.join('; ')}\n`);
  process.exit(1);
}
console.log('guard-wrangler-local-bindings: ok');
