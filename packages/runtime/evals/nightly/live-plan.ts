// How a live run is cut up and what it may spend. This file is the one place the workflow's trials, shards and call caps
// live: the workflow asks it (`tsx evals/nightly/live-plan.ts`, with WALDO_EVAL_SUBSET set) from the checked-out tree, so the
// default-branch copy of the workflow holds no numbers to drift from the plan a test holds these to.
//   all        the whole catalogue: 3 trials in 4 shards, under one total cap. A job on a hosted runner stops at 360 minutes
//              and a stopped job loses its scorecard, so the run is cut into jobs of about a quarter of it.
//   live / ids the subset or the named scenarios: 2 trials in one shard, under its cap.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NIGHTLY_SCENARIOS } from './catalogue';
import { callPlan } from './plan';
import type { NightlyScenario } from './scenarios';
import { shardOf } from './shard';
import { selectScenarios } from './subset';

export const LIVE_RUNS = {
  all: { trials: 3, total_cap: 5_900, shards: 4 },
  subset: { trials: 2, total_cap: 600, shards: 1 },
} as const;

export type LiveShard = Readonly<{ index: number; shard: string; cap: number }>;
export type LiveRunPlan = Readonly<{ subset: string; trials: number; shards: readonly LiveShard[] }>;

export const liveRunPlan = (spec: string | undefined, scenarios: readonly NightlyScenario[]): LiveRunPlan => {
  const subset = (spec ?? '').trim() || 'live';
  const picked = selectScenarios(subset, scenarios);
  const run = subset === 'all' ? LIVE_RUNS.all : LIVE_RUNS.subset;
  const label = (index: number) => `${index}/${run.shards}`;
  const plans = Array.from({ length: run.shards }, (_, at) => callPlan(shardOf(picked, label(at + 1)), run.trials));
  const total = plans.reduce((sum, plan) => sum + plan.candidate_calls.high + plan.judge_calls, 0);
  if (total > run.total_cap) throw new Error(`the plan needs ${total} calls and the run may spend ${run.total_cap}`);
  // The total is shared out in proportion to each shard's rounded plan (its suggested maximum), so while those fit under the
  // total no shard's cap is under its own; the caps never sum to more than the total.
  const rounded = plans.reduce((sum, plan) => sum + plan.suggested_max_calls, 0), share = Math.max(rounded, run.total_cap);
  return { subset, trials: run.trials, shards: plans.map((plan, at) => ({ index: at + 1, shard: label(at + 1), cap: Math.floor((plan.suggested_max_calls * run.total_cap) / share) })) };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const plan = liveRunPlan(process.env.WALDO_EVAL_SUBSET, NIGHTLY_SCENARIOS);
  // The planner has already refused anything it does not know, so what it writes to the job's outputs is its own.
  const lines = `subset=${plan.subset}\ntrials=${plan.trials}\nmatrix=${JSON.stringify(plan.shards)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines); else process.stdout.write(lines);
}
