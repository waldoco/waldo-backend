import { describe, expect, it } from 'vitest';
import { HEALTH_SERIES_SIGNALS_V1, healthSeriesSignalV1Schema } from '../../contracts/src/app/health-ingest';
import { produceHealthScores } from '../src/health/producer';
import { computeDailyScores } from '../src/health/scores';
import type { DailyScoresInput, DayRecord } from '../src/health/scores/types';
import { hourlyPick, SERIES_READS, seriesOf } from '../src/health/signals';
import { GOLDEN_READ_AT, goldenReadingsOfDay, goldenSample, PRODUCER_NOW, syntheticAddDays } from './support/health-golden';

// A chart's value for a day is the number the scores consumed for that day: the same DayRecord, from the same readings, by the same
// code. These tests run the producer to capture the DayRecords its engine was handed, then ask the signal read for each signal over
// the readings the database would return for it (only that signal's stored set), and compare day by day. Synthetic values only.
const TARGET = '2026-03-20';
const day = (back: number) => syntheticAddDays(TARGET, -back);
type Sample = Record<string, unknown>;
const SLEEP_SPAN = (d: string) => ({ start_at: `${syntheticAddDays(d, -1)}T23:00:00.000Z`, end_at: `${d}T07:00:00.000Z` });
const wob = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;

// What one night adds to the golden readings: stages and a vital reading inside the night, an efficiency, and an hour of energy.
const night = (back: number): Sample[] => {
  const d = day(back);
  const stages = { light: 200 + back, deep: 80 + back, rem: 90 + back, unspecified: 0, awake: 20 + back };
  return [
    ...goldenReadingsOfDay(d, back).map(s => (s.signal === 'sleep_duration' ? { ...s, stages } : s)),
    goldenSample('sleep_efficiency', d, { ...SLEEP_SPAN(d), value: 0.8 + back / 1000 }),
    goldenSample('respiratory_rate', d, { start_at: `${d}T01:00:00.000Z`, end_at: `${d}T01:00:00.000Z`, value: 14 + wob(back, 0.5) }),
    goldenSample('spo2', d, { start_at: `${d}T02:00:00.000Z`, end_at: `${d}T02:00:00.000Z`, value: 96 + wob(back, 1) }),
    goldenSample('wrist_temperature', d, { start_at: `${d}T02:30:00.000Z`, end_at: `${d}T02:30:00.000Z`, value: 34 + wob(back, 0.3), method: 'absolute' }),
    goldenSample('walking_heart_rate_average', d, { start_at: `${d}T12:00:00.000Z`, end_at: `${d}T12:00:00.000Z`, value: 100 + wob(back, 3) }),
    ...[8, 9, 10, 11, 12, 13, 14, 15].map(h => goldenSample('active_energy_window', d, {
      start_at: `${d}T${String(h).padStart(2, '0')}:00:00.000Z`, end_at: `${d}T${String(h + 1).padStart(2, '0')}:00:00.000Z`, value: 30 + wob(h + back, 5),
    })),
  ];
};
const nights = (count: number, edit: (back: number, samples: Sample[]) => Sample[] = (_, samples) => samples): Sample[] =>
  Array.from({ length: count }, (_, back) => edit(back, night(back))).flat();

const answerOf = (samples: Sample[], over: Record<string, unknown> = {}, source = 'apple', truncated = false) => ({
  access: 'granted', read_at: GOLDEN_READ_AT, from: day(29), to: TARGET,
  sources: [{ source, consent_epoch: 3, truncated, samples }], ...over,
});
const storedFor = (signal: keyof typeof SERIES_READS, samples: Sample[]) => samples.filter(s => SERIES_READS[signal].stored.includes(String(s.signal)));

// The DayRecords the engine consumed for today, read the way the producer reads them.
const engineDays = async (samples: Sample[]): Promise<Map<string, DayRecord>> => {
  let seen: DailyScoresInput | null = null;
  const series = answerOf(samples);
  await produceHealthScores({
    readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
    writeContext: async () => ({ written: true }),
    compute: input => { seen = input; return computeDailyScores(input); },
  }, { now: PRODUCER_NOW, timezone: 'UTC' });
  return new Map(seen!.days.map(record => [record.day, record]));
};
const sum = (values: readonly (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

// What the engine consumed for each signal, written out from its DayRecord without the route's reducers.
const consumed: Readonly<Record<string, (record: DayRecord) => { value: number; method?: string } | null>> = {
  sleep_asleep: r => (r.sleep ? { value: r.sleep.asleepMinutes } : null),
  sleep_midpoint: r => (r.sleep ? { value: r.sleep.midpointMinute } : null),
  overnight_hrv: r => (r.overnightHrv[0] ? { value: r.overnightHrv[0].value, method: r.overnightHrv[0].method } : null),
  resting_heart_rate: r => (r.restingHeartRate[0] ? { value: r.restingHeartRate[0].value, method: r.restingHeartRate[0].method } : null),
  breathing_rate: r => (r.vitals?.breathingRate != null ? { value: r.vitals.breathingRate } : null),
  spo2: r => (r.vitals?.bloodOxygen != null ? { value: r.vitals.bloodOxygen } : null),
  awake_time: r => (r.vitals?.awakeMinutes != null ? { value: r.vitals.awakeMinutes } : null),
  walking_heart_rate: r => (r.vitals?.walkingHeartRate != null ? { value: r.vitals.walkingHeartRate } : null),
  wrist_temperature: r => (r.vitals?.wristTemperature[0] ? { value: r.vitals.wristTemperature[0].value, method: r.vitals.wristTemperature[0].method } : null),
  daylight: r => (r.hourly.length ? { value: sum(r.hourly.map(b => b.daylightMinutes)) } : null),
  movement: r => (r.hourly.length ? { value: sum(r.hourly.map(b => b.movementMinutes)) } : null),
  active_energy: r => (r.hourly.length ? { value: sum(r.hourly.map(b => b.activeEnergyKcal)) } : null),
};
const compared = async (signal: keyof typeof consumed & string, samples: Sample[], over: Record<string, unknown> = {}) => {
  const records = await engineDays(samples);
  const route = seriesOf(answerOf(storedFor(signal as never, samples), over), signal as never);
  if (route.kind !== 'series') throw new Error(`no series for ${signal}`);
  const expected = [...records.values()].filter(r => r.day >= route.from && r.day <= route.to).sort((a, b) => a.day.localeCompare(b.day))
    .flatMap(r => { const value = consumed[signal]!(r); return value ? [{ day: r.day, value: value.value, method: value.method ?? null }] : []; });
  return { route: route.days.map(({ day, value, method }) => ({ day, value, method })), expected };
};
const ENGINE_SIGNALS = Object.keys(consumed);

describe('a day\'s value is the number the scores consumed', () => {
  for (const signal of ENGINE_SIGNALS) {
    it(`${signal}: every day of a mature owner, from the readings the signal's own read returns`, async () => {
      const { route, expected } = await compared(signal, nights(25));
      expect(expected.length, 'the scenario has values to compare').toBeGreaterThan(20);
      expect(route).toEqual(expected);
    });
  }
  it('takes a night with no measured resting heart rate from its own heart-rate hours, as the engine did', async () => {
    const samples = nights(25, (back, rows) => (back === 3
      ? [...rows.filter(s => s.signal !== 'resting_heart_rate'), ...[0, 1, 2, 3, 4, 5].map(h => goldenSample('heart_rate_window', day(3), {
        start_at: `${day(3)}T0${h}:00:00.000Z`, end_at: `${day(3)}T0${h + 1}:00:00.000Z`, value: 50 + h,
      }))]
      : back === 4 ? rows.filter(s => s.signal !== 'resting_heart_rate') : rows));
    const { route, expected } = await compared('resting_heart_rate', samples);
    expect(expected.find(entry => entry.day === day(3))?.method).toBe('asleep_hours_low');
    expect(expected.some(entry => entry.day === day(4))).toBe(false);
    expect(route).toEqual(expected);
    // Without the heart-rate hours the day would read differently: the read needs them, which is why its stored set holds them.
    const without = seriesOf(answerOf(samples.filter(s => s.signal !== 'heart_rate_window' && SERIES_READS.resting_heart_rate.stored.includes(String(s.signal)))), 'resting_heart_rate');
    expect(without.kind === 'series' && without.days.some(entry => entry.day === day(3))).toBe(false);
  });
  it('leaves out a day whose hourly windows overlap, as the engine did, and the read needs every window to know it', async () => {
    const samples = nights(25, (back, rows) => (back === 5
      ? [...rows, goldenSample('heart_rate_window', day(5), { start_at: `${day(5)}T10:30:00.000Z`, end_at: `${day(5)}T11:30:00.000Z`, value: 70 })]
      : rows));
    for (const signal of ['daylight', 'movement', 'active_energy']) {
      const { route, expected } = await compared(signal, samples);
      expect(expected.some(entry => entry.day === day(5)), signal).toBe(false);
      expect(route, signal).toEqual(expected);
    }
    const onlyDaylight = seriesOf(answerOf(samples.filter(s => ['sleep_duration', 'daylight_duration'].includes(String(s.signal)))), 'daylight');
    expect(onlyDaylight.kind === 'series' && onlyDaylight.days.some(entry => entry.day === day(5))).toBe(true);
  });
  it('drops the oldest day of a read that reached its cap, as the producer does, for every signal', async () => {
    const samples = nights(25);
    for (const signal of ENGINE_SIGNALS) {
      const whole = (await compared(signal, samples)).route;
      const { route } = await compared(signal, samples, {});
      expect(route, signal).toEqual(whole);
      const cut = seriesOf(answerOf(storedFor(signal as never, samples), {}, 'apple', true), signal as never);
      const kept = cut.kind === 'series' ? cut.days.map(entry => entry.day) : [];
      expect(kept, signal).toEqual(whole.map(entry => entry.day).filter(d => d !== day(24)));
    }
  });
  it('chooses a day\'s source as the producer does: the one that slept, else the higher-ranked, and reads that source alone', async () => {
    const apple = nights(12);
    const oura = nights(12, (back, rows) => rows.map(s => (s.signal === 'sleep_duration' ? { ...s, value: 300 + back } : s))).filter(s => (s.day as string) <= day(3));
    const both = { ...answerOf([]), sources: [
      { source: 'oura', consent_epoch: 1, truncated: false, samples: oura }, { source: 'health_connect', consent_epoch: 3, truncated: false, samples: apple.filter(s => !(s.signal === 'sleep_duration' && (s.day as string) === day(6))) },
    ] };
    const route = seriesOf(both, 'sleep_asleep');
    if (route.kind !== 'series') throw new Error('series');
    const byDay = new Map(route.days.map(entry => [entry.day, entry]));
    expect(byDay.get(day(1))?.source).toBe('health_connect');
    expect(byDay.get(day(4))?.source).toBe('oura');
    expect(byDay.get(day(6))?.source).toBe('oura');
    expect(byDay.get(day(6))?.value).toBe(306);
    expect(byDay.get(day(4))?.value).toBe(304);
  });
  it('keeps only the days inside the window the database named, and the newest efficiency of a night', () => {
    const inside = seriesOf(answerOf(storedFor('sleep_asleep', nights(10)), { from: day(3), to: day(0) }), 'sleep_asleep');
    expect(inside.kind === 'series' && inside.days.map(entry => entry.day)).toEqual([day(3), day(2), day(1), day(0)]);
    const later = goldenSample('sleep_efficiency', day(0), { ...SLEEP_SPAN(day(0)), start_at: `${day(0)}T06:00:00.000Z`, value: 0.5 });
    const earlier = goldenSample('sleep_efficiency', day(0), { ...SLEEP_SPAN(day(0)), start_at: `${day(0)}T05:00:00.000Z`, value: 0.9 });
    const series = seriesOf(answerOf([...storedFor('sleep_efficiency', nights(1)).filter(s => s.signal !== 'sleep_efficiency'), earlier, later]), 'sleep_efficiency');
    expect(series.kind === 'series' && series.days.map(entry => entry.value)).toEqual([0.5]);
  });
});

describe('stages and efficiency, which no score consumes, come from the same night\'s reading', () => {
  it('serves the four stage minutes of the asleep reading and the newest efficiency, one value a day', () => {
    const route = (signal: 'sleep_light' | 'sleep_deep' | 'sleep_rem' | 'sleep_efficiency') => {
      const series = seriesOf(answerOf(storedFor(signal, nights(8))), signal);
      return series.kind === 'series' ? series.days.map(entry => entry.value) : [];
    };
    expect(route('sleep_light')).toEqual([207, 206, 205, 204, 203, 202, 201, 200]);
    expect(route('sleep_deep')).toEqual([87, 86, 85, 84, 83, 82, 81, 80]);
    expect(route('sleep_rem')).toEqual([97, 96, 95, 94, 93, 92, 91, 90]);
    expect(route('sleep_efficiency')).toEqual([0.807, 0.806, 0.805, 0.804, 0.803, 0.802, 0.801, 0.8]);
  });
  it('leaves a day out when its night carries no stage totals, never a zero', () => {
    const samples = nights(5, (back, rows) => (back === 2 ? rows.map(s => (s.signal === 'sleep_duration' ? { ...s, stages: undefined } : s)) : rows));
    const series = seriesOf(answerOf(storedFor('sleep_deep', samples)), 'sleep_deep');
    expect(series.kind === 'series' && series.days.map(entry => entry.day)).toEqual([day(4), day(3), day(1), day(0)]);
  });
});

describe('today\'s hours', () => {
  it('are the hours of the day the engine consumed, for a signal made of hourly windows', async () => {
    const samples = nights(25);
    const records = await engineDays(samples);
    for (const signal of ['daylight', 'movement', 'active_energy'] as const) {
      const series = seriesOf(answerOf(storedFor(signal, samples)), signal);
      const pick = hourlyPick[signal]!;
      expect(series.kind === 'series' && series.hours, signal).toEqual(records.get(TARGET)!.hourly.map(bucket => ({ at: bucket.startAt, value: pick(bucket) })));
    }
  });
  it('are not given for a nightly signal', () => {
    const series = seriesOf(answerOf(storedFor('overnight_hrv', nights(5))), 'overnight_hrv');
    expect(series.kind === 'series' && series.hours).toEqual([]);
  });
});

describe('what the database answers when there is nothing to chart', () => {
  it('says why, as a closed reason', () => {
    expect(seriesOf({ error: 'not_linked' }, 'sleep_asleep')).toEqual({ kind: 'unavailable', reason: 'not_linked' });
    expect(seriesOf({ access: 'consent_required', read_at: GOLDEN_READ_AT, from: day(6), to: TARGET, sources: [] }, 'sleep_asleep')).toEqual({ kind: 'unavailable', reason: 'consent_required' });
    expect(seriesOf({ access: 'consent_withdrawn', read_at: GOLDEN_READ_AT, from: day(6), to: TARGET, sources: [] }, 'sleep_asleep')).toEqual({ kind: 'unavailable', reason: 'consent_withdrawn' });
    expect(seriesOf(answerOf([]), 'sleep_asleep')).toEqual({ kind: 'unavailable', reason: 'no_readings' });
  });
  it('treats an answer of the wrong shape as a fault, never as an empty chart', () => {
    for (const bad of [null, 'x', [], {}, { access: 'granted' }, answerOf(nights(3), { from: 'yesterday' }), answerOf(nights(3), { to: 7 }), answerOf(nights(3), { sources: 'none' })]) {
      expect(seriesOf(bad, 'sleep_asleep').kind, JSON.stringify(bad)?.slice(0, 40)).toBe('failed');
    }
  });
  it('leaves out a reading that is not a finite number, and never reads it as a value', () => {
    const rows = nights(3).map(s => (s.signal === 'sleep_duration' && s.day === day(1) ? { ...s, value: 'many' } : s));
    const series = seriesOf(answerOf(storedFor('sleep_asleep', rows)), 'sleep_asleep');
    expect(series.kind === 'series' && series.days.map(entry => entry.day)).toEqual([day(2), day(0)]);
  });
});

describe('the signals the read serves', () => {
  it('are the contract\'s, each with a reduction and a stored set that holds sleep_duration, from the database\'s closed list', () => {
    const closed = ['sleep_duration', 'sleep_midpoint', 'sleep_efficiency', 'overnight_hrv', 'resting_heart_rate', 'heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration', 'active_energy_window', 'respiratory_rate', 'spo2', 'wrist_temperature', 'walking_heart_rate_average'];
    expect(Object.keys(SERIES_READS).sort()).toEqual([...healthSeriesSignalV1Schema.options].sort());
    for (const [signal, read] of Object.entries(SERIES_READS)) {
      expect(read.stored, signal).toContain('sleep_duration');
      expect(read.stored.length, signal).toBeLessThanOrEqual(8);
      for (const stored of read.stored) expect(closed, `${signal}: ${stored}`).toContain(stored);
    }
  });
  it('have hours exactly where the contract says a signal is made of hourly windows', () => {
    expect(Object.keys(hourlyPick).sort()).toEqual(Object.entries(HEALTH_SERIES_SIGNALS_V1).filter(([, signal]) => signal.hourly).map(([name]) => name).sort());
  });
});
