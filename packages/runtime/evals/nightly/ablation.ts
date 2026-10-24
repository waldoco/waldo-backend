// Ablation: a nightly run with named behaviour rules taken out of the system prompt, compared with a run that keeps them.
// Production code is untouched; the trial's gateway drops the rules on the way to the model.
import { stableJson } from '../../src/context-composer/canonical';
import type { LLMGatewayAdapter } from '../../src/llm/provider';
import { ruleInventory, type RuleStatus } from './rules';
import type { Scorecard } from './scorecard';

// Only a reply's behaviour prompt is ablated; the memory writer's and other calls' prompts pass untouched.
const BEHAVIOUR_START = 'You are Waldo, ';

// A behaviour prompt that does not hold every named rule, or a named rule that is a hard boundary, is a miss: nothing is
// removed and the miss is counted, so the trial is a harness error and a run that dropped nothing never reads as no effect.
export const ablating = (inner: LLMGatewayAdapter, ids: readonly string[], miss: () => void): LLMGatewayAdapter => ({
  async complete(call) {
    const system = call.request.system;
    if (typeof system !== 'string' || !system.startsWith(BEHAVIOUR_START)) return inner.complete(call);
    const named = (await ruleInventory(system)).filter((status) => ids.includes(status.rule.id));
    if (named.length !== new Set(ids).size || named.some((status) => status.kind === 'boundary')) {
      miss();
      return inner.complete(call);
    }
    const dropped = new Set(named.map((status) => status.rule.text));
    return inner.complete({ ...call, request: { ...call.request, system: system.split('\n').filter((line) => !dropped.has(line)).join('\n') } });
  },
});

export const ablationLabel = (candidate: string, ids: readonly string[]): string => `${candidate}+ablate:${[...ids].sort().join(',')}`;

// WALDO_EVAL_RUNS: `<baseline.json>:<ablated.json>` pairs. A file named twice is one run counted twice.
export const ablationRuns = (spec: string, read: (path: string) => string): AblationRun[] => {
  const pairs = spec.split(',').filter(Boolean).map((pair) => pair.split(':'));
  if (pairs.some(([baseline, ablated]) => !baseline || !ablated)) throw new Error('WALDO_EVAL_RUNS takes <baseline.json>:<ablated.json> pairs');
  const paths = pairs.flat();
  const repeated = paths.find((path, index) => paths.indexOf(path) !== index);
  if (repeated) throw new Error(`WALDO_EVAL_RUNS names ${repeated} twice`);
  const card = (path: string) => JSON.parse(read(path)) as Scorecard;
  return pairs.map(([baseline, ablated]) => ({ baseline: card(baseline!), ablated: card(ablated!) }));
};

// The decision, fixed before any run. Ties and inconclusive results keep the rule.
// keep: removing the rule adds 2 or more failures out of 5 on a scenario it governs, in any run; or the overall pass rate
//   falls by 5 points or more in at least two runs, all moving the same way.
// prune: at least two runs that took out this rule alone, each fully graded and within 2 points overall, with no added
//   failure, voice failure or receipt failure on a scenario it governs.
// uncovered: no scenario exercises the rule, so no run can show it is unneeded.
export const TRIALS = 5;
const KEEP_FAILURES = 2, KEEP_DROP = 0.05, PRUNE_BAND = 0.02, RUNS = 2;
export type AblationRun = Readonly<{ baseline: Scorecard; ablated: Scorecard }>;
export type AblationVerdict = Readonly<{ verdict: 'keep' | 'prune' | 'inconclusive' | 'uncovered'; reason: string }>;

// A run whose budget ran out, or with any trial cut short, broken by the harness or left ungraded by the judge, measured
// only part of what it set out to. An ungraded trial also drops out of the overall rate, so a run whose judge failed on
// every scenario the rule does not govern would hold the rate by construction. A blocked scenario never runs in any card,
// so it is the one gap allowed.
const finished = (card: Scorecard) => !card.budget_exhausted && card.scenarios.every((row) => row.status === 'blocked' || row.passed + row.failed === TRIALS);
const scenarioIds = (card: Scorecard) => card.scenarios.map((row) => row.id).sort().join('\n');

export const ablationVerdict = (status: RuleStatus, runs: readonly AblationRun[]): AblationVerdict => {
  if (status.kind === 'boundary') throw new Error('a hard-boundary rule is never ablated');
  if (status.kind === 'uncovered' || status.scenarios.length === 0) return { verdict: 'uncovered', reason: 'no scenario exercises this rule' };
  const id = status.rule.id;
  // Independent runs are different runs: a card given twice, in one pair or across two, is one run counted twice.
  const cards = runs.flatMap(({ baseline, ablated }) => [stableJson(baseline), stableJson(ablated)]);
  if (new Set(cards).size !== cards.length) return { verdict: 'inconclusive', reason: 'a scorecard appears twice, so the runs are not independent' };
  // The label carries the model and every eval mode, so a pair whose labels differ by anything but the ablation would
  // credit the rule with a mode's or a judge's effect.
  for (const { baseline, ablated } of runs) {
    if (baseline.trials_per_scenario !== TRIALS || ablated.trials_per_scenario !== TRIALS) return { verdict: 'inconclusive', reason: `runs need ${TRIALS} trials per scenario` };
    const [candidate, ids] = ablated.candidate_model.split('+ablate:');
    // A run with several rules taken out measures them together; crediting its effect to each one would prune each alone.
    if (ids !== id && ids?.split(',').includes(id)) return { verdict: 'inconclusive', reason: 'a run pair took out more than this rule, so its effect is not this rule\'s alone' };
    if (ids !== id || baseline.candidate_model !== candidate || baseline.judge_model !== ablated.judge_model) {
      return { verdict: 'inconclusive', reason: 'a run pair is not this rule against an unablated baseline on the same model, modes and judge' };
    }
  }
  if (!runs.every(({ baseline, ablated }) => finished(baseline) && finished(ablated) && scenarioIds(baseline) === scenarioIds(ablated))) {
    return { verdict: 'inconclusive', reason: 'a run pair did not finish the same scenarios' };
  }
  // A governed scenario needs every trial graded on both sides: one graded trial can never show 2 more failures out of 5.
  const graded = (card: Scorecard) => status.scenarios.every((scenario) => card.scenarios.some((row) => row.id === scenario && row.passed + row.failed === TRIALS));
  if (!runs.every(({ baseline, ablated }) => graded(baseline) && graded(ablated))) return { verdict: 'inconclusive', reason: `a governed scenario was not graded on all ${TRIALS} trials in every run` };
  const governed = (card: Scorecard) => new Map(card.scenarios.filter((row) => status.scenarios.includes(row.id)).map((row) => [row.id, row]));
  const added = runs.map(({ baseline, ablated }) => {
    const before = governed(baseline), after = governed(ablated);
    return [...after].map(([scenario, row]) => {
      const was = before.get(scenario);
      return { scenario, failures: row.failed - (was?.failed ?? 0), voice: (row.voice_failed ?? 0) - (was?.voice_failed ?? 0), receipts: (row.receipt_failed ?? 0) - (was?.receipt_failed ?? 0) };
    });
  });
  const worst = added.flat().find((change) => change.failures >= KEEP_FAILURES);
  if (worst) return { verdict: 'keep', reason: `${worst.failures} more failures out of ${TRIALS} on ${worst.scenario}` };
  // Rates are fractions of trial counts; rounding drops float noise, so a fall of exactly 2 points is within the band.
  const deltas = runs.map(({ baseline, ablated }) => baseline.overall.pass_rate === null || ablated.overall.pass_rate === null ? null : Math.round((ablated.overall.pass_rate - baseline.overall.pass_rate) * 1e6) / 1e6);
  if (runs.length < RUNS || deltas.some((delta) => delta === null)) return { verdict: 'inconclusive', reason: `needs ${RUNS} graded run pairs` };
  if (deltas.every((delta) => delta! <= -KEEP_DROP)) return { verdict: 'keep', reason: 'the overall pass rate fell by 5 points or more in every run' };
  const clean = added.flat().every((change) => change.failures <= 0 && change.voice <= 0 && change.receipts <= 0);
  if (clean && deltas.every((delta) => Math.abs(delta!) <= PRUNE_BAND)) return { verdict: 'prune', reason: 'no governed scenario lost a trial and the overall rate held within 2 points in every run' };
  return { verdict: 'inconclusive', reason: 'the runs did not agree on a verdict' };
};

// What WALDO_EVAL_VERDICT prints. live is true only when every card names a live judge: the recorded judge grades nothing,
// so recorded cards can never reach prune, and the flag keeps a verdict read from them from passing for a live one.
export const ablationReport = (status: RuleStatus, runs: readonly AblationRun[]) => {
  const judges = [...new Set(runs.flatMap(({ baseline, ablated }) => [baseline.judge_model, ablated.judge_model]))].sort();
  return { id: status.rule.id, live: judges.length > 0 && !judges.includes('recorded'), judges, ...ablationVerdict(status, runs) };
};
