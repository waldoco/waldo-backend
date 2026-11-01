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
    // A row compiled at the very instant of the change may hold either need.
    const tied = await run({ readSettings: settings(480, '2026-03-30T09:00:00.000Z'), readScores: stored('2026-03-30T09:00:00.000Z') }, ['recovery']);
    expect(tied.notices).toEqual([]);
  });
});

// A need saved while a recompute runs: the run read the old need, so the row it would write for today is on the old need
// though stamped after the change, and the next run's fence, which keys on when today's row was compiled, would let a
// need-only zone move through. The run leaves today's row to the recompute the save asked for.
describe('producer: a need saved while it runs', () => {
  const T0 = '2026-03-30T08:00:00.000Z', T1 = '2026-03-30T11:00:00.000Z';
  const world = () => {
    const rows = new Map<string, Record<string, unknown>>(), notices: string[] = [];
    const clock = { at: T0 }, need = { answers: [] as unknown[], current: { sleep_need_minutes: null as number | null, updated_at: null as string | null } };
    const deps = (changed: readonly string[]): ProducerDeps => ({
      readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(entry => range.signals.includes(String(entry.signal))) })) }),
      writeContext: async payload => { const row = JSON.parse(payload); rows.set(row.day, { ...row, compiled_at: clock.at }); return { written: true, changed }; },
      readScores: async day => (rows.has(day) ? { scores: rows.get(day) } : { unavailable: 'no_readings' }),
      readSettings: async () => need.answers.shift() ?? need.current,
      compute: computeDailyScores,
      onZoneChange: async day => { notices.push(day); },
    });
    return { rows, notices, clock, need, deps };
  };

  it('writes no row for today on the need it read, and the next run fences the move the new need makes', async () => {
    const w = world();
    expect(await produceHealthScores(w.deps([]), { now: NOW, timezone: 'UTC' })).toBe('written');
    // The owner saves 540 after this run read the settings and before it writes today's row.
    w.need.current = { sleep_need_minutes: 540, updated_at: T1 };
    w.need.answers = [{ sleep_need_minutes: null, updated_at: null }];
    w.clock.at = '2026-03-30T11:00:05.000Z';
    await produceHealthScores(w.deps([]), { now: NOW, timezone: 'UTC' });
    expect(w.rows.get(TODAY)?.compiled_at).toBe(T0);
    w.clock.at = '2026-03-30T11:01:00.000Z';
    expect(await produceHealthScores(w.deps(['recovery']), { now: NOW, timezone: 'UTC' })).toBe('written');
    expect((w.rows.get(TODAY)?.sleep_debt as Record<string, unknown>).need_basis).toBe('owner_confirmed');
    expect(w.notices).toEqual([]);
  });

  // A need that moved is redone by the recompute its save asked for, so the run is not a failure. A read that failed asked
  // for nothing, so the run fails and the recompute's retry redoes today.
  it('leaves today\'s row and the late days alone when the second read fails or the need moved, and still writes yesterday\'s', async () => {
    for (const [second, outcome] of [[new Error('down'), 'failed'], [{ sleep_need_minutes: 540, updated_at: T1 }, 'written']] as const) {
      const w = world(), late: unknown[] = [];
      w.need.answers = [{ sleep_need_minutes: null, updated_at: null }];
      w.need.current = second as never;
      const deps = { ...w.deps([]), compute: dailyScoresFor('1'), readHistory: async () => ({ unavailable: 'no_readings' }) };
      const settings = deps.readSettings!;
      deps.readSettings = async () => { const answer = await settings(); if (answer instanceof Error) throw answer; return answer; };
      const writeContext = deps.writeContext;
      deps.writeContext = async payload => { if (JSON.parse(payload).backfilled === true) late.push(payload); return writeContext(payload); };
      expect(await produceHealthScores(deps, { now: NOW, timezone: 'UTC' }), String(second)).toBe(outcome);
      expect([...w.rows.keys()], String(second)).toEqual([addDays(TODAY, -1)]);
      expect(late, String(second)).toEqual([]);
    }
  });

  it('writes today as usual when the need it read is still the need, saved again or not', async () => {
    const w = world();
    w.need.answers = [{ sleep_need_minutes: 540, updated_at: T0 }];
    w.need.current = { sleep_need_minutes: 540, updated_at: T1 };
    w.clock.at = '2026-03-30T11:00:05.000Z';
    expect(await produceHealthScores(w.deps([]), { now: NOW, timezone: 'UTC' })).toBe('written');
    expect(w.rows.get(TODAY)?.compiled_at).toBe('2026-03-30T11:00:05.000Z');
  });
});
