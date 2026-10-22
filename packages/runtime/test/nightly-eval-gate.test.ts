import { describe, expect, it } from 'vitest';
import { gateScorecard, NIGHTLY_THRESHOLDS, scorecardMarkdown, SCORECARD_MARKER } from '../evals/nightly/gate';
import { scorecard, type ScenarioTrials } from '../evals/nightly/scorecard';

const usage = { candidate_calls: 93, judge_calls: 0, budget: 10_000, exhausted: false, candidate_tokens: 1860, judge_tokens: 0 };
const run = (id: string, outcomes: ScenarioTrials['outcomes'], harness_errors?: string[]): ScenarioTrials => ({ id, pain: 'context', outcomes, ...(harness_errors ? { harness_errors } : {}) });
const card = (rows: readonly ScenarioTrials[], over: Partial<typeof usage> = {}) => scorecard(rows, { candidate: 'recorded', judge: 'recorded', trials: 3, usage: { ...usage, ...over } });
const thresholds = { min_scenarios: 2, max_blocked: 1, max_harness_errors: 0, max_incomplete: 0, min_pass_rate: null };

describe('nightly eval gate', () => {
  it('passes a card that meets every threshold', () => {
    expect(gateScorecard(card([run('a', ['judge_error', 'judge_error', 'judge_error']), run('b', ['blocked', 'blocked', 'blocked'])]), thresholds))
      .toEqual({ ok: true, failures: [] });
  });

  it('fails on a harness error, a lost scenario, a newly blocked one and a budget stop, naming each', () => {
    const result = gateScorecard(card([
      run('a', ['harness_error', 'judge_error', 'judge_error'], ['TypeError']),
      run('b', ['blocked', 'blocked', 'blocked']), run('c', ['blocked', 'blocked', 'blocked']),
      run('d', ['pass', 'budget_exhausted', 'budget_exhausted']),
    ], { exhausted: true }), { ...thresholds, min_scenarios: 5 });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      'scenarios 4 < 5', 'blocked scenarios 2 > 1', 'harness errors 1 > 0 (TypeError)', 'incomplete scenarios 1 > 0', 'the call budget ran out',
    ]);
  });

  it('holds the pass rate to its floor only when one is set and something was graded', () => {
    const graded = card([run('a', ['pass', 'fail', 'fail']), run('b', ['pass', 'pass', 'pass'])]);
    expect(gateScorecard(graded, { ...thresholds, min_pass_rate: 0.7 }).failures).toEqual(['pass rate 0.667 < 0.7']);
    expect(gateScorecard(graded, { ...thresholds, min_pass_rate: 0.6 }).ok).toBe(true);
    expect(gateScorecard(card([run('a', ['judge_error']), run('b', ['judge_error'])]), { ...thresholds, min_pass_rate: 0.7 }).failures)
      .toEqual(['pass rate 0.7 required but nothing was graded']);
  });

  it('keeps the recorded thresholds at the M0 baseline plus the voice and safety set, the runnable errands and the connector case', () => {
    expect(NIGHTLY_THRESHOLDS.recorded).toEqual({ min_scenarios: 50, max_blocked: 3, max_harness_errors: 0, max_incomplete: 0, min_pass_rate: null });
  });

  it('renders a marked, text-free comment with the verdict, totals and each scenario', () => {
    const result = card([run('a', ['pass', 'fail', 'pass']), run('b', ['blocked', 'blocked', 'blocked'])]);
    const markdown = scorecardMarkdown(result, gateScorecard(result, thresholds), 'recorded');
    expect(markdown.startsWith(SCORECARD_MARKER)).toBe(true);
    expect(markdown).toContain('**Gate: pass**');
    expect(markdown).toContain('| a | context | graded | 2 | 1 | 0 |');
    expect(markdown).toContain('| b | context | blocked | 0 | 0 | 3 |');
    expect(markdown).toContain('Recorded mode grades nothing');
    const failed = scorecardMarkdown(result, { ok: false, failures: ['scenarios 2 < 5'] }, 'live');
    expect(failed).toContain('**Gate: fail**');
    expect(failed).toContain('- scenarios 2 < 5');
    expect(failed).not.toContain('Recorded mode grades nothing');
  });
});
