import { describe, expect, it } from 'vitest';
import {
  appHealthRoutesV1, HEALTH_CONSENT_VERSION_V1, healthApiErrorV1Schema, healthConsentChangeV1Schema, healthConsentGrantV1Schema,
  healthConsentListV1Schema, healthConsentWithdrawV1Schema, healthIngestReceiptV1Schema, healthIngestV1Schema, healthSampleV1Schema,
  healthScoresQueryV1Schema, healthScoresResponseV1Schema, healthScoresV1Schema,
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
  it('takes every source the app can read, and no server-side vendor', () => {
    for (const source of ['apple', 'samsung', 'health_connect']) expect(healthConsentGrantV1Schema.safeParse({ ...grant, source }).success, source).toBe(true);
    rejected(healthConsentGrantV1Schema, [{ ...grant, source: 'garmin' }, { ...grant, source: 'whoop' }]);
  });
  it('carries the copy version that names intraday window summaries', () => {
    expect(HEALTH_CONSENT_VERSION_V1).toBe(2);
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
