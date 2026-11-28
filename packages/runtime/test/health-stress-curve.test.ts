import { describe, expect, it } from 'vitest';
import { STRESS_CURVE_VERSION, stressCurve } from '../src/health/scores/stress-curve';
import { shiftDay } from '../src/health/scores/time';
import type { DayRecord, HourlyBucket } from '../src/health/scores/types';

// stress-curve.candidate.v1 (ADR-0081 amendment of 2 Nov 2026, §6). Every value is synthetic. Golden numbers are worked by hand:
// an hour's value is 50 + 20 z for heart rate (z against the same wall-clock hour's own mean and population spread over the
// earlier days), 50 - 20 z for HRV on the ln scale, averaged when both exist.
const TODAY = '2026-03-10';
const NOW = `${TODAY}T15:30:00.000Z`;
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const bucket = (day: string, hour: number, over: Partial<HourlyBucket> = {}): HourlyBucket =>
  ({ startAt: at(day, hour), heartRate: 60, hrvReadings: [], daylightMinutes: null, movementMinutes: 2, activeEnergyKcal: null, ...over });
const record = (day: string, hourly: HourlyBucket[], over: Partial<DayRecord> = {}): DayRecord => ({
  day, timezone: 'UTC', sleep: { startAt: at(shiftDay(day, -1), 23), endAt: at(day, 7), asleepMinutes: 450, midpointMinute: 180 },
  overnightHrv: [], restingHeartRate: [], hourly, workouts: [], demand: null, ...over,
});
// Earlier days: heart rate 58 or 62 by turns at every awake hour (mean 60, spread 2); `n` days of them.
const earlier = (n: number, make: (day: string, i: number, hour: number) => Partial<HourlyBucket> = () => ({})): DayRecord[] =>
  Array.from({ length: n }, (_, i) => {
    const day = shiftDay(TODAY, -(i + 1));
    return record(day, Array.from({ length: 13 }, (_, h) => bucket(day, 8 + h, { heartRate: i % 2 === 0 ? 58 : 62, ...make(day, i, 8 + h) })));
  });
const run = (today: DayRecord, days: DayRecord[], asOf: string | null = NOW) => stressCurve({ targetDay: TODAY, days: [today, ...days], asOf });
const todayWith = (readings: Record<number, Partial<HourlyBucket>>, over: Partial<DayRecord> = {}) =>
  record(TODAY, Object.entries(readings).map(([hour, extra]) => bucket(TODAY, Number(hour), extra)), over);
const hourOf = (curve: ReturnType<typeof stressCurve>, hour: number) => curve?.hours.find(h => h.at === at(TODAY, hour));

describe('the hourly stress curve', () => {
  it('reads each hour in spreads from its own wall-clock hour on the owner\'s earlier days: 50 is usual, 20 points a spread, higher is more strain', () => {
    const curve = run(todayWith({ 10: { heartRate: 64 }, 11: { heartRate: 56 }, 12: { heartRate: 60 }, 13: { heartRate: 61 } }), earlier(8));
    expect(curve?.version).toBe(STRESS_CURVE_VERSION);
    expect(hourOf(curve, 10)).toEqual({ at: at(TODAY, 10), value: 90, band: 'high' });
    expect(hourOf(curve, 11)).toEqual({ at: at(TODAY, 11), value: 10, band: 'low' });
    expect(hourOf(curve, 12)).toEqual({ at: at(TODAY, 12), value: 50, band: 'medium' });
    expect(hourOf(curve, 13)).toEqual({ at: at(TODAY, 13), value: 60, band: 'medium' });
  });
  it('averages the heart-rate part with an HRV part on the ln scale, read against the hour\'s own method only', () => {
    // Earlier HRV at hour 13: e^3.9 and e^4.1 by turns, so the ln mean is 4.0 and the spread 0.1. Today e^4.2 is z = 2, so 50 - 40 = 10.
    const days = earlier(8, (_, i, hour) => (hour === 13 ? { hrvReadings: [{ value: Math.exp(i % 2 === 0 ? 3.9 : 4.1), method: 'rmssd' }] } : {}));
    const curve = run(todayWith({ 13: { heartRate: 62, hrvReadings: [{ value: Math.exp(4.2), method: 'rmssd' }] } }), days);
    // Heart rate 62 is z = 1, so 70; the mean of 70 and 10 is 40.
    expect(hourOf(curve, 13)).toEqual({ at: at(TODAY, 13), value: 40, band: 'medium' });
    const sdnnToday = run(todayWith({ 13: { heartRate: 62, hrvReadings: [{ value: Math.exp(4.2), method: 'sdnn' }] } }), days);
    expect(hourOf(sdnnToday, 13)).toMatchObject({ value: 70, band: 'high' });
  });
  it('needs seven same-hour days behind an hour, and says so for the hours that have fewer', () => {
    const days = earlier(8, (_, i, hour) => (hour === 11 && i >= 2 ? { heartRate: null } : {}));
    const curve = run(todayWith({ 10: { heartRate: 64 }, 11: { heartRate: 64 } }), days);
    expect(hourOf(curve, 10)).toMatchObject({ value: 90 });
    expect(hourOf(curve, 11)).toEqual({ at: at(TODAY, 11), value: null, band: null, reason: 'baseline_immature' });
    expect(run(todayWith({ 10: { heartRate: 64 } }), earlier(6))).toBeNull();
  });
  it('gives a null hour a reason: a workout, movement, or no reading, and never a zero', () => {
    const curve = run(
      todayWith({ 9: { heartRate: 64 }, 10: { heartRate: 64 }, 11: { heartRate: 64, movementMinutes: 10 }, 12: { heartRate: null }, 13: { heartRate: 64, movementMinutes: null } }, { workouts: [{ startAt: `${TODAY}T10:20:00.000Z`, endAt: `${TODAY}T10:50:00.000Z` }] }),
      earlier(8));
    expect(hourOf(curve, 10)).toEqual({ at: at(TODAY, 10), value: null, band: null, reason: 'workout' });
    expect(hourOf(curve, 11)).toMatchObject({ value: null, reason: 'moving' });
    expect(hourOf(curve, 12)).toMatchObject({ value: null, reason: 'no_reading' });
    expect(hourOf(curve, 13)).toMatchObject({ value: null, reason: 'no_reading' });
    expect(hourOf(curve, 9)).toMatchObject({ value: 90 });
  });
  it('counts only the resting hours of earlier days: a workout or a moving hour there is not that day\'s usual', () => {
    const moving = earlier(10, (_, i, hour) => (hour === 10 && i < 2 ? { movementMinutes: 30, heartRate: 150 } : {}));
    expect(hourOf(run(todayWith({ 10: { heartRate: 64 } }), moving), 10)).toMatchObject({ value: 90 });
    const withWorkout = earlier(10).map((day, i) => (i < 2 ? { ...day, workouts: [{ startAt: `${day.day}T10:00:00.000Z`, endAt: `${day.day}T11:00:00.000Z` }] } : day));
    expect(hourOf(run(todayWith({ 10: { heartRate: 64 } }), withWorkout), 10)).toMatchObject({ value: 90 });
    expect(hourOf(run(todayWith({ 10: { heartRate: 64 }, 11: { heartRate: 64 } }), earlier(8).map((day, i) => (i < 2 ? { ...day, workouts: [{ startAt: `${day.day}T10:00:00.000Z`, endAt: `${day.day}T11:00:00.000Z` }] } : day))), 11)).toMatchObject({ value: 90 });
  });
  it('lists only settled awake hours: from the wake, and not the hour still filling', () => {
    const curve = run(todayWith({ 6: { heartRate: 64 }, 7: { heartRate: 64 }, 8: { heartRate: 64 }, 14: { heartRate: 64 }, 15: { heartRate: 64 } }), earlier(8));
    expect(curve?.hours[0]?.at).toBe(at(TODAY, 7));
    expect(curve?.hours.at(-1)?.at).toBe(at(TODAY, 14));
    expect(hourOf(curve, 6)).toBeUndefined();
    expect(hourOf(curve, 15)).toBeUndefined();
    expect(hourOf(run(todayWith({ 14: { heartRate: 64 }, 15: { heartRate: 64 } }), earlier(8), `${TODAY}T16:00:00.000Z`), 15)).toMatchObject({ value: 90 });
  });
  it('starts at the first whole hour after a wake that is not on the hour', () => {
    const late = todayWith({ 8: { heartRate: 64 }, 9: { heartRate: 64 } }, { sleep: { startAt: at(shiftDay(TODAY, -1), 23), endAt: `${TODAY}T07:20:00.000Z`, asleepMinutes: 440, midpointMinute: 180 } });
    expect(run(late, earlier(8))?.hours[0]?.at).toBe(at(TODAY, 8));
  });
  it('does not run away on a flat history: a spread under the noise floor is read at the floor', () => {
    const flat = earlier(8).map(day => ({ ...day, hourly: day.hourly.map(b => ({ ...b, heartRate: 60 })) }));
    // The floor is half a beat, so one beat above is z = 2.
    expect(hourOf(run(todayWith({ 10: { heartRate: 61 }, 11: { heartRate: 200 } }), flat), 10)).toMatchObject({ value: 90 });
    expect(hourOf(run(todayWith({ 10: { heartRate: 61 }, 11: { heartRate: 200 } }), flat), 11)).toMatchObject({ value: 100, band: 'high' });
  });
  it('has no curve without a wake, with no hour that has a value, with an unknown zone, or with days that disagree', () => {
    expect(run(todayWith({ 10: { heartRate: 64 } }, { sleep: null }), earlier(8))).toBeNull();
    expect(run(todayWith({ 10: { heartRate: null } }), earlier(8))).toBeNull();
    expect(run(todayWith({ 10: { heartRate: 64 } }, { timezone: 'Mars/Base' }), earlier(8))).toBeNull();
    const first = earlier(8);
    expect(stressCurve({ targetDay: TODAY, days: [todayWith({ 10: { heartRate: 64 } }), ...first, { ...first[0]!, hourly: [] }], asOf: NOW })).toBeNull();
  });
  it('reads the same wall-clock hour across a clock change: the hour after the fall-back is not matched by its UTC hour', () => {
    // New York, 1 Nov 2026: the clocks go back at 02:00, so the day is 25 hours. 08:00 local is 13:00Z that day and 12:00Z on earlier days,
    // where 09:00 local (13:00Z) holds a very different heart rate: matching on the UTC hour would read 64 against 100.
    const zone = 'America/New_York';
    const day = '2026-11-01';
    const local = (d: string, hour: number, offset: string) => `${d}T${String(hour).padStart(2, '0')}:00:00${offset}`;
    const mk = (d: string, offset: string, heartRate: number, wakeHour = 6): DayRecord => ({
      day: d, timezone: zone,
      sleep: { startAt: new Date(Date.parse(local(d, wakeHour, offset)) - 8 * 3_600_000).toISOString(), endAt: new Date(Date.parse(local(d, wakeHour, offset))).toISOString(), asleepMinutes: 480, midpointMinute: 120 },
      overnightHrv: [], restingHeartRate: [], workouts: [], demand: null,
      hourly: [[8, heartRate], [9, 100]].map(([h, rate]) => ({ startAt: new Date(Date.parse(local(d, h!, offset))).toISOString(), heartRate: rate!, hrvReadings: [], daylightMinutes: null, movementMinutes: 2, activeEnergyKcal: null })),
    });
    const prior = Array.from({ length: 8 }, (_, i) => mk(shiftDay(day, -(i + 1)), '-04:00', i % 2 === 0 ? 58 : 62));
    const curve = stressCurve({ targetDay: day, days: [mk(day, '-05:00', 64), ...prior], asOf: '2026-11-01T16:00:00.000Z' });
    expect(curve?.hours.find(h => h.at === '2026-11-01T13:00:00.000Z')).toEqual({ at: '2026-11-01T13:00:00.000Z', value: 90, band: 'high' });
  });
});
