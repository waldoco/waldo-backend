#!/usr/bin/env node
// Read-only staging deploy gate: what is deployed, is it healthy, how to roll back.
// Smoke probes need no credential and only exercise refusal paths. Identity reads use the
// existing staging secrets when present and are reported UNAVAILABLE when not. Nothing here
// deploys, rolls back or writes; only allow-listed fields are printed, never response bodies.
//   node scripts/staging-gate.mjs [--expect-sha <7-40 hex>]
// Optional env: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (Worker), SUPABASE_ACCESS_TOKEN (edge functions, migrations).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareHistory, localManifest, readHistory, STAGING_PROJECT as PROJECT } from './staging-migration-preflight.mjs';

export const STAGING_WORKER_URL = 'https://waldo-runtime-staging.piyushfulper3210.workers.dev';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export function deployedWorker(list) {
  const valid = Array.isArray(list) && list.length > 0 && list.every((d) => typeof d?.created_on === 'string'
    && Array.isArray(d.versions) && d.versions.length > 0
    && d.versions.every((v) => UUID.test(v?.version_id) && Number.isFinite(v.percentage)));
  if (!valid) throw new Error('deployments_shape');
  const ordered = [...list].sort((a, b) => b.created_on.localeCompare(a.created_on));
  const [current, ...earlier] = ordered;
  const live = new Set(current.versions.map((v) => v.version_id));
  const target = earlier.find((d) => d.versions.length === 1 && !live.has(d.versions[0].version_id));
  return {
    versions: current.versions.map((v) => ({ id: v.version_id, percentage: v.percentage })),
    createdOn: current.created_on,
    rollbackTo: target?.versions[0].version_id ?? null,
  };
}

export function versionFacts(version) {
  if (!UUID.test(version?.id) || !Array.isArray(version.resources?.bindings)) throw new Error('version_shape');
  const { bindings } = version.resources;
  const release = bindings.find((b) => b.type === 'plain_text' && b.name === 'WALDO_RELEASE')?.text;
  return { id: version.id, release: typeof release === 'string' ? release : null, browser: bindings.some((b) => b.type === 'browser' && b.name === 'BROWSER') };
}

// Supabase skips underscore-prefixed function directories (shared helpers); so does this.
export function functionSlugs(entries) {
  return entries.filter((e) => e.dir && !e.name.startsWith('_')).map((e) => e.name).sort();
}

export function edgeFunctionFacts(list, slugs) {
  if (!Array.isArray(list)) throw new Error('functions_shape');
  return slugs.map((slug) => {
    const fn = list.find((f) => f?.slug === slug);
    if (!fn) return { slug, missing: true };
    if (!Number.isInteger(fn.version) || typeof fn.status !== 'string' || !Number.isFinite(fn.updated_at)) throw new Error('functions_shape');
    return { slug, version: fn.version, status: fn.status, verifyJwt: fn.verify_jwt === true, updatedAt: new Date(fn.updated_at).toISOString() };
  });
}

const sameSha = (a, b) => SHA.test(a) && SHA.test(b) && (a.startsWith(b) || b.startsWith(a));
const EXPECTATIONS = {
  healthz: ({ status, body }, expectSha) => {
    const release = typeof body?.release === 'string' ? body.release : null;
    const pass = status === 200 && body?.ok === true && SHA.test(release ?? '') && (!expectSha || sameSha(release, expectSha));
    return { pass, observed: `${status} release ${SHA.test(release ?? '') ? release : 'unstamped'}` };
  },
  'telegram-unsigned': ({ status }) => ({ pass: status === 403, observed: String(status) }),
  'gmail-push-unsigned': ({ status }) => ({ pass: status === 403, observed: String(status) }),
  // The gateway refuses with 401 when JWT verification is on; otherwise the function itself
  // answers 200 carrying its own 401 refusal.
  'connector-proxy-unsigned': ({ status, body }) => {
    const inner = body?.error?.status === 401 && body.error.message === 'unsigned proxy call';
    return { pass: status === 401 || (status === 200 && inner), observed: status === 200 ? `200 inner ${body?.error?.status ?? 'none'}` : String(status) };
  },
};

export function evaluateProbe(name, response, expectSha) {
  const expectation = EXPECTATIONS[name];
  if (!expectation) throw new Error('unknown_probe');
  return expectation(response, expectSha);
}

export function verdict(checks) {
  if (!checks.length || checks.some((c) => c.result === 'FAIL')) return 'FAIL';
  return checks.some((c) => c.result === 'UNAVAILABLE') ? 'INCOMPLETE' : 'PASS';
}

const probe = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
};

const wrangler = (args) => {
  try {
    return JSON.parse(execFileSync('npx', ['--no-install', 'wrangler', ...args, '--env', 'staging', '--json'], {
      cwd: fileURLToPath(new URL('../packages/runtime/', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    }));
  } catch { throw new Error(`wrangler_${args[0]}_failed`); }
};

const supabaseFunctions = async (token) => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/functions`, {
    method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`functions_http_${response.status}`);
  return response.json();
};

const reason = (error) => (/^[a-z0-9_]+$/.test(error?.message) ? error.message : 'unexpected_error');

export async function main(argv = process.argv.slice(2), env = process.env) {
  const at = argv.indexOf('--expect-sha');
  const expectSha = at >= 0 ? argv[at + 1] : '';
  if (at >= 0 && !SHA.test(expectSha ?? '')) throw new Error('expect_sha_invalid');
  const checks = [];
  const record = (name, result, observed) => {
    checks.push({ name, result });
    console.log(`${result} ${name} | ${observed}`);
  };

  console.log('== Is it healthy? (unauthenticated, refusal paths only)');
  const probes = [
    ['healthz', `${STAGING_WORKER_URL}/healthz`, { method: 'GET' }],
    ['telegram-unsigned', `${STAGING_WORKER_URL}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['gmail-push-unsigned', `${STAGING_WORKER_URL}/events/gmail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['connector-proxy-unsigned', `https://${PROJECT}.supabase.co/functions/v1/connector-proxy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ];
  let release = null;
  for (const [name, url, init] of probes) {
    try {
      const response = await probe(url, init);
      const { pass, observed } = evaluateProbe(name, response, expectSha);
      if (name === 'healthz' && pass) release = response.body.release;
      record(name, pass ? 'PASS' : 'FAIL', observed);
    } catch (error) { record(name, 'FAIL', `unreachable ${error?.name ?? 'error'}`); }
  }

  console.log('== What is deployed?');
  let worker = null;
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      worker = deployedWorker(wrangler(['deployments', 'list']));
      const facts = worker.versions.map((v) => ({ ...versionFacts(wrangler(['versions', 'view', v.id])), percentage: v.percentage }));
      for (const f of facts) record('worker-version', SHA.test(f.release ?? '') ? 'PASS' : 'FAIL', `${f.id} ${f.percentage}% release ${f.release ?? 'none'} deployed ${worker.createdOn}`);
      record('browser-binding', facts.every((f) => f.browser) ? 'PASS' : 'FAIL', facts.map((f) => `${f.id} ${f.browser ? 'present' : 'absent'}`).join(', '));
      if (facts.length === 1 && release) record('healthz-matches-version', sameSha(release, facts[0].release ?? '') ? 'PASS' : 'FAIL', `healthz ${release} version ${facts[0].release ?? 'none'}`);
    } catch (error) { record('worker-version', 'FAIL', reason(error)); }
  } else record('worker-version', 'UNAVAILABLE', 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID not set');

  if (env.SUPABASE_ACCESS_TOKEN) {
    const slugs = functionSlugs(readdirSync(new URL('../supabase/functions/', import.meta.url), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })));
    try {
      for (const f of edgeFunctionFacts(await supabaseFunctions(env.SUPABASE_ACCESS_TOKEN), slugs)) {
        if (f.missing) record(`edge-function ${f.slug}`, 'FAIL', 'not deployed');
        else record(`edge-function ${f.slug}`, f.status === 'ACTIVE' ? 'PASS' : 'FAIL', `version ${f.version} ${f.status} verify_jwt ${f.verifyJwt} updated ${f.updatedAt}`);
      }
    } catch (error) { record('edge-functions', 'FAIL', reason(error)); }
    try {
      const { appliedVersions, pending } = compareHistory(localManifest(new URL('../supabase/migrations/', import.meta.url)), await readHistory(env.SUPABASE_ACCESS_TOKEN, PROJECT));
      record('migrations', 'PASS', `last applied ${appliedVersions.at(-1) ?? 'none'}, ${pending.length} pending against this checkout`);
    } catch (error) { record('migrations', 'FAIL', reason(error)); }
  } else record('supabase', 'UNAVAILABLE', 'SUPABASE_ACCESS_TOKEN not set');

  console.log('== How do we roll back? (printed only, never run here)');
  const target = worker?.rollbackTo ?? '<previous-version-id from: npx wrangler deployments list --env staging>';
  console.log(`Worker: scripts/staging-rollback.sh ${target} --confirm ${target} --message '<reason>'`);
  console.log('Edge function: redeploy it from the previous reviewed SHA; Supabase keeps no restorable prior version.');
  console.log('Migrations: forward-only. Write a new reviewed migration; see docs/ops/REVIEWED_STAGING_MIGRATION_ROUTE.md.');

  const result = verdict(checks);
  console.log(`GATE ${result}`);
  return result === 'PASS' ? 0 : result === 'INCOMPLETE' ? 2 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`GATE FAIL ${reason(error)}`); process.exitCode = 1; });
}
