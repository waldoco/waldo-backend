import { expect, it } from 'vitest';
import { WORKSPACE_REFERENT_CASES } from '../evals/workspace-referent-cases';
import { comparePaired, scoreTrace, type RecordedTrace } from '../evals/trace-replay';

// Scripted receipt checks only: no provider calls, model decisions or uplift claim.
const trace = (item: typeof WORKSPACE_REFERENT_CASES[number], effects: RecordedTrace['effects']): RecordedTrace => ({
  case_id: item.id, model: 'scripted-no-model', effects, reads: [], approvals: [],
  claimed_effects: [], receipt_effects: effects.filter(e => e.state === 'applied').map(e => e.kind),
  terminal: item.grader.expected_file_id ? 'completed' : 'refused',
  usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
});

it.each(WORKSPACE_REFERENT_CASES)('$id scores exact identity, rejects unwanted writes, and leaves final-state review unscored', item => {
  const want = item.grader.expectation;
  const desired = want.required_effects.map((e, index) => ({ ...e, seq: index + 1, state: 'applied' as const }));
  const accepted = scoreTrace(trace(item, desired), want);
  expect(accepted.structural_ok).toBe(true);
  expect(accepted.unscored).toEqual(['final_state']);
  expect(accepted.tokens.calls).toBe(0);
  const unrelated = item.visible.artifacts.find(a => a.file_id !== item.grader.expected_file_id)!;
  const wrong = { seq: 2, kind: 'workspace.write', state: 'applied' as const,
    payload: { file_id: unrelated.file_id, path: unrelated.path, revision: unrelated.revision + 1, text: item.grader.expected_text ?? 'Unrequested edit' } };
  expect(scoreTrace(trace(item, [wrong]), want).structural_ok).toBe(false);
  expect(scoreTrace(trace(item, [...desired, wrong]), want).failed).toContain('forbidden_effects');
  expect(scoreTrace(trace(item, [...desired, { ...wrong, state: 'unknown' }]), want).failed).toContain('forbidden_effects');
  expect(scoreTrace(trace(item, [...desired, { ...wrong, state: 'rejected' }]), want).structural_ok).toBe(true);
  if (desired[0]) {
    const e = desired[0];
    for (const changed of [{ revision: 99 }, { text: 'Redacted or wrong body' }, { file_id: unrelated.file_id }]) {
      expect(scoreTrace(trace(item, [{ ...e, payload: { ...e.payload, ...changed } }]), want).structural_ok).toBe(false);
    }
  }
  expect(JSON.stringify(item.visible)).not.toContain('expected_file_id');
  expect(JSON.stringify(item.visible)).not.toContain('forbidden_effect_payloads');
});

it('uses the same replay scorer across context variants without inventing a model comparison', () => {
  const a = WORKSPACE_REFERENT_CASES.map(item => scoreTrace(trace(item, []), item.grader.expectation));
  const b = WORKSPACE_REFERENT_CASES.map(item => scoreTrace(trace(item,
    item.grader.expectation.required_effects.map(e => ({ ...e, seq: 1, state: 'applied' }))), item.grader.expectation));
  expect(comparePaired(a, b)).toMatchObject({ cases: 6, both_ok: 2, b_only: ['same-basename', 'similar-names', 'different-names', 'explicit-older-override'] });
});
