import { z } from 'zod';

// Screen time: one summary per device and local day, sent by the phone and kept on the backend so the owner's agent can read
// it with get_screen_time. The phone is never asked for it live: it uploads what it has read, and the agent reads what is stored.
//
// - Consent is its own, apart from health: purposes storage_compute (keep the summaries) and model_processing (let Waldo's AI read
//   them). Model use needs both. The server owns status and epoch; an unknown state reads as not granted.
// - Withdrawing storage_compute withdraws both and deletes every stored day. Withdrawing model_processing only stops the agent's reads.
// - What is kept: the fields of screenTimeDayV1Schema and nothing else. No raw event, app name or package name is accepted.
// - Days are kept 90 days, then removed by the health retention sweep. Account deletion removes them with the owner.
// - Egress: the owner's model context in the turn that asked, and the owner's own read-back. Never logs, memory or third parties.
// - Android only. iOS waits on Apple's terms for Screen Time data leaving the device.

export const SCREEN_TIME_CONSENT_VERSION_V1 = 1;
export const SCREEN_TIME_INGEST_MAX_DAYS_V1 = 14;
export const SCREEN_TIME_READ_MAX_DAYS_V1 = 31;
export const SCREEN_TIME_MAX_REQUEST_BYTES_V1 = 32_768;

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
const epoch = z.int().min(0).max(999_999_999);
const instant = z.iso.datetime();
export const screenTimeDayV1Schema = z.iso.date();
const minutesOfDay = z.int().min(0).max(1440);
const count = z.int().min(0).max(10_000);
// Local HH:MM. 24:00 is the end of the day, for use that ran to midnight.
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);

export const screenTimePurposeV1Schema = z.enum(['storage_compute', 'model_processing']);
export const screenTimeConsentV1Schema = z.strictObject({
  purpose: screenTimePurposeV1Schema,
  version: z.int().positive(),
  status: z.enum(['not_granted', 'granted', 'withdrawn']),
  epoch,
  granted_at: instant.nullable(),
  withdrawn_at: instant.nullable(),
});
export const screenTimeConsentListV1Schema = z.strictObject({ consents: z.array(screenTimeConsentV1Schema).max(2) });
export const screenTimeConsentGrantV1Schema = z.strictObject({
  request_id: requestId, purpose: screenTimePurposeV1Schema, version: z.literal(SCREEN_TIME_CONSENT_VERSION_V1), expected_epoch: epoch,
});
export const screenTimeConsentWithdrawV1Schema = z.strictObject({ request_id: requestId, purpose: screenTimePurposeV1Schema, expected_epoch: epoch });
// deletion_routed: the stored days were deleted by this withdrawal.
export const screenTimeConsentChangeV1Schema = z.strictObject({ consent: screenTimeConsentV1Schema, replayed: z.boolean(), deletion_routed: z.boolean() });

// Android's ApplicationInfo categories; an app the phone cannot see is undefined.
export const screenTimeCategoryV1Schema = z.enum(['game', 'audio', 'video', 'image', 'social', 'news', 'maps', 'productivity', 'accessibility', 'undefined']);
// One local day on one device. Absent means not known, never zero. coverage none knows nothing, so it carries no number.
// partial: the phone's record does not cover the whole day (it started mid-day, or the day was read before it ended).
export const screenTimeDaySummaryV1Schema = z.strictObject({
  day: screenTimeDayV1Schema,
  timezone: z.string().min(1).max(64),
  platform: z.literal('android'),
  coverage: z.enum(['complete', 'partial', 'none']),
  screen_on_minutes: minutesOfDay.optional(),
  pickups: count.optional(),
  unlocks: count.optional(),
  late_night_minutes: minutesOfDay.optional(),
  // The window late_night_minutes counts, local HH:MM-HH:MM; a start after the end runs across midnight.
  late_night_window: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/),
  first_use_at: clock.optional(),
  last_use_at: clock.optional(),
  categories: z.array(z.strictObject({ category: screenTimeCategoryV1Schema, minutes: minutesOfDay.positive() })).max(screenTimeCategoryV1Schema.options.length).optional(),
}).refine(day => day.coverage !== 'none' || [day.screen_on_minutes, day.pickups, day.unlocks, day.late_night_minutes, day.first_use_at, day.last_use_at, day.categories].every(part => part === undefined),
  { error: 'a day with no coverage carries no number' })
  .refine(day => new Set(day.categories?.map(entry => entry.category)).size === (day.categories?.length ?? 0), { error: 'each category once', path: ['categories'] });

// A day is re-sent whole and replaces the earlier copy for the same device and day. expected_epoch is the storage_compute epoch
// the phone read with consent; an upload from before a withdrawal is refused, so it cannot repopulate what was deleted.
// device_id is the app installation id the push registration uses.
export const screenTimeIngestV1Schema = z.strictObject({
  request_id: requestId,
  expected_epoch: epoch,
  device_id: z.uuid(),
  days: z.array(screenTimeDaySummaryV1Schema).min(1).max(SCREEN_TIME_INGEST_MAX_DAYS_V1),
}).refine(body => new Set(body.days.map(day => day.day)).size === body.days.length, { error: 'each day once', path: ['days'] });
// out_of_window: the day is later than tomorrow or more than 14 days before today, in its own time zone.
export const screenTimeIngestReceiptV1Schema = z.strictObject({
  request_id: requestId,
  replayed: z.boolean(),
  results: z.array(z.strictObject({ day: screenTimeDayV1Schema, status: z.enum(['accepted', 'rejected']), reason: z.literal('out_of_window').optional() })
    .refine(result => (result.status === 'rejected') === (result.reason !== undefined), { error: 'a rejected day says why' })).max(SCREEN_TIME_INGEST_MAX_DAYS_V1),
});

const dayOrdinal = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
// What Waldo kept, for the owner's own view, read from the server. Needs storage consent only.
export const screenTimeDaysQueryV1Schema = z.strictObject({ from: screenTimeDayV1Schema, to: screenTimeDayV1Schema })
  .refine(query => dayOrdinal(query.from) <= dayOrdinal(query.to), { error: 'from must not be after to', path: ['to'] })
  .refine(query => dayOrdinal(query.to) - dayOrdinal(query.from) < SCREEN_TIME_READ_MAX_DAYS_V1, { error: `at most ${SCREEN_TIME_READ_MAX_DAYS_V1} days`, path: ['to'] });
export const screenTimeStoredDayV1Schema = z.strictObject({ device_id: z.uuid(), received_at: instant, summary: screenTimeDaySummaryV1Schema });
export const screenTimeDaysV1Schema = z.strictObject({ days: z.array(screenTimeStoredDayV1Schema).max(SCREEN_TIME_READ_MAX_DAYS_V1 * 4) });

// The runtime may attach a short message; a client acts on `error` only.
export const screenTimeApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'unavailable']),
  message: z.string().max(1000).optional(),
});

// A Worker with screen time off answers 404 on every route.
export const appScreenTimeRoutesV1 = [
  { method: 'GET', path: '/app/v1/screen-time/consents', response: screenTimeConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/screen-time/consents', request: screenTimeConsentGrantV1Schema, response: screenTimeConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: SCREEN_TIME_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/screen-time/consents/withdraw', request: screenTimeConsentWithdrawV1Schema, response: screenTimeConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: SCREEN_TIME_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/screen-time/days', request: screenTimeIngestV1Schema, response: screenTimeIngestReceiptV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: SCREEN_TIME_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/screen-time/days', query: screenTimeDaysQueryV1Schema, response: screenTimeDaysV1Schema, authenticated: true, success_status: 200 },
] as const;

export type ScreenTimeDaySummaryV1 = z.infer<typeof screenTimeDaySummaryV1Schema>;
export type ScreenTimeIngestV1 = z.infer<typeof screenTimeIngestV1Schema>;
export type ScreenTimeConsentV1 = z.infer<typeof screenTimeConsentV1Schema>;
