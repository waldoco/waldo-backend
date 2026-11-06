#!/usr/bin/env node
// Read-only beta deploy gate (docs/ops/BETA_ENVIRONMENT_2026-11-04.md): is the beta Worker healthy, what is deployed,
// how to roll back. Same shape as scripts/staging-gate.mjs, with beta's own expectations: a channel beta has not set up
// answers 404 where staging answers 403, and beta must bind no browser. Probes send no credential and only exercise
// refusal paths. Nothing here deploys, rolls back or writes; only allow-listed fields are printed, never response bodies.
//   node scripts/beta-gate.mjs [--expect-sha <7-40 hex>]
// Optional env: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (Worker versions).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deployedWorker, evaluateProbe, verdict, versionFacts } from './staging-gate.mjs';
import { parseJsonc } from './jsonc.mjs';

export const BETA_CONFIG = parseJsonc(readFileSync(new URL('../packages/runtime/wrangler.jsonc', import.meta.url), 'utf8')).env.beta;
// The beta Supabase project ref, committed once the project exists (runbook step B3). Empty, the edge-function probe is UNAVAILABLE.
export const BETA_SUPABASE_PROJECT = '';
const SHA = /^[0-9a-f]{7,40}$/;
const PROJECT_REF = /^[a-z]{20}$/;

const status = (expected) => ({ status }) => ({ pass: status === expected, observed: String(status) });

// Each probe: name, path or absolute URL, request, expectation. A channel's expectation follows whether beta's config names
// that channel: Gmail push answers 403 only once GMAIL_PUSH_PROJECT is set, and WhatsApp POST only once a number exists.
export function betaProbes(vars, project) {
  const json = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  return [
    ['healthz', '/healthz', { method: 'GET' }, null],
    ['app-signed-out', '/app/v1/controls', { method: 'GET' }, status(401)],
    ['console-signed-out', '/console', { method: 'GET' }, status(303)],
    ['probe-route-closed', '/probe/turn', json, status(404)],
    ['telegram-off', '/telegram/webhook', json, status(404)],
    ['whatsapp-verify-refused', '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=beta-gate&hub.challenge=0', { method: 'GET' }, status(403)],
    ['whatsapp-unsigned', '/whatsapp/webhook', json, status(vars.WHATSAPP_WALDO_NUMBER ? 403 : 404)],
    ['gmail-push-unsigned', '/events/gmail', json, status(vars.GMAIL_PUSH_PROJECT ? 403 : 404)],
    ...(PROJECT_REF.test(project) ? [['connector-proxy-unsigned', `https://${project}.supabase.co/functions/v1/connector-proxy`, json, null]] : []),
  ];
}

const reason = (error) => (/^[a-z0-9_]+$/.test(error?.message) ? error.message : 'unexpected_error');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const wrangler = (args) => {
  try {
    return JSON.parse(execFileSync('npx', ['--no-install', 'wrangler', ...args, '--env', 'beta', '--json'], {
      cwd: fileURLToPath(new URL('../packages/runtime/', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    }));
  } catch { throw new Error(`wrangler_${args[0]}_failed`); }
};

export async function main(argv = process.argv.slice(2), env = process.env, { fetcher = fetch, wait = sleep, config = BETA_CONFIG, project = BETA_SUPABASE_PROJECT, cli = wrangler } = {}) {
  const at = argv.indexOf('--expect-sha');
  const expectSha = at >= 0 ? argv[at + 1] : '';
  if (at >= 0 && !SHA.test(expectSha ?? '')) throw new Error('expect_sha_invalid');
  const origin = config?.vars?.WALDO_PUBLIC_ORIGIN;
  if (!origin) throw new Error('beta_origin_unset');
  const checks = [];
  const record = (name, result, observed) => {
    checks.push({ name, result });
    console.log(`${result} ${name} | ${observed}`);
  };

  console.log(`== Is it healthy? ${origin} (unauthenticated, refusal paths only)`);
  for (const [name, path, init, expect] of betaProbes(config.vars, project)) {
    const tries = name === 'healthz' && expectSha ? 3 : 1;
    for (let attempt = 1; ; attempt += 1) {
      let outcome;
      try {
        const response = await fetcher(new URL(path, origin), { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        outcome = expect ? expect({ status: response.status }) : evaluateProbe(name, { status: response.status, body }, expectSha);
      } catch (error) { outcome = { pass: false, observed: `unreachable ${error?.name ?? 'error'}` }; }
      if (outcome.pass || attempt === tries) {
        record(name, outcome.pass ? 'PASS' : 'FAIL', tries > 1 ? `${outcome.observed} (try ${attempt}/${tries})` : outcome.observed);
        break;
      }
      await wait(10000);
    }
  }
  if (!PROJECT_REF.test(project)) record('connector-proxy-unsigned', 'UNAVAILABLE', 'BETA_SUPABASE_PROJECT not committed yet');

  console.log('== What is deployed?');
  let worker = null;
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      worker = deployedWorker(cli(['deployments', 'list']));
      const facts = worker.versions.map((v) => ({ ...versionFacts(cli(['versions', 'view', v.id])), percentage: v.percentage }));
      for (const f of facts) record('worker-version', SHA.test(f.release ?? '') ? 'PASS' : 'FAIL', `${f.id} ${f.percentage}% release ${f.release ?? 'none'} deployed ${worker.createdOn}`);
      record('no-browser-binding', facts.some((f) => f.browser) ? 'FAIL' : 'PASS', facts.map((f) => `${f.id} ${f.browser ? 'present' : 'absent'}`).join(', '));
    } catch (error) { record('worker-version', 'FAIL', reason(error)); }
  } else record('worker-version', 'UNAVAILABLE', 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID not set');

  console.log('== How do we roll back? (printed only, never run here)');
  const target = worker?.rollbackTo ?? '<previous-version-id from: npx wrangler deployments list --env beta>';
  console.log(`Worker: scripts/beta-rollback.sh ${target} --confirm ${target} --message '<reason>'`);
  console.log('Edge function: redeploy it from the previous promoted tag; Supabase keeps no restorable prior version.');
  console.log('Migrations: forward-only. Write a new reviewed migration and promote it through staging first.');

  const result = verdict(checks);
  console.log(`GATE ${result}`);
  return result === 'PASS' ? 0 : result === 'INCOMPLETE' ? 2 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(`GATE FAIL ${reason(error)}`); process.exitCode = 1; });
}
