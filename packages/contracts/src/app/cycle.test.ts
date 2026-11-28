import { describe, expect, it } from 'vitest';
import {
  appCycleRoutesV1, cycleConsentGrantV1Schema, cycleConsentWithdrawV1Schema, cycleIngestReceiptV1Schema, cycleIngestV1Schema, cycleStatusV1Schema, menstrualPeriodV1Schema,
} from './cycle';

// Synthetic dates.
const origin = {
  read_api: 'healthkit', source_bundle_id: 'com.example.cycle', source_package_name: null, source_version: null, source_revision: null, device_ref: null, recording_method: 'manual',
} as const;
const period = { signal: 'menstrual_period', start_date: '2026-10-08', end_date: '2026-10-12', origin, source_name: 'Example Cycle' } as const;
const requestId = '7b1e2f8a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const ingest = { request_id: requestId, expected_epoch: 1, source: 'apple', window_start: '2026-08-06', periods: [period] } as const;
const granted = { status: 'granted', epoch: 1, version: 1 } as const;

describe('cycle status, as the app parses it', () => {
  it('names the three states of the Cycle row with the consent, and never a phase', () => {
    expect(cycleStatusV1Schema.safeParse({ state: 'off', consent: { status: 'not_granted', epoch: 0, version: 1 } }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'off', consent: { status: 'withdrawn', epoch: 2, version: 1 } }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'waiting_for_data', consent: granted }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'active', consent: granted, last_period_start: '2026-10-08', last_source_name: 'Example Cycle' }).success).toBe(true);
    expect(cycleStatusV1Schema.safeParse({ state: 'active', consent: granted, last_period_start: '2026-10-08', last_source_name: null }).success).toBe(true);
    for (const bad of [
      { state: 'active', consent: granted, last_period_start: '2026-10-08' },
      { state: 'off', consent: granted },
      { state: 'waiting_for_data', consent: { status: 'withdrawn', epoch: 2, version: 1 } },
      { state: 'active', consent: granted, last_period_start: '2026-10-08', last_source_name: null, phase: 'luteal' },
      { state: 'off', consent: { status: 'not_granted', epoch: 0, version: 2 } },
      { state: 'active', consent: granted, last_period_start: '2026-10-08', last_source_name: 'x'.repeat(81) },
    ]) expect(cycleStatusV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe('cycle consent', () => {
  it('is a request id, the version and the epoch the app last read; nothing else', () => {
    expect(cycleConsentGrantV1Schema.safeParse({ request_id: requestId, version: 1, expected_epoch: 0 }).success).toBe(true);
    expect(cycleConsentWithdrawV1Schema.safeParse({ request_id: requestId, expected_epoch: 1 }).success).toBe(true);
    for (const bad of [
      { request_id: 'cycle-grant-0001', version: 1, expected_epoch: 0 },
      { request_id: requestId, version: 2, expected_epoch: 0 },
      { request_id: requestId, version: 1, expected_epoch: -1 },
      { request_id: requestId, version: 1, expected_epoch: 0, purpose: 'cycle_context' },
    ]) expect(cycleConsentGrantV1Schema.safeParse(bad).success).toBe(false);
    expect(cycleConsentWithdrawV1Schema.safeParse({ request_id: requestId, expected_epoch: 1, version: 1 }).success).toBe(false);
  });
});

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
    expect(cycleIngestReceiptV1Schema.safeParse({ request_id: requestId, replayed: false, accepted: 1, ignored: 0 }).success).toBe(true);
    expect(cycleIngestReceiptV1Schema.safeParse({ request_id: requestId, replayed: false, accepted: 1, ignored: 0, phase: 'luteal' }).success).toBe(false);
  });
});

it('declares the app routes under health, each consent route answering with the status', () => {
  expect(appCycleRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
    'GET /app/v1/health/cycle', 'POST /app/v1/health/cycle/consent', 'POST /app/v1/health/cycle/consent/withdraw', 'POST /app/v1/health/cycle/periods',
  ]);
  expect(appCycleRoutesV1.slice(0, 3).every(route => route.response === cycleStatusV1Schema)).toBe(true);
});
