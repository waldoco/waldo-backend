import { z } from 'zod';
import { appJsonWireBytes } from './core';

export const APP_ACCESS_VERSION = 'access.v1' as const;
export const APP_ACCESS_MAX_REQUEST_BYTES = 32768;
export const appAccessWireFits = (value: unknown): boolean => appJsonWireBytes(value) <= APP_ACCESS_MAX_REQUEST_BYTES;
export const APP_ONBOARDING_STEPS = ['hello', 'name', 'day', 'goals', 'wake', 'bedtime', 'peak', 'stress', 'caffeine', 'profession', 'autonomy', 'connect-watch', 'permissions', 'signal-depth', 'notifications', 'legal', 'few-days'] as const;
export const appOnboardingStepV1Schema = z.enum(APP_ONBOARDING_STEPS);
const operation = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const account = z.string().regex(/^acct_[a-f0-9]{64}$/);
const revision = z.int().nonnegative();
const connection = z.string().min(1).max(256);
const optionalText = (max: number) => z.string().max(max).optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional();
export const appProfilePreferencesV1Schema = z.strictObject({
  name: optionalText(100), about: optionalText(4000), timezone: z.string().min(1).max(100).optional(),
  profession: optionalText(200), day_type: z.enum(['flexible', 'meetings', 'focus', 'varies']).optional(),
  goals: z.array(z.enum(['energy', 'stress', 'schedule', 'sleep', 'work', 'other'])).max(6).optional(), goals_note: optionalText(1000),
  wake_time: time, bedtime: time, peak: z.enum(['morning', 'afternoon', 'evening', 'varies']).optional(),
  stress_signs: z.array(z.enum(['focus', 'irritability', 'fatigue', 'push-through', 'cancel', 'other'])).max(6).optional(), stress_note: optionalText(1000),
  caffeine: z.enum(['none', 'morning', 'through-day', 'varies']).optional(), work_note: optionalText(1000),
  autonomy_preference: z.enum(['observe', 'approve', 'scoped']).optional(), wearable_preference: z.enum(['apple', 'android', 'other', 'none']).optional(),
  health_interest: z.enum(['not-now', 'device', 'cloud']).optional(),
});
export const appProfileV1Schema = z.strictObject({
  version: z.literal(APP_ACCESS_VERSION), account_ref: account, revision, updated_at: z.int().nonnegative().nullable(),
  preferences: appProfilePreferencesV1Schema, source: z.literal('explicit_owner'), authority: z.literal('preferences_only'),
});
export const appProfileSaveV1Schema = z.strictObject({ operation_id: operation, expected_revision: revision, preferences: appProfilePreferencesV1Schema });
export const appAccessReceiptV1Schema = z.strictObject({
  version: z.literal(APP_ACCESS_VERSION), operation_id: operation, kind: z.enum(['profile', 'onboarding', 'connect', 'disconnect', 'forget_derived', 'session_revoke']),
  state: z.enum(['recorded', 'unconfirmed', 'rejected']), revision: revision.nullable(), recorded_at: z.int().nonnegative(),
  // A recorded mutation describes server custody. Provider/native acceptance is separate.
  authority: z.literal('authenticated_owner'),
  handoff: z.strictObject({ url: z.url(), expires_at: z.int().nonnegative(), origin: z.url(), connection_ref: connection.nullable() }).nullable(),
});
export const appOnboardingV1Schema = z.strictObject({
  version: z.literal('onboarding.v1'), revision, setup_state: z.enum(['new', 'in_progress', 'first_value_observed']), required_steps: z.array(appOnboardingStepV1Schema),
  steps: z.array(z.strictObject({ step: appOnboardingStepV1Schema, state: z.enum(['not_recorded', 'visited', 'skipped', 'saved', 'observed']), evidence_ref: z.string().max(512).nullable() })),
  first_value: z.strictObject({ state: z.enum(['pending', 'observed']), evidence_ref: z.string().max(512).nullable() }),
});
export const appOnboardingUpdateV1Schema = z.strictObject({ operation_id: operation, expected_revision: revision, step: appOnboardingStepV1Schema, disposition: z.enum(['visit', 'skip']) });
export const appGoogleFeatureV1Schema = z.enum(['calendar', 'calendar_list', 'mail', 'tasks', 'availability', 'drive', 'docs', 'sheets', 'slides']);
export const appConnectorCatalogV1Schema = z.strictObject({
  version: z.literal(APP_ACCESS_VERSION), connectors: z.array(z.strictObject({ provider: z.literal('google'), configured: z.boolean(), multiple_accounts: z.literal(true),
    features: z.array(z.strictObject({ feature: appGoogleFeatureV1Schema, read: z.literal('source_capability'), effect_authority: z.literal('separate_approval') })) })),
});
export const appAccessAccountsV1Schema = z.strictObject({ version: z.literal(APP_ACCESS_VERSION), source_revision: revision, accounts: z.array(z.strictObject({
  connection_ref: connection, provider: z.literal('google'), email: z.email(), state: z.enum(['connected', 'reauth_required']),
  grants: z.array(z.strictObject({ feature: appGoogleFeatureV1Schema, read: z.enum(['granted', 'missing', 'reauth_required']), effect_authority: z.literal('separate_approval') })),
})) });
export const appConnectV1Schema = z.strictObject({ operation_id: operation, provider: z.literal('google'), mode: z.enum(['connect', 'reauth']), feature: appGoogleFeatureV1Schema, connection_ref: connection.optional() })
  .refine(value => value.mode !== 'reauth' || value.connection_ref !== undefined, 'Reauthentication requires the existing connection reference');
export const appDisconnectV1Schema = z.strictObject({ operation_id: operation, connection_ref: connection });
export const appForgetDerivedV1Schema = z.strictObject({ operation_id: operation, connection_ref: connection, expected_source_revision: revision });
export const appServerSessionsV1Schema = z.strictObject({ version: z.literal(APP_ACCESS_VERSION), sessions: z.array(z.strictObject({
  session_ref: z.string().regex(/^sess_[a-f0-9]{64}$/), current: z.boolean(), created_at: z.int().nonnegative(), last_seen_at: z.int().nonnegative(), absolute_expires_at: z.int().nonnegative(),
})) });
export const appSessionRevokeV1Schema = z.strictObject({ operation_id: operation, session_ref: z.string().regex(/^sess_[a-f0-9]{64}$/) });
export const appAccessRoutesV1 = [
  { method: 'GET', path: '/app/v1/profile', response: appProfileV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/profile', request: appProfileSaveV1Schema, response: appAccessReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ACCESS_MAX_REQUEST_BYTES },
  { method: 'GET', path: '/app/v1/onboarding', response: appOnboardingV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/onboarding', request: appOnboardingUpdateV1Schema, response: appAccessReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ACCESS_MAX_REQUEST_BYTES },
  { method: 'GET', path: '/app/v1/access/catalog', response: appConnectorCatalogV1Schema, authenticated: true, success_status: 200 },
  { method: 'GET', path: '/app/v1/access/accounts', response: appAccessAccountsV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/access/connect', request: appConnectV1Schema, response: appAccessReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ACCESS_MAX_REQUEST_BYTES },
  { method: 'POST', path: '/app/v1/access/disconnect', request: appDisconnectV1Schema, response: appAccessReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ACCESS_MAX_REQUEST_BYTES },
  { method: 'POST', path: '/app/v1/access/forget-derived', request: appForgetDerivedV1Schema, response: appAccessReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ACCESS_MAX_REQUEST_BYTES },
  { method: 'GET', path: '/app/v1/access/sessions', response: appServerSessionsV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/access/sessions/revoke', request: appSessionRevokeV1Schema, response: appAccessReceiptV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ACCESS_MAX_REQUEST_BYTES },
  { method: 'GET', path: '/app/v1/access/operations/{operation_id}', response: appAccessReceiptV1Schema, authenticated: true, success_status: 200 },
] as const;
export type AppProfilePreferencesV1 = z.infer<typeof appProfilePreferencesV1Schema>;
export type AppProfileV1 = z.infer<typeof appProfileV1Schema>;
export type AppAccessReceiptV1 = z.infer<typeof appAccessReceiptV1Schema>;
export type AppOnboardingV1 = z.infer<typeof appOnboardingV1Schema>;
export type AppConnectV1 = z.infer<typeof appConnectV1Schema>;
export type AppAccessAccountsV1 = z.infer<typeof appAccessAccountsV1Schema>;
export type AppServerSessionsV1 = z.infer<typeof appServerSessionsV1Schema>;
