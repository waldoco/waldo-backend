import { expect, it } from 'vitest';
import { COMMON_TEST_CEILING_MICROUSD, commonStagingRegistration } from '../src/channels/common-staging-registration';

const base = () => ({
  policy: { ref: 'trial-1', doName: 'owner-do', subject: '5458446350', directoryOwnerId: '11111111-2222-3333-4444-555555555555', createdAt: 1, expiresAt: 2_000_000_000_000, allowedOrigins: ['https://example.com'], maxAllocations: 2, maxReservedBrowserMs: 1_200_000, lifetimeMs: 120_000, maxScreenshotBytes: 500_000 },
  billing: { cloudflareAccountId: 'a'.repeat(32), billingCycleDays: 30, workersPaid: true },
  spend: { limitMicrousd: 10_000_000, maxCalls: 20, validUntil: 2_000_000_000_000, allocationDayCount: 1 },
});
const env = (value: unknown) => ({ WALDO_ENVIRONMENT: 'staging', COMMON_BROWSER_REGISTRATION: JSON.stringify(value) });

it('registers within the owner caps and quotes browser at zero', () => {
  const reg = commonStagingRegistration(env(base()))!;
  expect(reg.spend.policy.limitMicrousd).toBe(10_000_000);
  expect(reg.spend.quote('browser', null)).toBe(0);
  expect(reg.spend.quote('model', { request: { max_tokens: 1000 } })).toBeGreaterThan(0);
  expect(reg.spend.allocationMicrousd).toBeGreaterThan(0);
});
it('refuses a limit over the $20 test ceiling, non-staging, and no registration', () => {
  const big = base(); big.spend.limitMicrousd = COMMON_TEST_CEILING_MICROUSD + 1;
  expect(() => commonStagingRegistration(env(big))).toThrow('registration invalid');
  expect(commonStagingRegistration({ WALDO_ENVIRONMENT: 'production', COMMON_BROWSER_REGISTRATION: JSON.stringify(base()) })).toBeUndefined();
  expect(commonStagingRegistration({ WALDO_ENVIRONMENT: 'staging' })).toBeUndefined();
});
it('refuses allocations whose worst case exceeds the $5 monthly browser cap', () => {
  const heavy = base(); heavy.policy.maxAllocations = 60; heavy.policy.maxReservedBrowserMs = 100_000_000_000; heavy.spend.limitMicrousd = 20_000_000; heavy.policy.lifetimeMs = 600_000;
  expect(() => commonStagingRegistration(env(heavy))).toThrow('exceeds owner caps');
});
