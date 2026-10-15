#!/usr/bin/env node
// Guard: wrangler.jsonc deploy contracts.
// 1. Remote-only bindings (Workers AI, Vectorize) must never sit at top level:
//    vitest-pool-workers starts a remote proxy for them and the whole runtime
//    test pool dies demanding wrangler auth (2026-09-25, c76f7cd).
// 2. Bindings/vars/secrets are NON-INHERITABLE into named environments (official
//    wrangler docs): env.staging must mirror every top-level binding block
//    (durable_objects, ratelimits, migrations, ...) plus its own ai/vectorize.
//    The 2026-09-25 deploy shipped staging with ONLY ai+vectorize and healthz 404'd.
// 5. env.experimental (unmerged-branch Worker) mirrors env.staging's behaviour but owns every
//    stateful resource itself, runs no cron and never claims an owner DO namespace.
import { readFileSync } from 'node:fs';
import { parseJsonc } from '../jsonc.mjs';

const path = process.env.WRANGLER_CONFIG_PATH ?? 'packages/runtime/wrangler.jsonc';
const raw = readFileSync(path, 'utf8');
const bad = [];
for (const key of ['"ai"', '"vectorize"']) {
  if (new RegExp(`^  ${key}\\s*:`, 'm').test(raw)) bad.push(`${key} at top level`);
}

// comment/trailing-comma-tolerant parse for the structural checks
const cfg = parseJsonc(raw);
const staging = cfg?.env?.staging;
// Fetch invocation logs persist the full URL, including /c/<ticket> and OAuth callback
// code/state. Automatic traces also include url.full/url.path. Until #205 removes those
// credentials from URLs and proves query redaction, retain only structured custom logs.
const experimental = cfg?.env?.experimental;
for (const name of Object.keys(cfg?.env ?? {})) {
  if (name !== 'staging' && name !== 'experimental') bad.push(`env.${name} is not a recognised environment; add its mirror and isolation rules here first`);
}
const deployTargets = [['top level', cfg], ['env.staging', staging], ...(experimental ? [['env.experimental', experimental]] : [])];
for (const [name, node] of deployTargets) {
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

// 4. Staging browses through Cloudflare Browser Rendering, bound as BROWSER, by owner ruling; the S0 network-block
//    test no longer gates it. Production binds no browser: a binding there would ship on the next promote.
if (JSON.stringify(staging?.browser) !== JSON.stringify({ binding: 'BROWSER' })) bad.push('env.staging must bind Cloudflare Browser Rendering as BROWSER');
if (cfg.browser !== undefined) bad.push('the top-level (production) config must not bind a browser');

// 5. env.experimental. Bindings that hold no state mirror the top level exactly (its DO
//    namespaces are per-worker already); stateful bindings keep the binding names but must
//    point at resources no other environment uses.
if (experimental) {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (experimental.name !== 'waldo-runtime-experimental') bad.push('env.experimental missing or name != waldo-runtime-experimental');
  for (const key of ['assets', 'durable_objects', 'migrations', 'services']) {
    if (cfg[key] !== undefined && !eq(cfg[key], experimental[key])) bad.push(`env.experimental does not mirror top-level "${key}"`);
  }
  for (const key of ['main', 'limits', 'compatibility_flags', 'browser']) {
    if (!eq(staging?.[key], experimental[key])) bad.push(`env.experimental does not mirror env.staging "${key}"`);
  }
  if (experimental.triggers !== undefined) bad.push('env.experimental must not declare triggers (the health retention sweep is staging only)');
  if (!experimental.ai) bad.push('env.experimental missing ai binding');
  const stateful = [
    ['r2_buckets', 'bucket_name', 'R2 bucket'],
    ['vectorize', 'index_name', 'Vectorize index'],
    ['ratelimits', 'namespace_id', 'rate-limiter namespace'],
    ['kv_namespaces', 'id', 'KV namespace'],
    ['d1_databases', 'database_id', 'D1 database'],
  ];
  if ([cfg, staging, experimental].some((node) => node?.queues !== undefined)) bad.push('queues have no env.experimental isolation rule yet; add one before binding a queue');
  const others = [cfg, staging, cfg.previews].filter(Boolean);
  const names = (list) => (Array.isArray(list) ? list.map((b) => b?.binding ?? b?.name).sort() : []);
  for (const [key, resource, label] of stateful) {
    const reference = staging?.[key] ?? cfg[key];
    if (reference === undefined && experimental[key] === undefined) continue;
    if (!eq(names(reference), names(experimental[key]))) bad.push(`env.experimental ${key} bindings must match env.staging by name`);
    const used = new Set(others.flatMap((node) => (Array.isArray(node[key]) ? node[key].map((b) => b?.[resource]) : [])));
    for (const binding of Array.isArray(experimental[key]) ? experimental[key] : []) {
      if (!binding?.[resource] || used.has(binding[resource])) bad.push(`env.experimental shares ${label} "${binding?.[resource]}" with another environment`);
    }
  }
  const topVars = cfg.vars ?? {};
  const vars = experimental.vars ?? {};
  for (const k of Object.keys(topVars)) if (!(k in vars)) bad.push(`env.experimental missing var "${k}"`);
  for (const k of Object.keys(vars)) if (!(k in topVars)) bad.push(`top level missing var "${k}" present in env.experimental`);
  // Every staging-only runtime gate compares WALDO_ENVIRONMENT with the literal "staging".
  if (vars.WALDO_ENVIRONMENT !== 'staging') bad.push('env.experimental WALDO_ENVIRONMENT must be "staging" (staging behaviour, never production)');
  // waldo.workspace_owner_binding admits one namespace per owner and environment, first claim
  // wins: a second namespace against the shared staging project would lock staging out.
  if (vars.WALDO_OWNER_DO_NAMESPACE !== '') bad.push('env.experimental WALDO_OWNER_DO_NAMESPACE must be empty (staging owns the workspace mapping)');
  if (vars.IMESSAGE_CONNECTOR_ENABLED !== '0') bad.push('env.experimental IMESSAGE_CONNECTOR_ENABLED must be "0" (one iMessage bridge, on staging)');
}

if (bad.length) {
  process.stderr.write(`guard-wrangler-local-bindings: ${bad.join('; ')}\n`);
  process.exit(1);
}
console.log('guard-wrangler-local-bindings: ok');
