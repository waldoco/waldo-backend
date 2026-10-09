import { describe, expect, it } from 'vitest';
import {
  healthConsentGrantSchema, healthConsentWithdrawSchema, healthHistoryQuerySchema,
  healthIngestSchema, healthProducerDaySchema, healthSampleSchema,
} from './ingest';

const grant = { request_id: 'health-consent-001', source: 'apple', purpose: 'storage_compute', version: 1, expected_epoch: 0, age_attested_18_plus: true };
const sample = { sample_id: 'HK:sample-1', revision: 1, metric: 'sleep_duration', unit: 'minutes', value: 420, day: '2026-10-10', start_at: '2026-10-09T23:00:00Z', end_at: '2026-10-10T06:00:00Z' };
const batch = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 1, timezone: 'Asia/Kolkata', anchor_before: null, anchor_after: 'opaque-anchor-1', samples: [sample], deletions: [] };

describe('additive health ingest contract', () => {
  it('requires explicit exact source/purpose/version/age evidence and rejects client owner identity', () => {
    expect(healthConsentGrantSchema.safeParse(grant).success).toBe(true);
    for (const input of [ { ...grant, source: '*' }, { ...grant, purpose: 'all' }, { ...grant, version: '1' }, { ...grant, version: 2 }, { ...grant, age_attested_18_plus: false }, { ...grant, owner_id: 'other-owner' } ]) {
      expect(healthConsentGrantSchema.safeParse(input).success).toBe(false);
    }
    expect(healthConsentWithdrawSchema.safeParse({ request_id: 'withdraw-health-1', source: 'apple', purpose: 'model_processing', expected_epoch: 1 }).success).toBe(true);
  });

  it('validates metric units, finite value domains, chronological bounds and HRV method explicitly', () => {
    expect(healthSampleSchema.safeParse(sample).success).toBe(true);
    for (const input of [ { ...sample, unit: 'hours' }, { ...sample, value: -1 }, { ...sample, value: Infinity }, { ...sample, value: 1441 }, { ...sample, start_at: '2026-10-10T07:00:00Z' }, { ...sample, metric: 'overnight_hrv', unit: 'milliseconds', value: 50 }, { ...sample, metric: 'overnight_hrv', unit: 'milliseconds', value: 50, method: 'population_proxy' } ]) {
      expect(healthSampleSchema.safeParse(input).success).toBe(false);
    }
    expect(healthSampleSchema.safeParse({ ...sample, metric: 'overnight_hrv', unit: 'milliseconds', value: 50, method: 'sdnn' }).success).toBe(true);
  });

  it('allows zero-change acknowledged anchor advancement and caps combined changes', () => {
    expect(healthIngestSchema.safeParse({ ...batch, samples: [] }).success).toBe(true);
    expect(healthIngestSchema.safeParse({ ...batch, samples: Array.from({ length: 128 }, () => sample) }).success).toBe(true);
    expect(healthIngestSchema.safeParse({ ...batch, samples: Array.from({ length: 128 }, () => sample), deletions: [{ sample_id: 'deleted-1', metric: 'sleep_duration', revision: 2 }] }).success).toBe(false);
  });

  it('rejects forged owner fields, invalid timezone and old-protocol payload blobs', () => {
    for (const input of [ { ...batch, user_id: 'forged' }, { ...batch, timezone: 'invalid/private' }, { ...batch, readings: [{ value: 420 }] }, { ...batch, consent_epoch: -1 } ]) expect(healthIngestSchema.safeParse(input).success).toBe(false);
  });

  it('limits each history page to 90 days and preserves exact source/epoch', () => {
    expect(healthHistoryQuerySchema.safeParse({ source: 'apple', from: '2026-07-13', to: '2026-10-10', consent_epoch: 1 }).success).toBe(true);
    for (const query of [ { source: 'apple', from: '2026-01-01', to: '2026-10-10', consent_epoch: 1 }, { source: 'apple', from: '2026-10-11', to: '2026-10-10', consent_epoch: 1 }, { source: 'apple', from: '2026-10-09', to: '2026-10-10', consent_epoch: '1' } ]) expect(healthHistoryQuerySchema.safeParse(query).success).toBe(false);
  });

  it('validates provider producer timestamps/day/timezone before code handles them', () => {
    const day = { source: 'apple', consent_epoch: 1, day: '2026-10-10', timezone: 'UTC', compiled_at: '2026-10-10T07:00:00Z', samples: [sample], aggregates: [] };
    expect(healthProducerDaySchema.safeParse(day).success).toBe(true);
    for (const input of [ { ...day, timezone: 'invalid/private' }, { ...day, day: 'invalid' }, { ...day, compiled_at: 'invalid' } ]) expect(healthProducerDaySchema.safeParse(input).success).toBe(false);
  });
});
