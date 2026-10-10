import { expect, it, vi } from 'vitest';
import { appSessionRevocation } from '../src/rights/session-revocation';

it('settles server push before session signout, then verifies session absence', async () => {
  const calls: string[] = [], hash = 'a'.repeat(64);
  const auth = { revokeSession: vi.fn(async () => { calls.push('session'); return true; }), signOutAll: vi.fn(async () => 1), listSessions: vi.fn(async () => []) };
  const push = { revokeSession: vi.fn(async () => { calls.push('push'); return 1; }), revokeAll: vi.fn(async () => 1) };
  expect(await appSessionRevocation('actual-owner', auth, push).revokeRef(`sess_${hash}`)).toBe(true); expect(calls).toEqual(['push', 'session']); expect(auth.revokeSession).toHaveBeenCalledWith('actual-owner', hash);
});
it('cannot claim signout on unavailable push custody or a remaining directory session', async () => {
  const hash = 'a'.repeat(64), auth = { revokeSession: vi.fn(async () => true), signOutAll: vi.fn(async () => 1), listSessions: vi.fn(async () => [{ session: hash, created_at: '', last_seen_at: '' }]) };
  const push = { revokeSession: vi.fn(async () => { throw Error('push unavailable'); }), revokeAll: vi.fn(async () => 1) };
  await expect(appSessionRevocation('actual-owner', auth, push).revokeHash(hash)).rejects.toThrow('push unavailable'); expect(auth.revokeSession).not.toHaveBeenCalled();
  expect(await appSessionRevocation('actual-owner', auth, { ...push, revokeSession: async () => 0 }).revokeHash(hash)).toBe(false);
  expect(await appSessionRevocation('actual-owner', auth, push).revokeAll()).toBe(false);
});

it('confirms an already-gone session only from fresh signed absence and propagates malformed authority', async () => {
  const hash = 'a'.repeat(64), push = { revokeSession: vi.fn(async () => 0), revokeAll: vi.fn(async () => 0) };
  const auth = { revokeSession: vi.fn(async () => false), signOutAll: vi.fn(async () => 0), listSessions: vi.fn(async () => []) };
  expect(await appSessionRevocation('actual-owner', auth, push).revokeHash(hash)).toBe(true);
  expect(auth.listSessions).toHaveBeenCalledWith('actual-owner');
  auth.listSessions.mockRejectedValueOnce(Error('session inventory unavailable'));
  await expect(appSessionRevocation('actual-owner', auth, push).revokeHash(hash)).rejects.toThrow('session inventory unavailable');
});
