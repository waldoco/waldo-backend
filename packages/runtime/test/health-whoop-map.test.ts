import { describe, expect, it } from 'vitest';
import { healthIngestV1Schema, healthSampleV1Schema } from '../../contracts/src/app/health-ingest';
import { offsetMinutes, whoopDeletions, whoopNightSamples, whoopRecovery, whoopSleep, whoopWorkout, whoopWorkoutSamples } from '../src/health/providers/whoop-map';
import { recoveryRecord, sleepRecord, workoutRecord } from './fixtures/whoop-synthetic';

const night = (sleep: Record<string, unknown> = {}, recovery: Record<string, unknown> | null = {}) =>
  whoopNightSamples({ sleep: whoopSleep(sleepRecord(sleep))!, recovery: recovery === null ? null : whoopRecovery(recoveryRecord(recovery)) });
const bySignal = (samples: readonly { signal: string }[]) => Object.fromEntries(samples.map(s => [s.signal, s]));

describe('WHOOP night mapping', () => {
  it('maps a scored night and its recovery onto the shared signals, on the waking day in the record\'s own offset', () => {
    const samples = night();
    expect(samples.map(s => s.signal).sort()).toEqual(['overnight_hrv', 'resting_heart_rate', 'sleep_duration', 'sleep_efficiency', 'sleep_midpoint', 'spo2']);
    const s = bySignal(samples) as Record<string, any>;
    expect(s.sleep_duration).toMatchObject({ value: 430, unit: 'minutes', method: 'asleep_duration', day: '2026-10-20', utc_offset_minutes: 60, start_at: '2026-10-19T22:10:00.000Z', end_at: '2026-10-20T05:50:00.000Z', sample_id: 'whoop:3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01:sleep_duration' });
    // The night ran 23:10 to 06:50 local, so its midpoint is 03:00, minute 180.
    expect(s.sleep_midpoint.value).toBe(180);
    expect(s.sleep_efficiency.value).toBe(0.935);
    expect(s.overnight_hrv).toMatchObject({ value: 47.318, unit: 'milliseconds', method: 'rmssd' });
    expect(s.resting_heart_rate).toMatchObject({ value: 53, method: 'provider_resting_daily' });
    for (const sample of samples) expect(healthSampleV1Schema.safeParse(sample).success, sample.signal).toBe(true);
  });

  it('revises each reading by its own record\'s updated_at, so an older backfill page never beats a newer webhook fetch', () => {
    const s = bySignal(night({ updated_at: '2026-10-20T06:40:00.000Z' }, { updated_at: '2026-10-20T06:45:00.000Z' })) as Record<string, any>;
    expect(s.sleep_duration.revision).toBe(Date.parse('2026-10-20T06:40:00.000Z') / 1000);
    expect(s.overnight_hrv.revision).toBe(Date.parse('2026-10-20T06:45:00.000Z') / 1000);
    const older = bySignal(night({ updated_at: '2026-10-20T06:00:00.000Z' }, { updated_at: '2026-10-20T06:00:00.000Z' })) as Record<string, any>;
    expect(older.sleep_duration.revision).toBeLessThan(s.sleep_duration.revision);
    expect(older.overnight_hrv.revision).toBeLessThan(s.overnight_hrv.revision);
  });

  it('gives no reading at all for what WHOOP has not scored: unknown, never zero', () => {
    expect(night({ score_state: 'PENDING_SCORE', score: undefined }, null)).toEqual([]);
    expect(night({ score_state: 'UNSCORABLE' }, null)).toEqual([]);
    const pending = bySignal(night({}, { score_state: 'PENDING_SCORE', score: undefined }));
    expect(Object.keys(pending).sort()).toEqual(['sleep_duration', 'sleep_efficiency', 'sleep_midpoint']);
    const missingField = bySignal(night({}, { score: { resting_heart_rate: 53, spo2_percentage: null } }));
    expect(Object.keys(missingField)).not.toContain('overnight_hrv');
    const zeroed = night({}, { score: { resting_heart_rate: 0, hrv_rmssd_milli: 0, spo2_percentage: 0 } });
    expect(zeroed.map(s => s.signal)).not.toContain('overnight_hrv');
    expect(zeroed.map(s => s.signal)).not.toContain('resting_heart_rate');
    expect(zeroed.map(s => s.signal)).not.toContain('spo2');
  });

  it('leaves a nap, an unplaceable offset and a recovery that belongs to another sleep out', () => {
    expect(night({ nap: true })).toEqual([]);
    expect(night({ timezone_offset: 'EST' })).toEqual([]);
    expect(night({ end: '2026-10-19T20:00:00.000Z' })).toEqual([]);
    const other = bySignal(night({}, { sleep_id: '00000000-0000-4000-8000-000000000000' }));
    expect(Object.keys(other).sort()).toEqual(['sleep_duration', 'sleep_efficiency', 'sleep_midpoint']);
  });

  it('places the waking day by the record\'s own offset across a date line and an odd offset', () => {
    const east = bySignal(night({ start: '2026-10-19T17:00:00.000Z', end: '2026-10-20T01:00:00.000Z', timezone_offset: '+05:45' })) as Record<string, any>;
    expect(east.sleep_duration.day).toBe('2026-10-20');
    expect(east.sleep_duration.utc_offset_minutes).toBe(345);
    const west = bySignal(night({ start: '2026-10-20T03:00:00.000Z', end: '2026-10-20T10:00:00.000Z', timezone_offset: '-05:00' })) as Record<string, any>;
    expect(west.sleep_duration.day).toBe('2026-10-20');
    const late = bySignal(night({ start: '2026-10-20T20:00:00.000Z', end: '2026-10-21T03:00:00.000Z', timezone_offset: '-05:00' })) as Record<string, any>;
    expect(late.sleep_duration.day).toBe('2026-10-20');
    expect(late.sleep_midpoint.value).toBeGreaterThan(0);
  });

  it('keeps a batch of mapped samples inside the ingest contract', () => {
    const batch = { request_id: 'whoop-test-batch-01', source: 'whoop', consent_epoch: 1, timezone: 'Europe/Berlin', anchor_before: null, anchor_after: 'whoop-test-1', samples: night(), deletions: [] };
    expect(healthIngestV1Schema.safeParse(batch).success).toBe(true);
  });
});

describe('WHOOP workout mapping', () => {
  it('maps minutes from the record\'s span, energy only when scored, on the day it started', () => {
    const [sample] = whoopWorkoutSamples(whoopWorkout(workoutRecord())!);
    expect(sample).toMatchObject({ signal: 'workout', unit: 'minutes', activity: 'running', value: 50, day: '2026-10-20', energy_kcal: 400.1, sample_id: 'whoop:8d2e4b60-1c77-4f3a-9a52-6b0d3e8f1a22:workout' });
    expect(healthSampleV1Schema.safeParse(sample).success).toBe(true);
    const [unscored] = whoopWorkoutSamples(whoopWorkout(workoutRecord({ score_state: 'PENDING_SCORE', score: undefined }))!);
    expect(unscored).not.toHaveProperty('energy_kcal');
  });

  it('refuses a span that is empty, backwards or longer than a day, and a sport that is nothing once cleaned', () => {
    expect(whoopWorkoutSamples(whoopWorkout(workoutRecord({ end: '2026-10-20T11:00:00.000Z' }))!)).toEqual([]);
    expect(whoopWorkoutSamples(whoopWorkout(workoutRecord({ end: '2026-10-22T11:00:00.000Z' }))!)).toEqual([]);
    expect(whoopWorkoutSamples(whoopWorkout(workoutRecord({ sport_name: '***' }))!)).toEqual([]);
  });
});

describe('WHOOP record parsing and deletions', () => {
  it('reads only what has the shape the provider documents', () => {
    expect(whoopSleep(sleepRecord())).not.toBeNull();
    for (const bad of [null, [], {}, sleepRecord({ id: 5 }), sleepRecord({ start: 'yesterday' }), sleepRecord({ nap: 'no' }), sleepRecord({ score_state: 'MAYBE' }), sleepRecord({ cycle_id: '1' })]) expect(whoopSleep(bad), JSON.stringify(bad)).toBeNull();
    for (const bad of [null, recoveryRecord({ sleep_id: '../x' }), recoveryRecord({ updated_at: 7 })]) expect(whoopRecovery(bad)).toBeNull();
    for (const bad of [null, workoutRecord({ sport_name: 3 })]) expect(whoopWorkout(bad)).toBeNull();
    expect(whoopSleep(sleepRecord({ score: { stage_summary: { total_light_sleep_time_milli: 'x' } } }))?.score).toBeNull();
  });

  it('reads an offset as minutes and nothing that is not one', () => {
    expect([offsetMinutes('+05:30'), offsetMinutes('-05:00'), offsetMinutes('Z'), offsetMinutes('+14:00')]).toEqual([330, -300, 0, 840]);
    for (const bad of ['', '+5:30', '+15:00', '+05:75', 'UTC', '0530']) expect(offsetMinutes(bad), bad).toBeNull();
  });

  it('removes every reading a deleted record produced, at the time WHOOP said so', () => {
    expect(whoopDeletions('sleep', 'abc', 1_790_000_000).map(d => d.signal)).toEqual(['sleep_duration', 'sleep_midpoint', 'sleep_efficiency', 'overnight_hrv', 'resting_heart_rate', 'spo2']);
    expect(whoopDeletions('recovery', 'abc', 1_790_000_000).map(d => d.signal)).toEqual(['overnight_hrv', 'resting_heart_rate', 'spo2']);
    expect(whoopDeletions('workout', 'w1', 5)).toEqual([{ sample_id: 'whoop:w1:workout', signal: 'workout', revision: 5 }]);
    const batch = { request_id: 'whoop-test-delete-1', source: 'whoop', consent_epoch: 1, timezone: 'UTC', anchor_before: null, anchor_after: 'x', samples: [], deletions: whoopDeletions('sleep', '3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01', 1_790_000_000) };
    expect(healthIngestV1Schema.safeParse(batch).success).toBe(true);
  });
});
