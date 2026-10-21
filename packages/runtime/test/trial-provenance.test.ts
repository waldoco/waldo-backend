import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sealCaptureReceipt, verifyCaptureReceipts, type ReceiptKeys } from '../evals/trial-provenance';
import type { ObservedTrial } from '../evals/grading-contract';
const a = (bytes: string, role: string) => ({ bytes, source: `${role}:owner-a`, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
const trial: ObservedTrial = { case_id: 'W23', seed: 'trial-1', fixture_manifest: a('f','runner'), transcript: a('t','runner'), tool_trace: a('tools','runner'), authority_timeline: a('auth','runner'), source_revisions: a('source','source_adapter'), intercepted_effects: a('effects','effect_interceptor'), final_state_readback: a('state','provider_readback') };
const keys: ReceiptKeys = { runner: 'distinct-test-key-runner', source_adapter: 'distinct-test-key-source', effect_interceptor: 'distinct-test-key-effect', provider_readback: 'distinct-test-key-readback' };
const roles = { fixture_manifest:'runner', transcript:'runner', tool_trace:'runner', authority_timeline:'runner', source_revisions:'source_adapter', intercepted_effects:'effect_interceptor', final_state_readback:'provider_readback' } as const;
const receipts = Object.entries(roles).map(([field, role]) => sealCaptureReceipt(trial, 'owner-a', field as keyof typeof roles, role, keys[role]));
const identity = { owners: ['owner-a', 'owner-b'] as [string,string], candidate_owner: 'owner-a' };
describe('evaluator-side trial receipt verification', () => {
  it('requires distinct-role receipts bound to the same case, seed, owner and captured bytes', () => {
    expect(verifyCaptureReceipts(trial, identity, receipts, keys)).toEqual([]);
    expect(verifyCaptureReceipts(trial, identity, receipts.slice(1), keys)).not.toEqual([]);
    expect(verifyCaptureReceipts(trial, identity, [{ ...receipts[0]!, owner_id: 'owner-b' }, ...receipts.slice(1)], keys)).not.toEqual([]);
    expect(verifyCaptureReceipts({ ...trial, transcript: { ...trial.transcript, bytes: 'changed' } }, identity, receipts, keys)).not.toEqual([]);
    expect(verifyCaptureReceipts(trial, identity, [{ ...receipts[0]!, seed: 'other' }, ...receipts.slice(1)], keys)).not.toEqual([]);
    expect(verifyCaptureReceipts(trial, identity, receipts, { ...keys, provider_readback: 'wrong-key' })).not.toEqual([]);
    expect(verifyCaptureReceipts(trial, identity, receipts, { ...keys, provider_readback: keys.runner })).toContain('adapter keys must be nonempty and distinct');
    expect(verifyCaptureReceipts({ ...trial, final_state_readback: { ...trial.final_state_readback, source: 'runner:owner-a' } }, identity, receipts, keys)).not.toEqual([]);
  });
  it('rejects duplicate owner identities', () => {
    expect(verifyCaptureReceipts(trial, { owners: ['owner-a','owner-a'], candidate_owner:'owner-a' }, receipts, keys)).toContain('invalid two-owner isolation');
  });
});
