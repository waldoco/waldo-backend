import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { periodsOf, produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { computeDailyScores } from '../src/health/scores';

// The recompute with cycle context (ADR-0085 D4, D5, D9). Every value is synthetic: invented dates, readings and app names.
const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample = {}): Sample =>
  ({ signal, day, start_at: `${addDays(day, -1)}T23:00:00.000Z`, end_at: `${day}T07:00:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });

// A regular 28-day cycle whose current period began 20 days ago, so today and yesterday are luteal.
const PERIOD_STARTS = [0, 1, 2, 3].map(k => addDays(TODAY, -20 - 28 * k));
const PERIODS = { periods: PERIOD_STARTS.map(start => ({ start_date: start, end_date: addDays(start, 4) })).reverse() };
const luteal = (day: string) => {
  const start = [...PERIOD_STARTS].sort().reverse().find(s => s <= day);
  if (!start) return false;
  const age = (Date.parse(day) - Date.parse(start)) / 86_400_000;
  return age >= 14 && age < 28;
};
// The owner's luteal nights run lower HRV and a higher resting heart rate than the rest; today is an ordinary luteal night.
const night = (day: string, i: number): Sample[] => {
  const l = luteal(day);
  return [
    sample('sleep_duration', day, { value: 460 + wobble(i, 10), method: 'asleep_duration' }),
    sample('sleep_midpoint', day, { value: 180 + wobble(i, 10), method: 'sleep_midpoint' }),
    sample('overnight_hrv', day, { value: (l ? 48 : 66) + wobble(i, 3), method: 'rmssd' }),
    sample('resting_heart_rate', day, { start_at: `${day}T03:00:00.000Z`, end_at: `${day}T04:00:00.000Z`, value: (l ? 59 : 53) + wobble(i, 1), method: 'overnight_resting' }),
  ];
};
const SAMPLES = Array.from({ length: 91 }, (_, i) => night(addDays(TODAY, -i), i)).flat();
const seriesOf = (from: string, to: string, signals: readonly string[], epoch = 3) => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source: 'apple', consent_epoch: epoch, truncated: false, samples: SAMPLES.filter(s => String(s.day) >= from && String(s.day) <= to && signals.includes(String(s.signal))) }],
});

type Harness = { deps: ProducerDeps; writes: Record<string, unknown>[]; reads: { from: string; to: string; signals: readonly string[] }[] };
const harness = (extra: Partial<ProducerDeps> = {}, lookbackEpoch = 3): Harness => {
  const h: Harness = { writes: [], reads: [], deps: null as never };
  h.deps = {
    readSeries: async range => {
      h.reads.push(range);
      const lookback = range.from < addDays(TODAY, -31);
      return seriesOf(range.from, range.to, range.signals, lookback ? lookbackEpoch : 3);
    },
    writeContext: async payload => { h.writes.push(JSON.parse(payload)); return { written: true }; },
    compute: computeDailyScores,
    ...extra,
  };
  return h;
};
const run = (h: Harness) => produceHealthScores(h.deps, { now: NOW, timezone: 'UTC' });
const today = (h: Harness) => h.writes.find(row => row.day === TODAY)!;

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

describe('the recompute with cycle context', () => {
  it('reads the owner\'s own same-phase days over 90 days, and marks a row the phase changed', async () => {
    const plain = harness();
    await run(plain);
    const phased = harness({ readCycle: async () => PERIODS });
    expect(await run(phased)).toBe('written');
    expect(phased.reads).toContainEqual({ from: addDays(TODAY, -90), to: TODAY, signals: ['sleep_duration', 'sleep_midpoint', 'overnight_hrv', 'resting_heart_rate', 'respiratory_rate', 'wrist_temperature'] });
    expect(today(phased).reading_basis).toEqual({ kind: 'cycle_phase', explanation: 'Read against your own usual for this part of your cycle.' });
    expect((today(phased).recovery as { score: number }).score).toBeGreaterThan((today(plain).recovery as { score: number }).score);
    expect(today(plain)).not.toHaveProperty('reading_basis');
  });

  it('writes exactly the rows it writes without cycle context when the phase is unknown, the read fails or is refused', async () => {
    const plain = harness();
    await run(plain);
    for (const readCycle of [
      async () => ({ periods: [{ start_date: addDays(TODAY, -70), end_date: addDays(TODAY, -66) }] }),
      async () => ({ periods: [] }),
      async () => ({ error: 'consent_withdrawn' }),
      async () => { throw new Error('down'); },
      async () => ({ periods: [{ start_date: 'yesterday', end_date: null }] }),
    ]) {
      const h = harness({ readCycle });
      await run(h);
      expect(h.writes).toEqual(plain.writes);
    }
  });

  it('never reads the lookback under another consent epoch', async () => {
    const plain = harness();
    await run(plain);
    const regranted = harness({ readCycle: async () => PERIODS }, 4);
    await run(regranted);
    expect(regranted.writes).toEqual(plain.writes);
  });

  it('does not read cycle data at all without readCycle, which only HEALTH_CYCLE "1" gives', async () => {
    const h = harness();
    await run(h);
    expect(h.reads.every(range => range.from >= addDays(TODAY, -31))).toBe(true);
  });

  it('puts no period date, phase, basis or cycle word on a log line, whatever happens', async () => {
    await run(harness({ readCycle: async () => PERIODS }));
    await run(harness({ readCycle: async () => { throw new Error('down'); } }));
    await run(harness({ readCycle: async () => PERIODS, writeContext: async () => ({ error: 'consent_required' }) }));
    expect(lines.length).toBeGreaterThan(0);
    const forbidden = [...PERIOD_STARTS, ...PERIOD_STARTS.map(start => addDays(start, 4)), 'cycle', 'phase', 'luteal', 'follicular', 'menstrual', 'reading_basis', 'Read against'];
    for (const line of lines) for (const word of forbidden) expect(line.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it('reads a period answer as dates only', () => {
    expect(periodsOf(PERIODS)).toHaveLength(4);
    expect(periodsOf({ periods: [{ start_date: '2026-03-01', end_date: null }] })).toEqual([{ start: '2026-03-01', end: null }]);
    for (const bad of [null, { error: 'consent_required' }, { periods: 'x' }, { periods: [{ start_date: '2026-3-1', end_date: null }] }, { periods: Array.from({ length: 65 }, () => ({ start_date: '2026-03-01', end_date: null })) }])
      expect(periodsOf(bad)).toBeNull();
  });
});
