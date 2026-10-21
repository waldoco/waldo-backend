#!/usr/bin/env node
// STAGING trace: simulated device against a deployed staging Worker with the owner's own console session.
// Creates one test device, exercises the planned steps, then revokes it. No spend, no secrets stored.
// Run only with the owner's explicit go for this run. `--dry-run` (or WALDO_TRACE_DRY_RUN=1) runs the guard,
// prints the target origin and the planned effects, and exits without any network call.
// This module imports no network code: the flow loads only after the guard passes and dry run is off.
import { stagingTarget } from './device-bridge-staging-target.mjs';
import { TRACE_PLAN } from './device-bridge-staging-plan.mjs';

export async function main({ env, argv, log, fail, loadFlow = () => import('./device-bridge-staging-flow.mjs') }) {
  let target;
  try {
    const unknown = argv.filter(arg => arg !== '--dry-run');
    if (unknown.length) throw new Error('unknown argument (only --dry-run is accepted)');
    target = stagingTarget(env);
  } catch (error) { fail(`STAGING: REFUSED ${error.message}`); return 1; }
  if (argv.includes('--dry-run') || env.WALDO_TRACE_DRY_RUN === '1') {
    log(`STAGING DRY-RUN: target origin ${target.origin}`);
    TRACE_PLAN.forEach((step, i) => log(`STAGING DRY-RUN: ${i + 1}. ${step.effect}`));
    log('STAGING DRY-RUN: no request was sent');
    return 0;
  }
  const { runDeviceBridgeTrace } = await loadFlow();
  try {
    await runDeviceBridgeTrace({ origin: target.origin, cookie: target.cookie, report: line => log(`STAGING: ${line}`) });
    return 0;
  } catch (error) {
    // Only the message: assertion messages are written to exclude cookie, CSRF, code and key material.
    fail(`STAGING: FAIL ${error?.message ?? 'unknown error'}`); return 1;
  }
}

if (globalThis.process?.argv?.[1]?.endsWith('device-bridge-staging-trace.mjs'))
  process.exitCode = await main({ env: process.env, argv: process.argv.slice(2), log: console.log, fail: console.error });
