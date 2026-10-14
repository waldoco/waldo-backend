import { describe, expect, it } from 'vitest';
import { scorecard, type ScenarioTrials } from '../evals/nightly/scorecard';

const run = (id: string, pain: ScenarioTrials['pain'], outcomes: ScenarioTrials['outcomes']): ScenarioTrials => ({ id, pain, outcomes });
const usage = { candidate_calls: 40, judge_calls: 9, budget: 100, exhausted: false, candidate_tokens: 52_000, judge_tokens: 31_000 };
const card = (rows: readonly ScenarioTrials[]) => scorecard(rows, { candidate: 'model-a', judge: 'model-b', trials: 3, usage });

describe('nightly eval scorecard', () => {
  it('counts pass^k only when every one of the k trials passed', () => {
    const result = card([run('steady', 'context', ['pass', 'pass', 'pass']), run('flaky', 'context', ['pass', 'fail', 'pass'])]);
    expect(result.scenarios).toEqual([
      { id: 'steady', pain: 'context', status: 'graded', trials: 3, passed: 3, failed: 0, ungraded: 0, pass_rate: 1, pass_k: true },
      { id: 'flaky', pain: 'context', status: 'graded', trials: 3, passed: 2, failed: 1, ungraded: 0, pass_rate: 2 / 3, pass_k: false },
    ]);
    expect(result.pains.context).toEqual({ scenarios: 2, graded: 2, pass_rate: 5 / 6, pass_k_rate: 0.5 });
  });

  it('never counts a judge or harness error as a pass, and keeps it out of the pass rate', () => {
    const [row] = card([run('shaky', 'judgment', ['pass', 'judge_error', 'harness_error'])]).scenarios;
    expect(row).toMatchObject({ status: 'graded', passed: 1, failed: 0, ungraded: 2, pass_rate: 1, pass_k: false });
  });

  it('reports a blocked scenario with no rate, and leaves it out of the pain rates', () => {
    const result = card([run('image', 'context', ['blocked', 'blocked', 'blocked']), run('ok', 'context', ['pass', 'pass', 'pass'])]);
    expect(result.scenarios[0]).toEqual({ id: 'image', pain: 'context', status: 'blocked', trials: 3, passed: 0, failed: 0, ungraded: 3, pass_rate: null, pass_k: null });
    expect(result.pains.context).toEqual({ scenarios: 2, graded: 1, pass_rate: 1, pass_k_rate: 1 });
  });

  it('marks trials the budget stopped as not run and flags the whole card', () => {
    const result = scorecard([run('late', 'follow_through', ['pass', 'budget_exhausted', 'budget_exhausted'])],
      { candidate: 'model-a', judge: 'model-b', trials: 3, usage: { ...usage, exhausted: true } });
    expect(result.scenarios[0]).toMatchObject({ status: 'incomplete', passed: 1, ungraded: 2, pass_k: false });
    expect(result.budget_exhausted).toBe(true);
    expect(result.pains.follow_through).toEqual({ scenarios: 1, graded: 1, pass_rate: 1, pass_k_rate: 0 });
  });

  it('labels a scenario with no graded trial as ungraded', () => {
    expect(card([run('unread', 'context', ['judge_error', 'judge_error', 'harness_error'])]).scenarios[0]).toMatchObject({ status: 'ungraded', pass_rate: null, pass_k: false });
  });

  it('has an empty pain with null rates rather than a perfect score', () => {
    expect(card([]).pains.judgment).toEqual({ scenarios: 0, graded: 0, pass_rate: null, pass_k_rate: null });
  });

  it('carries models, trial count and usage, and no free text', () => {
    const result = card([run('steady', 'context', ['pass', 'pass', 'pass'])]);
    expect(result).toMatchObject({ version: 1, candidate_model: 'model-a', judge_model: 'model-b', trials_per_scenario: 3, calls: { candidate: 40, judge: 9, budget: 100 }, tokens: { candidate: 52_000, judge: 31_000 } });
    expect(Object.keys(result).sort()).toEqual(['budget_exhausted', 'calls', 'candidate_model', 'judge_model', 'overall', 'pains', 'scenarios', 'tokens', 'trials_per_scenario', 'version']);
    expect(result.overall).toEqual({ scenarios: 1, graded: 1, pass_rate: 1, pass_k_rate: 1 });
  });
});
