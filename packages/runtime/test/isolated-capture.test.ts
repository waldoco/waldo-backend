import { describe, expect, it } from 'vitest';
import { assembleIsolatedCapture, type IsolatedCapture } from '../evals/isolated-capture';
const owner = 'fixture-owner-a';
const capture: IsolatedCapture = {
  case_id: 'W23', seed: 'independent-seed-1', owners: [owner, 'fixture-owner-b'], candidate_owner: owner,
  fixture_manifest: { role: 'runner', owner_id: owner, bytes: 'manifest' },
  transcript: { role: 'runner', owner_id: owner, bytes: 'transcript' },
  tool_trace: { role: 'runner', owner_id: owner, bytes: 'tool spans' },
  authority_timeline: { role: 'runner', owner_id: owner, bytes: 'fictional grants' },
  source_revisions: { role: 'source_adapter', owner_id: owner, bytes: 'source revision' },
  intercepted_effects: { role: 'effect_interceptor', owner_id: owner, bytes: 'intercepted outbox empty' },
  final_state_readback: { role: 'provider_readback', owner_id: owner, bytes: 'provider state' },
};
describe('isolated capture assembly, not a scored trial', () => {
  it('binds each artifact to the candidate owner, a source role and digest', () => {
    const assembled = assembleIsolatedCapture(capture);
    expect(assembled.case_id).toBe('W23');
    expect(assembled.intercepted_effects.source).toBe(`effect_interceptor:${owner}`);
    expect(assembled.final_state_readback.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('refuses mixed-owner, fake role, duplicate owners and empty readback', () => {
    expect(() => assembleIsolatedCapture({ ...capture, source_revisions: { ...capture.source_revisions, owner_id: 'fixture-owner-b' } })).toThrow(/unbound/);
    expect(() => assembleIsolatedCapture({ ...capture, final_state_readback: { ...capture.final_state_readback, role: 'runner' } })).toThrow(/unbound/);
    expect(() => assembleIsolatedCapture({ ...capture, owners: [owner, owner] })).toThrow(/identity/);
    expect(() => assembleIsolatedCapture({ ...capture, final_state_readback: { ...capture.final_state_readback, bytes: ' ' } })).toThrow(/empty/);
  });
});
