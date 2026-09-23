import { describe, expect, it } from 'vitest';
import { ConnectionModule, type Connection, connectionSchema } from './connection';

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'google-work', ownerId: 'owner-a', provider: 'google', providerAccountId: 'subject-1',
  accountLabel: 'work@example.com', purpose: 'calendar read', dataClasses: ['calendar_metadata'],
  scopes: ['calendar.readonly'], scopeRevision: 1, credentialHandle: 'vault:opaque',
  credentialGeneration: 1, adapterVersion: 'google-v1', consentEpoch: 1,
  revocationGeneration: 0, status: 'active', updatedAt: 1, ...overrides,
});

describe('ConnectionModule', () => {
  it('stores opaque owner-bound connections and normalizes capabilities', () => {
    const module = new ConnectionModule();
    const stored = module.put('owner-a', connection({ scopes: ['calendar.readonly', 'calendar.readonly'] }));
    expect(stored.scopes).toEqual(['calendar.readonly']);
    expect(module.list('owner-a')).toEqual([stored]);
    expect(module.list('owner-b')).toEqual([]);
    expect(() => module.put('owner-b', connection())).toThrow('owner mismatch');
    expect(connectionSchema.safeParse({ ...connection(), refreshToken: 'secret' }).success).toBe(false);
  });

  it('keeps provider account identity immutable and generations monotonic', () => {
    const module = new ConnectionModule();
    module.put('owner-a', connection());
    expect(() => module.put('owner-a', connection({ providerAccountId: 'subject-2', updatedAt: 2 }))).toThrow('identity is immutable');
    expect(() => module.put('owner-a', connection({ credentialGeneration: 0, updatedAt: 2 }))).toThrow('cannot decrease');
    expect(() => module.put('owner-a', connection({ scopeRevision: 0, updatedAt: 2 }))).toThrow('cannot decrease');
  });

  it('fails closed on invalid lifecycle transitions', () => {
    const module = new ConnectionModule();
    module.put('owner-a', connection({ status: 'revoked', revocationGeneration: 1 }));
    expect(() => module.put('owner-a', connection({ status: 'active', revocationGeneration: 1, updatedAt: 2 }))).toThrow('transition denied');
    expect(module.put('owner-a', connection({ status: 'revoked', revocationGeneration: 1, updatedAt: 2 })).status).toBe('revoked');
    expect(() => module.put('owner-a', connection({ status: 'revoked', revocationGeneration: 2, updatedAt: 3 }))).toThrow('revoke is idempotent');
  });

  it('rechecks scope, data class, credential, consent and revocation generations at use', () => {
    const module = new ConnectionModule();
    module.put('owner-a', connection());
    const required = { scopes: ['calendar.readonly'], dataClasses: ['calendar_metadata'], credentialGeneration: 1, revocationGeneration: 0, consentEpoch: 1 };
    expect(module.assertUsable('owner-a', 'google-work', required).providerAccountId).toBe('subject-1');
    expect(() => module.assertUsable('owner-a', 'google-work', { ...required, scopes: ['gmail.send'] })).toThrow('scope missing');
    expect(() => module.assertUsable('owner-a', 'google-work', { ...required, credentialGeneration: 0 })).toThrow('generation mismatch');
    module.put('owner-a', connection({ status: 'reauthorization_required', updatedAt: 2 }));
    expect(() => module.assertUsable('owner-a', 'google-work', required)).toThrow('unavailable');
  });
});
