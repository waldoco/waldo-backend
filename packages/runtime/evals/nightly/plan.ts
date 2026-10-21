// What a live run will spend, before anyone spends it, and what pass-rate floor its scorecard supports after.
//   tsx evals/nightly/plan.ts                     the call plan for the catalogue at WALDO_EVAL_TRIALS (default 3)
//   tsx evals/nightly/plan.ts <scorecard.json>    the live floor the first graded scorecard supports
// No network, no keys. docs/evals/LIVE_BASELINE_RUNBOOK.md explains the numbers.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NIGHTLY_SCENARIOS } from './catalogue';
import type { NightlyScenario } from './scenarios';
import type { Scorecard } from './scorecard';

// Model calls per owner turn or fired reminder, the memory writer's included: the answer alone at the low end, up to
// four tool rounds and the answer at the high end. The recorded dry run makes about one per turn; a live turn makes more.
export const CALLS_PER_TURN = { low: 2, high: 5 } as const;

export const callPlan = (scenarios: readonly NightlyScenario[], trials: number) => {
  const runnable = scenarios.filter((scenario) => !scenario.blocked);
  const turns = runnable.reduce((sum, scenario) => sum + scenario.steps.filter((step) => 'say' in step || 'fire_due' in step).length, 0) * trials;
  const judge = runnable.length * trials + runnable.filter((scenario) => scenario.rubric.voice).length * trials;
  const candidate = { low: turns * CALLS_PER_TURN.low, high: turns * CALLS_PER_TURN.high };
  return {
    trials, scenarios: scenarios.length, runnable: runnable.length, owner_turns: turns, judge_calls: judge, candidate_calls: candidate,
    // Room for the high estimate, rounded up: a run that exhausts the budget fails the gate.
    suggested_max_calls: Math.ceil((candidate.high + judge) / 100) * 100,
  };
};

// The 95% Wilson lower bound on a pass rate: with tens of graded trials the point estimate is noise, so the floor
// sits below what the first run showed, at the rate it can claim with confidence, rounded down to a 0.05 step.
export const wilsonLower = (passed: number, graded: number, z = 1.96): number => {
  if (graded === 0) return 0;
  const rate = passed / graded;
  const centre = rate + (z * z) / (2 * graded);
  const margin = z * Math.sqrt((rate * (1 - rate)) / graded + (z * z) / (4 * graded * graded));
  return (centre - margin) / (1 + (z * z) / graded);
};
export const suggestedFloor = (card: Scorecard) => {
  const passed = card.scenarios.reduce((sum, row) => sum + row.passed, 0);
  const graded = card.scenarios.reduce((sum, row) => sum + row.passed + row.failed, 0);
  return { passed, graded, pass_rate: card.overall.pass_rate, wilson_lower: wilsonLower(passed, graded), suggested_min_pass_rate: Math.floor(wilsonLower(passed, graded) * 20) / 20 };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cardPath] = process.argv.slice(2);
  const out = cardPath
    ? suggestedFloor(JSON.parse(readFileSync(cardPath, 'utf8')) as Scorecard)
    : callPlan(NIGHTLY_SCENARIOS, Number(process.env.WALDO_EVAL_TRIALS ?? '3'));
  console.log(JSON.stringify(out, null, 2));
}
