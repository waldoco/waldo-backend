import { afterEach, describe, expect, it, vi } from 'vitest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// The one line the producer logs when it writes a derived row: that it wrote, and whether a written pillar was provisional.
// Nothing of the owner, the day or any value. Synthetic owners.
const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const dayOfReadings = (day: string, i: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 450 + ((i * 7919) % 13 - 6) * 3, method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 180, method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 55 + (i % 5), method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 + (i % 3) }),
];
const series = (nights: number) => ({
  access: 'granted', read_at: READ_AT,
  sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TODAY, -i), i)).flat() }],
});
const run = async (flag: string | undefined, nights: number, answer: unknown = { written: true }) => {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { /* not a record */ } });
  const samples = series(nights);
  const outcome = await produceHealthScores({
    readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
    writeContext: async () => answer,
    compute: dailyScoresFor(flag),
  }, { now: NOW, timezone: 'UTC' });
  spy.mockRestore();
  return { outcome, logged: lines.filter(line => line.hop === 'health_scores') };
};
afterEach(() => vi.restoreAllMocks());

describe('the producer logs a written row', () => {
  it('as exactly its hop, the code written and whether it was provisional, once per successful write', async () => {
    const { logged } = await run('1', 5);
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(Object.keys(line).sort()).toEqual(['code', 'hop', 'provisional']);
      expect(line).toMatchObject({ hop: 'health_scores', code: 'written' });
      expect(typeof line.provisional).toBe('boolean');
    }
  });
  it('says provisional while a written pillar leans on the prior, and not once the baseline is personal', async () => {
    expect((await run('1', 3)).logged.map(line => line.provisional)).toEqual([true, true]);
    expect((await run('1', 25)).logged.map(line => line.provisional)).toEqual([false, false]);
  });
  it('says not provisional for a row written with provisional scores off', async () => {
    const { logged } = await run(undefined, 25);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every(line => line.provisional === false)).toBe(true);
  });
  it('writes no line for a write that was refused, stale or failed', async () => {
    for (const answer of [{ error: 'invalid_request' }, { error: 'consent_required' }, { written: false, stale: true }, null]) {
      expect((await run('1', 5, answer)).logged, JSON.stringify(answer)).toEqual([]);
    }
  });
  it('carries no day, value or count: the whole line has no digit', async () => {
    const { logged } = await run('1', 5);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toMatch(/\d/);
  });
});
