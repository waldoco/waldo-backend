import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { captureFixtureAdapters } from '../evals/fixture-adapter-capture';
import { sealCaptureReceipt, verifyCaptureReceipts, type ReceiptKeys } from '../evals/trial-provenance';
import type { ObservedTrial } from '../evals/grading-contract';
const keys: ReceiptKeys = { runner: 'test-runner', source_adapter: 'test-source', effect_interceptor: 'test-effects', provider_readback: 'test-provider' };
const identity = { case_id: 'fictional-smoke', seed: 'fixture-1', candidate_owner: 'a', control_owner: 'b' };
const world = () => new IsolatedSourceWorld({ clock: '2026-10-01T00:00:00Z', owners: [{ id: 'a' }, { id: 'b' }],
  sources: { mail: [{ owner_id: 'a', id: 'same', body: 'A original' }, { owner_id: 'b', id: 'same', body: 'B secret' }] },
  revisions: [{ owner_id: 'a', source: 'mail', id: 'same', at: '2026-10-01T00:01:00Z', patch: { body: 'A updated' } }] });
const runnerArtifact = (bytes: string) => ({ bytes, source: 'runner:a', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
describe('fictional adapter-side capture, not provider custody', () => {
  it('captures actual source reads/revisions, effects and provider state with bound receipts', () => {
    const w = world();
    w.read('a', 'mail', 'same'); w.advance('2026-10-01T00:01:00Z');
    w.commitCalendarCreate('a', { title: 'A meeting', start: '2026-10-02T10:00:00Z', end: '2026-10-02T11:00:00Z' }, 'key');
    const captured = captureFixtureAdapters(w, identity, keys);
    const trial: ObservedTrial = { case_id: identity.case_id, seed: identity.seed, ...captured.artifacts,
      fixture_manifest: runnerArtifact('fixture'), transcript: runnerArtifact('scripted'), tool_trace: runnerArtifact('trace'), authority_timeline: runnerArtifact('fictional') };
    const runnerFields = ['fixture_manifest', 'transcript', 'tool_trace', 'authority_timeline'] as const;
    const receipts = [...captured.receipts, ...runnerFields.map((field) => sealCaptureReceipt(trial, 'a', field, 'runner', keys.runner))];
    expect(verifyCaptureReceipts(trial, { owners: ['a', 'b'], candidate_owner: 'a' }, receipts, keys)).toEqual([]);
    expect(captured.artifacts.source_revisions.bytes).toContain('A updated');
    expect(captured.artifacts.source_revisions.bytes).toContain('A original');
    expect(captured.artifacts.intercepted_effects.bytes).toContain('calendar.create');
    expect(captured.artifacts.final_state_readback.bytes).toContain('A meeting');
    expect(JSON.stringify(captured)).not.toContain('B secret');
    w.commitCalendarCreate('a', { title: 'Later event', start: '2026-10-03T10:00:00Z', end: '2026-10-03T11:00:00Z' }, 'later');
    expect(captured.artifacts.final_state_readback.bytes).not.toContain('Later event');
    expect(verifyCaptureReceipts({ ...trial, final_state_readback: { ...trial.final_state_readback, bytes: 'forged' } },
      { owners: ['a', 'b'], candidate_owner: 'a' }, receipts, keys)).toContain('invalid final_state_readback receipt');
    expect(captureFixtureAdapters(world(), identity, keys).artifacts.intercepted_effects.bytes).not.toContain('calendar.create');
  });
  it('refuses unknown or duplicate owners, reused keys, empty identities and invalid signer inputs', () => {
    const w = world();
    expect(() => captureFixtureAdapters(w, { ...identity, candidate_owner: 'c' }, keys)).toThrow(/owner/);
    expect(() => captureFixtureAdapters(w, { ...identity, control_owner: 'c' }, keys)).toThrow(/owner/);
    expect(() => captureFixtureAdapters(w, { ...identity, control_owner: 'a' }, keys)).toThrow(/identity/);
    expect(() => captureFixtureAdapters(w, { ...identity, seed: '' }, keys)).toThrow(/identity/);
    expect(() => captureFixtureAdapters(w, identity, { ...keys, provider_readback: keys.source_adapter })).toThrow(/distinct/);
    const trial = { case_id: 'x', seed: 'y', transcript: runnerArtifact('t') } as ObservedTrial;
    expect(() => sealCaptureReceipt(trial, 'a', 'transcript', 'provider_readback', keys.provider_readback)).toThrow(/receipt input/);
    expect(() => sealCaptureReceipt({ ...trial, transcript: { ...trial.transcript, bytes: 'changed' } }, 'a', 'transcript', 'runner', keys.runner)).toThrow(/receipt input/);
  });
});
