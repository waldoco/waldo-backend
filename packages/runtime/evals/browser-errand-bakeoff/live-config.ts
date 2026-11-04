import { z } from 'zod';
import { BAKEOFF_SPECS } from './specs';

// A live bake-off spends real money on real test accounts, so it starts only when the operator opts in, names a
// spend cap and supplies the targets file. Nothing here runs in CI.
const HARD_CAP_USD = 50;
const target = z.strictObject({
  origin: z.url().refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; } }),
  profileRef: z.string().min(1).max(200).nullable(),
  details: z.string().max(1000).optional(),
  expected: z.record(z.string().min(1).max(80), z.string().min(1).max(500)).optional(),
  account: z.string().max(320).optional(),
});
export const bakeoffTargetsSchema = z.record(z.string(), target).refine(
  targets => Object.keys(targets).every(type => BAKEOFF_SPECS.some(spec => spec.type === type)), 'targets name an unknown errand type');

export type LiveBakeoffConfig = Readonly<{ apiKey: string; spendCapUsd: number; runsPerType: number; maxCostUsdPerRun: number; targetsPath: string }>;

export function liveBakeoffConfig(env: Readonly<Record<string, string | undefined>>): LiveBakeoffConfig {
  if (env.BAKEOFF_LIVE !== '1') throw Error('Set BAKEOFF_LIVE=1 to run a paid bake-off against test accounts.');
  const cap = Number(env.BAKEOFF_SPEND_CAP_USD);
  if (!Number.isFinite(cap) || cap <= 0 || cap > HARD_CAP_USD) throw Error(`Set BAKEOFF_SPEND_CAP_USD between 0 and ${HARD_CAP_USD}.`);
  if (!env.BROWSER_USE_API_KEY?.startsWith('bu_')) throw Error('Set BROWSER_USE_API_KEY from the test project.');
  if (!env.BAKEOFF_TARGETS) throw Error('Set BAKEOFF_TARGETS to the local targets JSON file.');
  const runs = env.BAKEOFF_RUNS === undefined ? 5 : Number(env.BAKEOFF_RUNS);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw Error('BAKEOFF_RUNS must be 1-20.');
  return { apiKey: env.BROWSER_USE_API_KEY, spendCapUsd: cap, runsPerType: runs, maxCostUsdPerRun: Math.min(0.5, cap), targetsPath: env.BAKEOFF_TARGETS };
}
