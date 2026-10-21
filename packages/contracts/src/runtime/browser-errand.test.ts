import { describe, expect, it } from 'vitest';
import { browserErrandBlockedSchema, browserErrandCheckpointSchema, browserLoginStateSchema } from './browser-errand';

const valid = {
  version: 1, errandId: 'errand-1', ownerId: 'owner-a', errandType: 'subscription_cancel', engine: 'browser_use_v4', origin: 'https://shop.example',
  phase: 'awaiting_approval', holdExpiresAt: 2000, finalAction: 'Confirm cancellation', expected: { status: 'Cancelled' }, verifyCheck: 'Report the plan status.',
  review: { url: 'https://shop.example/cancel', facts: { plan: 'Premium' }, factsDigest: `sha256:${'a'.repeat(64)}` },
  proposalId: 'proposal-1', approvalExpiresAt: 1800, submit: null, blocked: null, login: null, receipt: null,
  custody: { profileRef: 'p', sessionRef: 's', prepareRunRef: 'r', submitRunRef: null, liveViewUrl: null }, updatedAt: 1,
};

describe('browser errand checkpoint', () => {
  it('accepts a held review awaiting approval', () => {
    expect(browserErrandCheckpointSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an origin with a path', { origin: 'https://shop.example/account' }],
    ['a plain-HTTP origin', { origin: 'http://shop.example' }],
    ['a credentialed review URL', { review: { ...valid.review, url: 'https://user:pass@shop.example/cancel' } }],
    ['an engine outside the list', { engine: 'browserbase_agents' }],
    ['empty postconditions', { expected: {} }],
    ['an unknown field', { notes: 'free text' }],
    ['a credentialed live view link', { custody: { ...valid.custody, liveViewUrl: 'https://a:b@live.example/view' } }],
    ['an empty fact value', { review: { ...valid.review, facts: { plan: '' } } }],
  ])('rejects %s', (_name, change) => {
    expect(browserErrandCheckpointSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it('names exactly three structured blocks and seven login states', () => {
    expect(browserErrandBlockedSchema.options).toEqual(['challenge', 'login_required', 'js_required']);
    expect(browserErrandBlockedSchema.safeParse('captcha').success).toBe(false);
    expect(browserLoginStateSchema.safeParse('owner_in_control').success).toBe(true);
    expect(browserLoginStateSchema.safeParse('typing').success).toBe(false);
  });
});
