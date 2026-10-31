import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthRecompute } from '../src/health/recompute';
import { dailyScoresFor } from '../src/health/scores';
import { detectHealthWakes, healthSnapshot, type HealthWakeReason } from '../src/health/wakes';

// A change of the owner's stated sleep need is not a change in their body, on any wake path. The engine that writes no debt
// direction word is judged by the stored figures of the last four days, so rows computed before and after the change must
// never be read as one run. The real recompute, producer and engine write into an in-memory row store, as the database
// would. Every value is synthetic.
const TODAY = '2026-03-30';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const noonOf = (day: string) => Date.parse(`${day}T12:00:00Z`);

type Need = { minutes: number | null; changedAt: number | null; reads: number; failRead: number };
const world = (nights: (day: string) => number, engine: string | undefined) => {
  const rows = new Map<string, Record<string, unknown>>(), woken: [string, readonly HealthWakeReason[]][] = [];
  const clock = { at: noonOf(addDays(TODAY, -10)) }, need: Need = { minutes: null, changedAt: null, reads: 0, failRead: 0 };
  const today = () => new Date(clock.at).toISOString().slice(0, 10);
  const samples = () => Array.from({ length: 30 }, (_, i) => addDays(today(), -i)).flatMap(day => [
    { signal: 'sleep_duration', day, start_at: at(addDays(day, -1), 23), end_at: at(day, 6), utc_offset_minutes: 0, timezone: 'UTC', value: nights(day), method: 'asleep_duration' },
    { signal: 'sleep_midpoint', day, start_at: at(addDays(day, -1), 23), end_at: at(day, 6), utc_offset_minutes: 0, timezone: 'UTC', value: 150, method: 'sleep_midpoint' },
  ]);
  const scores = (day: string) => rows.has(day) ? { scores: rows.get(day) } : { unavailable: 'no_readings' };
  const recompute = healthRecompute({
    scheduler: { lookup: () => ({ state: 'absent' }), schedule: async () => null as never },
    now: () => clock.at, ownerZone: () => 'UTC',
    producer: {
      readSeries: async range => ({ access: 'granted', read_at: new Date(clock.at).toISOString().replace('Z', '000Z'), sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: samples().filter(s => range.signals.includes(s.signal)) }] }),
      writeContext: async payload => { const row = JSON.parse(payload); rows.set(row.day, { ...row, compiled_at: new Date(clock.at).toISOString() }); return { written: true, changed: [] }; },
      readScores: async day => scores(day),
      readSettings: async () => { need.reads += 1; if (need.reads === need.failRead) throw new Error('settings unreadable'); return { sleep_need_minutes: need.minutes, updated_at: need.changedAt === null ? null : new Date(need.changedAt).toISOString() }; },
      compute: dailyScoresFor(engine),
    },
    wakes: {
      enabled: () => true,
      readContext: async () => (rows.has(today()) ? { context: rows.get(today()) } : null),
      woken: async (day, reasons) => { woken.push([day, reasons]); },
    },
  });
  // The owner states a need at this moment; the next run computes on it.
  const state = (minutes: number | null) => { need.minutes = minutes; need.changedAt = clock.at; clock.at += 60_000; };
  const runOn = async (day: string) => { clock.at = Math.max(clock.at, noonOf(day)); await recompute.run(); };
  const debt = (day: string) => (rows.get(day)?.sleep_debt as Record<string, unknown> | undefined);
  return { recompute, woken, runOn, state, debt, clock, need };
};

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe('a change of the stated sleep need never wakes the trigger as sleep debt building', () => {
  // Steady nights, and a shorter one today: on the owner's own average the earlier rows show no debt, and on the stated need
  // every row would. Only the need moved the figures between the rows.
  const nights = (day: string) => (day === TODAY ? 330 : 400);

  it('stays asleep when rows computed before the change meet rows computed after it, on every later recompute that day', async () => {
    const run = world(nights, '0');
    await run.runOn(addDays(TODAY, -2));
    expect([run.debt(addDays(TODAY, -3)), run.debt(addDays(TODAY, -2))].map(d => d?.need_basis)).toEqual(['own_average', 'own_average']);
    run.state(540);
    await run.runOn(TODAY);
    expect([run.debt(addDays(TODAY, -1)), run.debt(TODAY)].map(d => d?.need_basis)).toEqual(['owner_confirmed', 'owner_confirmed']);
    await run.runOn(TODAY);
    expect(run.woken).toEqual([]);
  });

  it('stays asleep when a stated need is replaced by another, which the rows themselves cannot tell apart', async () => {
    const run = world(nights, '0');
    run.state(420);
    await run.runOn(addDays(TODAY, -2));
    run.state(540);
    await run.runOn(TODAY);
    expect(run.woken).toEqual([]);
  });

  it('still wakes on debt that builds night after night on one need', async () => {
    const shrinking = (day: string) => ({ [TODAY]: 300, [addDays(TODAY, -1)]: 330 } as Record<string, number>)[day] ?? 400;
    const run = world(shrinking, '0');
    run.state(540);
    await run.runOn(addDays(TODAY, -2));
    await run.runOn(TODAY);
    expect(run.woken).toEqual([[TODAY, ['sleep_debt_building']]]);
  });

  it('asks no debt question when the need cannot be read after the rows are written', async () => {
    const shrinking = (day: string) => ({ [TODAY]: 300, [addDays(TODAY, -1)]: 330 } as Record<string, number>)[day] ?? 400;
    const run = world(shrinking, '0');
    run.state(540);
    await run.runOn(addDays(TODAY, -2));
    run.need.failRead = run.need.reads + 2;
    await run.runOn(TODAY);
    expect(run.debt(TODAY)?.need_basis).toBe('owner_confirmed');
    expect(run.woken).toEqual([]);
  });
});

describe('the debt figures across a change, read from the rows alone', () => {
  const debtRow = (day: string, minutes: number, basis: string, compiledAt: string) => ({ scores: { day, compiled_at: compiledAt, sleep_debt: { state: 'available', debt_minutes: minutes, need_basis: basis, algorithm_version: 'sleep-debt.v1', activation: 'candidate_unaccepted' } } });
  const after = healthSnapshot({ context: { day: TODAY, basis: [{ source: 'apple', consent_epoch: 1 }], drivers: [] } })!;
  const wakes = (rows: Record<string, unknown>, needChangedAt?: number | null | 'unknown') =>
    detectHealthWakes({ before: null, after, today: TODAY, readDebt: async day => rows[day] ?? { unavailable: 'no_readings' }, ...(needChangedAt === undefined ? {} : { needChangedAt }) });
  const rising = (basis: (back: number) => string) => Object.fromEntries([0, 1, 2].map(back => {
    const day = addDays(TODAY, -back);
    return [day, debtRow(day, 150 - 50 * back, basis(back), `${day}T08:00:00.000Z`)];
  }));

  it('reads a step between rows of different need bases as no step, even with no change time to go by', async () => {
    expect(await wakes(rising(() => 'own_average'))).toEqual(['sleep_debt_building']);
    expect(await wakes(rising(back => (back === 2 ? 'own_average' : 'owner_confirmed')))).toEqual([]);
  });

  it('leaves the debt question unasked when the time of the change could not be read', async () => {
    expect(await wakes(rising(() => 'owner_confirmed'), 'unknown')).toEqual([]);
    expect(await wakes(rising(() => 'owner_confirmed'), Date.parse(`${addDays(TODAY, -5)}T08:00:00.000Z`))).toEqual(['sleep_debt_building']);
  });

  it('puts a row compiled at the instant of the change on neither side', async () => {
    // Today's row was compiled at the instant the need changed, the two before it earlier: they may hold another need.
    expect(await wakes(rising(() => 'owner_confirmed'), Date.parse(`${TODAY}T08:00:00.000Z`))).toEqual([]);
    expect(await wakes(rising(() => 'owner_confirmed'), Date.parse(`${TODAY}T08:00:00.001Z`))).toEqual(['sleep_debt_building']);
  });
});
