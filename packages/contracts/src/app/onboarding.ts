import { z } from 'zod';

// First run, the consent ledger and the owner look-up findings, app.v1. Additive and self-contained: it imports only zod so
// the app can pin it verbatim. Owner identity is never in a request; the authenticated serving adapter derives it.
// Health consent is not here: it stays in the health plane's own per-source ledger (health-ingest.ts), and the first run's
// health step only reads it.

// The copy versions a grant is recorded against. A grant names the version the owner saw; a stale version is refused, so a
// record always points at the copy that was on screen. Notice copy 1 says Waldo may look the owner up on the public web.
export const APP_TERMS_VERSION_V1 = 1;
export const APP_PRIVACY_NOTICE_VERSION_V1 = 1;
export const APP_ONBOARDING_MAX_REQUEST_BYTES_V1 = 4096;

const epoch = z.int().nonnegative();
const count = z.int().nonnegative();
export const appOnboardingRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const requestId = appOnboardingRequestIdV1Schema;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// Structural only. The serving adapter also checks the name against the platform's zone database.
const timezone = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/);

// Consent ledger. terms and privacy_notice are accepted once per copy version and end only with the account. owner_lookup is
// the owner's yes to Waldo looking them up on the public web and keeping what it finds; withdrawing it erases every finding.
export const appConsentPurposeV1Schema = z.enum(['terms', 'privacy_notice', 'owner_lookup']);
export const appConsentStateV1Schema = z.strictObject({
  purpose: appConsentPurposeV1Schema,
  version: z.int().positive().nullable(),
  status: z.enum(['granted', 'withdrawn', 'not_granted']),
  granted_at: epoch.nullable(),
  withdrawn_at: epoch.nullable(),
}).superRefine((state, ctx) => {
  if ((state.status === 'not_granted') !== (state.granted_at === null) || (state.status === 'not_granted') !== (state.version === null)) ctx.addIssue({ code: 'custom', path: ['granted_at'], message: 'only a never-granted purpose has no version or grant time' });
  if ((state.status === 'withdrawn') !== (state.withdrawn_at !== null)) ctx.addIssue({ code: 'custom', path: ['withdrawn_at'], message: 'withdrawn status and withdrawn_at must agree' });
  if (state.withdrawn_at !== null && state.granted_at !== null && state.withdrawn_at < state.granted_at) ctx.addIssue({ code: 'custom', path: ['withdrawn_at'], message: 'withdrawal cannot precede grant' });
  if (state.status === 'withdrawn' && state.purpose !== 'owner_lookup') ctx.addIssue({ code: 'custom', path: ['status'], message: 'only owner_lookup can be withdrawn; terms and the notice end with the account' });
});
// age_attested_18_plus is true once the owner has said they are 18 or over; it is recorded on the account, never only ticked.
export const appConsentListV1Schema = z.strictObject({
  age_attested_18_plus: z.boolean(),
  consents: z.array(appConsentStateV1Schema).length(appConsentPurposeV1Schema.options.length)
    .refine(rows => new Set(rows.map(row => row.purpose)).size === rows.length, 'each purpose is listed once'),
});
export const appConsentGrantV1Schema = z.strictObject({
  request_id: requestId, purpose: appConsentPurposeV1Schema, version: z.int().positive(), age_attested_18_plus: z.literal(true),
});
export const appConsentWithdrawV1Schema = z.strictObject({ request_id: requestId, purpose: z.literal('owner_lookup') });
// findings_erased counts the look-up findings a withdrawal removed; it is 0 for a grant and for a replay.
export const appConsentChangeV1Schema = z.strictObject({ consent: appConsentStateV1Schema, replayed: z.boolean(), findings_erased: count });

// First run. Three questions at most, each skippable: name, brief_time and priority are the only steps that ask the owner
// anything. google and health are connections the owner may decline; channel is a choice among fixed surfaces, with the app
// the default when it is skipped; first_look is Waldo's first piece of work. A step is pending until the owner answers,
// connects or skips it.
export const appOnboardingStepV1Schema = z.enum(['agreements', 'name', 'google', 'health', 'first_look', 'brief_time', 'priority', 'channel']);
export const appOnboardingStepStateV1Schema = z.enum(['pending', 'done', 'skipped']);
export const APP_ONBOARDING_SKIPPABLE_V1 = ['name', 'google', 'health', 'brief_time', 'priority', 'channel'] as const;
// Where Waldo's proactive messages go: the Brief, reminders and follow-ups. This is the console's own setting (app by default).
// Choosing whatsapp or both before WhatsApp is linked is safe: delivery falls back to the app until the number is linked.
export const appProactiveSurfaceV1Schema = z.enum(['app', 'whatsapp', 'both']);
const steps = z.strictObject({
  agreements: appOnboardingStepStateV1Schema, name: appOnboardingStepStateV1Schema, google: appOnboardingStepStateV1Schema,
  health: appOnboardingStepStateV1Schema, first_look: appOnboardingStepStateV1Schema, brief_time: appOnboardingStepStateV1Schema,
  priority: appOnboardingStepStateV1Schema, channel: appOnboardingStepStateV1Schema,
}).refine(value => value.agreements !== 'skipped' && value.first_look !== 'skipped', 'agreements and first_look cannot be skipped');
// first_look.message_id is the main-chat client message id of the first-look request; the app reads its receipt and the reply
// through the chat routes. brief.time is null until the owner sets it; the first Brief goes out only once the zone is confirmed.
// channel.surface is the live proactive-surface setting, so the app reads it rather than guessing the default.
export const appOnboardingV1Schema = z.strictObject({
  version: z.literal(1),
  state: z.enum(['not_started', 'in_progress', 'completed']),
  run_id: z.string().regex(/^onb_[a-f0-9]{32}$/).nullable(),
  started_at: epoch.nullable(),
  completed_at: epoch.nullable(),
  steps,
  first_look: z.strictObject({ message_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullable() }),
  brief: z.strictObject({ time: clock.nullable(), timezone_confirmed: z.boolean() }),
  channel: z.strictObject({ surface: appProactiveSurfaceV1Schema }),
  revision,
}).superRefine((run, ctx) => {
  if ((run.state === 'not_started') !== (run.run_id === null) || (run.run_id === null) !== (run.started_at === null)) ctx.addIssue({ code: 'custom', path: ['run_id'], message: 'a run id and start time exist exactly once started' });
  if ((run.state === 'completed') !== (run.completed_at !== null)) ctx.addIssue({ code: 'custom', path: ['completed_at'], message: 'completed_at exists exactly once completed' });
  if ((run.steps.first_look === 'done') !== (run.first_look.message_id !== null)) ctx.addIssue({ code: 'custom', path: ['first_look'], message: 'a done first look names its message' });
  if (run.state === 'completed' && run.steps.agreements !== 'done') ctx.addIssue({ code: 'custom', path: ['steps', 'agreements'], message: 'a completed run has accepted the agreements' });
});
// agreements.accept records terms and the notice at their current versions, the 18+ attestation and the owner's look-up choice
// in one step. health.connected is checked against the health plane's own consent ledger; an app's word alone never marks it.
const action = <Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) => z.strictObject({ request_id: requestId, action: z.literal(name), ...shape });
export const appOnboardingActionV1Schema = z.discriminatedUnion('action', [
  action('start', {}),
  action('agreements.accept', { terms_version: z.int().positive(), notice_version: z.int().positive(), age_attested_18_plus: z.literal(true), owner_lookup: z.boolean() }),
  action('name.set', { name: z.string().trim().min(1).max(80) }),
  action('health.connected', {}),
  action('first_look.request', {}),
  action('brief_time.set', { time: clock, timezone }),
  action('priority.set', { text: z.string().trim().min(1).max(500) }),
  action('channel.set', { surface: appProactiveSurfaceV1Schema }),
  action('skip', { step: z.enum(APP_ONBOARDING_SKIPPABLE_V1) }),
  action('complete', {}),
]);
export const appOnboardingResultV1Schema = z.strictObject({ request_id: requestId, onboarding: appOnboardingV1Schema, replayed: z.boolean() });

// Look-up findings: what Waldo found about the owner on the public web, each with the page it came from. A finding is
// external content and stays unconfirmed until the owner keeps or corrects it; only then does it become owner memory. It
// is about the owner alone (there is no subject field) and its category is one of these: there is no category for health,
// religion, caste, politics or sexuality, so none can be stored. Every string renders as plain text, never markdown or links,
// except source.url, which the app opens only as an http(s) link.
export const appFindingCategoryV1Schema = z.enum(['work', 'education', 'public_work', 'based_in', 'public_profile', 'interest', 'achievement']);
export const appFindingIdV1Schema = z.string().regex(/^fnd_[a-f0-9]{32}$/);
export const APP_FINDING_TEXT_MAX_V1 = 300;
export const APP_FINDINGS_PAGE_MAX_V1 = 50;
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);
export const appFindingV1Schema = z.strictObject({
  finding_id: appFindingIdV1Schema,
  category: appFindingCategoryV1Schema,
  text: z.string().min(1).max(APP_FINDING_TEXT_MAX_V1),
  source: z.strictObject({ url: httpUrl, title: z.string().max(300) }),
  state: z.enum(['unconfirmed', 'kept', 'corrected']),
  found_at: epoch,
  decided_at: epoch.nullable(),
}).refine(finding => (finding.state === 'unconfirmed') === (finding.decided_at === null), { error: 'decided_at exists exactly once the owner kept or corrected it', path: ['decided_at'] });
// Newest first. lookup is the owner_lookup consent status; with it withdrawn or never granted the list is empty.
export const appFindingListV1Schema = z.strictObject({
  lookup: appConsentStateV1Schema.shape.status,
  items: z.array(appFindingV1Schema).max(APP_FINDINGS_PAGE_MAX_V1),
  total: count,
  next_cursor: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
}).refine(page => page.total >= page.items.length, { error: 'total counts every finding', path: ['total'] });
export const appFindingListQueryV1Schema = z.strictObject({ cursor: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() });
export const appFindingActionV1Schema = z.discriminatedUnion('action', [
  z.strictObject({ request_id: requestId, finding_id: appFindingIdV1Schema, action: z.literal('keep') }),
  z.strictObject({ request_id: requestId, finding_id: appFindingIdV1Schema, action: z.literal('correct'), text: z.string().trim().min(1).max(APP_FINDING_TEXT_MAX_V1) }),
  z.strictObject({ request_id: requestId, finding_id: appFindingIdV1Schema, action: z.literal('forget') }),
]);
export const appFindingResultV1Schema = z.strictObject({
  request_id: requestId, finding_id: appFindingIdV1Schema, outcome: z.enum(['kept', 'corrected', 'forgotten']), replayed: z.boolean(),
});

// A client acts on `error` only. stale_version: the grant named a copy that is no longer current. agreements_required: a step
// that needs the accepted agreements came first. not_started: the run must be started first. not_connected: health.connected
// found no live health consent. completed: the run is finished and changes go through the controls. request_reused: a
// request_id came back with a different body. not_found: no such finding.
export const appOnboardingErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'stale_version', 'agreements_required', 'not_started', 'not_connected', 'completed', 'request_reused', 'not_found', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appOnboardingRoutesV1 = [
  { method: 'GET', path: '/app/v1/onboarding', response: appOnboardingV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/onboarding/actions', request: appOnboardingActionV1Schema, response: appOnboardingResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/consents', response: appConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/consents', request: appConsentGrantV1Schema, response: appConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/consents/withdraw', request: appConsentWithdrawV1Schema, response: appConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/findings', query: appFindingListQueryV1Schema, response: appFindingListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/findings/actions', request: appFindingActionV1Schema, response: appFindingResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
] as const;

export type AppConsentPurposeV1 = z.infer<typeof appConsentPurposeV1Schema>;
export type AppConsentStateV1 = z.infer<typeof appConsentStateV1Schema>;
export type AppOnboardingV1 = z.infer<typeof appOnboardingV1Schema>;
export type AppOnboardingActionV1 = z.infer<typeof appOnboardingActionV1Schema>;
export type AppOnboardingStepV1 = z.infer<typeof appOnboardingStepV1Schema>;
export type AppProactiveSurfaceV1 = z.infer<typeof appProactiveSurfaceV1Schema>;
export type AppFindingV1 = z.infer<typeof appFindingV1Schema>;
export type AppFindingCategoryV1 = z.infer<typeof appFindingCategoryV1Schema>;
export type AppFindingActionV1 = z.infer<typeof appFindingActionV1Schema>;
