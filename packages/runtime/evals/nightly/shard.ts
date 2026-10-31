// WALDO_EVAL_SHARD=<n>/<of> runs one slice of the scenarios a run selected, so a long run can be cut into jobs that each finish
// inside a hosted runner's limit. Scenarios are dealt out by their expected cost, largest first to the lightest shard, so the
// slices take about the same time; ties go to the lower shard, so the same catalogue always splits the same way.
import { callPlan } from './plan';
import type { NightlyScenario } from './scenarios';

const SHARD_SPEC = /^([1-9]\d{0,1})\/([1-9]\d{0,1})$/;

export const parseShard = (spec: string): Readonly<{ index: number; of: number }> => {
  const match = SHARD_SPEC.exec(spec);
  const index = Number(match?.[1]);
  const of = Number(match?.[2]);
  if (!match || index > of) throw new Error('WALDO_EVAL_SHARD takes <n>/<of> with n between 1 and of');
  return { index, of };
};

const cost = (scenario: NightlyScenario) => { const plan = callPlan([scenario], 1); return plan.candidate_calls.high + plan.judge_calls; };

export const shardOf = (scenarios: readonly NightlyScenario[], spec: string | undefined): readonly NightlyScenario[] => {
  if (spec === undefined || spec.trim() === '') return scenarios;
  const { index, of } = parseShard(spec.trim());
  const load = Array.from({ length: of }, () => 0);
  const taken = Array.from({ length: of }, () => new Set<NightlyScenario>());
  for (const scenario of [...scenarios].sort((a, b) => cost(b) - cost(a) || scenarios.indexOf(a) - scenarios.indexOf(b))) {
    const lightest = load.indexOf(Math.min(...load));
    load[lightest]! += cost(scenario);
    taken[lightest]!.add(scenario);
  }
  return scenarios.filter((scenario) => taken[index - 1]!.has(scenario));
};
