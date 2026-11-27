import { describe, expect, it } from 'vitest';
import { healthIngestV1Schema, healthSampleV1Schema } from '../../contracts/src/app/health-ingest';
import {
  offsetMinutes, whoopBody, whoopBodySamples, whoopCycle, whoopCycleSamples, whoopDeletions, whoopNapSamples, whoopNightSamples, whoopRecovery, whoopSleep, whoopWorkout, whoopWorkoutSamples, withoutProviderScores,
} from '../src/health/providers/whoop-map';
import { bodyRecord, cycleRecord, recoveryRecord, sleepRecord, workoutRecord } from './fixtures/whoop-synthetic';

const night = (sleep: Record<string, unknown> = {}, recovery: Record<string, unknown> | null = {}) =>
  whoopNightSamples({ sleep: whoopSleep(sleepRecord(sleep))!, recovery: recovery === null ? null : whoopRecovery(recoveryRecord(recovery)) });
const bySignal = (samples: readonly { signal: string }[]) => Object.fromEntries(samples.map(s => [s.signal, s]));

describe('WHOOP night mapping', () => {
  it('maps a scored night and its recovery onto the shared signals, on the waking day in the record\'s own offset', () => {
    const samples = night();
    expect(samples.map(s => s.signal).sort()).toEqual([
      'overnight_hrv', 'provider_recovery', 'provider_sleep_consistency', 'provider_sleep_need', 'provider_sleep_performance',
      'respiratory_rate', 'resting_heart_rate', 'skin_temperature', 'sleep_duration', 'sleep_efficiency', 'sleep_midpoint', 'spo2',
    ]);
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
    expect(Object.keys(pending).sort()).toEqual(['provider_sleep_consistency', 'provider_sleep_need', 'provider_sleep_performance', 'respiratory_rate', 'sleep_duration', 'sleep_efficiency', 'sleep_midpoint']);
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
    expect(Object.keys(other)).not.toContain('provider_recovery');
    expect(Object.keys(other)).not.toContain('overnight_hrv');
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
    expect(whoopDeletions('sleep', 'abc', 1_790_000_000).map(d => d.signal)).toEqual([
      'sleep_duration', 'sleep_midpoint', 'sleep_efficiency', 'respiratory_rate', 'provider_sleep_performance', 'provider_sleep_consistency', 'provider_sleep_need', 'nap',
      'overnight_hrv', 'resting_heart_rate', 'spo2', 'provider_recovery', 'skin_temperature',
    ]);
    expect(whoopDeletions('recovery', 'abc', 1_790_000_000).map(d => d.signal)).toEqual(['overnight_hrv', 'resting_heart_rate', 'spo2', 'provider_recovery', 'skin_temperature']);
    // Every reading the mapping makes from a night, a nap or a workout has a deletion that removes it.
    const made = [...night(), ...whoopNapSamples(whoopSleep(sleepRecord({ nap: true }))!), ...whoopWorkoutSamples(whoopWorkout(workoutRecord())!)].map(sample => sample.sample_id.replace(/^whoop:[^:]+:/, ''));
    const removed = [...whoopDeletions('sleep', 'x', 1), ...whoopDeletions('workout', 'x', 1)].map(deletion => deletion.signal);
    for (const signal of made) expect(removed, signal).toContain(signal);
    expect(whoopDeletions('workout', 'w1', 5)).toEqual([{ sample_id: 'whoop:w1:workout', signal: 'workout', revision: 5 }]);
    const batch = { request_id: 'whoop-test-delete-1', source: 'whoop', consent_epoch: 1, timezone: 'UTC', anchor_before: null, anchor_after: 'x', samples: [], deletions: whoopDeletions('sleep', '3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01', 1_790_000_000) };
    expect(healthIngestV1Schema.safeParse(batch).success).toBe(true);
  });
});

const ms = (minutes: number) => minutes * 60_000;
describe('WHOOP night: every field the sleep and recovery carry (health revision 16)', () => {
  it('maps stage totals, cycles and disturbances onto the time-asleep reading, labelled as totals', () => {
    const s = bySignal(night()) as Record<string, any>;
    expect(s.sleep_duration.stage_totals).toEqual({ method: 'provider_totals', light: 220, deep: 100, rem: 110, awake: 30, no_data: 0, in_bed: 460, sleep_cycles: 4, disturbances: 9 });
    expect(s.sleep_duration).not.toHaveProperty('stages');
  });
  it('leaves stage totals off, and keeps the time asleep, when a total is missing or the totals overrun the time in bed', () => {
    const stages = sleepRecord().score.stage_summary;
    for (const stage_summary of [{ ...stages, disturbance_count: undefined }, { ...stages, total_in_bed_time_milli: ms(100) }, { ...stages, sleep_cycle_count: 1.5 }]) {
      const s = bySignal(night({ score: { ...sleepRecord().score, stage_summary } })) as Record<string, any>;
      expect(s.sleep_duration.value).toBe(430);
      expect(s.sleep_duration).not.toHaveProperty('stage_totals');
      expect(healthSampleV1Schema.safeParse(s.sleep_duration).success).toBe(true);
    }
  });
  it('maps breathing rate, sleep performance and consistency, and the need with its parts', () => {
    const s = bySignal(night({ score: { ...sleepRecord().score, sleep_needed: { baseline_milli: ms(450), need_from_sleep_debt_milli: ms(35), need_from_recent_strain_milli: ms(20), need_from_recent_nap_milli: -ms(15) } } })) as Record<string, any>;
    expect(s.respiratory_rate).toMatchObject({ value: 15.2, unit: 'breaths_per_minute', day: '2026-10-20' });
    expect(s.provider_sleep_performance).toMatchObject({ value: 88, method: 'whoop' });
    expect(s.provider_sleep_consistency).toMatchObject({ value: 81, method: 'whoop' });
    expect(s.provider_sleep_need).toMatchObject({ value: 490, baseline_minutes: 450, debt_minutes: 35, strain_minutes: 20, nap_minutes: -15, method: 'whoop' });
    for (const sample of Object.values(s)) expect(healthSampleV1Schema.safeParse(sample).success, sample.signal).toBe(true);
  });
  it('gives no breathing rate, performance, consistency or need that is missing or off its scale', () => {
    const base = sleepRecord().score;
    const s = bySignal(night({ score: { ...base, respiratory_rate: 2, sleep_performance_percentage: null, sleep_consistency_percentage: 140, sleep_needed: { ...base.sleep_needed, need_from_recent_nap_milli: ms(10) } } }));
    for (const signal of ['respiratory_rate', 'provider_sleep_performance', 'provider_sleep_consistency', 'provider_sleep_need']) expect(Object.keys(s), signal).not.toContain(signal);
    const partless = bySignal(night({ score: { ...base, sleep_needed: { baseline_milli: ms(450) } } }));
    expect(Object.keys(partless)).not.toContain('provider_sleep_need');
  });
  it('maps WHOOP\'s recovery score with its calibrating flag, and the skin temperature as absolute degrees', () => {
    const s = bySignal(night({}, { score: { ...recoveryRecord().score, user_calibrating: true } })) as Record<string, any>;
    expect(s.provider_recovery).toMatchObject({ value: 61, calibrating: true, method: 'whoop', unit: 'percent', sample_id: 'whoop:3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01:provider_recovery' });
    expect(s.skin_temperature).toMatchObject({ value: 33.2, method: 'absolute', unit: 'celsius' });
  });
  it('gives no recovery score without its calibrating flag or off its scale, and no skin temperature off the body\'s scale (a 3.0 strap has none)', () => {
    for (const score of [{ ...recoveryRecord().score, user_calibrating: undefined }, { ...recoveryRecord().score, recovery_score: 140 }]) expect(Object.keys(bySignal(night({}, { score })))).not.toContain('provider_recovery');
    for (const skin_temp_celsius of [undefined, 92.1, 0]) expect(Object.keys(bySignal(night({}, { score: { ...recoveryRecord().score, skin_temp_celsius } })))).not.toContain('skin_temperature');
  });
  it('drops every WHOOP score, and a workout\'s strain, where the storage grant does not name them, and keeps the readings', () => {
    const kept = withoutProviderScores([...night(), ...whoopWorkoutSamples(whoopWorkout(workoutRecord())!)]);
    expect(kept.map(s => s.signal).filter(signal => signal.startsWith('provider_'))).toEqual([]);
    expect(kept.find(s => s.signal === 'workout')).not.toHaveProperty('strain');
    expect(kept.map(s => s.signal)).toEqual(expect.arrayContaining(['sleep_duration', 'respiratory_rate', 'skin_temperature', 'overnight_hrv', 'workout']));
  });
});

describe('WHOOP naps', () => {
  it('stores a nap as a nap on the day it started, never as the night', () => {
    const sleep = whoopSleep(sleepRecord({ nap: true, start: '2026-10-20T13:00:00.000Z', end: '2026-10-20T13:40:00.000Z', score: { ...sleepRecord().score, stage_summary: { ...sleepRecord().score.stage_summary, total_light_sleep_time_milli: ms(20), total_slow_wave_sleep_time_milli: ms(5), total_rem_sleep_time_milli: ms(3) } } }))!;
    expect(whoopNightSamples({ sleep, recovery: null })).toEqual([]);
    const [nap] = whoopNapSamples(sleep);
    expect(nap).toMatchObject({ signal: 'nap', method: 'asleep_duration', value: 28, day: '2026-10-20', sample_id: 'whoop:3f6c1a52-9b0e-4d7a-8c11-2a5e7d9b0c01:nap' });
    expect(healthSampleV1Schema.safeParse(nap).success).toBe(true);
  });
  it('gives an unscored nap its span, and no nap for a main sleep, a backwards span or an unplaceable offset', () => {
    const [unscored] = whoopNapSamples(whoopSleep(sleepRecord({ nap: true, start: '2026-10-20T13:00:00.000Z', end: '2026-10-20T13:40:00.000Z', score_state: 'PENDING_SCORE', score: undefined }))!);
    expect(unscored).toMatchObject({ method: 'span', value: 40 });
    expect(whoopNapSamples(whoopSleep(sleepRecord())!)).toEqual([]);
    expect(whoopNapSamples(whoopSleep(sleepRecord({ nap: true, end: '2026-10-19T20:00:00.000Z' }))!)).toEqual([]);
    expect(whoopNapSamples(whoopSleep(sleepRecord({ nap: true, timezone_offset: 'CET' }))!)).toEqual([]);
  });
});

describe('WHOOP workouts: every scored field', () => {
  const zoned = (over: Record<string, unknown> = {}) => workoutRecord({ score: {
    strain: 9.4, average_heart_rate: 141, max_heart_rate: 172, kilojoule: 1_674, percent_recorded: 96.5, distance_meter: 8_100, altitude_gain_meter: 54.2, altitude_change_meter: -3.1,
    zone_durations: { zone_zero_milli: 60_000, zone_one_milli: 240_000, zone_two_milli: 900_000, zone_three_milli: 1_200_000, zone_four_milli: 480_000, zone_five_milli: 120_000 }, ...over } });
  it('maps strain, heart rate, distance, altitude, recorded share and the five zones, zone zero folded into zone 1', () => {
    const [sample] = whoopWorkoutSamples(whoopWorkout(zoned())!);
    expect(sample).toMatchObject({
      avg_hr_bpm: 141, max_hr_bpm: 172, distance_m: 8_100, elevation_gain_m: 54.2, elevation_change_m: -3.1, percent_recorded: 96.5,
      strain: { value: 9.4, method: 'whoop' }, hr_zones: { basis: 'provider', lower_bounds_bpm: null, seconds: [300, 900, 1_200, 480, 120] },
    });
    expect(healthSampleV1Schema.safeParse(sample).success).toBe(true);
  });
  it('leaves off each part that is missing or impossible, and keeps the session', () => {
    const [sample] = whoopWorkoutSamples(whoopWorkout(zoned({ average_heart_rate: 190, strain: 25, percent_recorded: 140, distance_meter: -1, altitude_gain_meter: null, zone_durations: { zone_one_milli: 1 } }))!) as Record<string, any>[];
    for (const key of ['avg_hr_bpm', 'max_hr_bpm', 'strain', 'percent_recorded', 'distance_m', 'elevation_gain_m', 'hr_zones']) expect(sample, key).not.toHaveProperty(key);
    expect(sample!.value).toBe(50);
    const [overrun] = whoopWorkoutSamples(whoopWorkout(zoned({ zone_durations: { zone_zero_milli: 0, zone_one_milli: ms(60), zone_two_milli: 0, zone_three_milli: 0, zone_four_milli: 0, zone_five_milli: 0 } }))!);
    expect(overrun).not.toHaveProperty('hr_zones');
    expect(healthSampleV1Schema.safeParse(overrun).success).toBe(true);
  });
});

describe('WHOOP cycles: day strain', () => {
  it('maps a closed cycle\'s strain, energy, heart rate and steps on the waking day of the sleep that opens it', () => {
    const [sample] = whoopCycleSamples(whoopCycle(cycleRecord())!);
    expect(sample).toMatchObject({
      signal: 'provider_day_strain', method: 'whoop', unit: 'strain', value: 11.37, open: false, day: '2026-10-20', energy_kcal: 2_199.8, avg_hr_bpm: 68, max_hr_bpm: 172, step_count: 9_412,
      sample_id: 'whoop:cycle:810001:provider_day_strain', revision: Date.parse('2026-10-20T22:20:00.000Z') / 1000,
    });
    expect(healthSampleV1Schema.safeParse(sample).success).toBe(true);
  });
  it('maps the open cycle ending when WHOOP last scored it, so the same revision is always the same reading', () => {
    const open = whoopCycle(cycleRecord({ end: null, updated_at: '2026-10-20T09:30:00.000Z' }))!;
    const [sample] = whoopCycleSamples(open);
    expect(sample).toMatchObject({ open: true, end_at: '2026-10-20T09:30:00.000Z', day: '2026-10-20' });
    expect(whoopCycleSamples(open)).toEqual([sample]);
    // Moments after the night began, the cycle's only day so far is the one it started on.
    const [early] = whoopCycleSamples(whoopCycle(cycleRecord({ end: null, updated_at: '2026-10-19T22:40:00.000Z' }))!);
    expect(early).toMatchObject({ day: '2026-10-19', open: true });
    expect(healthSampleV1Schema.safeParse(early).success).toBe(true);
  });
  it('gives no strain for an unscored cycle, a strain off the scale, an unplaceable offset or a span that runs backwards; steps only when stated', () => {
    for (const over of [{ score_state: 'PENDING_SCORE', score: undefined }, { score: { strain: 22 } }, { timezone_offset: 'BST' }, { end: '2026-10-19T20:00:00.000Z' }]) {
      const cycle = whoopCycle(cycleRecord(over));
      expect(cycle ? whoopCycleSamples(cycle) : [], JSON.stringify(over)).toEqual([]);
    }
    const [stepless] = whoopCycleSamples(whoopCycle(cycleRecord({ step_count: null }))!);
    expect(stepless).not.toHaveProperty('step_count');
    for (const bad of [null, cycleRecord({ id: 'x' }), cycleRecord({ start: 'today' }), cycleRecord({ end: 'later' }), cycleRecord({ score_state: 'DONE' })]) expect(whoopCycle(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('WHOOP body measurements', () => {
  const at = Date.parse('2026-10-20T08:00:00.000Z');
  it('maps weight, height and WHOOP\'s maximum heart rate estimate as rolling readings revised at the read, on the owner\'s local day', () => {
    const samples = whoopBodySamples(whoopBody(bodyRecord())!, at, 'Asia/Kolkata');
    expect(bySignal(samples)).toMatchObject({
      body_mass: { value: 71.4, unit: 'kilograms', sample_id: 'whoop:body:body_mass', day: '2026-10-20', utc_offset_minutes: 330, revision: at / 1000 },
      height: { value: 1.762, unit: 'meters' }, max_heart_rate: { value: 189, method: 'provider_estimate' },
    });
    for (const sample of samples) expect(healthSampleV1Schema.safeParse(sample).success, sample.signal).toBe(true);
    expect(whoopBodySamples(whoopBody(bodyRecord())!, Date.parse('2026-10-20T20:00:00.000Z'), 'America/Los_Angeles')[0]).toMatchObject({ day: '2026-10-20', utc_offset_minutes: -420 });
  });
  it('leaves out a measurement in the wrong unit or missing', () => {
    expect(whoopBodySamples(whoopBody(bodyRecord({ height_meter: 176.2, weight_kilogram: null, max_heart_rate: 320 }))!, at, 'UTC')).toEqual([]);
    expect(whoopBody('x')).toBeNull();
  });
});
