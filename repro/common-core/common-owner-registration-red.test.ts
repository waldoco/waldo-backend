// Synthetic contract RED only. Existing session fixtures do not establish real messaging authority.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { IdentityPresenceModule } from '../../packages/runtime/src/coordinator/identity-presence-module';

it('one owner root retains two independently revocable verified synthetic presence registrations', async () => {
  const stub = env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('common-registration-red'));
  await runInDurableObject(stub, (_instance, state) => {
    const identity = new IdentityPresenceModule(state.storage);
    const first = { ownerId: 'owner_common_01', authenticatedSubjectRef: `supabase_subject_${'a'.repeat(64)}`,
      presenceId: 'presence_common_01', presenceRegistrationId: 'presence_registration_common_01',
      authenticatedSessionId: `authenticated_session_${'b'.repeat(64)}`, ownerPolicyRevision: 7, ownerRootRoutingVersion: 2 };
    const second = { ...first, presenceId: 'presence_common_02', presenceRegistrationId: 'presence_registration_common_02',
      authenticatedSessionId: `authenticated_session_${'c'.repeat(64)}` };
    for (const authority of [first, second]) {
      state.storage.transactionSync(() => identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({ ...authority,
        presenceState: 'active', authenticatedSessionExpiresAt: '2026-08-06T13:00:00.000Z', at: '2026-08-06T12:00:00.000Z' }));
    }
    expect(identity.assertCanonicalAuthorityInCurrentTransaction(first, '2026-08-06T12:30:00.000Z')).toMatchObject(first);
    expect(identity.assertCanonicalAuthorityInCurrentTransaction(second, '2026-08-06T12:30:00.000Z')).toMatchObject(second);
    identity.setPresenceStateInCurrentTransaction(first.presenceRegistrationId, 'revoked', '2026-08-06T12:31:00.000Z');
    expect(() => identity.assertCanonicalAuthorityInCurrentTransaction(first, '2026-08-06T12:32:00.000Z')).toThrow('responsibility authority denied');
    expect(identity.assertCanonicalAuthorityInCurrentTransaction(second, '2026-08-06T12:32:00.000Z')).toMatchObject(second);
  });
});
