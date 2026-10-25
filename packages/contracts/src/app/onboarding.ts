import { z } from 'zod';

// First run, the consent ledger and the owner look-up findings, app.v1. Additive and self-contained: it imports only zod so
// the app can pin it verbatim. Owner identity is never in a request; the authenticated serving adapter derives it.
// Health consent is not here: it stays in the health plane's own per-source ledger (health-ingest.ts), and the first run's
// health step only reads it. One consent, one representation: the purposes below are the non-health ones, and no health
// source or purpose, WHOOP's express authorization included, is ever a value here. WHOOP's authorization is the health plane's
// (whoop, storage_compute) and (whoop, model_processing) grants, both live.

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
  // Whether the yes counts now: granted, at the current copy, offered by this server, with its prerequisite live. A yes the
  // server holds back (a switch off) or an older copy reads granted and not active; a settings screen shows active.
  active: z.boolean(),
}).superRefine((state, ctx) => {
  if (state.active && state.status !== 'granted') ctx.addIssue({ code: 'custom', path: ['active'], message: 'only a granted purpose can be active' });
  if ((state.status === 'not_granted') !== (state.granted_at === null) || (state.status === 'not_granted') !== (state.version === null)) ctx.addIssue({ code: 'custom', path: ['granted_at'], message: 'only a never-granted purpose has no version or grant time' });
  if ((state.status === 'withdrawn') !== (state.withdrawn_at !== null)) ctx.addIssue({ code: 'custom', path: ['withdrawn_at'], message: 'withdrawn status and withdrawn_at must agree' });
  if (state.withdrawn_at !== null && state.granted_at !== null && state.withdrawn_at < state.granted_at) ctx.addIssue({ code: 'custom', path: ['withdrawn_at'], message: 'withdrawal cannot precede grant' });
  if (state.status === 'withdrawn' && state.purpose !== 'owner_lookup') ctx.addIssue({ code: 'custom', path: ['status'], message: 'only owner_lookup can be withdrawn; terms and the notice end with the account' });
});
// age_attested_18_plus is true once the owner has said they are 18 or over; it is recorded on the account, never only ticked.
// agreements_offered is false while this server holds back the terms and the notice (until their copy is approved): the app
// then shows no agreements step, terms and privacy_notice are refused not_offered, and the steps after the agreements run with
// the agreements step pending, in a completed run too, until they are offered and accepted on the consent route. owner_lookup_offered is false while this server does not offer the look-up (until the notice that discloses it is
// published, and whenever the agreements are held back): the app then does not ask, and a grant is refused not_offered.
// owner_lookup can be granted only after privacy_notice.
export const appConsentListV1Schema = z.strictObject({
  age_attested_18_plus: z.boolean(),
  agreements_offered: z.boolean(),
  owner_lookup_offered: z.boolean(),
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
// the default when it is skipped, plus linking a chat channel (iMessage, WhatsApp or Telegram, one flow for all); first_look is Waldo's first piece of work. A step is pending until the owner answers,
// connects or skips it.
export const appOnboardingStepV1Schema = z.enum(['agreements', 'name', 'google', 'health', 'first_look', 'brief_time', 'priority', 'channel']);
export const appOnboardingStepStateV1Schema = z.enum(['pending', 'done', 'skipped']);
export const APP_ONBOARDING_SKIPPABLE_V1 = ['name', 'google', 'health', 'brief_time', 'priority', 'channel'] as const;
// Where Waldo's proactive messages go: the Brief, reminders and follow-ups. This is the console's own setting (app by default).
// Choosing whatsapp or both before WhatsApp is linked is safe: delivery falls back to the app until the number is linked.
// app_imessage keeps the app taking the work and sends iMessage a copy.
export const appProactiveSurfaceV1Schema = z.enum(['app', 'whatsapp', 'both', 'app_imessage']);
// The chat channels an owner can link, the same flow for each: iMessage, WhatsApp and Telegram (the team's test channel while it
// lasts; the server stops offering it by reporting not_offered). linked is read live from the owner directory, never from the
// app's word. not_offered means this server cannot link it, so the app hides it; unknown means the directory could not be read.
export const appChatProviderV1Schema = z.enum(['imessage', 'whatsapp', 'telegram']);
export const appChatLinkStateV1Schema = z.enum(['linked', 'not_linked', 'not_offered', 'unknown']);
export const appOnboardingChannelsV1Schema = z.strictObject({
  surface: appProactiveSurfaceV1Schema,
  channels: z.array(z.strictObject({ provider: appChatProviderV1Schema, state: appChatLinkStateV1Schema })).length(appChatProviderV1Schema.options.length)
    .refine(rows => new Set(rows.map(row => row.provider)).size === rows.length, 'each provider is listed once'),
});
// A one-time code the owner sends from their own phone, which links that account to their own Waldo. It has no request_id: it
// is a secret that is never stored for a replay, and a repeat just issues another code. text is what to send; address and
// send_url are set only where Waldo knows the number to open (iMessage). Linking is the owner's act in the app, never Waldo's:
// no tool issues a code, and one that did would have to go through an approval card.
export const appChannelLinkRequestV1Schema = z.strictObject({ provider: appChatProviderV1Schema });
export const appChannelLinkCodeV1Schema = z.strictObject({
  provider: appChatProviderV1Schema,
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/),
  text: z.string().max(64),
  address: z.string().min(3).max(320).nullable(),
  send_url: z.string().startsWith('sms:').max(512).nullable(),
  expires_in_seconds: z.literal(600),
}).refine(link => link.text.endsWith(link.code), { error: 'the text to send carries the code', path: ['text'] });

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
});
// agreements.accept records terms and the notice at their current versions, the 18+ attestation and the owner's look-up choice
// in one step. health.connected is checked against the health plane's own consent ledger; an app's word alone never marks it.
// A device source counts on its storage grant; a cloud wearable such as WHOOP counts only with storage and model use both live.
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
  action('channel.linked', { provider: appChatProviderV1Schema }),
  action('skip', { step: z.enum(APP_ONBOARDING_SKIPPABLE_V1) }),
  action('complete', {}),
]);
export const appOnboardingResultV1Schema = z.strictObject({ request_id: requestId, onboarding: appOnboardingV1Schema, replayed: z.boolean() });

// Look-up findings: what Waldo found about the owner on the public web, each with the page it came from. A finding is
// external content and stays unconfirmed until the owner keeps or corrects it; only then does it become owner memory. Whether
// a page is the owner's, or a namesake's, is decided by the owner on each finding: forget removes it and bars it from coming
// back. There is no subject field, and its category is one of these: there is no category for health,
// religion, caste, politics or sexuality, so none can be stored. Every string renders as plain text, never markdown or links,
// except source.url, which the app opens only as an http(s) link.
export const appFindingCategoryV1Schema = z.enum(['work', 'education', 'public_work', 'based_in', 'public_profile', 'interest', 'achievement']);
export const appFindingIdV1Schema = z.string().regex(/^fnd_[a-f0-9]{32}$/);
export const APP_FINDING_TEXT_MAX_V1 = 300;
export const APP_FINDINGS_PAGE_MAX_V1 = 50;
// An unconfirmed finding is deleted this many days after found_at; one the owner kept or corrected stays.
export const APP_FINDING_UNCONFIRMED_DAYS_V1 = 30;
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
// Newest first. lookup is the owner_lookup consent status as it counts now. A withdrawal erases every finding, so the list is
// empty after one; when the look-up stops counting another way (the server's switch, a newer notice), what was found stays
// listed, and forgettable, with lookup not_granted.
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

// Setup answers: what the app's setup conversation asks besides the steps above, kept as owner facts Waldo reads on every
// turn, on every surface. Each answer a request names is set, null clears it, and one left out stays as it is. day and slips
// pair a choice with the owner's own words; an empty choice with no words clears it too. wearable is the watch the owner
// says they wear, never a paired device or its data. Not part of the run: these can be sent before it starts and after it
// finishes, as often as setup is run again. Refused agreements_required while the agreements are offered and not accepted.
export const APP_SETUP_OWN_WORDS_MAX_V1 = 280;
export const appSetupDayShapeV1Schema = z.enum(['meetings', 'focus', 'fixed', 'varies']);
export const appSetupSlipV1Schema = z.enum(['replies', 'overlaps', 'promises', 'breaks', 'evenings']);
export const appSetupWearableV1Schema = z.enum(['samsung', 'apple', 'oura', 'whoop', 'garmin']);
const ownWords = z.string().trim().max(APP_SETUP_OWN_WORDS_MAX_V1);
const SETUP_ANSWERS = ['name', 'day', 'slips', 'wearable'] as const;
export const appSetupAnswersRequestV1Schema = z.strictObject({
  request_id: requestId,
  name: z.string().trim().min(1).max(80).nullable().optional(),
  day: z.strictObject({ shape: appSetupDayShapeV1Schema.nullable(), own_words: ownWords }).nullable().optional(),
  slips: z.strictObject({
    picked: z.array(appSetupSlipV1Schema).max(appSetupSlipV1Schema.options.length).refine(picked => new Set(picked).size === picked.length, 'a slip is picked once'),
    own_words: ownWords,
  }).nullable().optional(),
  wearable: appSetupWearableV1Schema.nullable().optional(),
}).refine(request => SETUP_ANSWERS.some(answer => request[answer] !== undefined), 'name at least one answer');
// held says, for each answer, whether Waldo holds it as an owner fact now, read back after the write.
export const appSetupAnswersResultV1Schema = z.strictObject({
  request_id: requestId,
  held: z.strictObject({ name: z.boolean(), day: z.boolean(), slips: z.boolean(), wearable: z.boolean() }),
  replayed: z.boolean(),
});

// channel.linked marks the channel step done once the owner directory shows that provider linked, as health.connected does for health.
// A client acts on `error` only. stale_version: the grant named a copy that is no longer current. agreements_required: a step
// that needs the accepted agreements came first. not_started: the run must be started first. not_connected: health.connected
// found no live health consent, or channel.linked found the provider not linked. not_offered: this server cannot link that chat
// channel, or does not offer the look-up, or holds the agreements back. agreements_required also answers a look-up grant made before the privacy notice. completed: the run is finished and changes go through the controls. request_reused: a
// request_id came back with a different body. not_found: no such finding.
export const appOnboardingErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'stale_version', 'agreements_required', 'not_started', 'not_connected', 'not_offered', 'completed', 'request_reused', 'not_found', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appOnboardingRoutesV1 = [
  { method: 'GET', path: '/app/v1/onboarding', response: appOnboardingV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/onboarding/actions', request: appOnboardingActionV1Schema, response: appOnboardingResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/onboarding/answers', request: appSetupAnswersRequestV1Schema, response: appSetupAnswersResultV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/onboarding/channels', response: appOnboardingChannelsV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/onboarding/channel-link', request: appChannelLinkRequestV1Schema, response: appChannelLinkCodeV1Schema, authenticated: true, success_status: 200, max_request_bytes: APP_ONBOARDING_MAX_REQUEST_BYTES_V1 },
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
export type AppChatProviderV1 = z.infer<typeof appChatProviderV1Schema>;
export type AppChatLinkStateV1 = z.infer<typeof appChatLinkStateV1Schema>;
export type AppOnboardingChannelsV1 = z.infer<typeof appOnboardingChannelsV1Schema>;
export type AppChannelLinkCodeV1 = z.infer<typeof appChannelLinkCodeV1Schema>;
export type AppFindingV1 = z.infer<typeof appFindingV1Schema>;
export type AppFindingCategoryV1 = z.infer<typeof appFindingCategoryV1Schema>;
export type AppFindingActionV1 = z.infer<typeof appFindingActionV1Schema>;
export type AppSetupAnswersRequestV1 = z.infer<typeof appSetupAnswersRequestV1Schema>;
export type AppSetupAnswersResultV1 = z.infer<typeof appSetupAnswersResultV1Schema>;
