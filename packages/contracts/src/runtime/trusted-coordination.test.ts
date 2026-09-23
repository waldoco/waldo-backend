import { describe, expect, it } from 'vitest';
import { TrustedCoordinationModule, type CoordinationRequest } from './trusted-coordination';

const H = 3_600_000;
const connected = () => {
  const module = new TrustedCoordinationModule();
  module.establish('owner-a', { ownerId: 'owner-a', peerOwnerId: 'owner-b', purposes: ['scheduling'], establishedAt: 1 });
  module.establish('owner-b', { ownerId: 'owner-b', peerOwnerId: 'owner-a', purposes: ['scheduling'], establishedAt: 2 });
  return module;
};
const request = (overrides: Partial<CoordinationRequest> = {}): CoordinationRequest => ({
  requestId: 'rq-1', requesterOwnerId: 'owner-a', recipientOwnerId: 'owner-b', purpose: 'scheduling',
  durationMinutes: 30, windows: [{ start: 10 * H, end: 12 * H }], createdAt: 100, expiresAt: 5 * H, ...overrides,
});
const accept = (overrides = {}) => ({ requesterOwnerId: 'owner-a', requestId: 'rq-1', decision: 'accept', slot: { start: 10 * H, end: 10.5 * H }, at: 200, ...overrides });

describe('TrustedCoordinationModule', () => {
  it('schedules through mutual consent, independent approvals and dual receipts', () => {
    const module = connected();
    expect(module.request('owner-a', request())).toMatchObject({ role: 'requester', status: 'pending' });
    expect(module.list('owner-b', 150)).toMatchObject([{ role: 'recipient', peerOwnerId: 'owner-a', status: 'pending' }]);
    expect(module.receipts('owner-a')).toEqual([]);
    expect(module.respond('owner-b', accept()).status).toBe('accepted');
    expect(module.receipts('owner-b')).toEqual([]);
    expect(module.confirm('owner-a', 'rq-1', 300).status).toBe('confirmed');
    expect(module.receipts('owner-a')).toEqual([{ requestId: 'rq-1', ownerId: 'owner-a', peerOwnerId: 'owner-b', purpose: 'scheduling', slot: { start: 10 * H, end: 10.5 * H }, confirmedAt: 300 }]);
    expect(module.receipts('owner-b')[0]).toMatchObject({ ownerId: 'owner-b', peerOwnerId: 'owner-a' });
    expect(module.receipts('owner-c')).toEqual([]);
  });

  it('shares only minimal availability and rejects extra fields or bad offers', () => {
    const module = connected();
    expect(() => module.request('owner-a', { ...request(), eventTitles: ['Therapy'] })).toThrow();
    expect(() => module.request('owner-a', request({ windows: [{ start: 10 * H, end: 10 * H + 60_000 }] }))).toThrow('window too short');
    expect(() => module.request('owner-a', request({ expiresAt: 100 }))).toThrow('expiry');
    expect(() => module.request('owner-b', request())).toThrow('owner mismatch');
    module.request('owner-a', request());
    expect(() => module.respond('owner-b', accept({ slot: { start: 11.75 * H, end: 12.25 * H } }))).toThrow('outside offer');
    expect(() => module.respond('owner-b', accept({ slot: { start: 10 * H, end: 11 * H } }))).toThrow('outside offer');
    expect(() => module.respond('owner-a', accept())).toThrow('not found');
    expect(() => module.confirm('owner-a', 'rq-1', 300)).toThrow('not accepted');
  });

  it('requires both sides and keeps decline, expiry and withdrawal indistinguishable to the requester', () => {
    const one = new TrustedCoordinationModule();
    one.establish('owner-a', { ownerId: 'owner-a', peerOwnerId: 'owner-b', purposes: ['scheduling'], establishedAt: 1 });
    expect(() => one.request('owner-a', request())).toThrow('not mutual');

    const module = connected();
    module.request('owner-a', request());
    module.request('owner-a', request({ requestId: 'rq-2' }));
    module.respond('owner-b', accept({ decision: 'decline', slot: null }));
    expect(module.list('owner-a', 300).map((item) => item.status)).toEqual(['closed', 'pending']);
    expect(module.list('owner-b', 300)[0]?.status).toBe('declined');
    expect(module.list('owner-a', 5 * H).map((item) => item.status)).toEqual(['closed', 'closed']);
    expect(module.list('owner-b', 5 * H)[1]?.status).toBe('expired');
    expect(() => module.respond('owner-b', accept({ requestId: 'rq-2', at: 5 * H }))).toThrow('expired');
  });

  it('closes open requests on revoke or block and records reports without leaking the reason', () => {
    const module = connected();
    module.request('owner-a', request());
    module.revoke('owner-b', 'owner-a');
    expect(module.list('owner-a', 300)[0]?.status).toBe('closed');
    expect(() => module.respond('owner-b', accept())).toThrow('not mutual');
    module.block('owner-b', 'owner-a', true, 400);
    expect(() => module.establish('owner-b', { ownerId: 'owner-b', peerOwnerId: 'owner-a', purposes: ['scheduling'], establishedAt: 500 })).toThrow('blocked');
    expect(() => module.request('owner-a', request({ requestId: 'rq-2' }))).toThrow('not mutual');
    expect(module.reports()).toEqual([{ reporterOwnerId: 'owner-b', reportedOwnerId: 'owner-a', at: 400 }]);
  });

  it('namespaces request ids per requester and lets the requester withdraw', () => {
    const module = connected();
    module.establish('owner-c', { ownerId: 'owner-c', peerOwnerId: 'owner-b', purposes: ['scheduling'], establishedAt: 3 });
    module.establish('owner-b', { ownerId: 'owner-b', peerOwnerId: 'owner-c', purposes: ['scheduling'], establishedAt: 4 });
    module.request('owner-a', request());
    module.request('owner-c', request({ requesterOwnerId: 'owner-c' }));
    expect(module.withdraw('owner-a', 'rq-1', 150).status).toBe('closed');
    expect(module.respond('owner-b', accept({ requesterOwnerId: 'owner-c' })).status).toBe('accepted');
    expect(() => module.respond('owner-b', accept())).toThrow('not pending');
    expect(module.list('owner-a', 150)).toHaveLength(1);
  });
});
