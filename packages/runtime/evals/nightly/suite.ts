// Runs the catalogue: k trials per scenario, each judged once, against one call budget.
import type { ModelName } from '@waldo/contracts';
import type { LLMGatewayAdapter } from '../../src/llm/provider';
import type { CallBudget } from './budget';
import type { Judge, Verdict } from './judge';
import type { NightlyScenario } from './scenarios';
import { scorecard, type ScenarioTrials, type TrialOutcome } from './scorecard';
import { runTrial, type TrialRecord } from './trial';

export type NightlyRun = Readonly<{
  trials: number;
  budget: CallBudget;
  // A fresh model adapter per trial.
  gateway: () => LLMGatewayAdapter;
  judge: Judge;
  candidate: string;
  judgeModel: string;
  model?: ModelName;
  // A local look at each judged trial; the scorecard never carries any of it.
  show?: (scenario: NightlyScenario, record: TrialRecord, verdict: Verdict) => void;
}>;

export const runNightly = async (scenarios: readonly NightlyScenario[], run: NightlyRun) => {
  const results: ScenarioTrials[] = [];
  for (const scenario of scenarios) {
    const outcomes: TrialOutcome[] = [];
    for (let trial = 0; trial < run.trials; trial += 1) {
      if (scenario.blocked) { outcomes.push('blocked'); continue; }
      if (run.budget.exhausted()) { outcomes.push('budget_exhausted'); continue; }
      const record = await runTrial(scenario, { gateway: run.gateway(), budget: run.budget, ...(run.model ? { model: run.model } : {}) });
      if (record.status !== 'ran') { outcomes.push(record.status); continue; }
      const verdict = await run.judge({ scenario: scenario.id, rubric: scenario.rubric, transcript: record.transcript, tools: record.tools, effects: record.effects, final_state: record.final_state });
      outcomes.push(verdict.outcome);
      run.show?.(scenario, record, verdict);
    }
    results.push({ id: scenario.id, pain: scenario.pain, outcomes });
  }
  return scorecard(results, { candidate: run.candidate, judge: run.judgeModel, trials: run.trials, usage: run.budget.usage() });
};
