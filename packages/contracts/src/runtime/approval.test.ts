import { describe, expect, it } from 'vitest';
import { ApprovalQueueModule, type PendingApproval } from './approval';

const a = `sha256:${'a'.repeat(64)}`;
const b = `sha256:${'b'.repeat(64)}`;
const proposal = (overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  approvalId: 'ap-1', ownerId: 'owner-a', operation: 'calendar.event.create', effectClass: 'reversible',
  payloadDigest: a, manifestDigest: b, generation: 1, summary: 'Create focus block', telegramScope: false,
  createdAt: 100, expiresAt: 200, ...overrides,
});
const decision = (overrides = {}) => ({ approvalId: 'ap-1', decision: 'approve', payloadDigest: a, generation: 1, surface: 'app', at: 150, ...overrides });

describe('ApprovalQueueModule', () => {
  it('lists pending approvals per owner and approves the exact payload once', () => {
    const queue = new ApprovalQueueModule();
    queue.propose('owner-a', proposal());
    queue.propose('owner-b', proposal({ ownerId: 'owner-b' }));
    expect(queue.pending('owner-a', 150).map((item) => item.ownerId)).toEqual(['owner-a']);
    expect(queue.decide('owner-a', decision())).toMatchObject({ status: 'approved', surface: 'app', decidedAt: 150 });
    expect(queue.pending('owner-a', 150)).toEqual([]);
    expect(queue.consume('owner-a', 'ap-1', a, 1, 160).status).toBe('consumed');
    expect(() => queue.consume('owner-a', 'ap-1', a, 1, 161)).toThrow('not approved');
    expect(queue.pending('owner-b', 150)).toHaveLength(1);
  });

  it('rejects substitution, expiry, cross-owner and replayed decisions', () => {
    const queue = new ApprovalQueueModule();
    queue.propose('owner-a', proposal());
    expect(() => queue.propose('owner-a', proposal())).toThrow('already exists');
    expect(() => queue.propose('owner-b', proposal())).toThrow('owner mismatch');
    expect(() => queue.decide('owner-b', decision())).toThrow('not found');
    expect(() => queue.decide('owner-a', decision({ payloadDigest: b }))).toThrow('substitution');
    expect(() => queue.decide('owner-a', decision({ generation: 2 }))).toThrow('substitution');
    expect(() => queue.decide('owner-a', decision({ at: 200 }))).toThrow('expired');
    expect(queue.pending('owner-a', 200)).toEqual([]);
    queue.decide('owner-a', decision({ decision: 'decline' }));
    expect(() => queue.decide('owner-a', decision())).toThrow('not pending');
    expect(() => queue.consume('owner-a', 'ap-1', a, 1, 160)).toThrow('not approved');
  });

  it('allows Telegram decisions only for separately proved scopes', () => {
    const queue = new ApprovalQueueModule();
    queue.propose('owner-a', proposal());
    queue.propose('owner-a', proposal({ approvalId: 'ap-2', telegramScope: true }));
    expect(() => queue.decide('owner-a', decision({ surface: 'telegram' }))).toThrow('surface not permitted');
    expect(queue.decide('owner-a', decision({ approvalId: 'ap-2', surface: 'telegram' })).surface).toBe('telegram');
  });

  it('stops or supersedes open approvals so they cannot be consumed', () => {
    const queue = new ApprovalQueueModule();
    queue.propose('owner-a', proposal());
    queue.propose('owner-a', proposal({ approvalId: 'ap-2' }));
    queue.decide('owner-a', decision());
    expect(queue.stop('owner-a', 'ap-1').status).toBe('stopped');
    expect(() => queue.consume('owner-a', 'ap-1', a, 1, 160)).toThrow('not approved');
    expect(queue.supersede('owner-a', 'ap-2').status).toBe('superseded');
    expect(() => queue.decide('owner-a', decision({ approvalId: 'ap-2' }))).toThrow('not pending');
    expect(() => queue.stop('owner-a', 'ap-2')).toThrow('not open');
  });
});
