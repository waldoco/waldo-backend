import { describe, expect, it } from 'vitest';
import {
  appCycleRoutesV1, cycleConsentGrantV1Schema, cycleConsentListV1Schema, cycleIngestReceiptV1Schema, cycleIngestV1Schema, cycleStatusV1Schema, menstrualPeriodV1Schema,
} from './cycle';
import { healthScoresBasisV1Schema, healthScoresV1Schema } from './health-ingest';

// Synthetic dates.
const origin = {
  read_api: 'healthkit', source_bundle_id: 'com.example.cycle', source_package_name: null, source_version: null, source_revision: null, device_ref: null, recording_method: 'manual',
} as const;
const period = { signal: 'menstrual_period', start_date: '2026-10-08', end_date: '2026-10-12', origin, source_name: 'Example Cycle' } as const;
const ingest = { request_id: 'cycle-ingest-0001', expected_epoch: 1, source: 'apple', window_start: '2026-08-06', periods: [period] } as const;

describe('menstrual period', () => {
  it('takes dates, provenance and the recording app, and nothing else', () => {
    expect(menstrualPeriodV1Schema.safeParse(period).success).toBe(true);
    expect(menstrualPeriodV1Schema.safeParse({ ...period, end_date: null }).success).toBe(true);
    expect(menstrualPeriodV1Schema.safeParse({ ...period, source_name: null }).success).toBe(true);
    for (const bad of [
      { ...period, flow: 'heavy' },
      { ...period, signal: 'ovulation_test' },
      { ...period, end_date: '2026-10-07' },
      { ...period, end_date: '2026-10-23' },
      { ...period, start_date: '2026-10-08T00:00:00Z' },
      { ...period, origin: undefined },
      { ...period, symptoms: ['cramps'] },
    ]) expect(menstrualPeriodV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe('cycle ingest', () => {
  it('accepts a window of periods from one source', () => {
    expect(cycleIngestV1Schema.safeParse(ingest).success).toBe(true);
    expect(cycleIngestV1Schema.safeParse({ ...ingest, periods: [] }).success).toBe(true);
    const latest = { ...period, start_date: '2026-11-03', end_date: null };
    expect(cycleIngestV1Schema.safeParse({ ...ingest, periods: [latest, period] }).success).toBe(true);
  });

  it('refuses overlaps, an ongoing period that is not the latest, periods before the window, and a read origin from the other platform', () => {
    const later = { ...period, start_date: '2026-11-03', end_date: '2026-11-06' };
    for (const bad of [
      { ...ingest, periods: [period, { ...later, start_date: '2026-10-12' }] },
      { ...ingest, periods: [{ ...period, end_date: null }, later] },
      { ...ingest, periods: [{ ...period, start_date: '2026-08-05' }] },
      { ...ingest, periods: [{ ...period, origin: { ...origin, read_api: 'health_connect' } }] },
      { ...ingest, source: 'samsung' },
      { ...ingest, source: 'flo' },
      { ...ingest, owner_id: 'someone-else' },
      { ...ingest, periods: Array.from({ length: 13 }, (_, i) => ({ ...period, start_date: `2026-${String(i % 12 + 1).padStart(2, '0')}-01`, end_date: `2026-${String(i % 12 + 1).padStart(2, '0')}-02` })) },
    ]) expect(cycleIngestV1Schema.safeParse(bad).success).toBe(false);
  });

  it('answers counts only', () => {
    expect(cycleIngestReceiptV1Schema.safeParse({ request_id: 'cycle-ingest-0001', replayed: false, accepted: 1, ignored: 0 }).success).toBe(true);
    expect(cycleIngestReceiptV1Schema.safeParse({ request_id: 'cycle-ingest-0001', replayed: false, accepted: 1, ignored: 0, phase: 'luteal' }).success).toBe(false);
  });
});

describe('cycle consent', () => {
  it('is the reproductive_health class with the one cycle_context purpose', () => {
    expect(cycleConsentGrantV1Schema.safeParse({ request_id: 'cycle-grant-0001', purpose: 'cycle_context', version: 1, expected_epoch: 0, age_attested_18_plus: true }).success).toBe(true);
    expect(cycleConsentGrantV1Schema.safeParse({ request_id: 'cycle-grant-0001', purpose: 'model_processing', version: 1, expected_epoch: 0, age_attested_18_plus: true }).success).toBe(false);
    expect(cycleConsentGrantV1Schema.safeParse({ request_id: 'cycle-grant-0001', purpose: 'cycle_context', version: 2, expected_epoch: 0, age_attested_18_plus: true }).success).toBe(false);
    expect(cycleConsentGrantV1Schema.safeParse({ request_id: 'cycle-grant-0001', purpose: 'cycle_context', version: 1, expected_epoch: 0 }).success).toBe(false);
    const row = { consent_class: 'reproductive_health', purpose: 'cycle_context', version: 1, status: 'not_granted', epoch: 0, granted_at: null, withdrawn_at: null, deletion_state: 'not_required' };
    expect(cycleConsentListV1Schema.safeParse({ consents: [row] }).success).toBe(true);
    expect(cycleConsentListV1Schema.safeParse({ consents: [{ ...row, consent_class: 'health_processing' }] }).success).toBe(false);
  });
});

describe('cycle status', () => {
  it('names the three states of the Cycle row and never a phase', () => {
    expect(cycleStatusV1Schema.safeParse({ state: 'off' }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'waiting_for_data' }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'active', last_period_start: '2026-10-08', last_source_name: 'Example Cycle' }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'active', last_period_start: '2026-10-08' }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'active' }).success).toBe(false);
    expect(cycleStatusV1Schema.safeParse({ state: 'off', last_period_start: '2026-10-08' }).success).toBe(false);
    expect(cycleStatusV1Schema.safeParse({ state: 'active', last_period_start: '2026-10-08', phase: 'luteal' }).success).toBe(false);
  });
});

describe('scores basis', () => {
  it('is cycle_phase with the backend line, as an optional key of the scores', () => {
    expect(healthScoresBasisV1Schema.safeParse({ kind: 'cycle_phase', explanation: 'Read against your usual readings for this part of your cycle.' }).success).toBe(true);
    expect(healthScoresBasisV1Schema.safeParse({ kind: 'cycle_phase', explanation: '' }).success).toBe(false);
    expect(healthScoresBasisV1Schema.safeParse({ kind: 'cycle_phase', explanation: 'x', phase: 'luteal' }).success).toBe(false);
    expect('basis' in healthScoresV1Schema.shape && healthScoresV1Schema.shape.basis.safeParse(undefined).success).toBe(true);
  });
});

it('declares its routes', () => {
  expect(appCycleRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
    'GET /app/v1/cycle/consents', 'POST /app/v1/cycle/consents', 'POST /app/v1/cycle/consents/withdraw', 'POST /app/v1/cycle/periods', 'GET /app/v1/cycle/status',
  ]);
});
