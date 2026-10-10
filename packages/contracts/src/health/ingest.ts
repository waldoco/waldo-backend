import { z } from 'zod';
import { healthSourceSchema } from '../adapters/health';
import { iso8601Schema } from '../core/error';
import { formZoneSchema, loadZoneSchema, recoveryZoneSchema } from './crs';

// Additive beta health API. Owner identity is supplied by the authenticated serving
// adapter, never by the upload; raw values have Supabase custody only.
export const HEALTH_CONSENT_VERSION = 1;
export const HEALTH_RAW_RETENTION_DAYS = 90;
export const HEALTH_AGGREGATE_RETENTION_MONTHS = 24;
export const healthPurposeSchema = z.enum(['storage_compute', 'model_processing']);
export const healthRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
export const healthDaySchema = z.iso.date();
export const healthTimezoneSchema = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'invalid timezone');
const sampleIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const epochSchema = z.int().nonnegative();

export const healthConsentGrantSchema = z.strictObject({
  request_id: healthRequestIdSchema,
  source: healthSourceSchema,
  purpose: healthPurposeSchema,
  version: z.literal(HEALTH_CONSENT_VERSION),
  expected_epoch: epochSchema,
  age_attested_18_plus: z.literal(true),
});
export type HealthConsentGrant = z.infer<typeof healthConsentGrantSchema>;
export const healthConsentWithdrawSchema = z.strictObject({
  request_id: healthRequestIdSchema,
  source: healthSourceSchema,
  purpose: healthPurposeSchema,
  expected_epoch: epochSchema,
});
export type HealthConsentWithdraw = z.infer<typeof healthConsentWithdrawSchema>;
export const healthConsentStateSchema = z.strictObject({
  consent_class: z.literal('health_processing'),
  source: healthSourceSchema,
  purpose: healthPurposeSchema,
  version: z.literal(HEALTH_CONSENT_VERSION),
  status: z.enum(['granted', 'withdrawn', 'not_granted']),
  epoch: epochSchema,
  granted_at: iso8601Schema.nullable(),
  withdrawn_at: iso8601Schema.nullable(),
  deletion_state: z.enum(['not_required', 'completed']),
});
export type HealthConsentState = z.infer<typeof healthConsentStateSchema>;

// The permission/read API is not the physiological producer. Preserve actual
// native source revision and recording origin without inferring a vendor.
export const healthSampleOriginSchema = z.strictObject({
  read_api: z.enum(['healthkit', 'health_connect', 'samsung_health', 'provider_api', 'manual']),
  source_bundle_id: z.string().min(1).max(200).nullable(),
  source_package_name: z.string().min(1).max(200).nullable(),
  source_version: z.string().min(1).max(128).nullable(),
  source_revision: z.string().min(1).max(128).nullable(),
  device_ref: z.string().regex(/^(?:sha256:|hmac-sha256:)?[0-9a-f]{64}$/).nullable(),
  recording_method: z.union([z.enum(['automatic', 'active', 'manual', 'unknown']), z.int().min(0).max(3), z.boolean()]),
  manufacturer: z.string().min(1).max(128).nullable().optional(),
  product_type: z.string().min(1).max(128).nullable().optional(),
  client_record_version: z.int().nonnegative().nullable().optional(),
  sync_version: z.int().nonnegative().nullable().optional(),
});
export type HealthSampleOrigin = z.infer<typeof healthSampleOriginSchema>;
export const healthSleepContextSchema = z.strictObject({
  source_ref: z.string().min(1).max(200), session_ref: sampleIdSchema,
  waking_day: healthDaySchema, reducer_version: z.literal('asleep-interval-union.v1'),
  contributor_ids: z.array(sampleIdSchema).max(128),
  intervals: z.array(z.strictObject({
    contributor_id: sampleIdSchema, start_at: iso8601Schema, end_at: iso8601Schema,
    kind: z.enum(['asleep', 'in_bed']),
  }).refine(interval => Date.parse(interval.start_at) < Date.parse(interval.end_at), 'invalid sleep interval')).max(128),
}).superRefine((sleep, context) => {
  if (new Set(sleep.contributor_ids).size !== sleep.contributor_ids.length || sleep.intervals.some(interval => !sleep.contributor_ids.includes(interval.contributor_id))) context.addIssue({ code: 'custom', message: 'invalid sleep contributors' });
});
export type HealthSleepContext = z.infer<typeof healthSleepContextSchema>;
const sampleCommon = {
  sample_id: sampleIdSchema,
  origin: healthSampleOriginSchema.optional(),
  sleep_context: healthSleepContextSchema.optional(),
  revision: z.int().nonnegative(),
  start_at: iso8601Schema,
  end_at: iso8601Schema,
  day: healthDaySchema,
};
export const healthMetricSchema = z.enum(['sleep_duration', 'sleep_efficiency', 'overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight_duration', 'movement_duration', 'perceived_stress', 'physical_load']);
const signalContextSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const healthSampleSchema = z.discriminatedUnion('metric', [
  z.strictObject({ ...sampleCommon, metric: z.literal('sleep_duration'), unit: z.literal('minutes'), method: z.enum(['asleep_duration', 'time_in_bed', 'unknown']).optional(), value: z.number().finite().min(0).max(1440) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('sleep_efficiency'), unit: z.literal('ratio'), value: z.number().finite().min(0).max(1) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('overnight_hrv'), unit: z.literal('milliseconds'), method: z.enum(['rmssd', 'sdnn']), value: z.number().finite().positive().max(1000) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('resting_heart_rate'), unit: z.literal('beats_per_minute'), method: z.enum(['overnight_resting', 'provider_resting_daily', 'resting_measurement', 'unknown']).optional(), value: z.number().finite().positive().max(300) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('sleep_midpoint'), unit: z.literal('local_minute'), method: z.literal('sleep_midpoint'), value: z.number().finite().min(0).max(1439.999) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('daylight_duration'), unit: z.literal('minutes'), method: z.literal('daylight_duration'), context_ref: signalContextSchema, value: z.number().finite().min(0).max(1440) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('movement_duration'), unit: z.literal('minutes'), method: z.literal('active_minutes'), context_ref: signalContextSchema, value: z.number().finite().min(0).max(1440) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('perceived_stress'), unit: z.literal('rating_0_10'), method: z.literal('self_report_0_10'), context_ref: signalContextSchema, value: z.number().finite().min(0).max(10) }),
  z.strictObject({ ...sampleCommon, metric: z.literal('physical_load'), unit: z.literal('source_units'), method: z.enum(['provider_load', 'trimp']), context_ref: signalContextSchema, value: z.number().finite().min(0).max(1000000) }),
]).refine(sample => Date.parse(sample.start_at) <= Date.parse(sample.end_at), 'sample end precedes start');
export type HealthSample = z.infer<typeof healthSampleSchema>;
export const healthSampleDeletionSchema = z.strictObject({
  sample_id: sampleIdSchema,
  metric: healthMetricSchema,
  revision: z.int().nonnegative(),
});
export const healthIngestSchema = z.strictObject({
  request_id: healthRequestIdSchema,
  source: healthSourceSchema,
  consent_epoch: epochSchema,
  timezone: healthTimezoneSchema,
  anchor_before: z.string().min(1).max(2048).nullable(),
  anchor_after: z.string().min(1).max(2048),
  samples: z.array(healthSampleSchema).max(128),
  deletions: z.array(healthSampleDeletionSchema).max(128),
}).refine(batch => batch.samples.length + batch.deletions.length <= 128, 'batch exceeds 128 changes');
export type HealthIngest = z.infer<typeof healthIngestSchema>;
export const healthIngestReceiptSchema = z.strictObject({
  request_id: healthRequestIdSchema,
  source: healthSourceSchema,
  consent_epoch: epochSchema,
  accepted: z.int().nonnegative(),
  deleted: z.int().nonnegative(),
  ignored: z.int().nonnegative(),
  anchor_after: z.string().min(1).max(2048),
  replayed: z.boolean(),
});
export type HealthIngestReceipt = z.infer<typeof healthIngestReceiptSchema>;

export const healthUnavailableReasonSchema = z.enum([
  'not_linked', 'consent_required', 'consent_withdrawn', 'model_consent_required',
  'no_readings', 'baseline_immature', 'missing_sleep', 'missing_resting_signal',
  'stale_inputs', 'conflicting_inputs', 'algorithm_not_accepted',
  'intraday_inputs_unavailable', 'calendar_demand_unavailable',
  'missing_signal', 'baseline_variance_zero', 'baseline_ambiguous', 'source_method_context_mismatch',
  'time_mismatch', 'stale_signal', 'conflicting_observations', 'sleep_reference_required',
]);
const availablePillarCommon = {
  state: z.literal('available'), score: z.number().finite().min(0).max(100),
  review_ref: z.string().min(1).max(200).optional(), interpretation: z.literal('personal_baseline_index').optional(),
  reference_basis: z.enum(['owner_confirmed', 'provisional_baseline']).optional(),
  activation: z.literal('candidate_unaccepted').optional(),
  components: z.array(z.strictObject({
    component: z.string().min(1).max(80), score: z.number().finite().min(0).max(100), weight: z.number().finite().min(0).max(1), baseline_days: z.int().min(14).max(30),
    source_ref: z.string().min(1).max(200), method: z.string().min(1).max(80), context_ref: signalContextSchema,
    metric: z.string().min(1).max(80), unit: z.string().min(1).max(80), observed_at: iso8601Schema, revision: z.int().nonnegative(),
  })).max(10).optional(),
};
export const healthPillarSchema = z.union([
  z.strictObject({ state: z.literal('unavailable'), reason: healthUnavailableReasonSchema }),
  z.discriminatedUnion('algorithm_version', [
    z.strictObject({ ...availablePillarCommon, algorithm_version: z.literal('recovery.v1'), zone: recoveryZoneSchema }),
    z.strictObject({ ...availablePillarCommon, algorithm_version: z.literal('recovery.candidate.v1'), zone: recoveryZoneSchema }),
    z.strictObject({ ...availablePillarCommon, algorithm_version: z.literal('form.candidate.v1'), zone: formZoneSchema }),
    z.strictObject({ ...availablePillarCommon, algorithm_version: z.literal('weight.candidate.v1'), zone: loadZoneSchema }),
  ]),
]);
const sleepDebtSummarySchema = z.strictObject({
  state: z.enum(['available', 'partial', 'unavailable']),
  algorithm_version: z.literal('sleep-debt.candidate.v1'),
  debt_minutes: z.number().finite().nonnegative().nullable(),
  observed_nights: z.int().min(0).max(14),
  coverage: z.number().finite().min(0).max(1),
  missing_nights: z.array(healthDaySchema).max(14),
  reference_basis: z.enum(['owner_confirmed', 'provisional_baseline']).nullable(),
  review_ref: z.string().min(1).max(200),
  interpretation: z.enum(['shortfall_from_owner_target', 'shortfall_from_usual_sleep']).nullable(),
  observed_weighted_shortfall_minutes: z.number().finite().nonnegative().optional(),
  reference_minutes: z.number().finite().positive().max(1440).optional(),
  reference_baseline_days: z.int().min(14).max(30).nullable().optional(),
  activation: z.literal('candidate_unaccepted').optional(),
});
export const healthDailySummarySchema = z.strictObject({
  day: healthDaySchema,
  source: healthSourceSchema,
  timezone: healthTimezoneSchema,
  consent_epoch: epochSchema,
  compiled_at: iso8601Schema,
  freshness: z.enum(['fresh', 'stale', 'expired']),
  coverage: z.strictObject({ sleep: z.boolean(), hrv: z.boolean(), resting_heart_rate: z.boolean(), conflicting_metrics: z.array(healthMetricSchema).max(9) }),
  baseline: z.strictObject({ state: z.enum(['not_computed', 'immature', 'mature']), distinct_days: z.int().min(0).max(30), required_days: z.literal(14).nullable(), method: z.enum(['rmssd', 'sdnn']).nullable() }),
  recovery: healthPillarSchema.refine(p => p.state === 'unavailable' || p.algorithm_version === 'recovery.v1' || p.algorithm_version === 'recovery.candidate.v1'),
  form: healthPillarSchema.refine(p => p.state === 'unavailable' || p.algorithm_version === 'form.candidate.v1'),
  weight: healthPillarSchema.refine(p => p.state === 'unavailable' || p.algorithm_version === 'weight.candidate.v1'),
  sleep_debt: sleepDebtSummarySchema.optional(),
  calculation_review: z.strictObject({ review_ref: z.string().min(1).max(200), clinical_validation: z.literal('not_established') }).optional(),
});
export type HealthDailySummary = z.infer<typeof healthDailySummarySchema>;
export const healthHistoryQuerySchema = z.strictObject({
  source: healthSourceSchema,
  from: healthDaySchema,
  to: healthDaySchema,
  consent_epoch: epochSchema,
}).refine(query => query.from <= query.to && Date.parse(query.to) - Date.parse(query.from) <= 89 * 86400000, 'history range exceeds 90 days');
export type HealthHistoryQuery = z.infer<typeof healthHistoryQuerySchema>;
// Opaque value-free continuation. The signed health plane binds its source,
// epoch, query range and data revision; a changed dataset requires restart.
export const healthReadingsCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/);
export const healthReadingsQuerySchema = healthHistoryQuerySchema.safeExtend({ cursor: healthReadingsCursorSchema.optional() });
export type HealthReadingsQuery = z.infer<typeof healthReadingsQuerySchema>;
export const healthReadingsSchema = z.strictObject({
  source: healthSourceSchema,
  consent_epoch: epochSchema,
  samples: z.array(healthSampleSchema).max(4096),
  count: z.int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: healthReadingsCursorSchema.nullable().optional(),
}).superRefine((page, context) => {
  if (page.count !== page.samples.length || (page.next_cursor !== undefined && page.has_more !== (page.next_cursor !== null))) context.addIssue({ code: 'custom', message: 'invalid readings continuation' });
});
export type HealthReadings = z.infer<typeof healthReadingsSchema>;
export const healthConsentListSchema = z.strictObject({ consents: z.array(healthConsentStateSchema).max(12) });
export type HealthConsentList = z.infer<typeof healthConsentListSchema>;
export const healthConsentChangeSchema = z.strictObject({ consent: healthConsentStateSchema, replayed: z.boolean(), deletion_routed: z.boolean() });
export type HealthConsentChange = z.infer<typeof healthConsentChangeSchema>;
export const healthProducerDaySchema = z.strictObject({
  source: healthSourceSchema, consent_epoch: epochSchema, timezone: healthTimezoneSchema,
  compiled_at: iso8601Schema, day: healthDaySchema,
  samples: z.array(healthSampleSchema).max(4096),
  aggregates: z.array(z.strictObject({
    day: healthDaySchema,
    metrics: z.array(healthMetricSchema).max(9),
    methods: z.array(z.enum(['rmssd', 'sdnn'])).max(2),
    conflicting_metrics: z.array(healthMetricSchema).max(9),
    timezone: healthTimezoneSchema.optional(),
    observed_at: iso8601Schema.optional(),
    values: z.partialRecord(healthMetricSchema, z.number().finite()).optional(),
    observations: z.partialRecord(healthMetricSchema, z.strictObject({
      method: z.string().min(1).max(80), context_ref: signalContextSchema, origin: healthSampleOriginSchema.optional(), sleep_ended_at: iso8601Schema.optional(), eligibility: z.enum(['admitted_sleep_context', 'admitted_resting_method', 'unknown']).optional(),
      observed_at: iso8601Schema, revision: z.int().nonnegative(),
    })).optional(),
  })).max(44),
});
export type HealthProducerDay = z.infer<typeof healthProducerDaySchema>;
export const healthProducerTodaySchema = healthProducerDaySchema.nullable();
export const healthProducerHistorySchema = z.strictObject({ days: z.array(healthProducerDaySchema).max(90) });
export const healthRetentionReceiptSchema = z.strictObject({ raw_deleted: z.int().nonnegative(), aggregates_deleted: z.int().nonnegative() });
export const healthPurgeReceiptSchema = z.strictObject({
  state: z.literal('completed'),
  scopes_revoked: z.int().nonnegative(),
  raw_deleted: z.int().nonnegative(),
  aggregates_deleted: z.int().nonnegative(),
  compatibility_rows_deleted: z.int().nonnegative(),
  retained: z.literal('consent_audit_only'),
});
export type HealthPurgeReceipt = z.infer<typeof healthPurgeReceiptSchema>;
export const healthApiErrorSchema = z.strictObject({ error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'anchor_conflict', 'sample_conflict', 'unavailable']) });
export type HealthApiErrorCode = z.infer<typeof healthApiErrorSchema>['error'];
