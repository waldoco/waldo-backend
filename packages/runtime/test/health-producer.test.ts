import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromRowZone } from '../../contracts/src/health/zone-bridge';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { computeDailyScores } from '../src/health/scores';
import type { DailyScores, DailyScoresInput } from '../src/health/scores/types';
import { formZone, recoveryZone } from '../src/health/scores/zones';
import realSeries from './fixtures/health-series-read.json';

const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
const SCORED_WINDOW_SIGNALS = ['heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration'];

type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample = {}): Sample =>
  ({ signal, day, start_at: `${day}T08:00:00.000Z`, end_at: `${day}T09:00:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });

// One local day of everything the phone uploads for sleep, recovery and the daytime hours.
const dayOfReadings = (day: string, i: number, over: { hrvMethod?: string; sleepMethod?: string; zone?: string } = {}): Sample[] => [
  sample('sleep_duration', day, { start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T07:00:00.000Z`, value: 450 + wobble(i, 20), method: over.sleepMethod ?? 'asleep_duration', timezone: over.zone ?? 'UTC' }),
  sample('sleep_midpoint', day, { start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T07:00:00.000Z`, value: 180 + wobble(i, 15), method: 'sleep_midpoint', timezone: over.zone ?? 'UTC' }),
  sample('overnight_hrv', day, { start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T07:00:00.000Z`, value: 55 + wobble(i, 6), method: over.hrvMethod ?? 'rmssd', timezone: over.zone ?? 'UTC' }),
  sample('resting_heart_rate', day, { start_at: `${day}T03:00:00.000Z`, end_at: `${day}T04:00:00.000Z`, value: 56 + wobble(i, 2), timezone: over.zone ?? 'UTC' }),
  ...[8, 9, 10, 11, 12, 13, 14, 15].flatMap(h => {
    const start_at = `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
    const end_at = `${day}T${String(h + 1).padStart(2, '0')}:00:00.000Z`;
    return [
      sample('heart_rate_window', day, { start_at, end_at, value: 72 + wobble(h + i, 2), min: 60, max: 90, n_samples: 20 }),
      sample('hrv_window', day, { start_at, end_at, value: 50 + wobble(h + i, 4), method: 'rmssd' }),
      sample('daylight_duration', day, { start_at, end_at, value: 20 }),
      sample('movement_duration', day, { start_at, end_at, value: 12 }),
    ];
  }),
];

const history = (nights: number, over: Parameters<typeof dayOfReadings>[2] = {}): Sample[] =>
  Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, over)).flat();

const seriesOf = (samples: Sample[], over: { source?: string; epoch?: number; truncated?: boolean; access?: string } = {}) => ({
  access: over.access ?? 'granted', read_at: READ_AT,
  sources: over.access && over.access !== 'granted' ? [] : [{ source: over.source ?? 'apple', consent_epoch: over.epoch ?? 3, truncated: over.truncated ?? false, samples }],
});

type Harness = { deps: ProducerDeps; writes: Record<string, unknown>[]; reads: Record<string, unknown>[]; inputs: DailyScoresInput[] };
// Like waldo.health_series_read, the fake returns only the signals it was asked for.
const askedFor = (series: unknown, signals: readonly string[]): unknown => {
  const body = series as { sources?: unknown } | null;
  if (!body || typeof body !== 'object' || !Array.isArray(body.sources)) return series;
  return { ...body, sources: body.sources.map(source => ({ ...source, samples: (source as { samples: Sample[] }).samples.filter(entry => !entry || signals.includes(String(entry.signal))) })) };
};
const harness = (series: unknown, writeResult: unknown = { written: true }, compute = computeDailyScores, extra: Partial<ProducerDeps> = {}): Harness => {
  const h: Harness = { writes: [], reads: [], inputs: [], deps: null as never };
  h.deps = {
    readSeries: async range => { h.reads.push(range); return askedFor(series, range.signals); },
    writeContext: async payload => { h.writes.push(JSON.parse(payload)); return writeResult; },
    compute: input => { h.inputs.push(input); return compute(input); },
    ...extra,
  };
  return h;
};
const run = (h: Harness, timezone = 'UTC') => produceHealthScores(h.deps, { now: NOW, timezone });
const busyMonth = (partial: (i: number) => boolean = () => false) =>
  Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: Math.round(240 + wobble(i, 40)), partial: partial(i) }));
const demandLogs = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.flatMap(([line]) => { try { const parsed = JSON.parse(String(line)); return parsed.hop === 'weight_demand' ? [parsed] : []; } catch { return []; } });
afterEach(() => vi.restoreAllMocks());

describe('produceHealthScores', () => {
  it('reads thirty days back from the owner\'s local today and writes today and yesterday', async () => {
    const h = harness(seriesOf(history(25)));
    expect(await run(h)).toBe('written');
    // The scores' signals, and beside them the night's vital signals, which can be dense, in a read of their own.
    expect(h.reads).toEqual([
      { from: addDays(TODAY, -30), to: TODAY, signals: expect.arrayContaining(['sleep_duration', 'overnight_hrv', 'workout', 'active_energy_window']) },
      { from: addDays(TODAY, -30), to: TODAY, signals: ['respiratory_rate', 'spo2', 'wrist_temperature', 'walking_heart_rate_average'] },
    ]);
    expect(h.reads[0]!.signals).not.toContain('steps_window');
    expect(h.writes.map(w => w.day).sort()).toEqual([addDays(TODAY, -1), TODAY]);
  });

  it('cuts the window by the owner\'s own clock, not UTC', async () => {
    const h = harness(seriesOf(history(25)));
    await produceHealthScores(h.deps, { now: Date.parse('2026-03-20T23:30:00Z'), timezone: 'Asia/Kolkata' });
    expect(h.reads[0]).toMatchObject({ from: addDays('2026-03-21', -30), to: '2026-03-21' });
  });

  it('writes a computed Recovery with its coverage, its zone word in the stored vocabulary and the read it came from', async () => {
    const h = harness(seriesOf(history(25)));
    await run(h);
    const row = h.writes.find(w => w.day === TODAY)!;
    const recovery = row.recovery as Record<string, unknown>;
    expect(typeof recovery.score).toBe('number');
    expect(recovery.activation).toBe('candidate_unaccepted');
    expect(recovery.confidence).toBeGreaterThan(0);
    expect(recovery.confidence).toBeLessThanOrEqual(1);
    expect(fromRowZone('recovery', recovery.zone)).not.toBeNull();
    expect(row.read_at).toBe(READ_AT);
    expect(row.timezone).toBe('UTC');
    expect(row.basis).toEqual([{ source: 'apple', consent_epoch: 3 }]);
    expect(row.freshness).toBe('fresh');
  });

  it('computes Weight from the calendar\'s busy minutes and the day\'s physical load', async () => {
    const asked: unknown[] = [];
    const busy = Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: Math.round(240 + wobble(i, 40)) }));
    const h = harness(seriesOf(history(25)), undefined, undefined, { readDemand: async range => { asked.push(range); return { state: 'available', days: busy }; } });
    await run(h);
    expect(asked).toEqual([{ from: addDays(TODAY, -30), to: TODAY, timezone: 'UTC' }]);
    const today = h.inputs.find(input => input.targetDay === TODAY)!.days.find(d => d.day === TODAY)!;
    expect(today.demand).toEqual({ meetingMinutes: busy[0]!.busy_minutes, messageCount: null, openTaskMinutes: null, physicalLoad: 96 });
    const weight = h.writes.find(w => w.day === TODAY)!.weight as Record<string, unknown>;
    expect(typeof weight.score).toBe('number');
    expect(weight.confidence).toBe(0.55);
    expect(weight.activation).toBe('candidate_unaccepted');
  });

  it('leaves Weight unavailable, and still writes Recovery and Form, when the calendar cannot be read', async () => {
    const cases: [string, ProducerDeps['readDemand'], string[]][] = [
      ['failed', async () => { throw new Error('do down'); }, ['demand_failed']],
      ['unavailable', async () => ({ state: 'unavailable', reason: 'not_connected' }), []],
      ['out of range', async () => ({ state: 'available', days: [{ day: TODAY, busy_minutes: -5 }, { day: addDays(TODAY, -1), busy_minutes: 5000 }] }), []],
    ];
    for (const [label, readDemand, codes] of cases) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness(seriesOf(history(25)), undefined, undefined, { readDemand });
      expect(await run(h)).toBe('written');
      const row = h.writes.find(w => w.day === TODAY)!;
      expect([label, row.weight]).toEqual([label, { reason: 'calendar_demand_unavailable' }]);
      expect(typeof (row.recovery as Record<string, unknown>).score).toBe('number');
      expect([label, demandLogs(log)]).toEqual([label, codes.map(code => ({ hop: 'weight_demand', ok: false, code }))]);
      log.mockRestore();
    }
  });

  it('starts the calendar read beside the series read, and writes Recovery and Form without waiting past the grace', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const order: string[] = [];
    let settled = false;
    const h = harness(seriesOf(history(25)), undefined, undefined, {
      demandGraceMs: 10,
      readDemand: () => { order.push('demand'); return new Promise(resolve => setTimeout(() => { settled = true; resolve({ state: 'available', days: busyMonth() }); }, 80)); },
    });
    const { readSeries, writeContext } = h.deps;
    h.deps = { ...h.deps, readSeries: range => { order.push('series'); return readSeries(range); }, writeContext: payload => { order.push(settled ? 'write after demand' : 'write'); return writeContext(payload); } };
    expect(await run(h)).toBe('written');
    expect(order).toEqual(['demand', 'series', 'series', 'write', 'write']);
    expect(h.writes.find(w => w.day === TODAY)!.weight).toEqual({ reason: 'calendar_demand_unavailable' });
    expect(typeof (h.writes.find(w => w.day === TODAY)!.form as Record<string, unknown>).score).toBe('number');
    expect(demandLogs(log)).toEqual([{ hop: 'weight_demand', ok: false, code: 'demand_late' }]);
    // The late read still runs to the end, so the owner object can cache it for the next upload.
    expect(settled).toBe(true);
  });

  it('tags a day whose Weight was read without a calendar Google reported gone', async () => {
    const tagsAfter = async (calendarDays: number) => {
      const h = harness(seriesOf(history(25)), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busyMonth(i => i === 0).slice(0, calendarDays) }) });
      await run(h);
      return Object.fromEntries(h.writes.map(w => [w.day, w.tags]));
    };
    expect(await tagsAfter(31)).toEqual({ [TODAY]: ['calendar_partial'], [addDays(TODAY, -1)]: [] });
    // No Weight was shown, so there is nothing for the tag to qualify.
    expect((await tagsAfter(3))[TODAY]).toEqual([]);
  });

  it('counts a workout toward physical load only in hours movement did not already cover', async () => {
    const workout = (start: string, end: string) => sample('workout', TODAY, { start_at: `${TODAY}T${start}:00.000Z`, end_at: `${TODAY}T${end}:00.000Z`, value: 60, activity: 'run' });
    const h = harness(seriesOf([...history(25), workout('06:00', '07:00'), workout('09:00', '09:30')]), undefined, undefined, { readDemand: async () => ({ state: 'available', days: [] }) });
    await run(h);
    const today = h.inputs.find(input => input.targetDay === TODAY)!.days.find(d => d.day === TODAY)!;
    // 8 hours x 12 movement minutes, plus the 06:00 workout; the 09:00 one falls in an hour movement already counts.
    expect(today.demand?.physicalLoad).toBe(96 + 60);
  });

  it('takes the calendar baseline from every day the calendar reports, not only days with health readings', async () => {
    const busy = Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: Math.round(240 + wobble(i, 40)) }));
    const h = harness(seriesOf(history(3)), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busy }) });
    await run(h);
    const weight = h.writes.find(w => w.day === TODAY)!.weight as Record<string, unknown>;
    expect(typeof weight.score).toBe('number');
    expect(weight.confidence).toBe(0.35);
  });

  it('writes Weight for a day the phone sent nothing for yet, and leaves its other pillars to reasons', async () => {
    const samples = history(25).filter(r => r.day !== TODAY);
    const h = harness(seriesOf(samples), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busyMonth() }) });
    await run(h);
    const row = h.writes.find(w => w.day === TODAY)!;
    expect(typeof (row.weight as Record<string, unknown>).score).toBe('number');
    expect(row.recovery).toEqual({ reason: expect.any(String) });
    expect(row.form).toEqual({ reason: expect.any(String) });
    expect(h.inputs.find(input => input.targetDay === TODAY)!.days.find(d => d.day === TODAY)).toMatchObject({ timezone: 'UTC', sleep: null, hourly: [], workouts: [], demand: { physicalLoad: null } });
  });

  it('leaves Recovery and Form as they were when the calendar adds days the phone sent nothing for', async () => {
    const samples = history(25).filter(r => ![addDays(TODAY, -2), addDays(TODAY, -5), addDays(TODAY, -9)].includes(r.day as string));
    const pillars = async (readDemand?: ProducerDeps['readDemand']) => {
      const h = harness(seriesOf(samples), undefined, undefined, readDemand ? { readDemand } : {});
      await run(h);
      return h.writes.map(w => ({ day: w.day, recovery: w.recovery, form: w.form }));
    };
    expect(await pillars(async () => ({ state: 'available', days: busyMonth() }))).toEqual(await pillars());
  });

  it('writes no row for a day with no readings when the calendar gives Weight too little to score', async () => {
    const h = harness(seriesOf(history(25).filter(r => r.day !== TODAY)), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busyMonth().slice(0, 1) }) });
    await run(h);
    expect(h.writes.map(w => w.day)).toEqual([addDays(TODAY, -1)]);
  });

  it('leaves physical load unknown on a day with no movement reading and no workout, even with heart-rate hours', async () => {
    const cases = {
      sleepOnly: history(25).filter(r => r.day !== TODAY || ['sleep_duration', 'sleep_midpoint', 'overnight_hrv'].includes(r.signal as string)),
      heartRateHours: history(25).filter(r => r.day !== TODAY || r.signal !== 'movement_duration'),
    };
    for (const [label, samples] of Object.entries(cases)) {
      const h = harness(seriesOf(samples), undefined, undefined, { readDemand: async () => ({ state: 'available', days: [] }) });
      await run(h);
      expect([label, h.inputs.find(input => input.targetDay === TODAY)!.days.find(d => d.day === TODAY)!.demand?.physicalLoad]).toEqual([label, null]);
    }
  });

  it('writes only keys the database accepts, and every pillar is either a score or a reason', async () => {
    const h = harness(seriesOf(history(25)));
    await run(h);
    for (const row of h.writes) {
      expect(Object.keys(row).every(k => ['day', 'timezone', 'basis', 'form', 'recovery', 'weight', 'drivers', 'confidence', 'freshness', 'tags', 'read_at', 'sleep_debt'].includes(k))).toBe(true);
      for (const pillar of ['form', 'recovery', 'weight'] as const) {
        const p = row[pillar] as Record<string, unknown>;
        expect('reason' in p ? Object.keys(p) : ['score', 'zone', 'algorithm_version', 'activation']).toEqual('reason' in p ? ['reason'] : ['score', 'zone', 'algorithm_version', 'activation']);
      }
    }
  });

  it('shows sparse data as unavailable with a reason and no score', async () => {
    const h = harness(seriesOf(history(2)));
    await run(h);
    const row = h.writes.find(w => w.day === TODAY)!;
    expect(row.recovery).toEqual({ reason: expect.any(String) });
    expect(JSON.stringify(row.recovery)).not.toMatch(/score/);
  });

  it('does not write a row for a day that has no readings and nothing computable', async () => {
    const h = harness(seriesOf(history(1).filter(s => s.day === addDays(TODAY, 0))));
    await run(h);
    expect(h.writes.map(w => w.day)).toEqual([TODAY]);
  });

  it('passes the HRV method through so SDNN and RMSSD days stay separate regimes', async () => {
    const h = harness(seriesOf(history(25, { hrvMethod: 'sdnn' })));
    await run(h);
    const today = h.inputs.find(i => i.targetDay === TODAY)!.days.find(d => d.day === TODAY)!;
    expect(today.overnightHrv.map(entry => entry.method)).toEqual(['sdnn']);
    expect((h.writes.find(w => w.day === TODAY)!.recovery as Record<string, unknown>).hrv_method).toBe('sdnn');
  });

  it('does not take time in bed for time asleep', async () => {
    const h = harness(seriesOf(history(25, { sleepMethod: 'time_in_bed' })));
    await run(h);
    const days = h.inputs[0]!.days;
    expect(days.every(d => d.sleep === null)).toBe(true);
  });

  it('takes an unlabelled duration for time asleep, as the contract defines it, and an unknown one for nothing', async () => {
    const unlabelled = history(25).map(r => (r.signal === 'sleep_duration' ? { ...r, method: null } : r));
    const a = harness(seriesOf(unlabelled));
    await run(a);
    expect(a.inputs[0]!.days.every(d => d.sleep !== null)).toBe(true);
    const b = harness(seriesOf(history(25, { sleepMethod: 'unknown' })));
    await run(b);
    expect(b.inputs[0]!.days.every(d => d.sleep === null)).toBe(true);
  });

  it('flags a day that holds readings from two zones, and keeps the zone each day was read in', async () => {
    const travelled = [...history(25), sample('active_energy_window', TODAY, { timezone: 'Asia/Tokyo', utc_offset_minutes: 540, value: 100 })];
    const h = harness(seriesOf(travelled));
    await run(h);
    expect(h.writes.find(w => w.day === TODAY)!.tags).toEqual(['zone_changed']);
    expect(h.writes.find(w => w.day === addDays(TODAY, -1))!.tags).toEqual([]);
  });

  it('builds hourly buckets and workouts from the windows the phone sends', async () => {
    const extra = [sample('workout', TODAY, { start_at: `${TODAY}T06:00:00.000Z`, end_at: `${TODAY}T06:45:00.000Z`, value: 45, activity: 'run' })];
    const h = harness(seriesOf([...history(25), ...extra]));
    await run(h);
    const today = h.inputs[0]!.days.find(d => d.day === TODAY)!;
    expect(today.workouts).toEqual([{ startAt: `${TODAY}T06:00:00.000Z`, endAt: `${TODAY}T06:45:00.000Z` }]);
    expect(today.hourly).toHaveLength(8);
    expect(today.hourly[0]).toMatchObject({ startAt: `${TODAY}T08:00:00.000Z`, daylightMinutes: 20, movementMinutes: 12, hrvMethod: 'rmssd' });
    // Without a calendar reader only physical load is known: 8 hours x 12 movement minutes plus the 45-minute run.
    expect(today.demand).toEqual({ meetingMinutes: null, messageCount: null, openTaskMinutes: null, physicalLoad: 96 + 45 });
  });

  describe('hour windows sent again on another grid', () => {
    const YESTERDAY = addDays(TODAY, -1);
    const window = (signal: string, day: string, start: string, end: string, value = 30) => sample(signal, day, { start_at: start, end_at: end, value, timezone: 'Asia/Kolkata', utc_offset_minutes: 330 });
    const hourlyByDay = async (extra: Sample[]) => {
      const h = harness(seriesOf([...history(25), ...extra]));
      await run(h);
      return { h, hourly: new Map(h.inputs[0]!.days.map(d => [d.day, d.hourly.length])) };
    };

    it('leaves a day with an overlapping window no hourly windows, so Form says intraday inputs are unavailable', async () => {
      const { h, hourly } = await hourlyByDay([window('movement_duration', TODAY, `${TODAY}T08:30:00.000Z`, `${TODAY}T09:30:00.000Z`)]);
      expect([hourly.get(TODAY), hourly.get(YESTERDAY)]).toEqual([0, 8]);
      expect(h.writes.find(w => w.day === TODAY)!.form).toEqual({ reason: 'intraday_inputs_unavailable' });
      expect(h.writes.find(w => w.day === TODAY)!.recovery).toHaveProperty('score');
      // A window sent again in the new zone also marks the day as read in two zones.
      expect(h.writes.find(w => w.day === TODAY)!.tags).toContain('zone_changed');
    });

    it('leaves physical load unknown on a day with an overlapping window, even with a workout', async () => {
      const workout = (day: string) => sample('workout', day, { start_at: `${day}T06:00:00.000Z`, end_at: `${day}T07:00:00.000Z`, value: 60, activity: 'run' });
      const extra = [workout(TODAY), workout(YESTERDAY), window('movement_duration', TODAY, `${TODAY}T08:30:00.000Z`, `${TODAY}T09:30:00.000Z`)];
      const h = harness(seriesOf([...history(25), ...extra]), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busyMonth() }) });
      await run(h);
      const load = (day: string) => h.inputs.find(input => input.targetDay === TODAY)!.days.find(d => d.day === day)!.demand?.physicalLoad;
      expect([load(TODAY), load(YESTERDAY)]).toEqual([null, 96 + 60]);
      // Weight's baselines admit fewer physical-load days too, so Weight is a new version as well.
      expect((h.writes.find(w => w.day === TODAY)!.weight as Record<string, unknown>).algorithm_version).toBe('weight.candidate.v4');
    });

    it('checks the whole series, so an overlap across a day boundary clears both days', async () => {
      const { hourly } = await hourlyByDay([window('daylight_duration', TODAY, `${YESTERDAY}T15:30:00.000Z`, `${YESTERDAY}T16:30:00.000Z`)]);
      expect([hourly.get(TODAY), hourly.get(YESTERDAY), hourly.get(addDays(TODAY, -2))]).toEqual([0, 0, 8]);
    });

    it('treats the same hour stored under two days as an overlap', async () => {
      const { hourly } = await hourlyByDay([window('heart_rate_window', TODAY, `${YESTERDAY}T09:00:00.000Z`, `${YESTERDAY}T10:00:00.000Z`)]);
      expect([hourly.get(TODAY), hourly.get(YESTERDAY)]).toEqual([0, 0]);
    });

    it('keeps a window that only touches the next one, and a window repeated on the same day', async () => {
      const { hourly } = await hourlyByDay([
        window('movement_duration', TODAY, `${TODAY}T16:00:00.000Z`, `${TODAY}T17:00:00.000Z`),
        window('movement_duration', TODAY, `${TODAY}T08:00:00.000Z`, `${TODAY}T09:00:00.000Z`),
      ]);
      expect([hourly.get(TODAY), hourly.get(YESTERDAY)]).toEqual([9, 8]);
    });

    it('compares windows of one signal only', async () => {
      const { hourly } = await hourlyByDay([window('daylight_duration', TODAY, `${TODAY}T16:30:00.000Z`, `${TODAY}T17:30:00.000Z`), window('movement_duration', TODAY, `${TODAY}T17:00:00.000Z`, `${TODAY}T18:00:00.000Z`)]);
      expect(hourly.get(TODAY)).toBe(10);
    });

    it('leaves an overlapped earlier day out of the baseline, as if it had no hourly windows', async () => {
      // An earlier day of unusually heavy movement, so whether it is in the baseline shows in today's Form.
      const day = addDays(TODAY, -3);
      const heavy = history(25).map(s => (s.day === day && s.signal === 'movement_duration' ? { ...s, value: 55 } : s));
      const formOf = async (samples: Sample[]) => {
        const h = harness(seriesOf(samples));
        await run(h);
        return { form: h.writes.find(w => w.day === TODAY)!.form, hourly: h.inputs[0]!.days.find(d => d.day === day)?.hourly.length };
      };
      const overlapped = await formOf([...heavy, window('movement_duration', day, `${day}T10:30:00.000Z`, `${day}T11:30:00.000Z`)]);
      const without = await formOf(heavy.filter(s => !(s.day === day && SCORED_WINDOW_SIGNALS.includes(s.signal as string))));
      const counted = await formOf(heavy);
      expect([overlapped.hourly, counted.hourly]).toEqual([0, 8]);
      expect(overlapped.form).toEqual(without.form);
      expect(counted.form).not.toEqual(without.form);
      // Admitting fewer inputs is a new Form version under ADR-0081.
      expect((counted.form as Record<string, unknown>).algorithm_version).toBe('form.candidate.v8');
    });
  });

  it('computes each day from the highest-ranked source holding its sleep, never the one with most readings', async () => {
    // A ring sends one record a night; the phone sends dozens of hourly windows. Rank decides, so the owner is not re-based
    // on another wearable whenever the phone happens to send more.
    const ring = history(25).filter(s => !SCORED_WINDOW_SIGNALS.includes(s.signal as string));
    const series = { access: 'granted', read_at: READ_AT, sources: [
      { source: 'health_connect', consent_epoch: 1, truncated: false, samples: history(25) },
      { source: 'whoop', consent_epoch: 2, truncated: false, samples: ring },
    ] };
    const h = harness(series);
    await run(h);
    expect(h.writes.map(w => w.basis)).toEqual([[{ source: 'whoop', consent_epoch: 2 }], [{ source: 'whoop', consent_epoch: 2 }]]);
    // The night the ring missed is computed from the next source that has it, and that row names that source.
    const missed = { ...series, sources: [series.sources[0]!, { ...series.sources[1]!, samples: ring.filter(s => s.day !== TODAY) }] };
    const g = harness(missed);
    await run(g);
    expect(g.writes.map(w => [w.day, w.basis])).toEqual([[addDays(TODAY, -1), [{ source: 'whoop', consent_epoch: 2 }]], [TODAY, [{ source: 'health_connect', consent_epoch: 1 }]]]);
  });

  it('tells the owner only that today moved zone, and only when the writer says a pillar moved', async () => {
    const told: string[] = [];
    const onZoneChange = async (day: string) => { told.push(day); };
    await run(harness(seriesOf(history(25)), { written: true, changed: [] }, computeDailyScores, { onZoneChange }));
    expect(told).toEqual([]);
    await run(harness(seriesOf(history(25)), { written: true, changed: ['recovery'] }, computeDailyScores, { onZoneChange }));
    expect(told).toEqual([TODAY]);
    await run(harness(seriesOf(history(25)), { written: false, stale: true, changed: ['recovery'] }, computeDailyScores, { onZoneChange }));
    expect(told).toEqual([TODAY]);
    // A notice that fails never fails the write.
    expect(await run(harness(seriesOf(history(25)), { written: true, changed: ['form'] }, computeDailyScores, { onZoneChange: async () => { throw new Error('owner object away'); } }))).toBe('written');
  });

  describe('a zone that holds through a steady move', () => {
    // The derived rows as the database keeps them: the writer reports a pillar changed against the row it replaces or, for a
    // day's first row, the newest earlier day; the scores read returns one day's row.
    const plane = () => {
      const rows = new Map<string, Record<string, Record<string, unknown>>>();
      const newestBefore = (day: string) => [...rows.keys()].filter(d => d < day).sort().at(-1);
      return {
        rows,
        writeContext: async (payload: string) => {
          const row = JSON.parse(payload) as Record<string, Record<string, unknown>> & { day: string };
          const old = rows.get(row.day) ?? rows.get(newestBefore(row.day) ?? '');
          const changed = old ? ['recovery', 'form', 'weight'].filter(p => typeof old[p]?.zone === 'string' && typeof row[p]?.zone === 'string' && old[p]!.zone !== row[p]!.zone) : [];
          rows.set(row.day, row);
          return { written: true, changed };
        },
        readScores: async (day: string) => {
          const row = rows.get(day);
          return row ? { scores: { day, timezone: 'UTC', compiled_at: '2026-03-20T11:00:00.000Z', freshness: 'fresh', form: row.form, recovery: row.recovery, weight: row.weight } } : { unavailable: 'no_readings' };
        },
      };
    };
    const scored = (form: number, version = 'form.candidate.v4', recovery = 70): DailyScores => ({
      recovery: { state: 'available', score: recovery, zone: recoveryZone(recovery), algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted', coverage: 1, hrv_method: 'rmssd', used: { signals: [], days: [] } },
      form: { state: 'available', score: form, zone: formZone(form), algorithm_version: version, activation: 'candidate_unaccepted', coverage: 1, hrv_method: 'rmssd', used: { signals: [], days: [] } },
      weight: { state: 'unavailable', reason: 'calendar_demand_unavailable' }, sleep_debt: { state: 'unavailable', reason: 'no_readings' }, drivers: [],
    });
    // One recompute per score; for each, whether the owner's object was told today moved zone.
    const uploads = async (scores: readonly number[], store = plane(), version?: string, recovery?: number) => {
      const told: boolean[] = [];
      for (const score of scores) {
        let notified = false;
        await run(harness(seriesOf(history(25)), undefined, () => scored(score, version, recovery), { writeContext: store.writeContext, readScores: store.readScores, onZoneChange: async () => { notified = true; } }));
        told.push(notified);
      }
      return { told, store };
    };
    const formWord = (store: ReturnType<typeof plane>, day = TODAY) => fromRowZone('form', store.rows.get(day)?.form?.zone);

    it('tells the owner of a real crossing once, when it happens, not of the first wobble across the edge', async () => {
      const { told, store } = await uploads([62, 58, 52]);
      expect(told).toEqual([false, false, true]);
      expect(formWord(store)).toBe('flagging');
    });
    it('tells the owner nothing while a score wavers on an edge', async () => {
      const { told, store } = await uploads([62, 58, 62, 58, 56, 63]);
      expect(told).toEqual([false, false, false, false, false, false]);
      expect(formWord(store)).toBe('steady');
      expect(store.rows.get(TODAY)!.form!.score).toBe(63);
    });
    it('holds on the lower edges too, and crosses once the score is clear of them', async () => {
      const { told, store } = await uploads([42, 38, 41, 37, 33]);
      expect(told).toEqual([false, false, false, false, true]);
      expect(formWord(store)).toBe('depleted');
    });
    it('needs more than a steady move past the old zone in both directions', async () => {
      expect((await uploads([80, 75])).told).toEqual([false, false]);
      expect((await uploads([80, 74])).told).toEqual([false, true]);
      expect((await uploads([79, 84])).told).toEqual([false, false]);
      expect((await uploads([79, 85])).told).toEqual([false, true]);
    });
    it('holds nothing across days, so a fresh night\'s score writes its own band and its crossing is told', async () => {
      // Yesterday's row was Recovery 82 and Form 62; tonight's scores are 76 and 58, each within a steady move of yesterday's zone.
      const store = plane();
      store.rows.set(addDays(TODAY, -1), {
        recovery: { score: 82, zone: 'high', algorithm_version: 'recovery.candidate.v1' },
        form: { score: 62, zone: 'good', algorithm_version: 'form.candidate.v4' },
      });
      let told = false;
      const nightly = (input: DailyScoresInput) => (input.targetDay === TODAY ? scored(58, undefined, 76) : scored(62, undefined, 82));
      await run(harness(seriesOf(history(25)), undefined, nightly, { writeContext: store.writeContext, readScores: store.readScores, onZoneChange: async () => { told = true; } }));
      expect(told).toBe(true);
      expect(fromRowZone('recovery', store.rows.get(TODAY)?.recovery?.zone)).toBe('solid');
      expect(formWord(store)).toBe('flagging');
    });
    it('holds nothing from a zone another algorithm version wrote', async () => {
      const store = plane();
      store.rows.set(TODAY, { form: { score: 62, zone: 'good', algorithm_version: 'form.candidate.v3' } });
      store.rows.set(addDays(TODAY, -1), { form: { score: 62, zone: 'good', algorithm_version: 'form.candidate.v3' } });
      const { told } = await uploads([58], store);
      expect(told).toEqual([true]);
      expect(formWord(store)).toBe('flagging');
    });
    it('writes the score\'s own band when the row before cannot be read', async () => {
      const store = plane();
      store.rows.set(TODAY, { form: { score: 62, zone: 'good', algorithm_version: 'form.candidate.v4' } });
      const writes: Record<string, unknown>[] = [];
      for (const readScores of [async () => { throw new Error('down'); }, async () => null, async () => ({ error: 'not_linked' })]) {
        await run(harness(seriesOf(history(25)), undefined, () => scored(58), { writeContext: async payload => { writes.push(JSON.parse(payload)); return { written: true }; }, readScores }));
      }
      expect(writes.filter(w => w.day === TODAY).map(w => (w.form as { zone: string }).zone)).toEqual(['moderate', 'moderate', 'moderate']);
    });
  });

  it('never scores a newly worn wearable against the old one\'s baseline', async () => {
    // Two weeks on the watch, then three nights on a strap: the strap's nights are its own short history, still learning.
    const watch = Array.from({ length: 14 }, (_, i) => dayOfReadings(addDays(TODAY, -3 - i), i)).flat();
    const strap = Array.from({ length: 3 }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, { hrvMethod: 'rmssd' })).flat()
      .filter(s => !SCORED_WINDOW_SIGNALS.includes(s.signal as string)).map(s => s.signal === 'overnight_hrv' ? { ...s, value: 31 } : s);
    const h = harness({ access: 'granted', read_at: READ_AT, sources: [
      { source: 'apple', consent_epoch: 1, truncated: false, samples: watch },
      { source: 'whoop', consent_epoch: 1, truncated: false, samples: strap },
    ] });
    await run(h);
    const today = h.inputs.find(i => i.targetDay === TODAY)!;
    expect(today.days.filter(d => d.overnightHrv).map(d => d.day).sort()).toEqual([addDays(TODAY, -2), addDays(TODAY, -1), TODAY]);
    const row = h.writes.find(w => w.day === TODAY)!;
    expect(row.basis).toEqual([{ source: 'whoop', consent_epoch: 1 }]);
    expect(row.recovery).not.toHaveProperty('score');
  });

  it('computes from the higher-ranked of two sources and names only that source as the basis', async () => {
    const series = { access: 'granted', read_at: READ_AT, sources: [
      { source: 'health_connect', consent_epoch: 1, truncated: false, samples: history(3) },
      { source: 'apple', consent_epoch: 4, truncated: false, samples: history(25) },
    ] };
    const h = harness(series);
    await run(h);
    expect(h.writes.every(w => JSON.stringify(w.basis) === JSON.stringify([{ source: 'apple', consent_epoch: 4 }]))).toBe(true);
    expect(h.inputs[0]!.days.length).toBeGreaterThan(20);
  });

  it('does nothing when storage consent is not live', async () => {
    for (const access of ['consent_required', 'consent_withdrawn']) {
      const h = harness(seriesOf([], { access }));
      expect(await run(h)).toBe('no_consent');
      expect(h.writes).toEqual([]);
    }
  });

  it('does nothing when a consented source has no readings', async () => {
    const h = harness(seriesOf([]));
    expect(await run(h)).toBe('no_readings');
    expect(h.writes).toEqual([]);
  });

  it('fails closed on an unreadable series and never writes', async () => {
    for (const bad of [null, 'x', { error: 'not_linked' }, { access: 'granted' }, { access: 'granted', read_at: 'nope', sources: [] }]) {
      const h = harness(bad);
      expect(await run(h)).toBe(bad && typeof bad === 'object' && (bad as { error?: string }).error === 'not_linked' ? 'no_consent' : 'failed');
      expect(h.writes).toEqual([]);
    }
  });

  it('drops a malformed reading instead of guessing it', async () => {
    const h = harness(seriesOf([...history(25), { signal: 'overnight_hrv', day: TODAY, value: 'high' }, { signal: 'resting_heart_rate', day: 'today', value: 50 }, null as never]));
    expect(await run(h)).toBe('written');
  });

  it('reports a stale write and an epoch change as what they are, and never throws', async () => {
    expect(await run(harness(seriesOf(history(25)), { written: false, stale: true }))).toBe('stale');
    expect(await run(harness(seriesOf(history(25)), { error: 'epoch_conflict' }))).toBe('refused');
    expect(await run(harness(seriesOf(history(25)), { error: 'consent_required' }))).toBe('refused');
    expect(await run(harness(seriesOf(history(25)), null))).toBe('failed');
    const thrower = harness(seriesOf(history(25)), { written: true }, () => { throw new Error('boom'); });
    expect(await run(thrower)).toBe('failed');
    expect(thrower.writes).toEqual([]);
    const broken = harness(seriesOf(history(25)));
    broken.deps = { ...broken.deps, readSeries: async () => { throw new Error('down'); } };
    expect(await run(broken)).toBe('failed');
  });

  it('makes a row the prompt reader accepts, in the zone word the bridge gives back', async () => {
    const h = harness(seriesOf(history(25)));
    await run(h);
    const written = h.writes.find(w => w.day === TODAY)!;
    const row: HealthContextRow = {
      context: { id: 'ctx', day: TODAY, form: written.form, recovery: written.recovery, weight: written.weight, drivers: written.drivers ?? [], confidence: written.confidence ?? null, freshness: written.freshness, tags: written.tags ?? [], compiled_at: '2026-03-20T12:00:01.000Z' },
      previous: null,
    };
    const material = toContextHealthMaterial(row, { timezone: 'UTC', now: () => new Date(NOW + 5_000) });
    expect(material).not.toBeNull();
    expect(material!.narrative.recovery_descriptor).toBe(fromRowZone('recovery', (written.recovery as { zone: string }).zone));
    // No calendar demand is read yet, so Weight is stated as unavailable rather than guessed, and the reader says so too.
    expect(written.weight).toEqual({ reason: 'calendar_demand_unavailable' });
    expect(material!.narrative.load_descriptor).toBeUndefined();
  });

  it('produces rows from the series the database function itself returned', async () => {
    const h = harness(realSeries);
    expect(await produceHealthScores(h.deps, { now: Date.parse('2026-10-11T07:44:50Z'), timezone: 'UTC' })).toBe('written');
    expect(h.writes.map(w => w.day)).toEqual(['2026-10-10', '2026-10-11']);
    const today = h.writes[1]!;
    expect(today.read_at).toBe(realSeries.read_at);
    expect(today.basis).toEqual([{ source: 'apple', consent_epoch: 1 }]);
    expect(today.recovery).toMatchObject({ zone: expect.stringMatching(/^(low|moderate|good|high)$/), algorithm_version: 'recovery.candidate.v4' });
    expect(today.weight).toEqual({ reason: 'calendar_demand_unavailable' });
  });

  describe('Apple Watch coverage', () => {
    // A night's breathing rate, read twice: once before midnight, dated the day before, and once after.
    const breathing = (day: string, i: number, late = 14 + wobble(i, 0.6), early = 14 + wobble(i + 3, 0.6)) => [
      sample('respiratory_rate', addDays(day, -1), { start_at: `${addDays(day, -1)}T23:30:00.000Z`, end_at: `${addDays(day, -1)}T23:30:00.000Z`, value: late }),
      sample('respiratory_rate', day, { start_at: `${day}T03:00:00.000Z`, end_at: `${day}T03:00:00.000Z`, value: early }),
    ];
    const nights = (n: number, reading: (day: string, i: number) => Sample[]) => Array.from({ length: n }, (_, i) => reading(addDays(TODAY, -i), i)).flat();
    const todayRow = (h: Harness) => h.writes.find(w => w.day === TODAY)!;

    it('stores sleep debt on the row in the shape the app reads, in every state', async () => {
      const full = harness(seriesOf(history(25)));
      await run(full);
      expect(todayRow(full).sleep_debt).toEqual({ state: 'available', debt_minutes: expect.any(Number), need_basis: 'own_average', algorithm_version: 'sleep-debt.candidate.v1', activation: 'candidate_unaccepted' });
      const gaps = harness(seriesOf(history(25).filter(entry => entry.signal !== 'sleep_duration' || entry.day !== addDays(TODAY, -3))));
      await run(gaps);
      expect(todayRow(gaps).sleep_debt).toEqual({ state: 'partial', confidence: expect.any(Number), algorithm_version: 'sleep-debt.candidate.v1', activation: 'candidate_unaccepted' });
      const young = harness(seriesOf(history(3)));
      await run(young);
      expect(todayRow(young).sleep_debt).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    });

    it('names a night\'s breathing rate far above usual, counting the reading before midnight toward the night it falls in', async () => {
      const h = harness(seriesOf([...history(25), ...nights(25, (day, i) => (i === 0 ? breathing(day, i, 30, 14) : breathing(day, i)))]));
      await run(h);
      expect(todayRow(h).drivers).toEqual(['breathing rate far above usual']);
      // The same high reading dated today but outside the night is daytime, not the night's.
      const daytime = harness(seriesOf([...history(25), ...nights(25, (day, i) => (i === 0 ? [...breathing(day, i, 14, 14), sample('respiratory_rate', day, { start_at: `${day}T11:00:00.000Z`, end_at: `${day}T11:00:00.000Z`, value: 30 })] : breathing(day, i)))]));
      await run(daytime);
      expect(todayRow(daytime).drivers).toEqual([]);
    });

    it('reads blood oxygen, the night\'s wrist temperature of each method, walking heart rate and awake time', async () => {
      const temperature = (day: string, value: number, method = 'absolute') => sample('wrist_temperature', day, { start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T07:00:00.000Z`, value, method });
      const oxygen = (day: string, value: number) => sample('spo2', day, { start_at: `${day}T02:00:00.000Z`, end_at: `${day}T02:00:00.000Z`, value });
      const walking = (day: string, value: number) => sample('walking_heart_rate_average', day, { start_at: `${day}T00:00:00.000Z`, end_at: `${day}T23:59:00.000Z`, value });
      const staged = (entries: Sample[], awake: (i: number) => number) => entries.map((entry, index) => {
        if (entry.signal !== 'sleep_duration') return entry;
        const i = Math.floor(index / 36);
        return { ...entry, stages: { light: 200, deep: 80, rem: 90, unspecified: (entry.value as number) - 370, awake: awake(i) } };
      });
      // Earlier nights wobble around the owner's usual; today sits on it unless a test moves it.
      const usual = nights(25, (day, i) => (i === 0 ? [temperature(day, 34), oxygen(day, 96), walking(day, 100)] : [temperature(day, 34 + wobble(i, 0.3)), oxygen(day, 96 + wobble(i, 1)), walking(day, 100 + wobble(i, 3))]));
      const awake = (i: number) => (i === 0 ? 25 : 25 + wobble(i, 8));
      const h = harness(seriesOf([...staged(history(25), awake), ...usual.filter(entry => entry.day !== TODAY),
        temperature(TODAY, 36.5), oxygen(TODAY, 90), walking(TODAY, 100), temperature(TODAY, 1.5, 'baseline_delta')]));
      await run(h);
      expect(todayRow(h).drivers).toEqual(['wrist temperature far above usual', 'blood oxygen far below usual']);
      const restless = harness(seriesOf([...staged(history(25), i => (i === 0 ? 90 : awake(i))), ...usual]));
      await run(restless);
      expect(todayRow(restless).drivers).toEqual(['awake time in the night far above usual']);
    });

    it('scores exactly as before when the vital signals cannot be read, and names no driver from them', async () => {
      const series = seriesOf([...history(25), ...nights(25, (day, i) => (i === 0 ? breathing(day, i, 30, 30) : breathing(day, i)))]);
      const read = harness(series);
      await run(read);
      const failing = harness(series, undefined, undefined, { readSeries: async range => { if (range.signals.includes('respiratory_rate')) throw new Error('down'); return askedFor(series, range.signals); } });
      expect(await run(failing)).toBe('written');
      const strip = (row: Record<string, unknown>) => ({ ...row, drivers: undefined });
      expect(failing.writes.map(strip)).toEqual(read.writes.map(strip));
      expect([todayRow(read).drivers, todayRow(failing).drivers]).toEqual([['breathing rate far above usual'], []]);
    });

    it('reaches the prompt through the existing reader: the stored phrase, word for word, and no value', async () => {
      const h = harness(seriesOf([...history(25), ...nights(25, (day, i) => (i === 0 ? breathing(day, i, 30, 30) : breathing(day, i)))]));
      await run(h);
      const written = todayRow(h);
      const material = toContextHealthMaterial({
        context: { id: 'ctx', day: TODAY, form: written.form, recovery: written.recovery, weight: written.weight, drivers: written.drivers, confidence: written.confidence ?? null, freshness: written.freshness, tags: written.tags ?? [], compiled_at: '2026-03-20T12:00:01.000Z' },
        previous: null,
      }, { timezone: 'UTC', now: () => new Date(NOW + 5_000) });
      expect(material!.narrative.day_summary).toContain('Drivers: breathing rate far above usual.');
      expect(material!.narrative.day_summary).not.toMatch(/\d/);
    });

    it('takes a vital reading only from the consent epoch the scores were read under', async () => {
      const vitals = nights(25, (day, i) => (i === 0 ? breathing(day, i, 30, 30) : breathing(day, i)));
      const main = seriesOf(history(25));
      const regranted = seriesOf(vitals, { epoch: 4 });
      const h = harness(main, undefined, undefined, { readSeries: async range => (range.signals.includes('respiratory_rate') ? regranted : askedFor(main, range.signals)) });
      await run(h);
      expect(todayRow(h).drivers).toEqual([]);
    });

    it('puts active energy in the hour it was burned, so Weight can read it', async () => {
      const energy = [8, 9, 10].map(h => sample('active_energy_window', TODAY, { start_at: `${TODAY}T${String(h).padStart(2, '0')}:00:00.000Z`, end_at: `${TODAY}T${String(h + 1).padStart(2, '0')}:00:00.000Z`, value: 40 }));
      const h = harness(seriesOf([...history(25), ...energy]));
      await run(h);
      const today = h.inputs[0]!.days.find(d => d.day === TODAY)!;
      expect(today.hourly.slice(0, 4).map(bucket => bucket.activeEnergyKcal)).toEqual([40, 40, 40, null]);
    });

    it('drops the oldest day of each truncated read, which may be partial, and logs which read without a value', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = harness(seriesOf(history(25), { truncated: true }));
      await run(h);
      const days = h.inputs[0]!.days.map(d => d.day);
      expect(days).not.toContain(addDays(TODAY, -24));
      expect(days).toContain(addDays(TODAY, -23));
      const lines = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('health_series'));
      expect(lines.sort()).toEqual([JSON.stringify({ hop: 'health_series', ok: true, code: 'series_truncated' }), JSON.stringify({ hop: 'health_series', ok: true, code: 'vitals_truncated' })]);
    });

    it('keeps one HRV reading per method and one resting reading per method for each night', async () => {
      const both = [sample('overnight_hrv', TODAY, { start_at: `${addDays(TODAY, -1)}T23:00:00.000Z`, end_at: `${TODAY}T07:00:00.000Z`, value: 44, method: 'sdnn' }),
        sample('resting_heart_rate', TODAY, { start_at: `${TODAY}T05:00:00.000Z`, end_at: `${TODAY}T05:00:00.000Z`, value: 51, method: 'overnight_resting' })];
      const h = harness(seriesOf([...history(25), ...both]));
      await run(h);
      const today = h.inputs[0]!.days.find(d => d.day === TODAY)!;
      expect(today.overnightHrv.map(entry => entry.method).sort()).toEqual(['rmssd', 'sdnn']);
      expect(today.restingHeartRate.map(entry => entry.method).sort()).toEqual(['overnight_resting', 'unknown']);
    });
  });

  describe('a night with no measured resting heart rate', () => {
    // A Health Connect phone whose watch writes no resting rate and no HRV: each night's sleep and a heart-rate window for
    // every hour, lower while asleep (23:00 to 07:00) than awake. Every value is synthetic.
    const HOUR = 3_600_000;
    const heartHour = (day: string, startMs: number, value: number, over: Sample = {}) =>
      sample('heart_rate_window', day, { start_at: new Date(startMs).toISOString(), end_at: new Date(startMs + HOUR).toISOString(), value, min: value - 6, max: value + 9, n_samples: 40, ...over });
    const night = (day: string, i: number, from = `${addDays(day, -1)}T23:00:00.000Z`, to = `${day}T07:00:00.000Z`, over: Sample = {}) => [
      sample('sleep_duration', day, { start_at: from, end_at: to, value: 450 + wobble(i, 20), method: 'asleep_duration', ...over }),
      sample('sleep_midpoint', day, { start_at: from, end_at: to, value: 180 + wobble(i, 15), method: 'sleep_midpoint', ...over }),
    ];
    const hcDay = (day: string, i: number, lastHour = 23): Sample[] => [
      ...night(day, i),
      ...Array.from({ length: lastHour + 1 }, (_, h) => heartHour(day, Date.parse(`${day}T00:00:00Z`) + h * HOUR, h < 7 || h === 23 ? 52 + wobble(h + i, 3) : 74 + wobble(h + i, 3))),
    ];
    // Today's hours run up to the read, which is at noon unless a test reads later.
    const hcHistory = (nights: number, lastToday = 11) => Array.from({ length: nights }, (_, i) => hcDay(addDays(TODAY, -i), i, i === 0 ? lastToday : 23)).flat();
    const hc = (samples: Sample[], readAt = READ_AT) => ({ ...seriesOf(samples, { source: 'health_connect' }), read_at: readAt });
    const dayIn = (h: Harness, day: string) => h.inputs[0]!.days.find(d => d.day === day)!;
    const todayRow = (h: Harness) => h.writes.find(w => w.day === TODAY)!;

    it('scores Recovery from the night\'s asleep heart-rate hours, recorded as a method of their own', async () => {
      const h = harness(hc(hcHistory(25)));
      expect(await run(h)).toBe('written');
      expect(dayIn(h, TODAY).restingHeartRate).toEqual([{ value: expect.any(Number), method: 'asleep_hours_low' }]);
      expect(todayRow(h).recovery).toMatchObject({ score: expect.any(Number), confidence: 0.7, algorithm_version: 'recovery.candidate.v4', hrv_method: null });
    });

    it('takes the mean of the two lowest hours wholly inside the asleep span, across local midnight, never a waking or half-asleep hour', async () => {
      // Asleep 23:00 to 06:30 in Kolkata. The 23:00 hour is dated the day before; the 06:00 hour is half awake.
      const local = (day: string, h: number) => Date.parse(`${day}T00:00:00Z`) + h * HOUR - 330 * 60_000;
      const zone = { timezone: 'Asia/Kolkata', utc_offset_minutes: 330 };
      const YESTERDAY = addDays(TODAY, -1);
      const samples = [
        ...night(TODAY, 0, new Date(local(YESTERDAY, 23)).toISOString(), new Date(local(TODAY, 6) + HOUR / 2).toISOString(), zone),
        heartHour(YESTERDAY, local(YESTERDAY, 23), 50, zone),
        ...[58, 55, 53, 57, 60, 59].map((value, h) => heartHour(TODAY, local(TODAY, h), value, zone)),
        heartHour(TODAY, local(TODAY, 6), 44, zone),
        heartHour(TODAY, local(TODAY, 8), 42, zone),
      ];
      const h = harness(hc(samples));
      await run(h, 'Asia/Kolkata');
      expect(dayIn(h, TODAY).restingHeartRate).toEqual([{ value: 51.5, method: 'asleep_hours_low' }]);
    });

    it('never takes the place of a measured resting rate, so a night that has one writes exactly as before', async () => {
      const asleepHours = Array.from({ length: 25 }, (_, i) => addDays(TODAY, -i))
        .flatMap((day, i) => [0, 1, 2, 3, 4, 5, 6].map(h => heartHour(day, Date.parse(`${day}T00:00:00Z`) + h * HOUR, 50 + wobble(h + i, 3))));
      const measured = harness(seriesOf(history(25)));
      await run(measured);
      const withHours = harness(seriesOf([...history(25), ...asleepHours]));
      await run(withHours);
      expect(dayIn(withHours, TODAY).restingHeartRate).toEqual(dayIn(measured, TODAY).restingHeartRate);
      expect(dayIn(withHours, TODAY).restingHeartRate.map(entry => entry.method)).toEqual(['unknown']);
      expect(withHours.writes).toEqual(measured.writes);
    });

    it('never reads a derived night against measured nights', async () => {
      // A second watch measured a resting rate on the older nights only: nine derived nights back today, too few for a baseline.
      const measuredFrom = 10;
      const samples = [...hcHistory(25), ...Array.from({ length: 25 - measuredFrom }, (_, k) => {
        const day = addDays(TODAY, -(measuredFrom + k));
        return sample('resting_heart_rate', day, { start_at: `${day}T05:00:00.000Z`, end_at: `${day}T05:00:00.000Z`, value: 54 + wobble(k, 2) });
      })];
      const h = harness(hc(samples));
      await run(h);
      expect(dayIn(h, addDays(TODAY, -12)).restingHeartRate.map(entry => entry.method)).toEqual(['unknown']);
      expect(dayIn(h, TODAY).restingHeartRate.map(entry => entry.method)).toEqual(['asleep_hours_low']);
      expect(todayRow(h).recovery).toEqual({ reason: 'baseline_immature' });
    });

    it('leaves a night with fewer than three asleep hours, or no sleep, unavailable with its reason', async () => {
      // Last night keeps two asleep hours, 00:00 and 01:00; the hour before midnight and 02:00 to 07:00 are gone.
      const asleepOutside = (entry: Sample) => {
        const at = Date.parse(String(entry.start_at));
        return entry.signal === 'heart_rate_window' && at >= Date.parse(`${addDays(TODAY, -1)}T23:00:00Z`) && at < Date.parse(`${TODAY}T07:00:00Z`)
          && at !== Date.parse(`${TODAY}T00:00:00Z`) && at !== Date.parse(`${TODAY}T01:00:00Z`);
      };
      const few = harness(hc(hcHistory(25).filter(entry => !asleepOutside(entry))));
      await run(few);
      expect(dayIn(few, TODAY).restingHeartRate).toEqual([]);
      expect(todayRow(few).recovery).toEqual({ reason: 'missing_resting_signal' });
      const unslept = harness(hc(hcHistory(25).filter(entry => !(entry.day === TODAY && entry.signal === 'sleep_duration'))));
      await run(unslept);
      expect(todayRow(unslept).recovery).toEqual({ reason: 'missing_sleep' });
    });

    it('derives nothing for a night touching a day with an overlapping window, or begun before the first hour read', async () => {
      const overlapped = harness(hc([...hcHistory(25), heartHour(TODAY, Date.parse(`${TODAY}T08:30:00Z`), 74)]));
      await run(overlapped);
      expect(dayIn(overlapped, TODAY).restingHeartRate).toEqual([]);
      expect(dayIn(overlapped, addDays(TODAY, -1)).restingHeartRate).toHaveLength(1);
      // The oldest night read began the evening before the read's first day, so only part of it was read.
      const h = harness(hc(hcHistory(25)));
      await run(h);
      expect(dayIn(h, addDays(TODAY, -24)).restingHeartRate).toEqual([]);
      expect(dayIn(h, addDays(TODAY, -23)).restingHeartRate).toHaveLength(1);
    });

    it('scores Form on a day with only sleep and heart-rate hours once those hours are fresh, and not on stale ones', async () => {
      const evening = '2026-03-20T20:00:00.000Z';
      const fresh = harness(hc(hcHistory(25, 19), evening));
      await produceHealthScores(fresh.deps, { now: Date.parse(evening), timezone: 'UTC' });
      expect(todayRow(fresh).form).toMatchObject({ score: expect.any(Number), algorithm_version: 'form.candidate.v8', hrv_method: null });
      const stale = harness(hc(hcHistory(25, 9), evening));
      await produceHealthScores(stale.deps, { now: Date.parse(evening), timezone: 'UTC' });
      expect(todayRow(stale).form).toEqual({ reason: 'stale_inputs' });
      expect(todayRow(stale).recovery).toHaveProperty('score');
    });
  });
});
