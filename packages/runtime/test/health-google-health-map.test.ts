import { describe, expect, it } from 'vitest';
import { healthSampleV1Schema } from '../../contracts/src/app/health-ingest';
import {
  googleHealthBody, googleHealthBodySamples, googleHealthDaily, googleHealthExercise, googleHealthInterval, googleHealthNightSamples, googleHealthSleep,
  googleHealthWindowSamples, googleHealthWorkoutSamples, utcOffsetMinutes,
} from '../src/health/providers/google-health-map';

// Synthetic Google Health API v4 data points, shaped as the REST reference shows them. No real account, no real readings.
const FETCHED = 1_793_000_000;
const IST = '19800s';
const fitbit = { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' };
const sleepPoint = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  name: 'users/u1/dataTypes/sleep/dataPoints/s-0001', dataSource: fitbit,
  sleep: {
    interval: { startTime: '2026-11-05T17:30:00Z', startUtcOffset: IST, endTime: '2026-11-06T01:00:00Z', endUtcOffset: IST },
    type: 'STAGES', metadata: { mainSleep: true, nap: false, processed: true, ...meta },
    summary: { minutesInSleepPeriod: '450', minutesAsleep: '405', minutesAwake: '45' },
    updateTime: '2026-11-06T01:20:00Z', ...over,
  },
});
const daily = (field: string, body: Record<string, unknown>, date = { year: 2026, month: 11, day: 6 }) => ({ dataSource: fitbit, [field]: { date, ...body } });
const at = (sample: object) => healthSampleV1Schema.safeParse(sample).success;

describe('Google Health offsets', () => {
  it('reads a duration in seconds as whole minutes within a real zone, and nothing else', () => {
    expect([utcOffsetMinutes('19800s'), utcOffsetMinutes('-18000s'), utcOffsetMinutes('0s'), utcOffsetMinutes('20700.0s')]).toEqual([330, -300, 0, 345]);
    for (const bad of ['19830s', '19800', '+19800s', '60000s', '1.5s', '', 'abc']) expect(utcOffsetMinutes(bad), bad).toBeNull();
  });
});

describe('Google Health sleep', () => {
  it('maps the main sleep onto its waking day in its own offset: time asleep, efficiency and midpoint, revised by its update time', () => {
    const sleep = googleHealthSleep(sleepPoint())!;
    const samples = googleHealthNightSamples({ sleep, daily: [], fetchedAtSeconds: FETCHED });
    expect(samples.map(s => [s.sample_id, s.signal, s.value])).toEqual([
      ['google_health:sleep_duration:2026-11-06', 'sleep_duration', 405],
      ['google_health:sleep_midpoint:2026-11-06', 'sleep_midpoint', 165],
      ['google_health:sleep_efficiency:2026-11-06', 'sleep_efficiency', 0.9],
    ]);
    for (const s of samples) expect([s.day, s.utc_offset_minutes, s.revision, at(s)], s.sample_id).toEqual(['2026-11-06', 330, Date.parse('2026-11-06T01:20:00Z') / 1000, true]);
  });

  it('gives a nap, a sleep that is not the main one, or one whose summary is missing no sleep reading', () => {
    for (const point of [sleepPoint({}, { nap: true }), sleepPoint({}, { mainSleep: false }), sleepPoint({ summary: {} })]) {
      const sleep = googleHealthSleep(point);
      expect(sleep === null ? [] : googleHealthNightSamples({ sleep, daily: [], fetchedAtSeconds: FETCHED }).filter(s => s.signal.startsWith('sleep_'))).toEqual([]);
    }
  });

  it('refuses a sleep Google Health took from Apple Health or Health Connect, which Waldo reads itself, and a shape it cannot place', () => {
    for (const platform of ['HEALTH_KIT', 'HEALTH_CONNECT']) expect(googleHealthSleep({ ...sleepPoint(), dataSource: { platform } }), platform).toBeNull();
    for (const bad of [null, {}, { sleep: {} }, sleepPoint({ interval: { startTime: 'yesterday', startUtcOffset: IST, endTime: '2026-11-06T01:00:00Z', endUtcOffset: IST } }),
      sleepPoint({ interval: { startTime: '2026-11-06T01:00:00Z', startUtcOffset: IST, endTime: '2026-11-05T17:30:00Z', endUtcOffset: IST } }),
      sleepPoint({ interval: { startTime: '2026-11-05T17:30:00Z', startUtcOffset: IST, endTime: '2026-11-06T01:00:00Z', endUtcOffset: '19830s' } })]) {
      const sleep = googleHealthSleep(bad);
      expect(sleep === null || googleHealthNightSamples({ sleep, daily: [], fetchedAtSeconds: FETCHED }).length === 0, JSON.stringify(bad)).toBe(true);
    }
  });
});

describe('Google Health daily vitals', () => {
  const sleep = googleHealthSleep(sleepPoint())!;
  const vitals = [
    daily('dailyHeartRateVariability', { averageHeartRateVariabilityMilliseconds: 41.25 }),
    daily('dailyRestingHeartRate', { beatsPerMinute: '57' }),
    daily('dailyOxygenSaturation', { averagePercentage: 96.4, lowerBoundPercentage: 94, upperBoundPercentage: 98 }),
    daily('dailyRespiratoryRate', { breathsPerMinute: 14.6 }),
    daily('dailySleepTemperatureDerivations', { nightlyTemperatureCelsius: 34.1, baselineTemperatureCelsius: 34.3 }),
  ].map(googleHealthDaily);

  it('places each daily vital on that date\'s main sleep, HRV as RMSSD and skin temperature as an absolute reading, revised by the fetch', () => {
    const samples = googleHealthNightSamples({ sleep, daily: vitals.map(v => v!), fetchedAtSeconds: FETCHED }).filter(s => !s.signal.startsWith('sleep_'));
    expect(samples.map(s => [s.sample_id, s.signal, s.value, 'method' in s ? s.method : null])).toEqual([
      ['google_health:overnight_hrv:2026-11-06', 'overnight_hrv', 41.25, 'rmssd'],
      ['google_health:resting_heart_rate:2026-11-06', 'resting_heart_rate', 57, 'provider_resting_daily'],
      ['google_health:spo2:2026-11-06', 'spo2', 96.4, null],
      ['google_health:respiratory_rate:2026-11-06', 'respiratory_rate', 14.6, null],
      ['google_health:wrist_temperature:2026-11-06', 'wrist_temperature', 34.1, 'absolute'],
    ]);
    for (const s of samples) expect([s.start_at, s.end_at, s.revision, at(s)], s.sample_id).toEqual(['2026-11-05T17:30:00Z', '2026-11-06T01:00:00Z', FETCHED, true]);
  });

  it('places nothing from another date, and nothing for a value out of range or missing', () => {
    const other = googleHealthDaily(daily('dailyHeartRateVariability', { averageHeartRateVariabilityMilliseconds: 41 }, { year: 2026, month: 11, day: 5 }))!;
    expect(googleHealthNightSamples({ sleep, daily: [other], fetchedAtSeconds: FETCHED }).filter(s => s.signal === 'overnight_hrv')).toEqual([]);
    for (const bad of [daily('dailyHeartRateVariability', { entropy: 2.1 }), daily('dailyHeartRateVariability', { averageHeartRateVariabilityMilliseconds: 0 }),
      daily('dailyRestingHeartRate', { beatsPerMinute: 'fast' }), daily('dailyOxygenSaturation', { averagePercentage: 30 }),
      daily('dailyRespiratoryRate', {}), daily('dailyHeartRateVariability', { averageHeartRateVariabilityMilliseconds: 41 }, { year: 2026, month: 13, day: 1 })]) {
      const parsed = googleHealthDaily(bad);
      expect(parsed === null ? [] : googleHealthNightSamples({ sleep, daily: [parsed], fetchedAtSeconds: FETCHED }).filter(s => !s.signal.startsWith('sleep_')), JSON.stringify(bad)).toEqual([]);
    }
    expect(googleHealthDaily({ ...daily('dailyRespiratoryRate', { breathsPerMinute: 14 }), dataSource: { platform: 'HEALTH_KIT' } })).toBeNull();
  });
});

describe('Google Health workouts and body readings', () => {
  const exercise = (over: Record<string, unknown> = {}) => ({
    name: 'users/u1/dataTypes/exercise/dataPoints/x-0042', dataSource: fitbit,
    exercise: { interval: { startTime: '2026-11-06T12:00:00Z', startUtcOffset: IST, endTime: '2026-11-06T12:45:00Z', endUtcOffset: IST },
      exerciseType: 'FUNCTIONAL_STRENGTH_TRAINING', displayName: 'Strength', metricsSummary: { caloriesKcal: 310.4 }, updateTime: '2026-11-06T13:00:00Z', ...over },
  });

  it('maps a workout by its type, never its free-text name, with its calories and on the day it started', () => {
    const samples = googleHealthWorkoutSamples(googleHealthExercise(exercise())!);
    expect(samples).toEqual([{ day: '2026-11-06', utc_offset_minutes: 330, start_at: '2026-11-06T12:00:00Z', end_at: '2026-11-06T12:45:00Z', sample_id: 'google_health:x-0042:workout',
      revision: Date.parse('2026-11-06T13:00:00Z') / 1000, signal: 'workout', unit: 'minutes', activity: 'functional strength training', value: 45, energy_kcal: 310.4 }]);
    expect(at(samples[0]!)).toBe(true);
    const other = googleHealthWorkoutSamples(googleHealthExercise(exercise({ exerciseType: 'OTHER', displayName: 'My secret routine' }))!)[0]!;
    expect(other.signal === 'workout' ? other.activity : null).toBe('other');
    expect('energy_kcal' in googleHealthWorkoutSamples(googleHealthExercise(exercise({ metricsSummary: {} }))!)[0]!).toBe(false);
    expect(googleHealthExercise({ ...exercise(), dataSource: { platform: 'HEALTH_CONNECT' } })).toBeNull();
    expect(googleHealthExercise(exercise({ exerciseType: 7 }))).toBeNull();
  });

  it('maps weight in kilograms and body fat as point readings, and nothing outside the ranges Waldo stores', () => {
    const weight = googleHealthBody({ dataSource: fitbit, weight: { sampleTime: { physicalTime: '2026-11-06T02:30:00Z', utcOffset: IST }, weightGrams: 71250 } })!;
    const fat = googleHealthBody({ dataSource: fitbit, bodyFat: { sampleTime: { physicalTime: '2026-11-06T02:30:00Z', utcOffset: IST }, percentage: 18.2 } })!;
    const samples = [...googleHealthBodySamples(weight, FETCHED), ...googleHealthBodySamples(fat, FETCHED)];
    expect(samples.map(s => [s.sample_id, s.signal, s.value, s.day, s.start_at === s.end_at, s.revision])).toEqual([
      ['google_health:body_mass:2026-11-06T02:30:00Z', 'body_mass', 71.25, '2026-11-06', true, FETCHED],
      ['google_health:body_fat_percentage:2026-11-06T02:30:00Z', 'body_fat_percentage', 18.2, '2026-11-06', true, FETCHED],
    ]);
    for (const s of samples) expect(at(s), s.sample_id).toBe(true);
    expect(googleHealthBodySamples(googleHealthBody({ dataSource: fitbit, weight: { sampleTime: { physicalTime: '2026-11-06T02:30:00Z', utcOffset: IST }, weightGrams: 9000 } })!, FETCHED)).toEqual([]);
    expect(googleHealthBody({ dataSource: fitbit, weight: { sampleTime: { physicalTime: 'today', utcOffset: IST }, weightGrams: 71250 } })).toBeNull();
  });
});

describe('Google Health hourly windows', () => {
  const minute = (field: 'steps' | 'activeEnergyBurned', startTime: string, endTime: string, body: Record<string, unknown>, source = fitbit) =>
    ({ dataSource: source, [field]: { interval: { startTime, startUtcOffset: IST, endTime, endUtcOffset: IST }, ...body } });

  it('sums listed points into local-hour windows in the owner\'s offset, revised by the fetch', () => {
    const steps = [minute('steps', '2026-11-06T03:30:00Z', '2026-11-06T03:31:00Z', { count: '500' }), minute('steps', '2026-11-06T04:29:00Z', '2026-11-06T04:30:00Z', { count: '312' }),
      minute('steps', '2026-11-06T04:30:00Z', '2026-11-06T04:31:00Z', { count: '40' })].map(r => googleHealthInterval('steps', r)!);
    const out = googleHealthWindowSamples('steps', steps, 330, FETCHED);
    expect(out.map(s => [s.sample_id, s.start_at, s.end_at, s.value, s.day])).toEqual([
      ['google_health:steps_window:2026-11-06T03:30:00Z', '2026-11-06T03:30:00Z', '2026-11-06T04:30:00Z', 812, '2026-11-06'],
      ['google_health:steps_window:2026-11-06T04:30:00Z', '2026-11-06T04:30:00Z', '2026-11-06T05:30:00Z', 40, '2026-11-06'],
    ]);
    const energy = googleHealthWindowSamples('active_energy', [googleHealthInterval('active_energy', minute('activeEnergyBurned', '2026-11-06T03:30:00Z', '2026-11-06T03:31:00Z', { kcal: 1.25 }))!,
      googleHealthInterval('active_energy', minute('activeEnergyBurned', '2026-11-06T03:31:00Z', '2026-11-06T03:32:00Z', { kcal: 2 }))!], 330, FETCHED);
    expect(energy.map(s => [s.signal, s.value])).toEqual([['active_energy_window', 3.3]]);
    for (const s of [...out, ...energy]) expect([s.revision, at(s)], s.sample_id).toEqual([FETCHED, true]);
  });

  it('drops an hour a point crosses rather than splitting it, and refuses imported or malformed points', () => {
    const crossing = [minute('steps', '2026-11-06T04:40:00Z', '2026-11-06T04:41:00Z', { count: '30' }), minute('steps', '2026-11-06T05:29:00Z', '2026-11-06T05:31:00Z', { count: '20' })]
      .map(r => googleHealthInterval('steps', r)!);
    expect(googleHealthWindowSamples('steps', crossing, 330, FETCHED)).toEqual([]);
    expect(googleHealthInterval('steps', minute('steps', '2026-11-06T03:30:00Z', '2026-11-06T03:31:00Z', { count: '5' }, { platform: 'HEALTH_KIT', recordingMethod: 'PASSIVELY_MEASURED' }))).toBeNull();
    expect(googleHealthInterval('steps', minute('steps', '2026-11-06T03:30:00Z', '2026-11-06T03:31:00Z', { count: '-4' }))).toBeNull();
    expect(googleHealthInterval('steps', minute('steps', '2026-11-06T03:31:00Z', '2026-11-06T03:30:00Z', { count: '4' }))).toBeNull();
    expect(googleHealthInterval('active_energy', minute('steps', '2026-11-06T03:30:00Z', '2026-11-06T03:31:00Z', { count: '4' }))).toBeNull();
  });
});
