// The nightly scorecard: counts and rates, plus the class names of harness errors. It never carries reply text,
// error messages, mail, health or account details, so it can be kept and shared as is.
export type Pain = 'context' | 'follow_through' | 'judgment';
export const PAINS: readonly Pain[] = ['context', 'follow_through', 'judgment'];
export type TrialOutcome = 'pass' | 'fail' | 'judge_error' | 'harness_error' | 'blocked' | 'budget_exhausted';
export type ScenarioTrials = Readonly<{ id: string; pain: Pain; outcomes: readonly TrialOutcome[]; harness_errors?: readonly string[] }>;
export type Usage = Readonly<{ candidate_calls: number; judge_calls: number; budget: number; exhausted: boolean; candidate_tokens: number; judge_tokens: number }>;

type Rates = Readonly<{ scenarios: number; graded: number; pass_rate: number | null; pass_k_rate: number | null }>;
type ScenarioRow = Readonly<{
  id: string; pain: Pain; status: 'graded' | 'ungraded' | 'blocked' | 'incomplete'; trials: number;
  passed: number; failed: number; ungraded: number; pass_rate: number | null; pass_k: boolean | null; harness_errors?: readonly string[];
}>;

const row = ({ id, pain, outcomes, harness_errors }: ScenarioTrials, k: number): ScenarioRow => {
  const passed = outcomes.filter((outcome) => outcome === 'pass').length;
  const failed = outcomes.filter((outcome) => outcome === 'fail').length;
  const blocked = outcomes.length > 0 && outcomes.every((outcome) => outcome === 'blocked');
  return {
    id, pain, status: blocked ? 'blocked' : outcomes.includes('budget_exhausted') ? 'incomplete' : passed + failed === 0 ? 'ungraded' : 'graded',
    trials: outcomes.length, passed, failed, ungraded: outcomes.length - passed - failed,
    pass_rate: passed + failed === 0 ? null : passed / (passed + failed),
    // pass^k: every one of the k trials passed. An ungraded trial is never a pass.
    pass_k: blocked ? null : passed === k && outcomes.length === k,
    ...(harness_errors?.length ? { harness_errors } : {}),
  };
};

const rates = (rows: readonly ScenarioRow[]): Rates => {
  const graded = rows.filter((entry) => entry.pass_rate !== null);
  const trials = graded.reduce((sum, entry) => sum + entry.passed + entry.failed, 0);
  return {
    scenarios: rows.length, graded: graded.length,
    pass_rate: trials === 0 ? null : graded.reduce((sum, entry) => sum + entry.passed, 0) / trials,
    pass_k_rate: graded.length === 0 ? null : graded.filter((entry) => entry.pass_k).length / graded.length,
  };
};

export const scorecard = (results: readonly ScenarioTrials[], run: Readonly<{ candidate: string; judge: string; trials: number; usage: Usage }>) => {
  const scenarios = results.map((result) => row(result, run.trials));
  return {
    version: 1 as const,
    candidate_model: run.candidate,
    judge_model: run.judge,
    trials_per_scenario: run.trials,
    scenarios,
    pains: Object.fromEntries(PAINS.map((pain) => [pain, rates(scenarios.filter((entry) => entry.pain === pain))])) as Record<Pain, Rates>,
    overall: rates(scenarios),
    calls: { candidate: run.usage.candidate_calls, judge: run.usage.judge_calls, budget: run.usage.budget },
    tokens: { candidate: run.usage.candidate_tokens, judge: run.usage.judge_tokens },
    budget_exhausted: run.usage.exhausted,
  };
};
export type Scorecard = ReturnType<typeof scorecard>;
