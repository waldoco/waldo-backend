import { describe, expect, it } from 'vitest';
import {
  appHealthRoutesV1, checkHealthChangeV1, HEALTH_BASELINE_REVISION_V1, HEALTH_CONSENT_VERSION_V1, HEALTH_PER_SAMPLE_REVISION_V1, HEALTH_PROVIDER_CONSENT_VERSION_V1, HEALTH_PROVIDER_REVISION_V1,
  healthApiErrorV1Schema, healthBaselineV1Schema, healthChangeRejectionReasonV1Schema, healthDriverPhraseV1Schema, healthEnergyWindowV1Schema, healthConsentChangeV1Schema, healthConsentGrantV1Schema,
  healthConsentListV1Schema, healthConsentVersionV1, healthConsentWithdrawV1Schema, healthIngestEnvelopeV1Schema, healthIngestReceiptV1Schema, healthIngestV1Schema, healthSampleV1Schema,
  healthScoresQueryV1Schema, healthScoresResponseV1Schema, healthScoresV1Schema, reduceSleepContextV2,
} from './health-ingest';

const grant = { request_id: 'health-consent-001', source: 'apple', purpose: 'storage_compute', version: HEALTH_CONSENT_VERSION_V1, expected_epoch: 0, age_attested_18_plus: true };
const common = { sample_id: 'HK:sample-1', revision: 1, day: '2026-10-10', start_at: '2026-10-10T06:00:00+05:30', end_at: '2026-10-10T06:05:00+05:30', utc_offset_minutes: 330 };
const hour = { ...common, start_at: '2026-10-10T06:00:00+05:30', end_at: '2026-10-10T07:00:00+05:30' };
const sleep = { ...common, signal: 'sleep_duration', unit: 'minutes', value: 420 };
const batch = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 1, timezone: 'Asia/Kolkata', anchor_before: null, anchor_after: 'opaque-anchor-1', samples: [sleep], deletions: [] };
const rejected = (schema: { safeParse(input: unknown): { success: boolean } }, inputs: unknown[]) => inputs.forEach(input => expect(schema.safeParse(input).success, JSON.stringify(input)).toBe(false));

describe('health consent', () => {
  it('needs exact source, purpose, copy version and an explicit 18+ attestation, and never an owner identity', () => {
    expect(healthConsentGrantV1Schema.safeParse(grant).success).toBe(true);
    rejected(healthConsentGrantV1Schema, [{ ...grant, source: '*' }, { ...grant, source: 'oura' }, { ...grant, purpose: 'all' }, { ...grant, version: String(HEALTH_CONSENT_VERSION_V1) }, { ...grant, version: HEALTH_CONSENT_VERSION_V1 - 1 }, { ...grant, age_attested_18_plus: false }, { ...grant, owner_id: 'other-owner' }, { ...grant, expected_epoch: -1 }, { ...grant, request_id: 'short' }]);
    expect(healthConsentWithdrawV1Schema.safeParse({ request_id: 'withdraw-health-1', source: 'samsung', purpose: 'model_processing', expected_epoch: 1 }).success).toBe(true);
  });
  it('takes every source the app can read and the one provider the backend syncs, and no other vendor', () => {
    for (const source of ['apple', 'samsung', 'health_connect', 'whoop'] as const) expect(healthConsentGrantV1Schema.safeParse({ ...grant, source, version: healthConsentVersionV1(source) }).success, source).toBe(true);
    rejected(healthConsentGrantV1Schema, [{ ...grant, source: 'garmin' }, { ...grant, source: 'oura' }]);
  });
  it('carries the copy version that names intraday window summaries for a device source and the WHOOP-specific notice for WHOOP', () => {
    expect([HEALTH_CONSENT_VERSION_V1, HEALTH_PROVIDER_CONSENT_VERSION_V1]).toEqual([2, 3]);
    expect((['apple', 'samsung', 'health_connect', 'whoop'] as const).map(healthConsentVersionV1)).toEqual([2, 2, 2, 3]);
  });
  it('ties a grant to the copy of its own source: WHOOP on the device copy, or a device source on the WHOOP copy, is refused', () => {
    expect(healthConsentGrantV1Schema.safeParse({ ...grant, source: 'whoop', version: HEALTH_PROVIDER_CONSENT_VERSION_V1 }).success).toBe(true);
    rejected(healthConsentGrantV1Schema, [{ ...grant, source: 'whoop' }, { ...grant, source: 'whoop', version: HEALTH_CONSENT_VERSION_V1 }, { ...grant, version: HEALTH_PROVIDER_CONSENT_VERSION_V1 }, { ...grant, source: 'whoop', version: 4 }]);
  });
  // A stored grant keeps the version it was written on. After a copy change, reading it back must still work (the list, a
  // withdraw's answer, a replayed grant), while a new grant must name the current version.
  it('reads back every version its source has had, and still writes only the current one', () => {
    const row = { consent_class: 'health_processing', source: 'whoop', purpose: 'storage_compute', version: HEALTH_PROVIDER_CONSENT_VERSION_V1, status: 'granted', epoch: 1, granted_at: '2026-10-10T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' };
    for (const version of [2, 3]) expect(healthConsentListV1Schema.safeParse({ consents: [{ ...row, version }] }).success, `whoop ${version}`).toBe(true);
    expect(healthConsentListV1Schema.safeParse({ consents: [{ ...row, source: 'apple', version: 2 }] }).success).toBe(true);
    expect(healthConsentChangeV1Schema.safeParse({ consent: { ...row, version: 2 }, replayed: true, deletion_routed: false }).success).toBe(true);
    // Never a version the source has not had: not the next one, not another source's, not an invalid one.
    rejected(healthConsentListV1Schema, [{ consents: [{ ...row, version: 4 }] }, { consents: [{ ...row, source: 'apple', version: 3 }] }, { consents: [{ ...row, version: 1 }] }, { consents: [{ ...row, version: 2.5 }] }]);
    // New writes stay strict: a WHOOP grant on its earlier version is refused.
    rejected(healthConsentGrantV1Schema, [{ ...grant, source: 'whoop', version: 2 }]);
  });
  it('reports state, list and change receipts strictly', () => {
    const state = { consent_class: 'health_processing', source: 'apple', purpose: 'storage_compute', version: HEALTH_CONSENT_VERSION_V1, status: 'granted', epoch: 1, granted_at: '2026-10-10T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' };
    expect(healthConsentListV1Schema.safeParse({ consents: [state] }).success).toBe(true);
    expect(healthConsentChangeV1Schema.safeParse({ consent: state, replayed: false, deletion_routed: false }).success).toBe(true);
    rejected(healthConsentChangeV1Schema, [{ consent: { ...state, status: 'maybe' }, replayed: false, deletion_routed: false }, { consent: state, replayed: false }, { consent: { ...state, extra: 1 }, replayed: false, deletion_routed: false }]);
  });
});

describe('health samples', () => {
  it('validates units, finite value domains and chronological bounds', () => {
    expect(healthSampleV1Schema.safeParse(sleep).success).toBe(true);
    rejected(healthSampleV1Schema, [{ ...sleep, unit: 'hours' }, { ...sleep, value: -1 }, { ...sleep, value: Infinity }, { ...sleep, value: 1441 }, { ...sleep, start_at: '2026-10-10T07:00:00+05:30' }, { ...sleep, utc_offset_minutes: 900 }, { ...sleep, utc_offset_minutes: 1.5 }, { ...sleep, signal: 'unknown_metric' }, { ...sleep, owner_id: 'forged' }]);
    const { utc_offset_minutes: _offset, ...withoutOffset } = sleep;
    expect(healthSampleV1Schema.safeParse(withoutOffset).success).toBe(false);
  });
  it('labels every HRV reading rmssd or sdnn and refuses anything else', () => {
    const hrv = { ...common, signal: 'overnight_hrv', unit: 'milliseconds', value: 52 };
    expect(healthSampleV1Schema.safeParse({ ...hrv, method: 'rmssd' }).success).toBe(true);
    expect(healthSampleV1Schema.safeParse({ ...hrv, method: 'sdnn' }).success).toBe(true);
    rejected(healthSampleV1Schema, [hrv, { ...hrv, method: 'pnn50' }, { ...hrv, method: 'rmssd', value: 0 }]);
    const window = { ...hour, signal: 'hrv_window', unit: 'milliseconds', value: 41, method: 'rmssd', n_beats: 300 };
    expect(healthSampleV1Schema.safeParse(window).success).toBe(true);
    const { n_beats: _beats, ...native } = window;
    expect(healthSampleV1Schema.safeParse(native).success).toBe(true);
    rejected(healthSampleV1Schema, [{ ...window, method: undefined }, { ...window, n_beats: 2 }, { ...window, n_beats: 1.5 }, { ...window, beats: [800, 810] }]);
  });
  it('accepts intraday window summaries and nothing beat-to-beat', () => {
    const accepted = [
      { ...hour, signal: 'heart_rate_window', unit: 'beats_per_minute', value: 72, min: 60, max: 95, n_samples: 12 },
      { ...common, signal: 'spo2', unit: 'percent', value: 97 },
      { ...common, signal: 'respiratory_rate', unit: 'breaths_per_minute', value: 14.5 },
      { ...hour, signal: 'steps_window', unit: 'count', value: 1200 },
      { ...hour, signal: 'active_energy_window', unit: 'kilocalories', value: 85.5 },
      { ...hour, signal: 'daylight_duration', unit: 'minutes', value: 35 },
      { ...hour, signal: 'movement_duration', unit: 'minutes', value: 12 },
      { ...common, signal: 'workout', unit: 'minutes', value: 42, activity: 'running', energy_kcal: 410 },
    ];
    for (const sample of accepted) expect(healthSampleV1Schema.safeParse(sample).success, sample.signal).toBe(true);
    rejected(healthSampleV1Schema, [
      { ...accepted[0], min: 80 }, { ...accepted[0], max: 70 }, { ...accepted[0], ibi_ms: [800, 790] }, { ...accepted[0], series: [{ t: 1, bpm: 70 }] },
      { ...accepted[1], value: 120 }, { ...accepted[2], value: 0 }, { ...accepted[3], value: 1.5 }, { ...accepted[3], value: -1 }, { ...accepted[4], unit: 'joules' }, { ...accepted[5], value: 61 }, { ...accepted[6], value: 61 }, { ...accepted[7], activity: '' }, { ...accepted[5], context_ref: 'ctx' }, { ...accepted[6], method: 'daylight_duration' },
    ]);
  });
  it('keeps window signals to fixed local-hour buckets, so a window id never depends on when it was read', () => {
    const steps = { ...hour, signal: 'steps_window', unit: 'count', value: 100 };
    expect(healthSampleV1Schema.safeParse(steps).success).toBe(true);
    expect(healthSampleV1Schema.safeParse({ ...steps, start_at: '2026-10-10T00:30:00Z', end_at: '2026-10-10T01:30:00Z', utc_offset_minutes: 0 }).success).toBe(false);
    expect(healthSampleV1Schema.safeParse({ ...steps, start_at: '2026-10-10T01:00:00Z', end_at: '2026-10-10T02:00:00Z', utc_offset_minutes: 0 }).success).toBe(true);
    rejected(healthSampleV1Schema, [
      { ...steps, end_at: '2026-10-10T06:30:00+05:30' }, { ...steps, end_at: '2026-10-10T08:00:00+05:30' }, { ...steps, start_at: '2026-10-10T06:15:00+05:30', end_at: '2026-10-10T07:15:00+05:30' },
      { ...steps, utc_offset_minutes: 0 }, { ...steps, start_at: '2026-10-10T07:00:00+05:30', end_at: '2026-10-10T06:00:00+05:30' },
    ]);
    for (const signal of ['heart_rate_window', 'hrv_window', 'active_energy_window']) {
      const base = { ...hour, signal, ...(signal === 'heart_rate_window' ? { unit: 'beats_per_minute', value: 70, min: 60, max: 80, n_samples: 5 } : signal === 'hrv_window' ? { unit: 'milliseconds', value: 40, method: 'rmssd' } : { unit: 'kilocalories', value: 9 }) };
      expect(healthSampleV1Schema.safeParse(base).success, signal).toBe(true);
      expect(healthSampleV1Schema.safeParse({ ...base, end_at: '2026-10-10T06:20:00+05:30' }).success, signal).toBe(false);
    }
    expect(healthSampleV1Schema.safeParse({ ...common, signal: 'spo2', unit: 'percent', value: 96 }).success).toBe(true);
  });
  it('preserves native producer origin without treating the read API as a vendor', () => {
    const origin = { read_api: 'healthkit', source_bundle_id: 'com.example.other-source', source_package_name: null, source_version: '2', source_revision: 'rev-2', device_ref: `sha256:${'2'.repeat(64)}`, recording_method: 'automatic' };
    expect(healthSampleV1Schema.parse({ ...sleep, origin })).toEqual({ ...sleep, origin });
    rejected(healthSampleV1Schema, [{ ...sleep, origin: { ...origin, recording_method: 'inferred' } }, { ...sleep, origin: { ...origin, owner_id: 'forged' } }, { ...sleep, origin: { ...origin, device_ref: 'raw-device-name' } }]);
    expect(healthSampleV1Schema.parse(sleep)).not.toHaveProperty('origin');
    for (const recording_method of ['automatic', 'active', 'manual', 'unknown']) expect(healthSampleV1Schema.safeParse({ ...sleep, origin: { ...origin, recording_method } }).success, recording_method).toBe(true);
    rejected(healthSampleV1Schema, [2, true, false, 0].map(recording_method => ({ ...sleep, origin: { ...origin, recording_method } })));
  });
});

// The Apple Watch wellness tier (ADR-0081 amendment, AW-1). Every value here is synthetic.
describe('watch wellness signals', () => {
  const temperature = { ...common, signal: 'wrist_temperature', unit: 'celsius', method: 'absolute', value: 34.2 };
  const walking = { ...common, signal: 'walking_heart_rate_average', unit: 'beats_per_minute', value: 101 };
  const fitness = { ...common, signal: 'vo2_max', unit: 'ml_per_kg_min', value: 41.5 };
  const cardioRecovery = { ...common, signal: 'heart_rate_recovery', unit: 'beats_per_minute', value: 24 };
  const mindful = { ...common, signal: 'mindful_duration', unit: 'minutes', value: 10 };

  it('takes sleeping wrist temperature, walking heart rate, VO2 max, one-minute heart-rate recovery and mindful minutes', () => {
    for (const sample of [temperature, { ...temperature, method: 'baseline_delta', value: -0.4 }, walking, fitness, cardioRecovery, mindful]) {
      expect(healthSampleV1Schema.safeParse(sample).success, `${sample.signal} ${JSON.stringify(sample.value)}`).toBe(true);
    }
    expect(healthIngestV1Schema.safeParse({ ...batch, samples: [temperature, walking, fitness, cardioRecovery, mindful] }).success).toBe(true);
  });
  it('keeps each temperature method to its own scale, so a Fahrenheit reading or a delta labelled absolute is refused', () => {
    rejected(healthSampleV1Schema, [
      { ...temperature, value: 95 }, { ...temperature, value: 0.5 }, { ...temperature, method: 'baseline_delta', value: 34.2 }, { ...temperature, method: 'baseline_delta', value: 5.5 },
      { ...temperature, method: undefined }, { ...temperature, method: 'skin' }, { ...temperature, unit: 'fahrenheit' }, { ...temperature, value: Number.NaN },
    ]);
  });
  it('bounds the others as unit-mistake catches, never as medical thresholds', () => {
    rejected(healthSampleV1Schema, [
      { ...walking, value: 0 }, { ...walking, value: 301 }, { ...walking, unit: 'count' },
      { ...fitness, value: 5 }, { ...fitness, value: 95 }, { ...fitness, unit: 'ml_per_min' },
      { ...cardioRecovery, value: -1 }, { ...cardioRecovery, value: 121 },
      { ...mindful, value: -1 }, { ...mindful, value: 1441 }, { ...mindful, unit: 'seconds' }, { ...mindful, method: 'breathe' },
    ]);
  });
  it('lets a deletion name every new signal', () => {
    const deletions = ['wrist_temperature', 'walking_heart_rate_average', 'vo2_max', 'heart_rate_recovery', 'mindful_duration'].map((signal, index) => ({ sample_id: `HK:gone-${index}`, signal, revision: 2 }));
    expect(healthIngestV1Schema.safeParse({ ...batch, samples: [], deletions }).success).toBe(true);
  });
  it('checks a new signal per sample like any other, so a newer build loses only the bad reading', () => {
    expect(checkHealthChangeV1('sample', 0, temperature)).toEqual({ ok: true, change: temperature });
    expect(checkHealthChangeV1('sample', 1, { ...temperature, value: 95 })).toEqual({ ok: false, rejection: { change: 'sample', index: 1, signal: 'wrist_temperature', reason: 'invalid_sample' } });
  });
});

// Sleep stages (reducer v2). The phone and the backend run the same reducer, so the totals cannot drift.
describe('sleep stages', () => {
  const at = (clock: string, day = '2026-10-10') => `${day}T${clock}:00+05:30`;
  const ids = ['HK:bed', 'HK:s1', 'HK:s2', 'HK:s3', 'HK:s4', 'HK:s5'];
  const interval = (contributor_id: string, from: string, to: string, kind: string, stage?: string, fromDay = '2026-10-10', toDay = '2026-10-10') =>
    ({ contributor_id, start_at: at(from, fromDay), end_at: at(to, toDay), kind, ...(stage ? { stage } : {}) });
  // 23:00 to 06:30 across midnight: 120 light, 60 deep, 20 awake, 60 REM, 190 unstaged asleep.
  const night = [
    interval('HK:bed', '22:50', '06:40', 'in_bed', undefined, '2026-10-09'),
    interval('HK:s1', '23:00', '01:00', 'asleep', 'light', '2026-10-09'),
    interval('HK:s2', '01:00', '02:00', 'asleep', 'deep'),
    interval('HK:s3', '02:00', '02:20', 'awake'),
    interval('HK:s4', '02:20', '03:20', 'asleep', 'rem'),
    interval('HK:s5', '03:20', '06:30', 'asleep'),
  ];
  const context = (intervals: unknown[], reducer_version = 'asleep-interval-union.v2') =>
    ({ source_ref: 'HK:watch', session_ref: 'HK:night-10', waking_day: '2026-10-10', reducer_version, contributor_ids: ids, intervals });
  const stages = { light: 120, deep: 60, rem: 60, unspecified: 190, awake: 20 };
  const staged = { ...common, sample_id: 'HK:night-10:sleep_duration', start_at: at('23:00', '2026-10-09'), end_at: at('06:30'), signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: 430, sleep_context: context(night), stages };

  it('reduces asleep to the union of asleep time, each stage to its own union, and awake to waking time inside the night only', () => {
    expect(reduceSleepContextV2(context(night) as never)).toEqual({ asleep: 430, ...stages });
    // Awake time before the first sleep, after the last, or under an asleep interval is not time awake in the night.
    const edges = [...night, interval('HK:s5', '06:30', '06:50', 'awake'), interval('HK:s3', '22:40', '23:00', 'awake', undefined, '2026-10-09', '2026-10-09'), interval('HK:s3', '00:50', '01:10', 'awake')];
    expect(reduceSleepContextV2(context(edges) as never)).toEqual({ asleep: 430, ...stages });
    // Two intervals of one stage that overlap count once.
    const repeated = [...night, interval('HK:s1', '00:00', '00:30', 'asleep', 'light')];
    expect(reduceSleepContextV2(context(repeated) as never)).toEqual({ asleep: 430, ...stages });
    expect(reduceSleepContextV2(context([night[0]]) as never)).toEqual({ asleep: 0, light: 0, deep: 0, rem: 0, unspecified: 0, awake: 0 });
  });
  it('takes a staged night whose totals are the reducer output, to within a minute', () => {
    expect(healthSampleV1Schema.safeParse(staged).success).toBe(true);
    expect(healthSampleV1Schema.safeParse({ ...staged, value: 429.6, stages: { ...stages, light: 119.6 } }).success).toBe(true);
    expect(healthSampleV1Schema.safeParse({ ...staged, method: undefined }).success).toBe(true);
    // The other readings of the night may carry the same context.
    expect(healthSampleV1Schema.safeParse({ ...common, signal: 'sleep_efficiency', unit: 'ratio', value: 0.91, sleep_context: context(night) }).success).toBe(true);
  });
  it('refuses totals that disagree with their intervals, and stages without the intervals they come from', () => {
    rejected(healthSampleV1Schema, [
      { ...staged, stages: { ...stages, deep: 75 } }, { ...staged, stages: { ...stages, awake: 0 } }, { ...staged, value: 440 },
      { ...staged, stages: undefined }, { ...staged, sleep_context: undefined }, { ...staged, sleep_context: context(night.map(({ stage: _stage, ...rest }) => (rest.kind === 'awake' ? { ...rest, kind: 'asleep' } : rest)), 'asleep-interval-union.v1') },
      { ...staged, method: 'time_in_bed' }, { ...staged, stages: { ...stages, core: 10 } }, { ...staged, stages: { ...stages, rem: -1 } },
    ]);
  });
  it('refuses two differently staged intervals that overlap, with no rule to pick one', () => {
    const clash = [...night.slice(0, 2), interval('HK:s2', '00:50', '02:00', 'asleep', 'deep'), ...night.slice(3)];
    expect(reduceSleepContextV2(context(clash) as never)).toBeNull();
    rejected(healthSampleV1Schema, [{ ...staged, sleep_context: context(clash) }, { ...common, signal: 'sleep_efficiency', unit: 'ratio', value: 0.9, sleep_context: context(clash) }]);
    const unstagedUnderStage = [...night, interval('HK:s5', '01:30', '01:40', 'asleep')];
    rejected(healthSampleV1Schema, [{ ...staged, sleep_context: context(unstagedUnderStage) }]);
  });
  it('keeps reducer v1 exactly as it was: no stage, no awake interval', () => {
    const v1 = night.filter(entry => entry.kind !== 'awake').map(({ stage: _stage, ...rest }) => rest);
    expect(healthSampleV1Schema.safeParse({ ...sleep, sleep_context: context(v1, 'asleep-interval-union.v1') }).success).toBe(true);
    rejected(healthSampleV1Schema, [
      { ...sleep, sleep_context: context(night, 'asleep-interval-union.v1') },
      { ...sleep, sleep_context: context([...v1, interval('HK:s3', '02:00', '02:20', 'awake')], 'asleep-interval-union.v1') },
      { ...sleep, sleep_context: context(v1, 'asleep-interval-union.v1'), stages },
      { ...sleep, sleep_context: context(night, 'asleep-interval-union.v3') },
    ]);
  });
  it('gives a stage only to asleep time, and keeps every interval inside the contributors it names', () => {
    rejected(healthSampleV1Schema, [
      { ...staged, sleep_context: context([...night, interval('HK:s3', '02:00', '02:20', 'awake', 'light')]) },
      { ...staged, sleep_context: context([...night, interval('HK:bed', '22:50', '23:00', 'in_bed', 'rem', '2026-10-09', '2026-10-09')]) },
      { ...staged, sleep_context: context([...night, interval('HK:s1', '23:00', '01:00', 'asleep', 'core', '2026-10-09')]) },
      { ...staged, sleep_context: context([...night, interval('HK:other', '02:00', '02:20', 'awake')]) },
      { ...staged, sleep_context: context([...night, interval('HK:s3', '02:20', '02:00', 'awake')]) },
    ]);
  });
});

describe('health ingest batch', () => {
  it('allows a zero-change acknowledged anchor advance and caps combined changes at 128', () => {
    expect(healthIngestV1Schema.safeParse({ ...batch, samples: [] }).success).toBe(true);
    expect(healthIngestV1Schema.safeParse({ ...batch, samples: Array.from({ length: 128 }, () => sleep) }).success).toBe(true);
    rejected(healthIngestV1Schema, [{ ...batch, samples: Array.from({ length: 128 }, () => sleep), deletions: [{ sample_id: 'deleted-1', signal: 'sleep_duration', revision: 2 }] }]);
  });
  it('rejects forged owner fields, malformed zones and old-protocol payload blobs', () => {
    rejected(healthIngestV1Schema, [{ ...batch, user_id: 'forged' }, { ...batch, timezone: 'not a zone!' }, { ...batch, timezone: '' }, { ...batch, readings: [{ value: 420 }] }, { ...batch, consent_epoch: -1 }, { ...batch, source: 'garmin' }, { ...batch, anchor_after: '' }]);
    expect(healthIngestV1Schema.safeParse({ ...batch, timezone: 'UTC' }).success).toBe(true);
    expect(healthIngestV1Schema.safeParse({ ...batch, timezone: 'America/Argentina/Buenos_Aires' }).success).toBe(true);
  });
  it('lets the current hour grow by revision and a deletion name its exact revision', () => {
    const grown = { ...hour, signal: 'steps_window', unit: 'count', value: 5000, revision: 1_790_000_000 };
    expect(healthIngestV1Schema.safeParse({ ...batch, samples: [grown], deletions: [{ sample_id: 'HK:gone', signal: 'steps_window', revision: 1_790_000_100 }] }).success).toBe(true);
  });
  it('matches the receipt to the request it answers', () => {
    const receipt = { request_id: batch.request_id, source: 'apple', consent_epoch: 1, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };
    expect(healthIngestReceiptV1Schema.safeParse(receipt).success).toBe(true);
    rejected(healthIngestReceiptV1Schema, [{ ...receipt, accepted: -1 }, { ...receipt, replayed: 'no' }, { ...receipt, extra: 1 }]);
  });
});

// Health revision 3: each change in a batch is checked on its own. A client that names it gets the good changes stored and
// the bad ones listed by position, kind of reading and a closed reason, never by value.
describe('per-sample rejection', () => {
  const receipt = { request_id: batch.request_id, source: 'apple', consent_epoch: 1, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };
  it('is health revision 3, after the provider rows of revision 2', () => {
    expect([HEALTH_PROVIDER_REVISION_V1, HEALTH_PER_SAMPLE_REVISION_V1]).toEqual([2, 3]);
  });
  it('reads the envelope strictly and leaves each change to be checked on its own', () => {
    const changes = [sleep, { signal: 'blood_glucose', value: 'x' }, 7, null];
    expect(healthIngestEnvelopeV1Schema.safeParse({ ...batch, samples: changes, deletions: [{ nonsense: true }] }).success).toBe(true);
    // The server sets the per-sample mode itself; a client cannot name it, or any other key.
    rejected(healthIngestEnvelopeV1Schema, [
      { ...batch, rejection: 'per_sample' }, { ...batch, user_id: 'forged' }, { ...batch, request_id: 'short' }, { ...batch, source: 'garmin' },
      { ...batch, timezone: 'not a zone!' }, { ...batch, samples: {} }, { ...batch, samples: Array.from({ length: 128 }, () => sleep), deletions: [{}] },
    ]);
  });
  it('passes a valid change through and names a bad one by position, kind of reading and reason only', () => {
    expect(checkHealthChangeV1('sample', 0, sleep)).toEqual({ ok: true, change: sleep });
    const deletion = { sample_id: 'HK:gone', signal: 'spo2', revision: 3 };
    expect(checkHealthChangeV1('deletion', 0, deletion)).toEqual({ ok: true, change: deletion });
    expect(checkHealthChangeV1('sample', 4, { ...sleep, value: 1441 })).toEqual({ ok: false, rejection: { change: 'sample', index: 4, signal: 'sleep_duration', reason: 'invalid_sample' } });
    expect(checkHealthChangeV1('sample', 5, { ...sleep, signal: 'blood_glucose', unit: 'mmol_per_l' })).toEqual({ ok: false, rejection: { change: 'sample', index: 5, signal: null, reason: 'unsupported_signal' } });
    expect(checkHealthChangeV1('deletion', 1, { ...deletion, signal: 'atrial_fibrillation_burden' })).toEqual({ ok: false, rejection: { change: 'deletion', index: 1, signal: null, reason: 'unsupported_signal' } });
    expect(checkHealthChangeV1('deletion', 2, { ...deletion, revision: -1 })).toEqual({ ok: false, rejection: { change: 'deletion', index: 2, signal: 'spo2', reason: 'invalid_sample' } });
    for (const hostile of [null, 7, 'sleep', [], { signal: 42 }, { signal: '__proto__' }, { ...sleep, extra: 'x' }, { ...sleep, unit: 'hours' }]) {
      const verdict = checkHealthChangeV1('sample', 0, hostile);
      expect(verdict.ok, JSON.stringify(hostile)).toBe(false);
      if (!verdict.ok) expect(Object.keys(verdict.rejection).sort()).toEqual(['change', 'index', 'reason', 'signal']);
    }
  });
  it('carries a rejection list on the receipt only as positions, kinds and closed reasons', () => {
    const rejection = { change: 'sample', index: 3, signal: 'spo2', reason: 'invalid_sample' };
    expect(healthIngestReceiptV1Schema.safeParse({ ...receipt, rejected: [] }).success).toBe(true);
    expect(healthIngestReceiptV1Schema.safeParse({ ...receipt, rejected: [rejection, { ...rejection, change: 'deletion', index: 0, signal: null, reason: 'unsupported_signal' }, { ...rejection, reason: 'revision_conflict' }] }).success).toBe(true);
    rejected(healthIngestReceiptV1Schema, [
      { ...receipt, rejected: [{ ...rejection, value: 97 }] }, { ...receipt, rejected: [{ ...rejection, index: 128 }] }, { ...receipt, rejected: [{ ...rejection, index: -1 }] },
      { ...receipt, rejected: [{ ...rejection, reason: 'too_high' }] }, { ...receipt, rejected: [{ ...rejection, signal: 'blood_glucose' }] },
      { ...receipt, rejected: Array.from({ length: 129 }, () => rejection) },
    ]);
    expect(healthChangeRejectionReasonV1Schema.options).toEqual(['invalid_sample', 'unsupported_signal', 'revision_conflict']);
  });
});

// Health Connect on Android, mapped per docs/app/HEALTH_CONNECT_MAPPING_2026-10-21.md. The wire is the same as HealthKit's;
// these pin the HC shapes the app sends so a change that refuses one fails here first.
describe('health connect uploads', () => {
  const hc = { read_api: 'health_connect', source_bundle_id: null, source_package_name: 'com.example.ringapp', source_version: null, source_revision: null, device_ref: null, recording_method: 'automatic', manufacturer: 'Example', product_type: 'RING', client_record_version: 3 };
  const hcBatch = { ...batch, source: 'health_connect', timezone: 'Europe/Berlin' };
  const night = { ...common, day: '2026-10-10', start_at: '2026-10-09T23:10:00+02:00', end_at: '2026-10-10T06:40:00+02:00', utc_offset_minutes: 120 };
  const stages = { source_ref: 'hc:session-9', session_ref: 'hc:session-9', waking_day: '2026-10-10', reducer_version: 'asleep-interval-union.v1', contributor_ids: ['hc:session-9'],
    intervals: [{ contributor_id: 'hc:session-9', start_at: '2026-10-09T23:10:00+02:00', end_at: '2026-10-09T23:25:00+02:00', kind: 'in_bed' }, { contributor_id: 'hc:session-9', start_at: '2026-10-09T23:25:00+02:00', end_at: '2026-10-10T06:40:00+02:00', kind: 'asleep' }] };

  it('takes a staged sleep session, an RMSSD reading, resting heart rate and an hour of steps with their HC origin', () => {
    const samples = [
      { ...night, sample_id: 'hc:session-9:sleep_duration', origin: hc, sleep_context: stages, signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: 435 },
      { ...night, sample_id: 'hc:session-9:overnight_hrv', origin: hc, signal: 'overnight_hrv', unit: 'milliseconds', method: 'rmssd', value: 42 },
      { ...common, sample_id: 'hc:rhr-4', origin: { ...hc, recording_method: 'unknown' }, signal: 'resting_heart_rate', unit: 'beats_per_minute', method: 'unknown', value: 58 },
      { ...hour, sample_id: 'hc:steps:2026-10-10T06', revision: 1_790_000_000, origin: { ...hc, recording_method: 'active' }, signal: 'steps_window', unit: 'count', value: 830 },
    ];
    expect(healthIngestV1Schema.safeParse({ ...hcBatch, samples }).success).toBe(true);
    // A deleted record names the signal each derived reading carried; the app keeps the record type beside the id.
    expect(healthIngestV1Schema.safeParse({ ...hcBatch, deletions: ['sleep_duration', 'sleep_efficiency', 'sleep_midpoint'].map(signal => ({ sample_id: `hc:session-9:${signal}`, signal, revision: 1_790_000_100 })) }).success).toBe(true);
  });

  it('refuses HC values the app must map first: an integer recording method, a bare deletion id and an unlabelled HRV', () => {
    rejected(healthIngestV1Schema, [
      { ...hcBatch, samples: [{ ...sleep, origin: { ...hc, recording_method: 2 } }] },
      { ...hcBatch, deletions: [{ sample_id: 'hc:session-9:sleep_duration', revision: 1 }] },
      { ...hcBatch, samples: [{ ...night, sample_id: 'hc:hrv-1', origin: hc, signal: 'overnight_hrv', unit: 'milliseconds', value: 42 }] },
      { ...hcBatch, source: 'google_fit' },
    ]);
  });
});

describe('health scores read', () => {
  const available = (zone: string, algorithm_version: string) => ({ state: 'available', score: 71.5, zone, algorithm_version, activation: 'candidate_unaccepted', confidence: 0.8, hrv_method: null });
  const scores = {
    day: '2026-10-10', timezone: 'Asia/Kolkata', compiled_at: '2026-10-10T07:00:00Z', freshness: 'fresh',
    recovery: { ...available('solid', 'recovery.candidate.v1'), hrv_method: 'rmssd' }, form: { state: 'unavailable', reason: 'intraday_inputs_unavailable' }, weight: { state: 'unavailable', reason: 'calendar_demand_unavailable' },
  };
  it('returns each pillar with its value, meaning-bearing zone, version, confidence and the row compile time', () => {
    expect(healthScoresV1Schema.safeParse(scores).success).toBe(true);
    expect(healthScoresV1Schema.safeParse({ ...scores, form: available('energized', 'form.candidate.v1'), weight: available('heavy', 'weight.candidate.v1') }).success).toBe(true);
  });
  it('states absence explicitly instead of a zero or a missing pillar', () => {
    expect(healthScoresV1Schema.safeParse({ ...scores, recovery: { state: 'unavailable', reason: 'no_readings' } }).success).toBe(true);
    rejected(healthScoresV1Schema, [{ ...scores, recovery: { state: 'unavailable' } }, { ...scores, recovery: { state: 'unavailable', reason: 'made_up' } }, { ...scores, recovery: undefined }, { ...scores, recovery: { ...available('solid', 'recovery.candidate.v1'), score: null } }]);
  });
  it('refuses a zone from another pillar vocabulary, so direction cannot be confused', () => {
    rejected(healthScoresV1Schema, [
      { ...scores, recovery: available('heavy', 'recovery.candidate.v1') }, { ...scores, recovery: available('high', 'recovery.candidate.v1') },
      { ...scores, weight: available('excellent', 'weight.candidate.v1') }, { ...scores, weight: available('low', 'weight.candidate.v1') }, { ...scores, form: available('mixed', 'form.candidate.v1') },
    ]);
  });
  it('bounds the score, the confidence and the HRV method', () => {
    rejected(healthScoresV1Schema, [{ ...scores, recovery: { ...scores.recovery, score: 101 } }, { ...scores, recovery: { ...scores.recovery, score: -1 } }, { ...scores, recovery: { ...scores.recovery, confidence: 1.5 } }, { ...scores, recovery: { ...scores.recovery, hrv_method: 'pnn50' } }, { ...scores, freshness: 'old' }]);
  });
  it('shows a score without a zone word while its bands are not ratified', () => {
    expect(healthScoresV1Schema.safeParse({ ...scores, recovery: { ...scores.recovery, zone: null } }).success).toBe(true);
    rejected(healthScoresV1Schema, [{ ...scores, recovery: { ...scores.recovery, zone: 'unknown' } }, { ...scores, recovery: { ...scores.recovery, zone: undefined } }]);
  });
  it('carries sleep debt in its own states, so a missing night or a missing key never reads as zero', () => {
    const version = { algorithm_version: 'sleep-debt.candidate.v1', activation: 'candidate_unaccepted' };
    const debt = { state: 'available', debt_minutes: 630, need_basis: 'own_average', ...version };
    for (const sleep_debt of [{ state: 'unavailable', reason: 'missing_sleep' }, { state: 'partial', confidence: 0.6, ...version }, debt, { ...debt, debt_minutes: 0, need_basis: 'owner_confirmed' }]) {
      expect(healthScoresV1Schema.safeParse({ ...scores, sleep_debt }).success, JSON.stringify(sleep_debt)).toBe(true);
    }
    expect(healthScoresResponseV1Schema.safeParse({ ...scores, sleep_debt: debt }).success).toBe(true);
    rejected(healthScoresV1Schema, [
      { ...scores, sleep_debt: null }, { ...scores, sleep_debt: { state: 'unavailable' } }, { ...scores, sleep_debt: { state: 'unavailable', reason: 'made_up' } },
      { ...scores, sleep_debt: { state: 'partial', confidence: 0.6, debt_minutes: 630, ...version } }, { ...scores, sleep_debt: { state: 'partial', confidence: 1.5, ...version } },
      { ...scores, sleep_debt: { ...debt, need_basis: undefined } }, { ...scores, sleep_debt: { ...debt, need_basis: 'guessed' } }, { ...scores, sleep_debt: { ...debt, zone: 'heavy' } },
      { ...scores, sleep_debt: { ...debt, debt_minutes: -1 } }, { ...scores, sleep_debt: { ...debt, debt_minutes: 20_161 } }, { ...scores, sleep_debt: { ...debt, debt_minutes: null } },
      { ...scores, sleep_debt: { ...debt, algorithm_version: 'sleep debt' } }, { ...scores, sleep_debt: { ...debt, activation: 'live' } },
    ]);
  });
  it('answers a day with no row as unavailable with a reason, not as an error or a zero', () => {
    for (const reason of ['not_linked', 'consent_required', 'consent_withdrawn', 'no_readings']) expect(healthScoresResponseV1Schema.safeParse({ state: 'unavailable', day: '2026-10-10', reason }).success).toBe(true);
    expect(healthScoresResponseV1Schema.safeParse({ state: 'unavailable', day: null, reason: 'not_linked' }).success).toBe(true);
    expect(healthScoresResponseV1Schema.safeParse(scores).success).toBe(true);
    rejected(healthScoresResponseV1Schema, [
      { state: 'unavailable', day: '2026-10-10' }, { state: 'unavailable', day: '2026-10-10', reason: 'baseline_immature' },
      { state: 'unavailable', day: '2026-10-10', reason: 'no_readings', recovery: scores.recovery }, { state: 'available', day: '2026-10-10', reason: 'no_readings' },
    ]);
  });
  it('takes an optional local day, nothing else', () => {
    expect(healthScoresQueryV1Schema.safeParse({}).success).toBe(true);
    expect(healthScoresQueryV1Schema.safeParse({ day: '2026-10-10' }).success).toBe(true);
    rejected(healthScoresQueryV1Schema, [{ day: '10/10/2026' }, { day: '2026-10-10', owner: 'x' }]);
  });
});

describe('health routes', () => {
  it('declares authenticated routes, an idempotency key on every write, and the streamed body bound', () => {
    expect(appHealthRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/health/consents', 'POST /app/v1/health/consents', 'POST /app/v1/health/consents/withdraw', 'POST /app/v1/health/ingest', 'GET /app/v1/health/scores',
    ]);
    for (const route of appHealthRoutesV1) {
      expect(route.authenticated).toBe(true);
      if (route.method === 'POST') { expect(route.idempotency_field).toBe('request_id'); expect(route.max_request_bytes).toBe(98_304); }
    }
  });
  it('names closed error codes and tolerates a bounded message the runtime may send', () => {
    expect(healthApiErrorV1Schema.safeParse({ error: 'consent_required' }).success).toBe(true);
    expect(healthApiErrorV1Schema.safeParse({ error: 'unavailable', message: 'try again later' }).success).toBe(true);
    rejected(healthApiErrorV1Schema, [{ error: 'anything else' }, { error: 'unavailable', message: 'x'.repeat(1001) }, { error: 'unavailable', detail: 'x' }, { error: 'unavailable', message: 7 }]);
  });
});

describe('health revision 4: baseline label, drivers and energy windows', () => {
  const available = { state: 'available', score: 71.5, zone: 'solid', algorithm_version: 'recovery.v5', activation: 'accepted', confidence: 0.6, hrv_method: 'rmssd' };
  const scores = {
    day: '2026-10-10', timezone: 'Asia/Kolkata', compiled_at: '2026-10-10T07:00:00Z', freshness: 'fresh',
    recovery: available, form: { state: 'unavailable', reason: 'baseline_immature' }, weight: { state: 'unavailable', reason: 'calendar_demand_unavailable' },
  };
  const baseline = { state: 'provisional', personal_days: 6, needed: 14, prior: 'adults' };
  const subjects = ['breathing rate', 'wrist temperature', 'blood oxygen', 'awake time in the night', 'walking heart rate'];
  it('is health revision 4, after per-sample rejection', () => {
    expect(HEALTH_BASELINE_REVISION_V1).toBe(4);
    expect(HEALTH_BASELINE_REVISION_V1).toBeGreaterThan(HEALTH_PER_SAMPLE_REVISION_V1);
  });
  it('labels a baseline as provisional or personal, with the days it has and the prior it leans on', () => {
    for (const label of [baseline, { ...baseline, state: 'personal', personal_days: 14 }, { ...baseline, personal_days: 0, prior: 'none' }, { ...baseline, prior: 'age_sex' }, { ...baseline, personal_days: 366 }]) {
      expect(healthBaselineV1Schema.safeParse(label).success, JSON.stringify(label)).toBe(true);
    }
    rejected(healthBaselineV1Schema, [
      { ...baseline, state: 'learning' }, { ...baseline, personal_days: -1 }, { ...baseline, personal_days: 367 }, { ...baseline, personal_days: 6.5 }, { ...baseline, needed: 7 },
      { ...baseline, prior: 'population' }, { ...baseline, needed: undefined }, { ...baseline, prior: undefined }, { ...baseline, mean: 52 }, 'provisional', null,
    ]);
  });
  it('lets only an available pillar carry a baseline, and a score without one stays valid', () => {
    expect(healthScoresV1Schema.safeParse(scores).success).toBe(true);
    expect(healthScoresV1Schema.safeParse({ ...scores, recovery: { ...available, baseline } }).success).toBe(true);
    rejected(healthScoresV1Schema, [
      { ...scores, recovery: { ...available, baseline: { ...baseline, state: 'learning' } } }, { ...scores, recovery: { ...available, baseline: null } },
      { ...scores, form: { state: 'unavailable', reason: 'baseline_immature', baseline } },
    ]);
  });
  it('names a driver only from the closed phrase list: five subjects, two directions, near or far', () => {
    const phrases = subjects.flatMap(subject => ['', ' far'].flatMap(far => ['above', 'below'].map(way => `${subject}${far} ${way} usual`)));
    expect(phrases).toHaveLength(20);
    expect([...healthDriverPhraseV1Schema.options].sort()).toEqual([...phrases].sort());
    for (const phrase of phrases) expect(healthDriverPhraseV1Schema.safeParse(phrase).success, phrase).toBe(true);
    rejected(healthDriverPhraseV1Schema, ['breathing rate high', 'resting heart rate above usual', 'breathing rate far far above usual', 'Breathing rate above usual', 'breathing rate above usual ', 'breathing rate 14 above usual', '', 7, null]);
  });
  it('carries at most eight drivers on the scores', () => {
    expect(healthScoresV1Schema.safeParse({ ...scores, drivers: ['wrist temperature far above usual', 'blood oxygen below usual'] }).success).toBe(true);
    expect(healthScoresV1Schema.safeParse({ ...scores, drivers: [] }).success).toBe(true);
    const nine = healthDriverPhraseV1Schema.options.slice(0, 9);
    rejected(healthScoresV1Schema, [{ ...scores, drivers: nine }, { ...scores, drivers: ['feeling tired'] }, { ...scores, drivers: 'blood oxygen below usual' }, { ...scores, drivers: null }]);
  });
  it('names a need that leans on the prior as blended_average, beside the two it had, and nothing else', () => {
    const version = { algorithm_version: 'sleep-debt.v2', activation: 'accepted' };
    const debt = { state: 'available', debt_minutes: 630, need_basis: 'blended_average', ...version };
    for (const need_basis of ['owner_confirmed', 'own_average', 'blended_average']) {
      expect(healthScoresV1Schema.safeParse({ ...scores, sleep_debt: { ...debt, need_basis } }).success, need_basis).toBe(true);
    }
    rejected(healthScoresV1Schema, [{ ...scores, sleep_debt: { ...debt, need_basis: 'blended' } }, { ...scores, sleep_debt: { ...debt, need_basis: 'Blended_Average' } }, { ...scores, sleep_debt: { ...debt, need_basis: 'population_average' } }, { ...scores, sleep_debt: { ...debt, need_basis: null } }]);
  });
  it('takes an energy window as two 24-hour clock times and a kind, and nothing else', () => {
    const window = { start: '09:30', end: '11:45', kind: 'peak' };
    for (const ok of [window, { start: '00:00', end: '23:59', kind: 'dip' }]) expect(healthEnergyWindowV1Schema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    rejected(healthEnergyWindowV1Schema, [
      { ...window, start: '9:30' }, { ...window, end: '24:00' }, { ...window, end: '11:60' }, { ...window, start: '09:30:00' }, { ...window, start: '9.30am' }, { ...window, kind: 'low' }, { ...window, kind: undefined }, { ...window, note: 'focus' },
    ]);
  });
  it('carries at most four windows on the scores', () => {
    const window = { start: '09:30', end: '11:45', kind: 'peak' };
    expect(healthScoresV1Schema.safeParse({ ...scores, windows: [window, { start: '14:00', end: '15:00', kind: 'dip' }] }).success).toBe(true);
    rejected(healthScoresV1Schema, [{ ...scores, windows: [window, window, window, window, window] }, { ...scores, windows: [{ start: 'noon', end: '13:00', kind: 'peak' }] }, { ...scores, windows: null }]);
  });
});
