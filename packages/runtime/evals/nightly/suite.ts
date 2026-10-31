// Runs the catalogue: k trials per scenario, each judged once, against one call budget. A graded trial passes
// only when the outcome judge, the voice judge (for a scenario with a voice rubric), the state invariants every trial
// is held to and the scenario's own receipts agree.
import type { ModelName } from '@waldo/contracts';
import type { LLMGatewayAdapter } from '../../src/llm/provider';
import type { CallBudget } from './budget';
import type { Judge, Verdict } from './judge';
import { failedReceipts, STATE_INVARIANTS } from './receipts';
import type { NightlyScenario } from './scenarios';
import { scorecard, type ScenarioTrials, type TrialOutcome } from './scorecard';
import { runTrial, type TrialMetrics, type TrialRecord } from './trial';
import type { MemoryMode } from './world';
import type { EmbeddingRunner } from '../../src/memory/semantic-recall';
import type { CompactionSettings } from '../../src/conversation/compaction';
import type { ForgetBarrierMode } from '../../src/context-composer/forget-barrier';
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
  // Set on an ablation run: how many reply calls could not drop the named rules (absent, or a hard boundary).
  ablationMisses?: () => number;
  // The brain's flag-on menu: core tools up front, the rest found by tool search.
  toolSearch?: boolean;
  // The harness's own loader (WALDO_TOOL_LOADER=harness): core tools up front, the rest through find_tools and use_tool.
  toolLoader?: 'harness';
  // Opens the route's second-provider step; the gateway must serve Anthropic requests for it to be taken.
  fallbackKey?: string;
  forgetBarrier?: ForgetBarrierMode;
  // The staging profile and the subset spec the run used, named on the scorecard.
  profile?: 'staging';
  subset?: string;
  shard?: string;
  // Told the scorecard of the scenarios finished so far, after each one, so a run that is cut off leaves what it had.
  progress?: (card: ReturnType<typeof scorecard>) => void;
  // The memory the trials run with; the raw-history baseline when set to raw_history.
  memory?: MemoryMode;
  // Option B's memory in every trial (MEMORY_SELECTION=1).
  memorySelection?: true;
  // Semantic recall on: each trial embeds over a runner from this.
  embeddings?: () => EmbeddingRunner;
  // Compaction on: each trial's chat is the app's canonical store, built with these settings (WALDO_EVAL_COMPACTION=on).
  compaction?: CompactionSettings;
  // Read receipts on every completed trial, not only the ones a judge graded: state is checked in code, so a judge that
  // errs or runs out of budget cannot hide a duplicated effect. Live runs set it; the recorded dry run's fixed replies
  // carry no state, so it never grades.
  holdState?: true;
  // A local look at each judged trial; the scorecard never carries any of it.
  show?: (scenario: NightlyScenario, record: TrialRecord, verdict: Verdict, checks: Readonly<{ voice?: VoiceVerdict; receipts: readonly string[] }>) => void;
}>;

// Counts add up over a scenario's trials; the peak is the largest any trial saw.
const sumMetrics = (trials: readonly TrialMetrics[]): TrialMetrics & Readonly<{ trials: number }> => {
  const sum = (key: Exclude<keyof TrialMetrics, 'peak_result_chars'>) => trials.reduce((total, metrics) => total + metrics[key], 0);
  return {
    trials: trials.length, calls: sum('calls'), rounds: sum('rounds'), failed_calls: sum('failed_calls'), fallback_calls: sum('fallback_calls'),
    find_tools: sum('find_tools'), use_tool: sum('use_tool'), groups_loaded: sum('groups_loaded'), peak_result_chars: Math.max(...trials.map((metrics) => metrics.peak_result_chars)),
    input_tokens: sum('input_tokens'), cached_tokens: sum('cached_tokens'), cache_write_tokens: sum('cache_write_tokens'), output_tokens: sum('output_tokens'),
    usd: sum('usd'), unpriced_calls: sum('unpriced_calls'),
  };
};

const graded = (outcome: TrialOutcome) => outcome === 'pass' || outcome === 'fail';

const card = (results: readonly ScenarioTrials[], run: NightlyRun) =>
  scorecard(results, { candidate: run.candidate, judge: run.judgeModel, trials: run.trials, usage: run.budget.usage(), ...(run.profile ? { profile: run.profile } : {}), ...(run.subset ? { subset: run.subset } : {}), ...(run.shard ? { shard: run.shard } : {}) });

export const runNightly = async (scenarios: readonly NightlyScenario[], run: NightlyRun) => {
  const results: ScenarioTrials[] = [];
  for (const scenario of scenarios) {
    const outcomes: TrialOutcome[] = [];
    const errors: string[] = [];
    let voiceFailed = 0;
    let receiptFailed = 0;
    let judgePassed = 0;
    let receiptsSkipped = 0;
    const metrics: TrialMetrics[] = [];
    for (let trial = 0; trial < run.trials; trial += 1) {
      if (scenario.blocked) { outcomes.push('blocked'); continue; }
      if (run.budget.exhausted()) { outcomes.push('budget_exhausted'); continue; }
      const missed = run.ablationMisses?.() ?? 0;
      const record = await runTrial(run.compaction ? { ...scenario, world: { ...scenario.world, compaction: run.compaction } } : scenario, { gateway: run.gateway(), budget: run.budget, ...(run.model ? { model: run.model } : {}), ...(run.toolSearch ? { toolSearch: true } : {}), ...(run.toolLoader ? { toolLoader: run.toolLoader } : {}), ...(run.fallbackKey ? { fallbackKey: run.fallbackKey } : {}), ...(run.forgetBarrier ? { forgetBarrier: run.forgetBarrier } : {}), ...(run.memory ? { memory: run.memory } : {}), ...(run.embeddings ? { embeddings: run.embeddings() } : {}), ...(run.memorySelection ? { memorySelection: true } : {}) });
      metrics.push(record.metrics);
      if (record.status !== 'ran') { outcomes.push(record.status); if (record.error) errors.push(record.error); continue; }
      // A trial whose rules were not all dropped measured nothing about them.
      if ((run.ablationMisses?.() ?? 0) > missed) { outcomes.push('harness_error'); errors.push('AblationMiss'); continue; }
      const verdict = await run.judge({ scenario: scenario.id, rubric: scenario.rubric, transcript: record.transcript, tools: record.tools, effects: record.effects, final_state: record.final_state });
      // What the judges alone made of the trial, before receipts: the figure two memory modes can be compared on.
      let judged: TrialOutcome = verdict.outcome;
      let voice: VoiceVerdict | undefined;
      if (graded(verdict.outcome) && scenario.rubric.voice && run.voiceJudge) {
        voice = await run.voiceJudge({ voice: scenario.rubric.voice, transcript: record.transcript, tools: record.tools, effects: record.effects });
        if (voice.outcome === 'fail') { voiceFailed += 1; judged = 'fail'; }
        else if (voice.outcome !== 'pass' && judged === 'pass') judged = voice.outcome;
      }
      const allReceipts = [...STATE_INVARIANTS, ...(scenario.receipts ?? [])];
      const reading = graded(judged) || run.holdState;
      const receipts = reading ? failedReceipts(allReceipts, record, run.memory) : [];
      if (reading && (run.memory ?? 'claims') !== 'claims') receiptsSkipped += allReceipts.filter((receipt) => receipt.memory_store).length;
      if (receipts.length) receiptFailed += 1;
      if (judged === 'pass') judgePassed += 1;
      const outcome: TrialOutcome = receipts.length ? 'fail' : judged;
      outcomes.push(outcome);
      run.show?.(scenario, record, verdict, { ...(voice ? { voice } : {}), receipts });
    }
    results.push({
      id: scenario.id, pain: scenario.pain, outcomes, ...(errors.length ? { harness_errors: errors } : {}),
      ...(scenario.rubric.voice ? { voice_failed: voiceFailed } : {}), receipt_failed: receiptFailed, judge_passed: judgePassed, receipts_skipped: receiptsSkipped,
      ...(metrics.length ? { metrics: sumMetrics(metrics) } : {}),
    });
    run.progress?.(card(results, run));
  }
  return card(results, run);
};
