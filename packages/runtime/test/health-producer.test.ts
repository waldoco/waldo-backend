import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromRowZone } from '../../contracts/src/health/zone-bridge';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { computeDailyScores } from '../src/health/scores';
import type { DailyScoresInput } from '../src/health/scores/types';
import realSeries from './fixtures/health-series-read.json';

const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
const WINDOW_SIGNALS = ['heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration'];

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
const harness = (series: unknown, writeResult: unknown = { written: true }, compute = computeDailyScores, extra: Partial<ProducerDeps> = {}): Harness => {
  const h: Harness = { writes: [], reads: [], inputs: [], deps: null as never };
  h.deps = {
    readSeries: async range => { h.reads.push(range); return series; },
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
    expect(h.reads).toEqual([{ from: addDays(TODAY, -30), to: TODAY, signals: expect.arrayContaining(['sleep_duration', 'overnight_hrv', 'workout']) }]);
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
    expect(order).toEqual(['demand', 'series', 'write', 'write']);
    expect(h.writes.find(w => w.day === TODAY)!.weight).toEqual({ reason: 'calendar_demand_unavailable' });
    expect(typeof (h.writes.find(w => w.day === TODAY)!.form as Record<string, unknown>).score).toBe('number');
    expect(demandLogs(log)).toEqual([{ hop: 'weight_demand', ok: false, code: 'demand_late' }]);
    // The late read still runs to the end, so the owner object can cache it for the next upload.
    expect(settled).toBe(true);
  });

  it('tags a day whose Weight was read without a calendar Google reported gone', async () => {
    const tagsAfter = async (nights: number) => {
      const h = harness(seriesOf(history(nights)), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busyMonth(i => i === 0) }) });
      await run(h);
      return Object.fromEntries(h.writes.map(w => [w.day, w.tags]));
    };
    expect(await tagsAfter(25)).toEqual({ [TODAY]: ['calendar_partial'], [addDays(TODAY, -1)]: [] });
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

  it('needs readings on the baseline days too: calendar minutes attach only to days with health readings', async () => {
    const busy = Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: Math.round(240 + wobble(i, 40)) }));
    const weightAfter = async (nights: number) => {
      const h = harness(seriesOf(history(nights)), undefined, undefined, { readDemand: async () => ({ state: 'available', days: busy }) });
      await run(h);
      return h.writes.find(w => w.day === TODAY)!.weight as Record<string, unknown>;
    };
    expect(await weightAfter(3)).toEqual({ reason: 'baseline_immature' });
    expect(typeof (await weightAfter(15)).score).toBe('number');
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
      expect(Object.keys(row).every(k => ['day', 'timezone', 'basis', 'form', 'recovery', 'weight', 'drivers', 'confidence', 'freshness', 'tags', 'read_at'].includes(k))).toBe(true);
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
    expect(today.overnightHrv?.method).toBe('sdnn');
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
    const travelled = [...history(25), sample('steps_window', TODAY, { timezone: 'Asia/Tokyo', utc_offset_minutes: 540, value: 100 })];
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
      const without = await formOf(heavy.filter(s => !(s.day === day && WINDOW_SIGNALS.includes(s.signal as string))));
      const counted = await formOf(heavy);
      expect([overlapped.hourly, counted.hourly]).toEqual([0, 8]);
      expect(overlapped.form).toEqual(without.form);
      expect(counted.form).not.toEqual(without.form);
    });
  });

  it('computes from the source with the most readings and names only that source as the basis', async () => {
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
    expect(today.recovery).toMatchObject({ zone: expect.stringMatching(/^(low|moderate|good|high)$/), algorithm_version: 'recovery.candidate.v1' });
    expect(today.weight).toEqual({ reason: 'calendar_demand_unavailable' });
  });
});
