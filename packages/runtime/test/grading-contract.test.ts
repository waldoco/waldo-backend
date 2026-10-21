import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareNativeGrade, type ObservedTrial } from '../evals/grading-contract';

const ref = (source: string) => { const bytes = `captured fixture data for ${source}`; return { source, bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }; };
const trial = (case_id: string): ObservedTrial => ({ case_id, seed: 'independent-seed-1', fixture_manifest: ref('fixture'), transcript: ref('transcript'),
  tool_trace: ref('tools'), authority_timeline: ref('authority'), source_revisions: ref('revisions'), intercepted_effects: ref('effects'), final_state_readback: ref('readback') });

describe('native grading handoff', () => {
  it('blocks before any real trial evidence, without creating a score from reference judgments', () => {
    const result = prepareNativeGrade({ ...trial('W02'), final_state_readback: { ...ref('readback'), bytes: '' } });
    expect(result).toEqual({ status: 'incomplete', missing: ['missing or digest-invalid final_state_readback'] });
    expect(prepareNativeGrade({ ...trial('W02'), authority_timeline: { ...ref('authority'), digest: 'model says approved' }, intercepted_effects: { ...ref('effects'), digest: 'none' } })).toEqual({
      status: 'incomplete', missing: ['missing or digest-invalid authority_timeline', 'missing or digest-invalid intercepted_effects'],
    });
    expect(prepareNativeGrade(trial('not-a-case'))).toEqual({ status: 'incomplete', missing: ['unknown case or reference'] });
  });
  it('holds ambiguous branches until independently resolved fixture decisions are supplied', () => {
    for (const id of ['W01', 'W20', 'W22', 'W24', 'R33']) {
      expect(prepareNativeGrade(trial(id))).toEqual({ status: 'incomplete', missing: id === 'R33' ? [`unresolved ${id} fixture branch`, 'R33 tariff table, research question, source snapshots and deterministic error schedule are not pinned as fixture inputs'] : [`unresolved ${id} fixture branch`] });
      expect(prepareNativeGrade(trial(id), { [id]: ref('owner-branch-adjudication') }).status).toBe(id === 'R33' ? 'incomplete' : 'packet_prepared_ungraded');
    }
  });
  it('prepares an outcome rubric, not a golden-plan or tool-trajectory matching key', () => {
    const ready = prepareNativeGrade(trial('W02'));
    expect(ready.status).toBe('packet_prepared_ungraded');
    if (ready.status !== 'packet_prepared_ungraded') return;
    expect(ready.packet.spec.id).toBe('W02');
    expect(ready.packet.reference_rubric.original_pass_evidence).toEqual(ready.packet.spec.pass_evidence);
    expect(ready.packet.reference_rubric).not.toHaveProperty('golden_plan');
    expect(ready.packet.reference_rubric).not.toHaveProperty('observed_tools');
    expect(ready).not.toHaveProperty('score');
  });
});
