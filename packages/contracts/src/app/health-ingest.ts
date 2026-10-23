import { z } from 'zod';

// Health ingest and scores, app.v1. Additive and self-contained: it imports only zod so the app can
// pin it verbatim. Owner identity is never in a request; the authenticated serving adapter derives it.
// Readings are window summaries and point records. Beat-to-beat series and the 24 h heart-rate stream
// stay on the phone. The backend computes the official scores from stored readings; a phone may show
// a provisional score but never uploads one as canonical.
// Consent copy 1 named daily aggregates. Copy 2 names intraday window summaries and is the device sources' copy.
export const HEALTH_CONSENT_VERSION_V1 = 2;
export const HEALTH_INGEST_MAX_REQUEST_BYTES_V1 = 98_304;
export const HEALTH_INGEST_MAX_CHANGES_V1 = 128;
export const HEALTH_RAW_RETENTION_DAYS_V1 = 90;
export const HEALTH_AGGREGATE_RETENTION_MONTHS_V1 = 24;

// Device sources arrive from the app's uploads. A provider source is a cloud API Waldo syncs for the owner, so it never
// arrives through the app's ingest route; its consent rows and requests are health contract revision 2, and an older build
// never sees them (it parses the consent list strictly).
export const HEALTH_PROVIDER_SOURCES_V1 = ['whoop'] as const;
export const HEALTH_PROVIDER_REVISION_V1 = 2;
export const healthSourceV1Schema = z.enum(['apple', 'samsung', 'health_connect', ...HEALTH_PROVIDER_SOURCES_V1]);
export const isHealthProviderSourceV1 = (source: string): boolean => (HEALTH_PROVIDER_SOURCES_V1 as readonly string[]).includes(source);
// A cloud provider has its own consent notice, so its grants carry their own copy version. Copy 3 is WHOOP's: it says that
// Waldo stores the owner's WHOOP data and that an AI model provider, a third party the owner opts into with the
// model-processing grant, processes it to plan the owner's day, which is the express authorization WHOOP's terms ask for.
// A new grant carries the current version of its source's copy, never another's, so a stored grant shows which notice it
// rested on. A stored grant keeps the version it was written on, so reading one back accepts every version its source has
// had (WHOOP's first grants were written on copy 2). The app owns the wording; a changed notice takes the next number.
export const HEALTH_PROVIDER_CONSENT_VERSION_V1 = 3;
type HealthSourceV1 = z.infer<typeof healthSourceV1Schema>;
const CONSENT_COPY_V1: Readonly<Record<HealthSourceV1, Readonly<{ current: number; had: readonly number[] }>>> = {
  apple: { current: HEALTH_CONSENT_VERSION_V1, had: [HEALTH_CONSENT_VERSION_V1] },
  samsung: { current: HEALTH_CONSENT_VERSION_V1, had: [HEALTH_CONSENT_VERSION_V1] },
  health_connect: { current: HEALTH_CONSENT_VERSION_V1, had: [HEALTH_CONSENT_VERSION_V1] },
  whoop: { current: HEALTH_PROVIDER_CONSENT_VERSION_V1, had: [HEALTH_CONSENT_VERSION_V1, HEALTH_PROVIDER_CONSENT_VERSION_V1] },
};
export const healthConsentVersionV1 = (source: HealthSourceV1): number => CONSENT_COPY_V1[source].current;
const currentCopyOfItsSource = (row: { source: HealthSourceV1; version: number }) => row.version === CONSENT_COPY_V1[row.source].current;
const copyItsSourceHad = (row: { source: HealthSourceV1; version: number }) => CONSENT_COPY_V1[row.source].had.includes(row.version);
// Purposes are separate grants, requested together on one consent screen: storage_compute (store and compute the
// owner's health data and show the owner their scores) and model_processing (let Waldo use it when it talks to the
// owner). Model use needs both, so granting model_processing without a live storage grant is consent_required, and an
// owner who grants only storage gets consent_required for model use. Withdrawing model_processing stops model use only
// and deletes nothing. Withdrawing storage_compute withdraws both for the source and purges its data. Re-granting
// storage never restores model use.
// A provider source adds no purpose. Its express authorization to store the data and use it with AI is these same two
// grants for that source, recorded against copy that says so; a connection needs both.
export const healthPurposeV1Schema = z.enum(['storage_compute', 'model_processing']);
export const healthRequestIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
export const healthDayV1Schema = z.iso.date();
export const healthInstantV1Schema = z.iso.datetime({ offset: true });
// Structural only. The serving adapter also checks the name against the platform's zone database.
export const healthTimezoneV1Schema = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/);
const epochV1 = z.int().nonnegative();
const sampleIdV1 = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const anchorV1 = z.string().min(1).max(2048);

export const healthConsentGrantV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  source: healthSourceV1Schema,
  purpose: healthPurposeV1Schema,
  version: z.int().positive(),
  expected_epoch: epochV1,
  age_attested_18_plus: z.literal(true),
}).refine(currentCopyOfItsSource, { message: 'a new grant names the current copy version of its source', path: ['version'] });
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
  version: z.int().positive(),
  status: z.enum(['granted', 'withdrawn', 'not_granted']),
  epoch: epochV1,
  granted_at: healthInstantV1Schema.nullable(),
  withdrawn_at: healthInstantV1Schema.nullable(),
  deletion_state: z.enum(['not_required', 'completed']),
}).refine(copyItsSourceHad, { message: 'a stored grant carries a copy version its source has had', path: ['version'] });
export const healthConsentListV1Schema = z.strictObject({ consents: z.array(healthConsentStateV1Schema).max(12) });
// What a client at an older health revision may be shown: no provider rows, since it cannot parse them.
export const healthConsentListAtRevisionV1 = <Row extends { source: string }>(consents: readonly Row[], revision: number): Row[] =>
  revision >= HEALTH_PROVIDER_REVISION_V1 ? [...consents] : consents.filter(row => !isHealthProviderSourceV1(row.source));
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
  // One representation: the phone maps the platform's own encoding onto this enum.
  recording_method: z.enum(['automatic', 'active', 'manual', 'unknown']),
  manufacturer: z.string().min(1).max(128).nullable().optional(),
  product_type: z.string().min(1).max(128).nullable().optional(),
  client_record_version: z.int().nonnegative().nullable().optional(),
  sync_version: z.int().nonnegative().nullable().optional(),
});
// Sleep context names the intervals a night's readings were reduced from. Reducer v1 knows asleep and in-bed time only.
// Reducer v2 also carries the Watch's waking time in the night and, on asleep time, the stage: Apple core sleep and Health
// Connect LIGHT are `light`; an asleep interval with no stage is unspecified. A v1 context carries neither, so its meaning
// is unchanged.
const sleepIntervalAt = { contributor_id: sampleIdV1, start_at: healthInstantV1Schema, end_at: healthInstantV1Schema };
const inOrder = (interval: { start_at: string; end_at: string }) => Date.parse(interval.start_at) < Date.parse(interval.end_at);
const sleepContextAt = { source_ref: z.string().min(1).max(200), session_ref: sampleIdV1, waking_day: healthDayV1Schema, contributor_ids: z.array(sampleIdV1).max(128) };
export const healthSleepStageV1Schema = z.enum(['light', 'deep', 'rem']);
const sleepContextV2Schema = z.strictObject({
  ...sleepContextAt,
  reducer_version: z.literal('asleep-interval-union.v2'),
  intervals: z.array(z.strictObject({ ...sleepIntervalAt, kind: z.enum(['asleep', 'in_bed', 'awake']), stage: healthSleepStageV1Schema.optional() })
    .refine(inOrder, 'invalid sleep interval').refine(interval => interval.stage === undefined || interval.kind === 'asleep', 'only asleep time has a stage')).max(128),
});
type SleepContextV2 = z.infer<typeof sleepContextV2Schema>;
type Spans = [number, number][];
const union = (spans: Spans): Spans => {
  const merged: Spans = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  return merged;
};
const spanMs = (spans: Spans): number => spans.reduce((total, [start, end]) => total + end - start, 0);
const sharedMs = (a: Spans, b: Spans): number => a.reduce((total, [s1, e1]) => total + b.reduce((inner, [s2, e2]) => inner + Math.max(0, Math.min(e1, e2) - Math.max(s1, s2)), 0), 0);
export type HealthSleepStagesV1 = Readonly<{ light: number; deep: number; rem: number; unspecified: number; awake: number }>;
// Minutes per kind and stage of a v2 night. Asleep is the union of asleep intervals, as in v1, and each stage the union of
// its own. Awake is waking time inside the night: awake intervals clipped to the first asleep start and the last asleep end,
// less any asleep time under them. Two differently staged intervals that overlap have no single reading, so the night has
// none (null). The phone and the backend run this one function, so their totals cannot drift.
export const reduceSleepContextV2 = (context: SleepContextV2): (HealthSleepStagesV1 & { asleep: number }) | null => {
  const of = (kind: string, stage?: string): Spans => union(context.intervals.filter(i => i.kind === kind && i.stage === stage).map(i => [Date.parse(i.start_at), Date.parse(i.end_at)]));
  const staged = { light: of('asleep', 'light'), deep: of('asleep', 'deep'), rem: of('asleep', 'rem'), unspecified: of('asleep') };
  const kinds = Object.values(staged);
  if (kinds.some((a, i) => kinds.slice(i + 1).some(b => sharedMs(a, b) > 0))) return null;
  const asleep = union(kinds.flat());
  const night = asleep.length ? [asleep[0]![0], asleep[asleep.length - 1]![1]] as const : null;
  const awake = night ? union(context.intervals.filter(i => i.kind === 'awake').flatMap((i): Spans => {
    const start = Math.max(Date.parse(i.start_at), night[0]), end = Math.min(Date.parse(i.end_at), night[1]);
    return start < end ? [[start, end]] : [];
  })) : [];
  const minutes = (ms: number) => ms / 60_000;
  return {
    asleep: minutes(spanMs(asleep)), light: minutes(spanMs(staged.light)), deep: minutes(spanMs(staged.deep)), rem: minutes(spanMs(staged.rem)),
    unspecified: minutes(spanMs(staged.unspecified)), awake: minutes(spanMs(awake) - sharedMs(awake, asleep)),
  };
};
export const healthSleepContextV1Schema = z.discriminatedUnion('reducer_version', [
  z.strictObject({
    ...sleepContextAt,
    reducer_version: z.literal('asleep-interval-union.v1'),
    intervals: z.array(z.strictObject({ ...sleepIntervalAt, kind: z.enum(['asleep', 'in_bed']) }).refine(inOrder, 'invalid sleep interval')).max(128),
  }),
  sleepContextV2Schema.refine(context => reduceSleepContextV2(context) !== null, 'differently staged sleep intervals overlap'),
]).superRefine((sleep, context) => {
  if (new Set(sleep.contributor_ids).size !== sleep.contributor_ids.length || sleep.intervals.some(interval => !sleep.contributor_ids.includes(interval.contributor_id))) context.addIssue({ code: 'custom', message: 'invalid sleep contributors' });
});
// A night's stage totals in minutes, on its time-asleep reading. light + deep + rem + unspecified is the time asleep.
const stageMinutes = z.number().finite().min(0).max(1440);
export const healthSleepStagesV1Schema = z.strictObject({ light: stageMinutes, deep: stageMinutes, rem: stageMinutes, unspecified: stageMinutes, awake: stageMinutes });

// Identity. A point record (a sample the OS stored, a workout, one SpO2 reading) uses its OS record id
// and revision 0 unless the OS edits it. A window signal is one fixed local-hour bucket: the same hour
// always has the same bounds, so its sample_id (a hash of source, signal and bucket start) never depends
// on when it was read. Only the current hour grows, and its revision is the observation time in epoch
// seconds, which only increases and survives a reinstall. Daily totals are the backend's sum of buckets.
// A sleep reading takes its id from source, signal and waking_day, so a late stage or a second source
// replaces the session instead of adding a second one.
// Sleep definitions: sleep_duration is the minutes of the union of asleep intervals; sleep_efficiency is
// asleep minutes divided by in-bed minutes; sleep_midpoint is the local minute of day, in the reading's
// zone, of the midpoint between the first asleep start and the last asleep end. A time-asleep reading from a v2 context
// carries its stage totals, which are that context's reducer output to within a minute.
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
const WINDOW_SIGNALS: readonly string[] = ['heart_rate_window', 'hrv_window', 'steps_window', 'active_energy_window', 'daylight_duration', 'movement_duration'];
const HOUR_MS = 3_600_000;
// The bucket is exactly one hour and starts on the hour of the reading's own offset (so +05:30 and +05:45
// zones align on their local clock, not the UTC clock).
const isLocalHourBucket = (sample: { start_at: string; end_at: string; utc_offset_minutes: number }) => {
  const start = Date.parse(sample.start_at);
  return Date.parse(sample.end_at) - start === HOUR_MS && (start + sample.utc_offset_minutes * 60_000) % HOUR_MS === 0;
};
const bpm = z.number().finite().positive().max(300);
// A time-asleep reading from a v2 context carries that context's stage totals, and only such a reading does: stages without
// the intervals they come from, or a v2 night's time asleep without its stages, is not one reading.
const stagesMatchContext = (sample: { method?: string | undefined; value: number; sleep_context?: z.infer<typeof healthSleepContextV1Schema> | undefined; stages?: HealthSleepStagesV1 | undefined }): boolean => {
  const context = sample.sleep_context?.reducer_version === 'asleep-interval-union.v2' ? sample.sleep_context : null;
  const asleep = sample.method === undefined || sample.method === 'asleep_duration';
  if (!sample.stages) return !(context && asleep);
  const reduced = context && asleep ? reduceSleepContextV2(context) : null;
  if (!reduced) return false;
  const { light, deep, rem, unspecified, awake } = sample.stages;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  return near(light, reduced.light) && near(deep, reduced.deep) && near(rem, reduced.rem) && near(unspecified, reduced.unspecified) && near(awake, reduced.awake)
    && near(light + deep + rem + unspecified, sample.value);
};
// Bounds are plausibility limits that catch unit mistakes. They are not medical thresholds.
export const healthSampleV1Schema = z.discriminatedUnion('signal', [
  z.strictObject({ ...sampleCommon, signal: z.literal('sleep_duration'), unit: z.literal('minutes'), method: z.enum(['asleep_duration', 'time_in_bed', 'unknown']).optional(), value: z.number().finite().min(0).max(1440), stages: healthSleepStagesV1Schema.optional() }),
  z.strictObject({ ...sampleCommon, signal: z.literal('sleep_efficiency'), unit: z.literal('ratio'), value: z.number().finite().min(0).max(1) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('sleep_midpoint'), unit: z.literal('local_minute'), method: z.literal('sleep_midpoint'), value: z.number().finite().min(0).max(1439.999) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('overnight_hrv'), unit: z.literal('milliseconds'), method: hrvMethodV1, value: z.number().finite().positive().max(1000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('resting_heart_rate'), unit: z.literal('beats_per_minute'), method: z.enum(['overnight_resting', 'provider_resting_daily', 'resting_measurement', 'unknown']).optional(), value: bpm }),
  z.strictObject({ ...sampleCommon, signal: z.literal('daylight_duration'), unit: z.literal('minutes'), value: z.number().finite().min(0).max(60) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('movement_duration'), unit: z.literal('minutes'), value: z.number().finite().min(0).max(60) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('heart_rate_window'), unit: z.literal('beats_per_minute'), value: bpm, min: bpm, max: bpm, n_samples: z.int().min(1).max(100_000) }),
  // RMSSD is the canonical method. SDNN is a labelled fallback with its own baseline, never blended.
  z.strictObject({ ...sampleCommon, signal: z.literal('hrv_window'), unit: z.literal('milliseconds'), method: hrvMethodV1, value: z.number().finite().positive().max(1000), n_beats: z.int().min(10).max(1_000_000).optional() }),
  z.strictObject({ ...sampleCommon, signal: z.literal('spo2'), unit: z.literal('percent'), value: z.number().finite().min(50).max(100) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('respiratory_rate'), unit: z.literal('breaths_per_minute'), value: z.number().finite().min(4).max(80) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('steps_window'), unit: z.literal('count'), value: z.int().min(0).max(300_000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('active_energy_window'), unit: z.literal('kilocalories'), value: z.number().finite().min(0).max(30_000) }),
  z.strictObject({ ...sampleCommon, signal: z.literal('workout'), unit: z.literal('minutes'), activity: z.string().min(1).max(64), value: z.number().finite().min(0).max(1440), energy_kcal: z.number().finite().min(0).max(30_000).optional() }),
  // The Apple Watch wellness tier. A build sends these only under health revision 3, so a backend that does not know one yet
  // rejects that reading, never the batch. Sleeping wrist temperature is one value per night: HealthKit's is absolute;
  // Health Connect's is the night's mean delta against its own baseline. The two have separate baselines, never blended.
  z.strictObject({ ...sampleCommon, signal: z.literal('wrist_temperature'), unit: z.literal('celsius'), method: z.enum(['absolute', 'baseline_delta']), value: z.number().finite() })
    .refine(sample => (sample.method === 'absolute' ? sample.value >= 25 && sample.value <= 42 : sample.value >= -5 && sample.value <= 5), 'wrist temperature outside its method scale'),
  z.strictObject({ ...sampleCommon, signal: z.literal('walking_heart_rate_average'), unit: z.literal('beats_per_minute'), value: bpm }),
  z.strictObject({ ...sampleCommon, signal: z.literal('vo2_max'), unit: z.literal('ml_per_kg_min'), value: z.number().finite().min(10).max(90) }),
  // The drop from peak workout heart rate to one minute after.
  z.strictObject({ ...sampleCommon, signal: z.literal('heart_rate_recovery'), unit: z.literal('beats_per_minute'), value: z.number().finite().min(0).max(120) }),
  // One mindful session: its minutes are its start to its end.
  z.strictObject({ ...sampleCommon, signal: z.literal('mindful_duration'), unit: z.literal('minutes'), value: z.number().finite().min(0).max(1440) }),
]).refine(sample => Date.parse(sample.start_at) <= Date.parse(sample.end_at), 'sample end precedes start')
  .refine(sample => !WINDOW_SIGNALS.includes(sample.signal) || isLocalHourBucket(sample), 'window signals are fixed local-hour buckets')
  .refine(sample => sample.signal !== 'heart_rate_window' || (sample.min <= sample.value && sample.value <= sample.max), 'heart-rate window mean outside its range')
  .refine(sample => sample.signal !== 'sleep_duration' || stagesMatchContext(sample), 'sleep stages disagree with their intervals');
export const healthSignalV1Schema = z.enum([
  'sleep_duration', 'sleep_efficiency', 'sleep_midpoint', 'overnight_hrv', 'resting_heart_rate', 'daylight_duration', 'movement_duration',
  'heart_rate_window', 'hrv_window', 'spo2', 'respiratory_rate', 'steps_window', 'active_energy_window', 'workout',
  'wrist_temperature', 'walking_heart_rate_average', 'vo2_max', 'heart_rate_recovery', 'mindful_duration',
]);
export const healthSampleDeletionV1Schema = z.strictObject({ sample_id: sampleIdV1, signal: healthSignalV1Schema, revision: epochV1 });
// anchor_before and anchor_after form an opaque compare-and-set cursor of at most 2048 characters; the app keeps its
// real per-type anchors on the phone. The server stores the last acknowledged anchor_after per owner and source.
// A null anchor_before is always accepted as a resync (readings are idempotent); a non-null anchor_before that
// differs from the stored one is anchor_conflict, and the client restarts from null.
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
// Health revision 3: per-sample rejection. A build that names it has each change checked on its own, so one bad reading never
// fails an upload: the good changes are stored and the bad ones come back on the receipt by position, kind of reading and a
// closed reason, never by value. A build that does not name it keeps the all-or-nothing batch and never sees `rejected`, so
// it never gets a partial commit it could advance its anchor past without a trace.
// invalid_sample: the change is not a valid reading or deletion of a signal this backend knows (shape, unit, bounds, time).
// unsupported_signal: the signal is one this backend does not know yet; a newer build loses only that reading.
// revision_conflict: the same reading at the same revision was stored with other content; the app re-reads it and sends it
// at a higher revision.
// The anchor advances as for an accepted batch: the receipt is the trace of what was not stored.
export const HEALTH_PER_SAMPLE_REVISION_V1 = 3;
export const healthChangeRejectionReasonV1Schema = z.enum(['invalid_sample', 'unsupported_signal', 'revision_conflict']);
export const healthChangeRejectionV1Schema = z.strictObject({
  change: z.enum(['sample', 'deletion']),
  index: z.int().min(0).max(HEALTH_INGEST_MAX_CHANGES_V1 - 1),
  // Null when the change named no signal this backend knows.
  signal: healthSignalV1Schema.nullable(),
  reason: healthChangeRejectionReasonV1Schema,
});
// The server reads a revision-3 batch with this envelope, then each change on its own. The app still builds and checks its
// batch with healthIngestV1Schema.
export const healthIngestEnvelopeV1Schema = z.strictObject({
  ...healthIngestV1Schema.shape,
  samples: z.array(z.unknown()).max(HEALTH_INGEST_MAX_CHANGES_V1),
  deletions: z.array(z.unknown()).max(HEALTH_INGEST_MAX_CHANGES_V1),
}).refine(batch => batch.samples.length + batch.deletions.length <= HEALTH_INGEST_MAX_CHANGES_V1, 'batch exceeds 128 changes');
type HealthChangeRejectionV1 = z.infer<typeof healthChangeRejectionV1Schema>;
type HealthDeletionV1 = z.infer<typeof healthSampleDeletionV1Schema>;
export function checkHealthChangeV1(change: 'sample', index: number, value: unknown): { ok: true; change: z.infer<typeof healthSampleV1Schema> } | { ok: false; rejection: HealthChangeRejectionV1 };
export function checkHealthChangeV1(change: 'deletion', index: number, value: unknown): { ok: true; change: HealthDeletionV1 } | { ok: false; rejection: HealthChangeRejectionV1 };
export function checkHealthChangeV1(change: 'sample' | 'deletion', index: number, value: unknown) {
  const parsed = (change === 'sample' ? healthSampleV1Schema : healthSampleDeletionV1Schema).safeParse(value);
  if (parsed.success) return { ok: true, change: parsed.data };
  const named = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as { signal?: unknown }).signal : undefined;
  const signal = healthSignalV1Schema.safeParse(named);
  return {
    ok: false,
    rejection: { change, index, signal: signal.success ? signal.data : null, reason: typeof named === 'string' && !signal.success ? 'unsupported_signal' : 'invalid_sample' },
  };
}
export const healthIngestReceiptV1Schema = z.strictObject({
  request_id: healthRequestIdV1Schema,
  source: healthSourceV1Schema,
  consent_epoch: epochV1,
  accepted: z.int().nonnegative(),
  deleted: z.int().nonnegative(),
  ignored: z.int().nonnegative(),
  anchor_after: anchorV1,
  replayed: z.boolean(),
  // Present only for a request that named health revision 3 or later; empty when every change was taken.
  rejected: z.array(healthChangeRejectionV1Schema).max(HEALTH_INGEST_MAX_CHANGES_V1).optional(),
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
const algorithmVersion = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.v[0-9]+$/).max(64);
const activation = z.enum(['candidate_unaccepted', 'accepted']);
const scoreAvailable = <Zone extends z.ZodType>(zone: Zone) => z.strictObject({
  state: z.literal('available'),
  score: z.number().finite().min(0).max(100),
  // Null while this algorithm version has no ratified zone bands; the app shows the score without a zone word.
  zone: zone.nullable(),
  algorithm_version: algorithmVersion,
  activation,
  confidence: z.number().finite().min(0).max(1).nullable(),
  hrv_method: hrvMethodV1.nullable(),
});
const pillar = <Zone extends z.ZodType>(zone: Zone) => z.union([scoreUnavailable, scoreAvailable(zone)]);
// Sleep debt over the last 14 nights. A window with a missing night is partial and gives no figure. debt_minutes weighs
// recent nights more (the last night 1, the oldest 0.5) and earns nothing back for extra sleep, so it is not a count of
// minutes missed; 14 whole nights of 1,440 minutes bound it.
export const healthSleepDebtV1Schema = z.union([
  scoreUnavailable,
  z.strictObject({ state: z.literal('partial'), confidence: z.number().finite().min(0).max(1), algorithm_version: algorithmVersion, activation }),
  z.strictObject({
    state: z.literal('available'), debt_minutes: z.number().finite().min(0).max(20_160), need_basis: z.enum(['owner_confirmed', 'own_average']),
    algorithm_version: algorithmVersion, activation,
  }),
]);
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
  // Absent when the row was not computed with it, never a stand-in for zero debt.
  sleep_debt: healthSleepDebtV1Schema.optional(),
});
// No row to show for the day: a 200 with the reason, never a zero score.
export const healthScoresUnavailableV1Schema = z.strictObject({
  state: z.literal('unavailable'),
  day: healthDayV1Schema.nullable(),
  reason: healthScoreUnavailableReasonV1Schema.extract(['not_linked', 'consent_required', 'consent_withdrawn', 'no_readings']),
});
export const healthScoresResponseV1Schema = z.union([healthScoresV1Schema, healthScoresUnavailableV1Schema]);

// The runtime may attach a short message; a client acts on `error` only.
export const healthApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'anchor_conflict', 'sample_conflict', 'unavailable']),
  message: z.string().max(1000).optional(),
});

export const appHealthRoutesV1 = [
  { method: 'GET', path: '/app/v1/health/consents', response: healthConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/health/consents', request: healthConsentGrantV1Schema, response: healthConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: HEALTH_INGEST_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/health/consents/withdraw', request: healthConsentWithdrawV1Schema, response: healthConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: HEALTH_INGEST_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/health/ingest', request: healthIngestV1Schema, response: healthIngestReceiptV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: HEALTH_INGEST_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/health/scores', query: healthScoresQueryV1Schema, response: healthScoresResponseV1Schema, authenticated: true, success_status: 200 },
] as const;

export type HealthIngestV1 = z.infer<typeof healthIngestV1Schema>;
export type HealthSampleV1 = z.infer<typeof healthSampleV1Schema>;
export type HealthScoresV1 = z.infer<typeof healthScoresV1Schema>;
export type HealthScoresResponseV1 = z.infer<typeof healthScoresResponseV1Schema>;
