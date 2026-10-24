// The CI gate over a nightly scorecard, and the PR comment that shows it. Both read only the scorecard,
// which carries counts and class names, never reply text, so the comment is safe to post.
import type { Scorecard } from './scorecard';

export type GateThresholds = Readonly<{
  min_scenarios: number;
  max_blocked: number;
  max_harness_errors: number;
  max_incomplete: number;
  // null: report the pass rate without holding it to a floor.
  min_pass_rate: number | null;
  // A judge that answers unknown leaves a trial ungraded, not failed, so a high share of abstentions can lift the pass
  // rate over the trials it chose to decide. Absent or null reports the share only; set a ceiling once a live baseline
  // shows what a healthy run abstains on. The recorded dry run grades nothing, so it never carries one.
  max_ungraded_share?: number | null;
}>;
export type GateResult = Readonly<{ ok: boolean; failures: readonly string[] }>;

// Set from the M0 recorded baseline (beta-mvp b3fe8891): 22 scenarios, 3 blocked, no harness errors; raised to 36 by
// the fourteen voice and safety scenarios, to 49 by the thirteen runnable errands, to 50 by the connector case, to 51 by
// the health trigger case, to 60 by two more errands and seven state and memory cases, to 61 by the stale health
// reading case, to 62 by the owner look-up case, to 79 by the seventeen personality cases, and to 80 by the spoofed "paid" mail
// case, none blocked. A PR that adds, removes or unblocks a scenario moves these numbers in the same diff. Live mode has no
// pass-rate floor until a live baseline is recorded.
export const NIGHTLY_THRESHOLDS: Readonly<Record<'recorded' | 'live', GateThresholds>> = {
  recorded: { min_scenarios: 80, max_blocked: 3, max_harness_errors: 0, max_incomplete: 0, min_pass_rate: null },
  live: { min_scenarios: 80, max_blocked: 3, max_harness_errors: 0, max_incomplete: 0, min_pass_rate: null },
};

export const SCORECARD_MARKER = '<!-- waldo-eval-scorecard -->';

const rate = (value: number) => String(Number(value.toFixed(3)));

export const gateScorecard = (card: Scorecard, limits: GateThresholds): GateResult => {
  const failures: string[] = [];
  const count = (status: string) => card.scenarios.filter((row) => row.status === status).length;
  const harness = card.scenarios.flatMap((row) => row.harness_errors ?? []);
  if (card.scenarios.length < limits.min_scenarios) failures.push(`scenarios ${card.scenarios.length} < ${limits.min_scenarios}`);
  if (count('blocked') > limits.max_blocked) failures.push(`blocked scenarios ${count('blocked')} > ${limits.max_blocked}`);
  if (harness.length > limits.max_harness_errors) failures.push(`harness errors ${harness.length} > ${limits.max_harness_errors} (${[...new Set(harness)].join(', ')})`);
  if (count('incomplete') > limits.max_incomplete) failures.push(`incomplete scenarios ${count('incomplete')} > ${limits.max_incomplete}`);
  if (card.budget_exhausted) failures.push('the call budget ran out');
  const trials = card.scenarios.filter((row) => row.status !== 'blocked');
  const total = trials.reduce((sum, row) => sum + row.trials, 0);
  const ungraded = trials.reduce((sum, row) => sum + row.ungraded, 0);
  if (limits.max_ungraded_share != null && total > 0 && ungraded / total > limits.max_ungraded_share) {
    failures.push(`ungraded trials ${rate(ungraded / total * 100)}% > ${rate(limits.max_ungraded_share * 100)}%`);
  }
  if (limits.min_pass_rate !== null) {
    const passRate = card.overall.pass_rate;
    if (passRate === null) failures.push(`pass rate ${limits.min_pass_rate} required but nothing was graded`);
    else if (passRate < limits.min_pass_rate) failures.push(`pass rate ${rate(passRate)} < ${limits.min_pass_rate}`);
  }
  return { ok: failures.length === 0, failures };
};

// How many graded trials the voice judge and the receipt checks failed, when anything was graded.
const checkLines = (card: Scorecard): string[] => {
  if (card.overall.graded === 0) return [];
  const total = (key: 'voice_failed' | 'receipt_failed') => card.scenarios.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  const has = (key: 'voice_failed' | 'receipt_failed') => card.scenarios.some((row) => row[key] !== undefined);
  const trials = card.scenarios.filter((row) => row.status !== 'blocked');
  const ungraded = trials.reduce((sum, row) => sum + row.ungraded, 0);
  const sum = (key: 'judge_passed' | 'receipts_skipped') => card.scenarios.reduce((total, row) => total + (row[key] ?? 0), 0);
  const gradedTrials = card.scenarios.reduce((total, row) => total + row.passed + row.failed, 0);
  const lines = [
    `Judges alone passed ${sum('judge_passed')} of ${gradedTrials} graded trials${sum('receipts_skipped') ? `; ${sum('receipts_skipped')} receipt check${sum('receipts_skipped') === 1 ? '' : 's'} skipped (no claim store)` : ''}.`,
    `Ungraded: ${ungraded} of ${trials.reduce((sum, row) => sum + row.trials, 0)} trials (the judge answered unknown, errored or ran out of budget). They are no pass.`,
    ...(has('voice_failed') ? [`Voice judge: ${total('voice_failed')} graded trials failed the six tests.`] : []),
    ...(has('receipt_failed') ? [`Receipts: ${total('receipt_failed')} graded trials failed a receipt check.`] : []),
  ];
  return lines.length ? [...lines, ''] : [];
};

export const scorecardMarkdown = (card: Scorecard, gate: GateResult, mode: 'recorded' | 'live'): string => {
  const shown = (value: number | null) => (value === null ? '-' : rate(value));
  const lines = [
    SCORECARD_MARKER,
    `### Nightly eval scorecard (${mode})`,
    '',
    `**Gate: ${gate.ok ? 'pass' : 'fail'}**`,
    ...gate.failures.map((failure) => `- ${failure}`),
    '',
    ...(mode === 'recorded' ? ['Recorded mode grades nothing: the model answers with fixed text, so this checks that every scenario still runs, not reply quality.', ''] : []),
    `Candidate \`${card.candidate_model}\`, judge \`${card.judge_model}\`, ${card.trials_per_scenario} trials per scenario. Calls: ${card.calls.candidate} candidate, ${card.calls.judge} judge, budget ${card.calls.budget}. Tokens: ${card.tokens.candidate} candidate, ${card.tokens.judge} judge.`,
    '',
    '| Scope | Scenarios | Graded | Pass rate | pass^k rate |',
    '| --- | --- | --- | --- | --- |',
    ...[['overall', card.overall] as const, ...Object.entries(card.pains)].map(([scope, rates]) =>
      `| ${scope} | ${rates.scenarios} | ${rates.graded} | ${shown(rates.pass_rate)} | ${shown(rates.pass_k_rate)} |`),
    '',
    ...checkLines(card),
    '<details><summary>Scenarios</summary>',
    '',
    '| Scenario | Pain | Status | Passed | Failed | Ungraded |',
    '| --- | --- | --- | --- | --- | --- |',
    ...card.scenarios.map((row) => `| ${row.id} | ${row.pain} | ${row.status} | ${row.passed} | ${row.failed} | ${row.ungraded} |`),
    '',
    '</details>',
  ];
  return `${lines.join('\n')}\n`;
};
