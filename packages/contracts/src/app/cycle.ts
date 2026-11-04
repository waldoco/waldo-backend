import { z } from 'zod';
import { healthDayV1Schema, healthRequestIdV1Schema, healthSampleOriginV1Schema } from './health-ingest';

// Menstrual cycle context, under proposed ADR-0085. Off for every account until the owner turns it on from the Cycle row in the
// app's health-data settings; Waldo never offers it. The backend reads period dates only, derives the cycle phase itself, and uses
// it for one thing: reading the owner's HRV, resting heart rate, wrist temperature and breathing rate against their own baseline
// for the same phase. It is never shown outside the authenticated app.
//
// - Consent is its own class, reproductive_health, with one purpose, cycle_context, and its own epoch. A grant needs a live
//   health storage_compute grant for apple or health_connect. Withdrawing cycle_context, or withdrawing either of those storage
//   grants, withdraws it, deletes every stored period and moves the epoch, so a queued upload cannot repopulate anything.
//   An unknown state reads as not granted.
// - What is kept: one interval per period, start and end as local dates, the reading's provenance and the name of the app that
//   recorded it. Flow level, symptoms and every other reproductive type are never sent.
// - Periods are kept 90 days. Account deletion removes them with the owner.
// - Egress: the owner's own app. Never a model prompt, log, trace, metric, external channel or third party.
export const CYCLE_CONSENT_VERSION_V1 = 1;
export const CYCLE_RAW_RETENTION_DAYS_V1 = 90;
export const CYCLE_INGEST_MAX_PERIODS_V1 = 12;
export const CYCLE_MAX_REQUEST_BYTES_V1 = 32_768;
// A recorded period longer than this is a logging slip (an end date never set, a typo), not a period.
export const CYCLE_MAX_PERIOD_DAYS_V1 = 15;
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

const epoch = z.int().min(0).max(999_999_999);
const instant = z.iso.datetime();

export const cycleConsentPurposeV1Schema = z.literal('cycle_context');
export const cycleConsentStateV1Schema = z.strictObject({
  consent_class: z.literal('reproductive_health'),
  purpose: cycleConsentPurposeV1Schema,
  version: z.int().positive(),
  status: z.enum(['granted', 'withdrawn', 'not_granted']),
  epoch,
  granted_at: instant.nullable(),
  withdrawn_at: instant.nullable(),
  deletion_state: z.enum(['not_required', 'completed']),
});
export const cycleConsentListV1Schema = z.strictObject({ consents: z.array(cycleConsentStateV1Schema).max(1) });
export const cycleConsentGrantV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  purpose: cycleConsentPurposeV1Schema,
  version: z.literal(CYCLE_CONSENT_VERSION_V1),
  expected_epoch: epoch,
  age_attested_18_plus: z.literal(true),
});
export const cycleConsentWithdrawV1Schema = z.strictObject({ request_id: healthRequestIdV1Schema, purpose: cycleConsentPurposeV1Schema, expected_epoch: epoch });
// deletion_routed: the stored periods were deleted by this withdrawal.
export const cycleConsentChangeV1Schema = z.strictObject({ consent: cycleConsentStateV1Schema, replayed: z.boolean(), deletion_routed: z.boolean() });

export const cycleSourceV1Schema = z.enum(['apple', 'health_connect']);
const READ_API_OF = { apple: 'healthkit', health_connect: 'health_connect' } as const;
// One period. end_date is null while the period is ongoing. source_name is the display name of the app that recorded it (Apple
// Health, Flo, Clue), shown back to the owner on the Cycle row; null when the OS does not say.
export const menstrualPeriodV1Schema = z.strictObject({
  signal: z.literal('menstrual_period'),
  start_date: healthDayV1Schema,
  end_date: healthDayV1Schema.nullable(),
  origin: healthSampleOriginV1Schema,
  source_name: z.string().min(1).max(100).nullable(),
}).refine(period => period.end_date === null || period.start_date <= period.end_date, { error: 'a period ends on or after its start', path: ['end_date'] })
  .refine(period => period.end_date === null || dayNumber(period.end_date) - dayNumber(period.start_date) < CYCLE_MAX_PERIOD_DAYS_V1,
    { error: `a period lasts at most ${CYCLE_MAX_PERIOD_DAYS_V1} days`, path: ['end_date'] });

// The phone sends every period it reads that starts on or after window_start, and the set replaces what Waldo stored for that
// source from window_start on, so a period deleted or edited in the owner's cycle app is deleted or edited here. An empty list
// clears the window. expected_epoch is the cycle_context epoch the phone read with consent.
export const cycleIngestV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  expected_epoch: epoch,
  source: cycleSourceV1Schema,
  window_start: healthDayV1Schema,
  periods: z.array(menstrualPeriodV1Schema).max(CYCLE_INGEST_MAX_PERIODS_V1),
}).superRefine((body, context) => {
  const sorted = [...body.periods].sort((a, b) => a.start_date.localeCompare(b.start_date));
  sorted.forEach((period, i) => {
    if (period.start_date < body.window_start) context.addIssue({ code: 'custom', message: 'a period starts inside the window', path: ['periods'] });
    if (period.origin.read_api !== READ_API_OF[body.source]) context.addIssue({ code: 'custom', message: 'read_api matches the source', path: ['periods'] });
    const next = sorted[i + 1];
    if (next && (period.end_date === null || period.end_date >= next.start_date)) context.addIssue({ code: 'custom', message: 'periods do not overlap and only the latest is ongoing', path: ['periods'] });
  });
});
// ignored: periods outside what Waldo keeps (ending more than 90 days ago, or starting after tomorrow), counted and not stored.
export const cycleIngestReceiptV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  replayed: z.boolean(),
  accepted: z.int().nonnegative(),
  ignored: z.int().nonnegative(),
});

// The Cycle row. off: cycle_context is not granted. waiting_for_data: granted, and no period is stored. active: at least one
// period is stored; last_period_start is the latest one's start and last_source_name the app that recorded it, when known.
// The row says nothing about the phase.
export const cycleStatusV1Schema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('off') }),
  z.strictObject({ state: z.literal('waiting_for_data') }),
  z.strictObject({ state: z.literal('active'), last_period_start: healthDayV1Schema, last_source_name: z.string().min(1).max(100).optional() }),
]);

// The runtime may attach a short message; a client acts on `error` only.
export const cycleApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'unavailable']),
  message: z.string().max(1000).optional(),
});

// A Worker with cycle context off answers 404 on every route.
export const appCycleRoutesV1 = [
  { method: 'GET', path: '/app/v1/cycle/consents', response: cycleConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/cycle/consents', request: cycleConsentGrantV1Schema, response: cycleConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: CYCLE_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/cycle/consents/withdraw', request: cycleConsentWithdrawV1Schema, response: cycleConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: CYCLE_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/cycle/periods', request: cycleIngestV1Schema, response: cycleIngestReceiptV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: CYCLE_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/cycle/status', response: cycleStatusV1Schema, authenticated: true, success_status: 200 },
] as const;

export type CycleConsentStateV1 = z.infer<typeof cycleConsentStateV1Schema>;
export type MenstrualPeriodV1 = z.infer<typeof menstrualPeriodV1Schema>;
export type CycleIngestV1 = z.infer<typeof cycleIngestV1Schema>;
export type CycleStatusV1 = z.infer<typeof cycleStatusV1Schema>;
