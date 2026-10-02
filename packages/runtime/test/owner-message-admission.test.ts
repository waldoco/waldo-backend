import { expect, it, vi } from 'vitest';
import { canonicalInvocationIdempotencySerialization } from '@waldo/contracts';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const owner = '10000000-0000-0000-0000-000000000001';
const presence = '20000000-0000-0000-0000-000000000001';
const row = () => ({ owner_id: owner, do_name: 'owner-demo', state_version: 0, presence_id: presence, provider: 'telegram', subject: '1001' });
const scope = (): RunEffectScope => ({ runId: 'run-one', attempt: 'attempt-one', deadline: Date.now() + 30_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const options = (lookup: (provider: 'telegram', subject: string) => Promise<unknown> = vi.fn(async () => row())) => ({
  lookup, scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
  actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
  allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text: 'Plan the Bengaluru demo for October 15.',
  occurrenceKey: 'bot-one:update-10', occurredAt: Date.now() - 1, now: Date.now,
});

it('admits the actual owner message using canonical personal-owner authority and input digest', async () => {
  const admitted = await ownerMessageAdmission(options());
  expect(admitted.invocation.verified_authority.principal_ref).toBe('prn_10000000000000000000000000000001');
  expect(admitted.invocation.verified_authority.tenant_ref).toBe('ten_10000000000000000000000000000001');
  expect(admitted.invocation.admission_source).toBe('authenticated_ingress');
  expect(admitted.invocation.runtime_binding.trigger).toBe('user_message');
  const input = await admitted.readInput();
  expect(input.text).toBe('Plan the Bengaluru demo for October 15.');
  expect(input.content_digest).toBe(admitted.invocation.input_refs[0]!.content_digest);
  expect(input.principal_ref).toBe(admitted.invocation.verified_authority.principal_ref);
});

it('an unlink and relink during a paused turn denies input disclosure', async () => {
  const lookup = vi.fn().mockResolvedValueOnce(row()).mockResolvedValue({ ...row(), presence_id: '20000000-0000-0000-0000-000000000002' });
  const admitted = await ownerMessageAdmission(options(lookup));
  await expect(admitted.readInput()).rejects.toMatchObject({ code: 'rejected' });
});

it('future source time rejects before identity lookup', async () => {
  const setup = options();
  setup.occurredAt = Date.now() + 60_000;
  await expect(ownerMessageAdmission(setup)).rejects.toMatchObject({ code: 'rejected' });
  expect(setup.lookup).not.toHaveBeenCalled();
});

it('malformed lookup results reject without exposing host error text', async () => {
  const lookup = vi.fn().mockResolvedValue({ ...row(), extra: 'untrusted' });
  await expect(ownerMessageAdmission(options(lookup))).rejects.toMatchObject({ code: 'rejected' });
});

it('closing the run during the current lookup denies resumed input disclosure', async () => {
  let resume!: (value: unknown) => void;
  const pending = new Promise(resolve => { resume = resolve; });
  const lookup = vi.fn().mockResolvedValueOnce(row()).mockReturnValue(pending);
  const setup = options(lookup);
  let closed = false;
  setup.scope = { ...setup.scope, admit: () => { if (closed) throw new Error('closed'); } };
  const admitted = await ownerMessageAdmission(setup);
  const read = admitted.readInput();
  closed = true;
  resume(row());
  await expect(read).rejects.toThrow('closed');
});

it('lifecycle version and owner replacement invalidate a paused invocation', async () => {
  for (const change of [{ state_version: 2 }, { owner_id: '10000000-0000-0000-0000-000000000002' }]) {
    const lookup = vi.fn().mockResolvedValueOnce(row()).mockResolvedValue({ ...row(), ...change });
    const admitted = await ownerMessageAdmission(options(lookup));
    await expect(admitted.assertCurrent()).rejects.toMatchObject({ code: 'rejected' });
  }
});

it('lookup absence and failure fail closed at admission and resume', async () => {
  for (const value of [null, [], { ...row(), state_version: -1 }, { ...row(), owner_id: 'owner-demo' }]) {
    await expect(ownerMessageAdmission(options(vi.fn().mockResolvedValue(value)))).rejects.toMatchObject({ code: 'rejected' });
  }
  const admitted = await ownerMessageAdmission(options(vi.fn().mockResolvedValueOnce(row()).mockRejectedValue(new Error('private provider details'))));
  await expect(admitted.readInput()).rejects.toMatchObject({ code: 'unavailable', message: 'owner admission unavailable' });
});

it('different verified owners remain separate, while UUID case does not change authority', async () => {
  const first = await ownerMessageAdmission(options());
  const second = await ownerMessageAdmission(options(vi.fn().mockResolvedValue({ ...row(), owner_id: 'abcdef12-0000-0000-0000-000000000001' })));
  const upper = await ownerMessageAdmission(options(vi.fn().mockResolvedValue({ ...row(), owner_id: 'ABCDEF12-0000-0000-0000-000000000001' })));
  expect(second.invocation.verified_authority.principal_ref).not.toBe(first.invocation.verified_authority.principal_ref);
  expect(upper.invocation.verified_authority.principal_ref).toBe(second.invocation.verified_authority.principal_ref);
});

it('retries reuse occurrence identity but bind the actual message digest', async () => {
  const setup = options();
  const first = await ownerMessageAdmission(setup);
  const retry = await ownerMessageAdmission(setup);
  const changed = { ...setup, text: 'October 16 birthday and gym.' };
  const other = await ownerMessageAdmission(changed);
  expect(retry.invocation.idempotency.key_ref).toBe(first.invocation.idempotency.key_ref);
  expect(canonicalInvocationIdempotencySerialization(retry.invocation)).toBe(canonicalInvocationIdempotencySerialization(first.invocation));
  expect(canonicalInvocationIdempotencySerialization(other.invocation)).not.toBe(canonicalInvocationIdempotencySerialization(first.invocation));
  expect(other.invocation.input_refs[0]!.content_digest).not.toBe(first.invocation.input_refs[0]!.content_digest);
});

it('published authority and input receipts cannot be mutated by their consumer', async () => {
  const admitted = await ownerMessageAdmission(options());
  expect(Reflect.set(admitted.invocation.verified_authority, 'principal_ref', 'prn_ffffffffffffffffffffffffffffffff')).toBe(false);
  expect(Reflect.set(admitted.invocation.input_refs[0]!, 'content_digest', 'sha256:' + 'f'.repeat(64))).toBe(false);
  expect((await admitted.readInput()).principal_ref).toBe('prn_10000000000000000000000000000001');
});

it('locator mismatch and non-allowlisted staging identity reject before lookup', async () => {
  for (const patch of [{ actualDoId: 'other-do' }, { allowedDoNames: [] }, { locator: { ...options().locator, environment: 'production' } }]) {
    const setup = { ...options(), ...patch };
    await expect(ownerMessageAdmission(setup)).rejects.toMatchObject({ code: 'rejected' });
    expect(setup.lookup).not.toHaveBeenCalled();
  }
});

it('fresh context uses current observation time and the same owner across verified presences', async () => {
  const setup = options();
  const now = Date.now();
  setup.now = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now + 20);
  const first = await ownerMessageAdmission(setup);
  const other = options(vi.fn().mockResolvedValue({ ...row(), subject: '1002', presence_id: '20000000-0000-0000-0000-000000000002' }));
  other.subject = '1002';
  const second = await ownerMessageAdmission(other);
  expect(first.snapshot.snapshot_at).toBe(now + 20);
  expect(second.invocation.verified_authority.principal_ref).toBe(first.invocation.verified_authority.principal_ref);
  expect(second.invocation.verified_authority.tenant_ref).toBe(first.invocation.verified_authority.tenant_ref);
  expect(second.snapshot.snapshot_ref).not.toBe(first.snapshot.snapshot_ref);
});

it('hostile lookup accessors are rejected before reading their properties', async () => {
  const getter = vi.fn(() => owner);
  const hostile = { ...row() };
  Object.defineProperty(hostile, 'owner_id', { get: getter, enumerable: true });
  await expect(ownerMessageAdmission(options(vi.fn().mockResolvedValue(hostile)))).rejects.toMatchObject({ code: 'rejected' });
  expect(getter).not.toHaveBeenCalled();
});

it('changed locator, provider and subject in lookup receipts deny disclosure', async () => {
  for (const patch of [{ do_name: 'other-owner' }, { provider: 'ios' }, { subject: '1002' }]) {
    const admitted = await ownerMessageAdmission(options(vi.fn().mockResolvedValueOnce(row()).mockResolvedValue({ ...row(), ...patch })));
    await expect(admitted.readInput()).rejects.toMatchObject({ code: 'rejected' });
  }
});

it('closing during the initial lookup prevents admission', async () => {
  let resume!: (value: unknown) => void;
  const setup = options(vi.fn(() => new Promise(resolve => { resume = resolve; })));
  let closed = false;
  setup.scope = { ...setup.scope, admit: () => { if (closed) throw new Error('closed'); } };
  const admission = ownerMessageAdmission(setup);
  closed = true; resume(row());
  await expect(admission).rejects.toThrow('closed');
});

it('backwards observation clock prevents a misleading snapshot', async () => {
  const setup = options();
  const now = Date.now();
  setup.now = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now - 1);
  await expect(ownerMessageAdmission(setup)).rejects.toMatchObject({ code: 'rejected' });
});

it('mutating host option objects and the original receipt cannot rebind admitted authority', async () => {
  const receipt = row();
  const setup = options(vi.fn(async () => receipt));
  const admitted = await ownerMessageAdmission(setup);
  setup.text = 'replacement'; setup.locator.doName = 'different'; setup.allowedDoNames.length = 0;
  expect((await admitted.readInput()).text).toContain('Bengaluru');
  receipt.owner_id = '10000000-0000-0000-0000-000000000002';
  await expect(admitted.readInput()).rejects.toMatchObject({ code: 'rejected' });
});
