// Runs the catalogue: k trials per scenario, each judged once, against one call budget. A graded trial passes
// only when the outcome judge, the voice judge (for a scenario with a voice rubric) and every receipt agree.
import type { ModelName } from '@waldo/contracts';
import type { LLMGatewayAdapter } from '../../src/llm/provider';
import type { CallBudget } from './budget';
import type { Judge, Verdict } from './judge';
import { failedReceipts } from './receipts';
import type { NightlyScenario } from './scenarios';
import { scorecard, type ScenarioTrials, type TrialOutcome } from './scorecard';
import { runTrial, type TrialRecord } from './trial';
import type { VoiceJudge, VoiceVerdict } from './voice';

export type NightlyRun = Readonly<{
  trials: number;
  budget: CallBudget;
  // A fresh model adapter per trial.
  gateway: () => LLMGatewayAdapter;
  judge: Judge;
  // Grades scenarios that carry a voice rubric; without it those scenarios are graded on outcome and receipts only.
  voiceJudge?: VoiceJudge;
  candidate: string;
  judgeModel: string;
  model?: ModelName;
  // The brain's flag-on menu: core tools up front, the rest found by tool search.
  toolSearch?: boolean;
  // A local look at each judged trial; the scorecard never carries any of it.
  show?: (scenario: NightlyScenario, record: TrialRecord, verdict: Verdict, checks: Readonly<{ voice?: VoiceVerdict; receipts: readonly string[] }>) => void;
}>;

const graded = (outcome: TrialOutcome) => outcome === 'pass' || outcome === 'fail';

export const runNightly = async (scenarios: readonly NightlyScenario[], run: NightlyRun) => {
  const results: ScenarioTrials[] = [];
  for (const scenario of scenarios) {
    const outcomes: TrialOutcome[] = [];
    const errors: string[] = [];
    let voiceFailed = 0;
    let receiptFailed = 0;
    for (let trial = 0; trial < run.trials; trial += 1) {
      if (scenario.blocked) { outcomes.push('blocked'); continue; }
      if (run.budget.exhausted()) { outcomes.push('budget_exhausted'); continue; }
      const record = await runTrial(scenario, { gateway: run.gateway(), budget: run.budget, ...(run.model ? { model: run.model } : {}), ...(run.toolSearch ? { toolSearch: true } : {}) });
      if (record.status !== 'ran') { outcomes.push(record.status); if (record.error) errors.push(record.error); continue; }
      const verdict = await run.judge({ scenario: scenario.id, rubric: scenario.rubric, transcript: record.transcript, tools: record.tools, effects: record.effects, final_state: record.final_state });
      let outcome: TrialOutcome = verdict.outcome;
      let voice: VoiceVerdict | undefined;
      const receipts = graded(outcome) ? failedReceipts(scenario.receipts ?? [], record) : [];
      if (receipts.length) { receiptFailed += 1; outcome = 'fail'; }
      if (graded(verdict.outcome) && scenario.rubric.voice && run.voiceJudge) {
        voice = await run.voiceJudge({ voice: scenario.rubric.voice, transcript: record.transcript, tools: record.tools, effects: record.effects });
        if (voice.outcome === 'fail') { voiceFailed += 1; outcome = 'fail'; }
        else if (voice.outcome !== 'pass' && outcome === 'pass') outcome = voice.outcome;
      }
      outcomes.push(outcome);
      run.show?.(scenario, record, verdict, { ...(voice ? { voice } : {}), receipts });
    }
    results.push({
      id: scenario.id, pain: scenario.pain, outcomes, ...(errors.length ? { harness_errors: errors } : {}),
      ...(scenario.rubric.voice ? { voice_failed: voiceFailed } : {}), ...(scenario.receipts?.length ? { receipt_failed: receiptFailed } : {}),
    });
  }
  return scorecard(results, { candidate: run.candidate, judge: run.judgeModel, trials: run.trials, usage: run.budget.usage() });
};
