import { expect, it } from 'vitest';
import { APP_ONBOARDING_STEPS, appProfileSaveV1Schema, appAccessAccountsV1Schema, appOnboardingUpdateV1Schema, appConnectV1Schema, appAccessWireFits } from './access';

it('profile/onboarding accept explicit preferences without caller identity or a grant', () => {
  const request = { operation_id: 'profile-operation-01', expected_revision: 0, preferences: { name: 'Owner', timezone: 'Asia/Kolkata', wake_time: '07:30', autonomy_preference: 'scoped' } };
  expect(appProfileSaveV1Schema.safeParse(request).success).toBe(true);
  expect(appProfileSaveV1Schema.safeParse({ ...request, owner: 'another' }).success).toBe(false);
  expect(appProfileSaveV1Schema.safeParse({ ...request, preferences: { ...request.preferences, credentials: 'secret' } }).success).toBe(false);
  expect(APP_ONBOARDING_STEPS).toHaveLength(17);
  expect(appOnboardingUpdateV1Schema.safeParse({ operation_id: 'onboarding-visit-01', expected_revision: 0, step: 'legal', disposition: 'complete' }).success).toBe(false);
  expect(appAccessWireFits(request)).toBe(true);
  expect(appAccessWireFits({ ...request, preferences: { about: '\u0001'.repeat(4000), goals_note: '\u0001'.repeat(1000), stress_note: '\u0001'.repeat(1000) } })).toBe(false);
});
it('reconnect names an existing connection and account projections cannot carry credentials', () => {
  expect(appConnectV1Schema.safeParse({ operation_id: 'connect-operation-01', provider: 'google', mode: 'reauth', feature: 'mail' }).success).toBe(false);
  const accounts = { version: 'access.v1', source_revision: 0, accounts: [{ connection_ref: 'actual-connection', provider: 'google', email: 'owner@example.invalid', state: 'connected', grants: [] }] };
  expect(appAccessAccountsV1Schema.safeParse(accounts).success).toBe(true);
  expect(appAccessAccountsV1Schema.safeParse({ ...accounts, accounts: [{ ...accounts.accounts[0], refresh_token: 'secret' }] }).success).toBe(false);
});
