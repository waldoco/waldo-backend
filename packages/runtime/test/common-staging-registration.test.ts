import { expect, it } from 'vitest';
import { COMMON_TEST_CEILING_MICROUSD, commonStagingRegistration } from '../src/channels/common-staging-registration';

const base = () => ({
  policy: { ref: 'trial-1', doName: 'owner-do', subject: '81103', directoryOwnerId: '11111111-2222-3333-4444-555555555555', createdAt: 1_791_460_800_000, expiresAt: 1_791_461_400_000, allowedOrigins: ['https://example.com'], maxAllocations: 2, maxReservedBrowserMs: 1_200_000, lifetimeMs: 120_000, maxScreenshotBytes: 500_000 },
  billing: { cloudflareAccountId: 'a'.repeat(32), billingCycleDays: 30, workersPaid: true },
  spend: { limitMicrousd: 10_000_000, maxCalls: 20, validUntil: 1_791_461_400_000, allocationDayCount: 2 },
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
it('admits account-independent conservative reservation without pretending a paid plan or billing cycle was read',()=>{
 const value=base();(value as any).billing={cloudflareAccountId:'a'.repeat(32),conservativeWorstCase:true};delete (value.spend as any).allocationDayCount;
 const reg=commonStagingRegistration(env(value))!;expect(reg.spend.allocationMicrousd).toBe(2_090_000);
});

it('refuses a one-day envelope when the approved allocation window can cross billing days', () => {
 const value = base();
 value.policy.createdAt = Date.parse('2026-10-08T23:59:30Z'); value.policy.expiresAt = value.policy.createdAt + 120000;
 value.spend.allocationDayCount = 1; value.policy.lifetimeMs = 60000; value.policy.maxAllocations = 1; value.spend.validUntil = value.policy.expiresAt;
 expect(() => commonStagingRegistration(env(value))).toThrow('allocation day bound');
 value.spend.allocationDayCount = 2;
 expect(commonStagingRegistration(env(value))!.spend.allocationMicrousd).toBe(223334);
});
