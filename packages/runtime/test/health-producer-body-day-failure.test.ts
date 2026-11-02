import { afterEach, describe, expect, it, vi } from 'vitest';

// A computation that cannot be done costs the owner that one key and nothing else: today's row is still written, and the only
// trace is a tag that holds no value. Each of the three throws a message carrying a number that must not reach a log.
vi.mock('../src/health/scores/day-load', () => ({ dayLoad: () => { throw new Error('load failed for 78.4'); } }));
vi.mock('../src/health/scores/form-curve', () => ({ formCurve: () => { throw new Error('curve failed for 64'); } }));
vi.mock('../src/health/scores/stress-curve', () => ({ stressCurve: () => { throw new Error('stress failed for 71'); } }));
const { produceHealthScores } = await import('../src/health/producer');
const { dailyScoresFor } = await import('../src/health/scores');

const TODAY = '2026-03-20';
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const at = (d: string, hour: number) => `${d}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const sample = (signal: string, d: string, over: Record<string, unknown>) => ({ signal, day: d, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const samples = Array.from({ length: 20 }, (_, i) => {
  const d = day(i);
  return [
    sample('sleep_duration', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 450 + i, method: 'asleep_duration' }),
    sample('sleep_midpoint', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 180 + i, method: 'sleep_midpoint' }),
    sample('overnight_hrv', d, { start_at: at(day(i + 1), 23), end_at: at(d, 7), value: 55 + i, method: 'rmssd' }),
    sample('resting_heart_rate', d, { start_at: at(d, 3), end_at: at(d, 4), value: 56 + i }),
    ...Array.from({ length: i === 0 ? 10 : 16 }, (_, k) => 4 + k).flatMap(h => [
      sample('heart_rate_window', d, { start_at: at(d, h), end_at: at(d, h + 1), value: 60 + (i + h) % 5 }),
      sample('movement_duration', d, { start_at: at(d, h), end_at: at(d, h + 1), value: 2 }),
      sample('daylight_duration', d, { start_at: at(d, h), end_at: at(d, h + 1), value: 20 + ((i + h) % 3) }),
    ]),
  ];
}).flat();
afterEach(() => vi.restoreAllMocks());

describe('three computations that throw', () => {
  it('still write both rows without them, and say only that each failed', async () => {
    const rows: Record<string, unknown>[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcome = await produceHealthScores({
      readSeries: async range => ({ access: 'granted', read_at: `${TODAY}T14:30:00.000123Z`, sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: samples.filter(e => range.signals.includes(String(e.signal))) }] }),
      writeContext: async payload => { rows.push(JSON.parse(payload) as Record<string, unknown>); return { written: true }; },
      compute: dailyScoresFor('1'), dayLoad: true, formCurve: true, stressCurve: true,
    }, { now: Date.parse(`${TODAY}T14:30:00Z`), timezone: 'UTC' });
    expect(outcome).toBe('written');
    expect(rows.map(row => row.day).sort()).toEqual([day(1), TODAY]);
    for (const row of rows) {
      expect(row.recovery).toMatchObject({ score: expect.any(Number) });
      expect(Object.keys(row).some(key => ['day_load', 'form_curve', 'stress_curve'].includes(key))).toBe(false);
    }
    const said = [...error.mock.calls, ...log.mock.calls].flat().join(' ');
    expect(said).toContain('health day load failed');
    expect(said).toContain('health form curve failed');
    expect(said).toContain('health stress curve failed');
    expect(said).not.toMatch(/78\.4|64|71/);
  });
});
