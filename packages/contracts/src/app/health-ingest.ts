import { z } from 'zod';

// Health ingest and scores, app.v1. Additive and self-contained: it imports only zod so the app can
// pin it verbatim. Owner identity is never in a request; the authenticated serving adapter derives it.
// Readings are window summaries and point records. Beat-to-beat series and the 24 h heart-rate stream
// stay on the phone. The backend computes the official scores from stored readings; a phone may show
// a provisional score but never uploads one as canonical.
// Consent copy 1 named daily aggregates. Copy 2 names intraday window summaries.
export const HEALTH_CONSENT_VERSION_V1 = 2;
export const HEALTH_INGEST_MAX_REQUEST_BYTES_V1 = 98_304;
export const HEALTH_INGEST_MAX_CHANGES_V1 = 128;
export const HEALTH_RAW_RETENTION_DAYS_V1 = 90;
export const HEALTH_AGGREGATE_RETENTION_MONTHS_V1 = 24;

export const healthSourceV1Schema = z.enum(['apple', 'samsung']);
export const healthPurposeV1Schema = z.enum(['storage_compute', 'model_processing']);
export const healthRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
export const healthDayV1Schema = z.iso.date();
export const healthInstantV1Schema = z.iso.datetime({ offset: true });
// Structural only. The serving adapter also checks the name against the platform's zone database.
export const healthTimezoneV1Schema = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/);
const epochV1 = z.int().nonnegative();
const sampleIdV1 = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const contextRefV1 = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const anchorV1 = z.string().min(1).max(2048);

export const healthConsentGrantV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  source: healthSourceV1Schema,
  purpose: healthPurposeV1Schema,
  version: z.literal(HEALTH_CONSENT_VERSION_V1),
  expected_epoch: epochV1,
  age_attested_18_plus: z.literal(true),
});
export const healthConsentWithdrawV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  source: healthSourceV1Schema,
  purpose: healthPurposeV1Schema,
  expected_epoch: epochV1,
});
export const healthConsentStateV1Schema = z.strictObject({
  consent_class: z.literal('health_processing'),
  source: healthSourceV1Schema,
  purpose: healthPurposeV1Schema,
  version: z.literal(HEALTH_CONSENT_VERSION_V1),
  status: z.enum(['granted', 'withdrawn', 'not_granted']),
  epoch: epochV1,
  granted_at: healthInstantV1Schema.nullable(),
  withdrawn_at: healthInstantV1Schema.nullable(),
  deletion_state: z.enum(['not_required', 'completed']),
});
export const healthConsentListV1Schema = z.strictObject({ consents: z.array(healthConsentStateV1Schema).max(12) });
export const healthConsentChangeV1Schema = z.strictObject({ consent: healthConsentStateV1Schema, replayed: z.boolean(), deletion_routed: z.boolean() });

// The permission API is not the physiological producer: keep the observed read origin and
// recording method without inferring a vendor.
export const healthSampleOriginV1Schema = z.strictObject({
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
export const healthSleepContextV1Schema = z.strictObject({
  source_ref: z.string().min(1).max(200),
  session_ref: sampleIdV1,
  waking_day: healthDayV1Schema,
  reducer_version: z.literal('asleep-interval-union.v1'),
  contributor_ids: z.array(sampleIdV1).max(128),
  intervals: z.array(z.strictObject({
    contributor_id: sampleIdV1, start_at: healthInstantV1Schema, end_at: healthInstantV1Schema,
    kind: z.enum(['asleep', 'in_bed']),
  }).refine(interval => Date.parse(interval.start_at) < Date.parse(interval.end_at), 'invalid sleep interval')).max(128),
}).superRefine((sleep, context) => {
  if (new Set(sleep.contributor_ids).size !== sleep.contributor_ids.length || sleep.intervals.some(interval => !sleep.contributor_ids.includes(interval.contributor_id))) context.addIssue({ code: 'custom', message: 'invalid sleep contributors' });
});

// A reading window is identified by sample_id. For a growing aggregate window (steps so far today)
// revision is the observation time in epoch seconds, so it only grows and survives a reinstall; a point
// record is immutable and uses revision 0 unless the OS edits it.
const sampleCommon = {
  sample_id: sampleIdV1,
  origin: healthSampleOriginV1Schema.optional(),
  sleep_context: healthSleepContextV1Schema.optional(),
  revision: epochV1,
  start_at: healthInstantV1Schema,
  end_at: healthInstantV1Schema,
  day: healthDayV1Schema,
  utc_offset_minutes: z.int().min(-840).max(840),
};
const hrvMethodV1 = z.enum(['rmssd', 'sdnn']);
const bpm = z.number().finite().positive().max(300);
// Bounds are plausibility limits that catch unit mistakes. They are not medical thresholds.
export const healthSampleV1Schema = z.discriminatedUnion('signal', [
  z.strictObject({ ...sampleCommon, signal: z.literal('sleep_duration'), unit: z.literal('minutes'), method: z.enum(['asleep_duration', 'time_in_bed', 'unknown']).optional(), value: z.number().finite().min(0).max(1440) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('sleep_efficiency'), unit: z.literal('ratio'), value: z.number().finite().min(0).max(1) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('sleep_midpoint'), unit: z.literal('local_minute'), method: z.literal('sleep_midpoint'), value: z.number().finite().min(0).max(1439.999) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('overnight_hrv'), unit: z.literal('milliseconds'), method: hrvMethodV1, value: z.number().finite().positive().max(1000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('resting_heart_rate'), unit: z.literal('beats_per_minute'), method: z.enum(['overnight_resting', 'provider_resting_daily', 'resting_measurement', 'unknown']).optional(), value: bpm }),
  z.strictObject({ ...sampleCommon, signal: z.literal('daylight_duration'), unit: z.literal('minutes'), method: z.literal('daylight_duration'), context_ref: contextRefV1, value: z.number().finite().min(0).max(1440) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('movement_duration'), unit: z.literal('minutes'), method: z.literal('active_minutes'), context_ref: contextRefV1, value: z.number().finite().min(0).max(1440) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('heart_rate_window'), unit: z.literal('beats_per_minute'), value: bpm, min: bpm, max: bpm, n_samples: z.int().min(1).max(100_000) }),
  // RMSSD is the canonical method. SDNN is a labelled fallback with its own baseline, never blended.
  z.strictObject({ ...sampleCommon, signal: z.literal('hrv_window'), unit: z.literal('milliseconds'), method: hrvMethodV1, value: z.number().finite().positive().max(1000), n_beats: z.int().min(10).max(1_000_000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('spo2'), unit: z.literal('percent'), value: z.number().finite().min(50).max(100) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('respiratory_rate'), unit: z.literal('breaths_per_minute'), value: z.number().finite().min(4).max(80) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('steps_window'), unit: z.literal('count'), value: z.int().min(0).max(300_000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('active_energy_window'), unit: z.literal('kilocalories'), value: z.number().finite().min(0).max(30_000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('workout'), unit: z.literal('minutes'), activity: z.string().min(1).max(64), value: z.number().finite().min(0).max(1440), energy_kcal: z.number().finite().min(0).max(30_000).optional() }),
]).refine(sample => Date.parse(sample.start_at) <= Date.parse(sample.end_at), 'sample end precedes start')
  .refine(sample => sample.signal !== 'heart_rate_window' || (sample.min <= sample.value && sample.value <= sample.max), 'heart-rate window mean outside its range');
export const healthSignalV1Schema = z.enum([
  'sleep_duration', 'sleep_efficiency', 'sleep_midpoint', 'overnight_hrv', 'resting_heart_rate', 'daylight_duration', 'movement_duration',
  'heart_rate_window', 'hrv_window', 'spo2', 'respiratory_rate', 'steps_window', 'active_energy_window', 'workout',
]);
export const healthSampleDeletionV1Schema = z.strictObject({ sample_id: sampleIdV1, signal: healthSignalV1Schema, revision: epochV1 });
export const healthIngestV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  source: healthSourceV1Schema,
  consent_epoch: epochV1,
  timezone: healthTimezoneV1Schema,
  anchor_before: anchorV1.nullable(),
  anchor_after: anchorV1,
  samples: z.array(healthSampleV1Schema).max(HEALTH_INGEST_MAX_CHANGES_V1),
  deletions: z.array(healthSampleDeletionV1Schema).max(HEALTH_INGEST_MAX_CHANGES_V1),
}).refine(batch => batch.samples.length + batch.deletions.length <= HEALTH_INGEST_MAX_CHANGES_V1, 'batch exceeds 128 changes');
export const healthIngestReceiptV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  source: healthSourceV1Schema,
  consent_epoch: epochV1,
  accepted: z.int().nonnegative(),
  deleted: z.int().nonnegative(),
  ignored: z.int().nonnegative(),
  anchor_after: anchorV1,
  replayed: z.boolean(),
});

// Zone words carry their meaning, so direction cannot be confused across pillars: the better the
// recovery or form, the better the word; the heavier the day, the heavier the word.
export const healthRecoveryZoneV1Schema = z.enum(['excellent', 'solid', 'mixed', 'compromised']);
export const healthFormZoneV1Schema = z.enum(['energized', 'steady', 'flagging', 'depleted']);
export const healthWeightZoneV1Schema = z.enum(['light', 'moderate', 'heavy', 'peak']);
export const healthScoreUnavailableReasonV1Schema = z.enum([
  'not_linked', 'consent_required', 'consent_withdrawn', 'no_readings', 'baseline_immature', 'missing_sleep',
  'missing_resting_signal', 'stale_inputs', 'conflicting_inputs', 'intraday_inputs_unavailable', 'calendar_demand_unavailable',
]);
const scoreUnavailable = z.strictObject({ state: z.literal('unavailable'), reason: healthScoreUnavailableReasonV1Schema });
const scoreAvailable = <Zone extends z.ZodType>(zone: Zone) => z.strictObject({
  state: z.literal('available'),
  score: z.number().finite().min(0).max(100),
  zone,
  algorithm_version: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.v[0-9]+$/).max(64),
  activation: z.enum(['candidate_unaccepted', 'accepted']),
  confidence: z.number().finite().min(0).max(1).nullable(),
  hrv_method: hrvMethodV1.nullable(),
});
const pillar = <Zone extends z.ZodType>(zone: Zone) => z.union([scoreUnavailable, scoreAvailable(zone)]);
export const healthScoresQueryV1Schema = z.strictObject({ day: healthDayV1Schema.optional() });
// compiled_at is the row's own compile time on the backend, never the read time and never a device clock.
export const healthScoresV1Schema = z.strictObject({
  day: healthDayV1Schema,
  timezone: healthTimezoneV1Schema,
  compiled_at: healthInstantV1Schema,
  freshness: z.enum(['fresh', 'stale', 'expired']),
  recovery: pillar(healthRecoveryZoneV1Schema),
  form: pillar(healthFormZoneV1Schema),
  weight: pillar(healthWeightZoneV1Schema),
});

export const healthApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'anchor_conflict', 'sample_conflict', 'unavailable']),
});

export const appHealthRoutesV1 = [
  { method: 'GET', path: '/app/v1/health/consents', response: healthConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/health/consents', request: healthConsentGrantV1Schema, response: healthConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: HEALTH_INGEST_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/health/consents/withdraw', request: healthConsentWithdrawV1Schema, response: healthConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: HEALTH_INGEST_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/health/ingest', request: healthIngestV1Schema, response: healthIngestReceiptV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: HEALTH_INGEST_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/health/scores', query: healthScoresQueryV1Schema, response: healthScoresV1Schema, authenticated: true, success_status: 200 },
] as const;

export type HealthIngestV1 = z.infer<typeof healthIngestV1Schema>;
export type HealthSampleV1 = z.infer<typeof healthSampleV1Schema>;
export type HealthScoresV1 = z.infer<typeof healthScoresV1Schema>;
