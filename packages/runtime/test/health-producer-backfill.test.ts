import { describe, expect, it, vi } from 'vitest';
import { BACKFILL_DAYS_PER_RUN, produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// Days that arrive late: Recovery and sleep debt are recomputed for each past day with no row, oldest first, labelled
// backfilled, without Form or Weight, without a zone change, and never over a live row. Synthetic owners and values.
const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
const dayOfReadings = (day: string, i: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 450 + wobble(i, 20), method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 180, method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 55 + wobble(i, 6), method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 + wobble(i, 2) }),
];
const series = (nights: number, source = 'apple') => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source, consent_epoch: 3, truncated: false, samples: Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TODAY, -i), i)).flat() }],
});
type Row = Record<string, any>;
type Run = Readonly<{ rows: Row[]; zoneNotices: string[]; scoreReads: string[]; outcome: string }>;
// `stored` is the set of days that already hold a row; the fake writer adds to it, as the database would.
const run = async (flag: string | undefined, nights: number, over: Partial<ProducerDeps> & { stored?: Set<string>; changed?: readonly string[]; source?: string } = {}): Promise<Run> => {
  const samples = series(nights, over.source);
  const rows: Row[] = [], zoneNotices: string[] = [], scoreReads: string[] = [];
  const stored = over.stored ?? new Set<string>();
  const outcome = await produceHealthScores({
    readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
    writeContext: async payload => {
      const row = JSON.parse(payload) as Row;
      rows.push(row);
      if (row.backfilled === true && stored.has(row.day)) return { written: false, stale: true };
      stored.add(row.day);
      return { written: true, changed: over.changed ?? [] };
    },
    readScores: async day => { scoreReads.push(day); return stored.has(day) ? { scores: { day } } : { unavailable: 'no_readings' }; },
    compute: dailyScoresFor(flag),
    onZoneChange: async day => { zoneNotices.push(day); },
    ...(over.backfillLimit === undefined ? {} : { backfillLimit: over.backfillLimit }),
  }, { now: NOW, timezone: 'UTC' });
  return { rows, zoneNotices, scoreReads, outcome };
};
const live = (rows: Row[]) => rows.filter(r => r.backfilled === undefined);
const late = (rows: Row[]) => rows.filter(r => r.backfilled === true);

describe('backfilled rows: which days and what they hold', () => {
  it('writes a row for each past day older than yesterday, oldest first, beside the two live rows', async () => {
    const { rows } = await run('1', 25);
    expect(live(rows).map(r => r.day).sort()).toEqual([addDays(TODAY, -1), TODAY]);
    const days = late(rows).map(r => r.day);
    expect(days.length).toBeGreaterThan(10);
    expect(days).toEqual([...days].sort());
    expect(days.every(day => day <= addDays(TODAY, -2))).toBe(true);
    expect(new Set(days).size).toBe(days.length);
  });
  it('carries Recovery and sleep debt, and leaves Form and Weight unavailable with a reason, and no windows', async () => {
    const { rows } = await run('1', 25);
    for (const row of late(rows)) {
      expect(row.backfilled).toBe(true);
      expect(Object.keys(row.form)).toEqual(['reason']);
      expect(Object.keys(row.weight)).toEqual(['reason']);
      expect(row.recovery.score ?? row.sleep_debt.state).toBeDefined();
      expect('windows' in row || 'windows_version' in row).toBe(false);
      expect(row.tags).toEqual([]);
    }
    expect(late(rows).some(r => 'score' in r.recovery)).toBe(true);
  });
  it('labels a live row personal on the first morning when the late days already give it fourteen of its own', async () => {
    const { rows } = await run('1', 20);
    const today = live(rows).find(r => r.day === TODAY)!;
    expect(today.recovery.baseline.state).toBe('personal');
  });
  it('writes none with provisional scores off, and reads no stored row for an older day', async () => {
    const { rows, scoreReads } = await run(undefined, 25);
    expect(late(rows)).toEqual([]);
    expect(scoreReads.filter(day => day < addDays(TODAY, -1))).toEqual([]);
  });
});

describe('backfilled rows: never a change, never over a live row', () => {
  it('names no zone change and no wake for a backfilled row, whatever the writer says moved', async () => {
    const { rows, zoneNotices } = await run('1', 25, { changed: ['recovery'] });
    expect(late(rows).length).toBeGreaterThan(0);
    expect(zoneNotices).toEqual([TODAY]);
  });
  it('leaves a day that already has a row alone, and a stale answer for one costs nothing', async () => {
    const older = addDays(TODAY, -5);
    const { rows, outcome } = await run('1', 25, { stored: new Set([older]) });
    expect(late(rows).map(r => r.day)).not.toContain(older);
    expect(outcome).toBe('written');
  });
  it('does not fail the live rows when a backfilled write fails', async () => {
    const samples = series(25);
    const outcome = await produceHealthScores({
      readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
      writeContext: async payload => { if ((JSON.parse(payload) as Row).backfilled) throw new Error('database down'); return { written: true }; },
      readScores: async () => ({ unavailable: 'no_readings' }),
      compute: dailyScoresFor('1'),
    }, { now: NOW, timezone: 'UTC' });
    expect(outcome).toBe('written');
  });
});

describe('backfilled rows: bounded work that continues', () => {
  it('is thirty days a run', () => expect(BACKFILL_DAYS_PER_RUN).toBe(30));
  it('writes at most the limit, the oldest first, and the next run takes the next days', async () => {
    const stored = new Set<string>();
    const first = await run('1', 25, { backfillLimit: 5, stored });
    const firstDays = late(first.rows).map(r => r.day);
    expect(firstDays).toHaveLength(5);
    const second = await run('1', 25, { backfillLimit: 5, stored });
    const secondDays = late(second.rows).map(r => r.day);
    expect(secondDays).toHaveLength(5);
    expect(secondDays.every(day => !firstDays.includes(day) && day > firstDays.at(-1)!)).toBe(true);
  });
});

describe('backfilled rows: the written-row log', () => {
  it('logs one line for each successful write, backfilled ones included, with nothing else in it', async () => {
    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { /* not a record */ } });
    const { rows } = await run('1', 25);
    spy.mockRestore();
    const logged = lines.filter(line => line.hop === 'health_scores');
    expect(logged).toHaveLength(rows.length);
    expect(late(rows).length).toBeGreaterThan(0);
    for (const line of logged) expect(Object.keys(line).sort()).toEqual(['code', 'hop', 'provisional']);
  });
});
