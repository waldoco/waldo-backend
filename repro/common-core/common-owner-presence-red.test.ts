// RED preparation only. Not a proof of shared task orchestration or closure.
import { expect, it, vi } from 'vitest';
import { ownerMessageAdmission } from '../../packages/runtime/src/identity/owner-message-admission';
import type { RunEffectScope } from '../../packages/runtime/src/channels/run-effect-scope';

it('authenticated Telegram and WhatsApp presences of one owner admit the same principal', async () => {
  const ownerId = '10000000-0000-0000-0000-000000000001';
  const scope: RunEffectScope = { runId: 'run-common', attempt: 'attempt-common', deadline: Date.now() + 30_000,
    signal: new AbortController().signal, admit: vi.fn(), commit: work => work() };
  const admit = (provider: 'telegram' | 'whatsapp', subject: string, presenceId: string) => {
    const setup = { lookup: async () => ({ owner_id: ownerId, do_name: 'owner-common', state_version: 0,
      admission_revision: '1', presence_id: presenceId, provider, subject }), scope,
      locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-common', doId: 'common-do' },
      actualDoId: 'common-do', expectedDoId: () => 'common-do', allowedDoNames: ['owner-common'],
      provider, subject, text: 'Continue my synthetic task.', occurrenceKey: `${provider}:fixture-1`,
      occurredAt: Date.now() - 1, now: Date.now };
    // Current type excludes WhatsApp too. Deliberately reach the current runtime boundary to reproduce its rejection.
    return ownerMessageAdmission(setup as unknown as Parameters<typeof ownerMessageAdmission>[0]);
  };
  const telegram = await admit('telegram', '81101', '20000000-0000-0000-0000-000000000001');
  const whatsapp = await admit('whatsapp', '15550001111', '20000000-0000-0000-0000-000000000002');
  expect(whatsapp.invocation.verified_authority.principal_ref).toBe(telegram.invocation.verified_authority.principal_ref);
  expect(whatsapp.invocation.verified_authority.tenant_ref).toBe(telegram.invocation.verified_authority.tenant_ref);
  expect(whatsapp.invocation.occurrence.occurrence_ref).not.toBe(telegram.invocation.occurrence.occurrence_ref);
});
