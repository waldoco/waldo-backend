import { describe, expect, it } from 'vitest';
import { produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { computeDailyScores, dailyScoresFor } from '../src/health/scores';

// The owner's stated sleep need in the producer. It reaches the score engine only when the coaching switch hands the producer
// a settings reader, and a change of need is never told to the health trigger as a change in the body. Every value is synthetic.
const NOW = Date.parse('2026-03-30T12:00:00Z');
const TODAY = '2026-03-30';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
type Sample = Record<string, unknown>;
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const night = (day: string): Sample => ({ signal: 'sleep_duration', day, start_at: at(addDays(day, -1), 23), end_at: at(day, 6), utc_offset_minutes: 0, timezone: 'UTC', value: 400, method: 'asleep_duration' });
const overnight = (day: string): Sample[] => [
  { signal: 'sleep_midpoint', day, start_at: at(addDays(day, -1), 23), end_at: at(day, 6), utc_offset_minutes: 0, timezone: 'UTC', value: 150, method: 'sleep_midpoint' },
  { signal: 'overnight_hrv', day, start_at: at(addDays(day, -1), 23), end_at: at(day, 6), utc_offset_minutes: 0, timezone: 'UTC', value: 50, method: 'rmssd' },
  { signal: 'resting_heart_rate', day, start_at: at(day, 3), end_at: at(day, 4), utc_offset_minutes: 0, timezone: 'UTC', value: 60 },
];
const worn = (day: string): Sample => ({ signal: 'heart_rate_window', day, start_at: at(day, 9), end_at: at(day, 10), utc_offset_minutes: 0, timezone: 'UTC', value: 70, min: 60, max: 90, n_samples: 20 });
const series = { access: 'granted', read_at: '2026-03-30T12:00:00.000000Z', sources: [{ source: 'apple', consent_epoch: 3, truncated: false,
  samples: Array.from({ length: 20 }, (_, i) => addDays(TODAY, -i)).flatMap(day => [night(day), ...overnight(day), worn(day)]) }] };

const run = async (extra: Partial<ProducerDeps> = {}, changed: readonly string[] = []) => {
  const needs: (number | null)[] = [], writes: Record<string, unknown>[] = [], notices: string[] = [];
  const deps: ProducerDeps = {
    readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(entry => range.signals.includes(String(entry.signal))) })) }),
    writeContext: async payload => { writes.push(JSON.parse(payload)); return { written: true, changed }; },
    compute: input => { needs.push(input.sleepNeedMinutes); return computeDailyScores(input); },
    onZoneChange: async day => { notices.push(day); },
    ...extra,
  };
  const outcome = await produceHealthScores(deps, { now: NOW, timezone: 'UTC' });
  return { outcome, needs, writes, notices };
};
const settings = (minutes: number | null, updatedAt: string | null = '2026-03-29T08:00:00.000Z') => async () => ({ sleep_need_minutes: minutes, updated_at: updatedAt });

describe('producer: the owner\'s stated sleep need', () => {
  it('computes on the owner\'s own nights when no settings reader is given (the coaching switch is off)', async () => {
    const { needs, writes } = await run();
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(needs)).toEqual(new Set([null]));
  });

  it('computes every row on the stated need when one is set, and on the owner\'s nights when it is cleared', async () => {
    const set = await run({ readSettings: settings(480) });
    expect(set.writes.length).toBeGreaterThan(0);
    expect(new Set(set.needs)).toEqual(new Set([480]));
    const cleared = await run({ readSettings: settings(null, null) });
    expect(new Set(cleared.needs)).toEqual(new Set([null]));
  });

  it('computes the late days it backfills on the stated need too', async () => {
    const provisional = dailyScoresFor('1');
    const { writes } = await run({ readSettings: settings(480), readHistory: async () => ({ unavailable: 'no_readings' }), compute: input => { expect(input.sleepNeedMinutes).toBe(480); return provisional(input); } });
    const late = writes.filter(row => row.backfilled === true);
    const bases = late.map(row => (row.sleep_debt as Record<string, unknown> | undefined)?.need_basis).filter(basis => basis !== undefined);
    expect(bases.length).toBeGreaterThan(0);
    expect(new Set(bases)).toEqual(new Set(['owner_confirmed']));
  });

  it('writes nothing when the settings read fails, rather than flip a row to another need', async () => {
    for (const answer of [async () => { throw new Error('down'); }, async () => null, async () => ({ error: 'not_linked' }), async () => ({ sleep_need_minutes: 900, updated_at: null })]) {
      const { outcome, writes } = await run({ readSettings: answer });
      expect(outcome).toBe('failed');
      expect(writes).toEqual([]);
    }
  });

  it('tells the trigger nothing when the need changed since today\'s row was compiled, so a new need never reads as a change in the body', async () => {
    const stored = (compiledAt: string) => async (day: string) => ({ scores: { day, compiled_at: compiledAt } });
    const moved = await run({ readSettings: settings(480, '2026-03-30T11:00:00.000Z'), readScores: stored('2026-03-30T09:00:00.000Z') }, ['recovery']);
    expect(moved.notices).toEqual([]);
    const body = await run({ readSettings: settings(480, '2026-03-29T08:00:00.000Z'), readScores: stored('2026-03-30T09:00:00.000Z') }, ['recovery']);
    expect(body.notices).toEqual([TODAY]);
  });
});
