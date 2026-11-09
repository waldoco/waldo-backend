import { describe, expect, it } from 'vitest';
import { produceHealthScores } from '../src/health/producer';
import { computeDailyScores, dailyScoresFor } from '../src/health/scores';

// The derived row with provisional scores on: today's energy windows and the sleep debt trend, written beside the scores. A
// synthetic owner with a steady wake and a gentle daily rhythm of heart rate, so windows exist.
const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
// Two peaks and a dip across the waking hours, flat trend: the same shape every day.
const rhythm = (h: number): number => 70 + ((h >= 3 && h <= 5) || (h >= 13 && h <= 15) ? 6 : 0) - (h >= 8 && h <= 10 ? 12 : 0);
const dayOfReadings = (day: string, nightMinutes: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: nightMinutes, method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 180, method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 55, method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 }),
  ...Array.from({ length: 16 }, (_, k) => [
    sample('heart_rate_window', day, { start_at: at(day, 7 + k), end_at: at(day, 8 + k), value: rhythm(k + 1) }),
    sample('movement_duration', day, { start_at: at(day, 7 + k), end_at: at(day, 8 + k), value: 2 }),
  ]).flat(),
];
const series = (nights: number, source = 'apple', nightMinutes: (i: number) => number = () => 450) => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source, consent_epoch: 3, truncated: false, samples: Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TODAY, -i), nightMinutes(i))).flat() }],
});
type Row = Record<string, any>;
const written = async (flag: string | undefined, samples: unknown): Promise<Row[]> => {
  const rows: Row[] = [];
  await produceHealthScores({
    readSeries: async range => { const s = samples as ReturnType<typeof series>; return { ...s, sources: s.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }; },
    writeContext: async payload => { rows.push(JSON.parse(payload) as Row); return { written: true }; },
    compute: dailyScoresFor(flag),
  }, { now: NOW, timezone: 'UTC' });
  return rows;
};

describe('the derived row: energy windows and the sleep debt trend', () => {
  it('writes today\'s windows with their version, as the engine computed them, and none on yesterday\'s row', async () => {
    const rows = await written('1', series(20));
    const today = rows.find(r => r.day === TODAY)!, yesterday = rows.find(r => r.day === addDays(TODAY, -1))!;
    expect(today.windows_version).toBe('energy-windows.v1');
    expect(today.windows.length).toBeGreaterThan(0);
    expect(today.windows.length).toBeLessThanOrEqual(4);
    for (const w of today.windows) expect(Object.keys(w).sort()).toEqual(['end', 'kind', 'start']);
    for (const w of today.windows) expect(w.start < w.end && /^\d\d:(00|30)$/.test(w.start) && /^\d\d:(00|30)$/.test(w.end)).toBe(true);
    expect('windows' in yesterday || 'windows_version' in yesterday).toBe(false);
  });
  it('writes the windows and the version together, or neither', async () => {
    for (const row of await written('1', series(5))) expect('windows' in row).toBe('windows_version' in row);
    const none = (await written('1', series(5))).find(r => r.day === TODAY)!;
    expect(none.windows).toBeUndefined();
  });
  it('writes the trend on the sleep debt of a provisional row: steady for steady nights, building for shortening ones', async () => {
    const steady = (await written('1', series(20))).find(r => r.day === TODAY)!;
    expect(steady.sleep_debt.trend).toBe('steady');
    const shortening = (await written('1', series(20, 'apple', i => (i === 0 ? 330 : i === 1 ? 400 : 480)))).find(r => r.day === TODAY)!;
    expect(shortening.sleep_debt.state).toBe('available');
    expect(shortening.sleep_debt.trend).toBe('building');
    const easing = (await written('1', series(20, 'apple', i => (i === 2 ? 240 : i < 2 ? 560 : 480)))).find(r => r.day === TODAY)!;
    expect(easing.sleep_debt.trend).toBe('easing');
  });
  it('writes no trend on a partial sleep debt, since nothing can be said', async () => {
    const row = (await written('1', series(4))).find(r => r.day === TODAY)!;
    expect(row.sleep_debt.state).toBe('partial');
    expect('trend' in row.sleep_debt).toBe(false);
  });
  it('adds nothing with provisional scores off: no windows, no version, no trend', async () => {
    for (const row of await written(undefined, series(20))) {
      expect(JSON.stringify(row)).not.toMatch(/windows|trend/);
    }
  });
  it('writes no windows from a source nothing has validated', async () => {
    for (const row of await written('1', series(20, 'fitbit'))) expect('windows' in row).toBe(false);
  });
  it('agrees with the engine: the row carries what compute returned', async () => {
    const seen = new Map<string, ReturnType<typeof computeDailyScores>>();
    const base = dailyScoresFor('1');
    const rows: Row[] = [];
    const samples = series(20);
    await produceHealthScores({
      readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
      writeContext: async payload => { rows.push(JSON.parse(payload) as Row); return { written: true }; },
      compute: input => { const out = base(input); seen.set(input.targetDay, out); return out; },
    }, { now: NOW, timezone: 'UTC' });
    const today = rows.find(r => r.day === TODAY)!;
    expect(today.windows).toEqual(seen.get(TODAY)!.windows);
  });
});
