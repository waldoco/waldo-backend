import { afterEach, describe, expect, it, vi } from 'vitest';

// A curve that cannot be computed costs the owner the curve and nothing else: today's row is still written.
vi.mock('../src/health/scores/form-curve', () => ({ formCurveRow: () => { throw new Error('curve failed for 72'); } }));
const { produceHealthScores } = await import('../src/health/producer');
const { dailyScoresFor } = await import('../src/health/scores');

const NOW = Date.parse('2026-03-20T14:30:00Z');
const TODAY = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const dayOfReadings = (day: string, i: number, through: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 450 + wobble(i, 20), method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 180 + wobble(i, 15), method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 55 + wobble(i, 6), method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 + wobble(i, 2) }),
  ...Array.from({ length: through }, (_, h) => [
    sample('heart_rate_window', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 70 + wobble(h + i, 2) }),
    sample('movement_duration', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 12 + wobble(h + i, 2) }),
  ]).flat(),
];
const samples = { access: 'granted', read_at: '2026-03-20T14:30:00.000123Z', sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: 20 }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, i === 0 ? 15 : 24)).flat() }] };
afterEach(() => vi.restoreAllMocks());

describe('a curve that throws', () => {
  it('still writes today\'s row without the curve, and says only that it failed', async () => {
    const rows: Record<string, unknown>[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcome = await produceHealthScores({
      readSeries: async range => ({ ...samples, sources: samples.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }),
      writeContext: async payload => { rows.push(JSON.parse(payload) as Record<string, unknown>); return { written: true }; },
      compute: dailyScoresFor('1'), formCurve: '1',
    }, { now: NOW, timezone: 'UTC' });
    expect(outcome).toBe('written');
    const today = rows.find(r => r.day === TODAY)!;
    expect(today.form).toMatchObject({ score: expect.any(Number) });
    expect('form_curve' in today || 'stress_trend' in today).toBe(false);
    expect(error).toHaveBeenCalledWith('health form curve failed');
    expect([...error.mock.calls, ...log.mock.calls].flat().join(' ')).not.toMatch(/72|boom/);
  });
});
