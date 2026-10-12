import { expect, it, vi } from 'vitest';
import { ownerJobAdmission, type SurfaceOwnerBinding } from '../src/identity/surface-owner-admission';

const OWNER = '10000000-0000-0000-0000-000000000001';
const binding = (overrides: Partial<SurfaceOwnerBinding> = {}): SurfaceOwnerBinding => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do', ...overrides });
const options = (lookup: () => Promise<SurfaceOwnerBinding> = vi.fn(async () => binding())) => ({
  lookup, expectedPhysicalDoId: 'actual-do', job: 'brief' as const, occurrenceKey: 'card:brief:2026-10-13', occurredAt: Date.now() - 1, now: Date.now,
});

it('admits a scheduled job under the bound owner principal, from the owner scheduler', async () => {
  const admitted = await ownerJobAdmission(options());
  expect(admitted.invocation.verified_authority.principal_ref).toBe('prn_10000000000000000000000000000001');
  expect(admitted.invocation.verified_authority.tenant_ref).toBe('ten_10000000000000000000000000000001');
  expect(admitted.invocation.admission_source).toBe('trusted_scheduler');
  expect(admitted.invocation.intent).toEqual({ kind: 'run_owner_job', job: 'brief' });
  expect(admitted.invocation.runtime_binding.trigger).toBe('brief');
  const input = await admitted.readInput();
  expect(input.principal_ref).toBe(admitted.invocation.verified_authority.principal_ref);
  expect(input.content_digest).toBe(admitted.invocation.input_refs[0]!.content_digest);
});

it('names one occurrence per owner, job and schedule occurrence', async () => {
  const first = await ownerJobAdmission(options());
  const again = await ownerJobAdmission(options());
  const other = await ownerJobAdmission({ ...options(), occurrenceKey: 'card:brief:2026-10-14' });
  const otherOwner = await ownerJobAdmission(options(vi.fn(async () => binding({ ownerId: '10000000-0000-0000-0000-000000000002' }))));
  expect(again.invocation.occurrence.occurrence_ref).toBe(first.invocation.occurrence.occurrence_ref);
  expect(other.invocation.occurrence.occurrence_ref).not.toBe(first.invocation.occurrence.occurrence_ref);
  expect(otherOwner.invocation.occurrence.occurrence_ref).not.toBe(first.invocation.occurrence.occurrence_ref);
});

it('a binding that changes after admission stops the job before any input is read', async () => {
  const lookup = vi.fn().mockResolvedValueOnce(binding()).mockResolvedValueOnce(binding()).mockResolvedValue(binding({ revision: '6' }));
  const admitted = await ownerJobAdmission(options(lookup));
  await expect(admitted.assertCurrent()).rejects.toMatchObject({ code: 'rejected' });
  await expect(admitted.readInput()).rejects.toMatchObject({ code: 'rejected' });
});

it('refuses a binding for another Durable Object, a malformed owner and an unknown job', async () => {
  await expect(ownerJobAdmission(options(vi.fn(async () => binding({ physicalDoId: 'other-do' }))))).rejects.toMatchObject({ code: 'rejected' });
  await expect(ownerJobAdmission(options(vi.fn(async () => binding({ ownerId: 'telegram:1001' }))))).rejects.toMatchObject({ code: 'rejected' });
  await expect(ownerJobAdmission({ ...options(), job: 'journal' as never })).rejects.toMatchObject({ code: 'rejected' });
});

it('a lookup that cannot answer reports unavailable, never an owner', async () => {
  await expect(ownerJobAdmission(options(vi.fn(async () => { throw new Error('directory down: secret detail'); })))).rejects.toMatchObject({ code: 'unavailable', message: 'owner admission unavailable' });
});
