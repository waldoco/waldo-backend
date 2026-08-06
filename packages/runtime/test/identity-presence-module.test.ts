import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { IdentityPresenceModule } from '../src/coordinator/identity-presence-module';
import type { RunLoopDO } from '../src/run-loop/do';

let sequence = 0;

function freshStub(): DurableObjectStub<RunLoopDO> {
  sequence += 1;
  return env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(`identity-presence-${sequence}`));
}

const canonical = Object.freeze({
  ownerId: 'owner_canonical_01',
  authenticatedSubjectRef: `supabase_subject_${'a'.repeat(64)}`,
  presenceId: 'presence_canonical_01',
  presenceRegistrationId: 'presence_registration_canonical_01',
  authenticatedSessionId: `authenticated_session_${'b'.repeat(64)}`,
  ownerPolicyRevision: 7,
  ownerRootRoutingVersion: 2,
});

describe('IdentityPresenceModule responsibility authority', () => {
  it('revalidates server claims against Waldo-owned canonical identity and Presence state', async () => {
    await runInDurableObject(freshStub(), (_instance, state) => {
      const identity = new IdentityPresenceModule(state.storage);
      state.storage.transactionSync(() => identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
        ...canonical,
        presenceState: 'active',
        authenticatedSessionExpiresAt: '2026-08-06T13:00:00.000Z',
        at: '2026-08-06T12:00:00.000Z',
      }));

      expect(identity.assertCanonicalAuthorityInCurrentTransaction(
        canonical,
        '2026-08-06T12:30:00.000Z',
      )).toMatchObject(canonical);
      for (const changed of [
        { ...canonical, ownerId: 'owner_substituted' },
        { ...canonical, authenticatedSubjectRef: `supabase_subject_${'c'.repeat(64)}` },
        { ...canonical, presenceId: 'presence_substituted' },
        { ...canonical, ownerPolicyRevision: 8 },
        { ...canonical, ownerRootRoutingVersion: 3 },
        { ...canonical, authenticatedSessionId: `authenticated_session_${'c'.repeat(64)}` },
      ]) {
        expect(() => identity.assertCanonicalAuthorityInCurrentTransaction(
          changed,
          '2026-08-06T12:30:00.000Z',
        )).toThrow('responsibility authority denied');
      }

      identity.setPresenceStateInCurrentTransaction(
        canonical.presenceRegistrationId,
        'revoked',
        '2026-08-06T12:31:00.000Z',
      );
      expect(() => identity.assertCanonicalAuthorityInCurrentTransaction(
        canonical,
        '2026-08-06T12:30:00.000Z',
      )).toThrow('responsibility authority denied');
    });
  });

  it('denies unregistered and expired Presence state without creating authority', async () => {
    await runInDurableObject(freshStub(), (_instance, state) => {
      const identity = new IdentityPresenceModule(state.storage);
      expect(() => identity.assertCanonicalAuthorityInCurrentTransaction(
        canonical,
        '2026-08-06T12:30:00.000Z',
      )).toThrow('responsibility authority denied');

      state.storage.transactionSync(() => identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
        ...canonical,
        presenceState: 'active',
        authenticatedSessionExpiresAt: '2026-08-06T12:29:59.000Z',
        at: '2026-08-06T12:00:00.000Z',
      }));
      expect(() => identity.assertCanonicalAuthorityInCurrentTransaction(
        canonical,
        '2026-08-06T12:30:00.000Z',
      )).toThrow('responsibility authority denied');
    });
  });

  it('binds a renewed login session to the stable Presence and fails closed on corrupt expiry', async () => {
    await runInDurableObject(freshStub(), (_instance, state) => {
      const identity = new IdentityPresenceModule(state.storage);
      state.storage.transactionSync(() => identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
        ...canonical,
        presenceState: 'active',
        authenticatedSessionExpiresAt: '2026-08-06T13:00:00.000Z',
        at: '2026-08-06T12:00:00.000Z',
      }));
      const renewed = {
        ...canonical,
        authenticatedSessionId: `authenticated_session_${'d'.repeat(64)}`,
      };
      state.storage.transactionSync(() => identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
        ...renewed,
        presenceState: 'active',
        authenticatedSessionExpiresAt: '2026-08-06T13:30:00.000Z',
        at: '2026-08-06T12:30:00.000Z',
      }));
      expect(identity.assertCanonicalAuthorityInCurrentTransaction(
        renewed,
        '2026-08-06T12:31:00.000Z',
      )).toMatchObject(renewed);

      state.storage.transactionSync(() =>
        identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
          ...canonical,
          presenceState: 'active',
          authenticatedSessionExpiresAt: '2026-08-06T12:45:00.000Z',
          at: '2026-08-06T12:35:00.000Z',
        }));
      expect(identity.assertCanonicalAuthorityInCurrentTransaction(
        renewed,
        '2026-08-06T13:01:00.000Z',
      )).toMatchObject(renewed);

      state.storage.sql.exec(
        "UPDATE presence_sessions SET expires_at = 'not-a-timestamp' " +
        'WHERE authenticated_session_id = ?',
        renewed.authenticatedSessionId,
      );
      expect(() => identity.assertCanonicalAuthorityInCurrentTransaction(
        renewed,
        '2026-08-06T12:31:00.000Z',
      )).toThrow('responsibility authority denied');
    });
  });

  it('bounds concurrent login-session bindings for one Presence', async () => {
    await runInDurableObject(freshStub(), (_instance, state) => {
      const identity = new IdentityPresenceModule(state.storage);
      for (let index = 0; index < 16; index += 1) {
        state.storage.transactionSync(() =>
          identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
            ...canonical,
            authenticatedSessionId: `authenticated_session_${index.toString(16).repeat(64)}`,
            presenceState: 'active',
            authenticatedSessionExpiresAt: '2026-08-06T13:00:00.000Z',
            at: '2026-08-06T12:00:00.000Z',
          }));
      }
      expect(() => state.storage.transactionSync(() =>
        identity.bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction({
          ...canonical,
          authenticatedSessionId: `authenticated_session_${'f0'.repeat(32)}`,
          presenceState: 'active',
          authenticatedSessionExpiresAt: '2026-08-06T13:00:00.000Z',
          at: '2026-08-06T12:00:00.000Z',
        }))).toThrow('responsibility authority denied');
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM presence_sessions',
      ).one().count).toBe(16);
    });
  });
});
