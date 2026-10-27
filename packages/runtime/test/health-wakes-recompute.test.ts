import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthRecompute, type HealthRecomputeDeps } from '../src/health/recompute';
import type { HealthWakeReason } from '../src/health/wakes';

// The recompute asks the wake check once its rows are written. The producer is replaced by a stub that moves a scripted
// world from "before the run" to "after it", so each case names exactly what the stored rows held on either side. Values
// are synthetic.
const world = vi.hoisted(() => ({
  stage: 'before' as 'before' | 'after',
  outcome: 'written' as string,
  produceFails: false,
  context: { before: null as unknown, after: null as unknown },
  contextFails: false,
  debts: new Map<string, unknown>(),
  order: [] as string[],
}));
vi.mock('../src/health/producer', () => ({
  produceHealthScores: async () => {
    world.order.push('produce');
    if (world.produceFails) return 'failed';
    world.stage = 'after';
    return world.outcome;
  },
}));

const SOURCES = [{ source: 'apple', consent_epoch: 1 }];
const row = (day: string, drivers: unknown = [], over: Record<string, unknown> = {}) => ({
  context: { id: day, day, compiled_at: `${day}T03:00:00Z`, basis: SOURCES, drivers, recovery: { score: 70, zone: 'good' }, form: { score: 70, zone: 'good' }, weight: { score: 30, zone: 'moderate', algorithm_version: 'weight.candidate.v3' }, ...over },
  previous: null,
});
const debtRow = (day: string, minutes: number) => ({ scores: { day, sleep_debt: { state: 'available', debt_minutes: minutes, need_basis: 'own_average', algorithm_version: 'sleep-debt.v1', activation: 'candidate_unaccepted' } } });
const NEW_DRIVER = ['wrist temperature above usual'];

type Harness = Readonly<{ recompute: ReturnType<typeof healthRecompute>; woken: [string, readonly HealthWakeReason[]][]; contextReads: () => number; scoreReads: string[]; zone: { name: string }; clock: { at: number } }>;
const harness = (over: { enabled?: boolean } = {}): Harness => {
  const woken: [string, readonly HealthWakeReason[]][] = [], scoreReads: string[] = [], zone = { name: 'Asia/Kolkata' }, clock = { at: Date.parse('2026-10-21T08:00:00Z') };
  let reads = 0;
  const deps: HealthRecomputeDeps = {
    scheduler: { lookup: () => ({ state: 'absent' }), schedule: async () => null as never },
    now: () => clock.at, ownerZone: () => zone.name,
    producer: {
      readSeries: async () => null, writeContext: async () => null, compute: null as never,
      readScores: async day => { scoreReads.push(day); return world.debts.get(day) ?? { unavailable: 'no_readings' }; },
    },
    wakes: {
      enabled: () => over.enabled ?? true,
      readContext: async () => { reads += 1; world.order.push(`read:${world.stage}`); if (world.contextFails) throw new Error('read failed'); return world.context[world.stage]; },
      woken: async (day, reasons) => { world.order.push('woken'); woken.push([day, reasons]); },
    },
  };
  return { recompute: healthRecompute(deps), woken, contextReads: () => reads, scoreReads, zone, clock };
};

beforeEach(() => {
  world.stage = 'before'; world.outcome = 'written'; world.produceFails = false; world.contextFails = false; world.debts = new Map(); world.order = [];
  world.context = { before: row('2026-10-21'), after: row('2026-10-21') };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the wake check after a recompute', () => {
  it('reads the newest row before the run and after it, and wakes once with the reasons that the two show', async () => {
    world.context = { before: row('2026-10-21'), after: row('2026-10-21', NEW_DRIVER) };
    const { recompute, woken } = harness();
    expect(await recompute.run()).toBe('written');
    expect(woken).toEqual([['2026-10-21', ['driver_appeared']]]);
    expect(world.order).toEqual(['read:before', 'produce', 'read:after', 'woken']);
  });

  it('wakes on sleep debt building without any driver or Weight change, reading the stored rows by local day', async () => {
    world.debts = new Map([['2026-10-21', debtRow('2026-10-21', 150)], ['2026-10-20', debtRow('2026-10-20', 90)], ['2026-10-19', debtRow('2026-10-19', 40)]]);
    const { recompute, woken, scoreReads } = harness();
    await recompute.run();
    expect(woken).toEqual([['2026-10-21', ['sleep_debt_building']]]);
    expect(scoreReads).toEqual(['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18']);
  });

  it('does not wake when nothing changed', async () => {
    world.debts = new Map([['2026-10-21', debtRow('2026-10-21', 90)], ['2026-10-20', debtRow('2026-10-20', 90)], ['2026-10-19', debtRow('2026-10-19', 90)]]);
    const { recompute, woken } = harness();
    expect(await recompute.run()).toBe('written');
    expect(woken).toEqual([]);
  });

  it('wakes on nothing when the owner has withdrawn model-use consent: the read returns nothing, whatever the debt rows say', async () => {
    world.debts = new Map([['2026-10-21', debtRow('2026-10-21', 150)], ['2026-10-20', debtRow('2026-10-20', 90)], ['2026-10-19', debtRow('2026-10-19', 40)]]);
    world.context = { before: row('2026-10-21'), after: null };
    const { recompute, woken, scoreReads } = harness();
    await recompute.run();
    expect([woken, scoreReads]).toEqual([[], []]);
  });

  it('wakes on nothing when the newest row is not today\'s, or is unreadable', async () => {
    world.debts = new Map([['2026-10-21', debtRow('2026-10-21', 150)], ['2026-10-20', debtRow('2026-10-20', 90)], ['2026-10-19', debtRow('2026-10-19', 40)]]);
    for (const after of [row('2026-10-20', NEW_DRIVER), row('2026-10-22', NEW_DRIVER), { context: { day: 'x' } }, 'row', null]) {
      world.stage = 'before'; world.context = { before: row('2026-10-20'), after };
      const { recompute, woken } = harness();
      await recompute.run();
      expect(woken, JSON.stringify(after)).toEqual([]);
    }
  });

  it('wakes on nothing for a row with the fields missing', async () => {
    world.context = { before: row('2026-10-21', ['breathing rate above usual']), after: row('2026-10-21', undefined, { weight: undefined, recovery: undefined, form: undefined }) };
    const { recompute, woken } = harness();
    await recompute.run();
    expect(woken).toEqual([]);
  });

  it('asks only after a row was written, never after a stale, refused, unconsented or empty outcome', async () => {
    world.context = { before: row('2026-10-21'), after: row('2026-10-21', NEW_DRIVER) };
    for (const outcome of ['stale', 'refused', 'no_consent', 'no_readings']) {
      world.stage = 'before'; world.outcome = outcome; world.order = [];
      const { recompute, woken } = harness();
      expect(await recompute.run()).toBe(outcome);
      expect(woken, outcome).toEqual([]);
      expect(world.order, outcome).not.toContain('read:after');
    }
  });

  it('reads nothing at all when health proposals are off', async () => {
    world.context = { before: row('2026-10-21'), after: row('2026-10-21', NEW_DRIVER) };
    const { recompute, woken, contextReads } = harness({ enabled: false });
    expect(await recompute.run()).toBe('written');
    expect([woken, contextReads()]).toEqual([[], 0]);
  });

  it('never fails or retries the recompute because the wake check could not read', async () => {
    world.contextFails = true;
    const { recompute, woken } = harness();
    expect(await recompute.run()).toBe('written');
    expect(woken).toEqual([]);
  });

  it('never fails the recompute because the wake could not be recorded', async () => {
    world.context = { before: row('2026-10-21'), after: row('2026-10-21', NEW_DRIVER) };
    const h = harness();
    const failing = healthRecompute({
      scheduler: { lookup: () => ({ state: 'absent' }), schedule: async () => null as never }, now: () => h.clock.at, ownerZone: () => h.zone.name,
      producer: { readSeries: async () => null, writeContext: async () => null, compute: null as never, readScores: async () => null },
      wakes: { enabled: () => true, readContext: async () => world.context[world.stage], woken: async () => { throw new Error('storage failed'); } },
    });
    expect(await failing.run()).toBe('written');
  });

  it('still fails a recompute that failed, and wakes nothing', async () => {
    world.produceFails = true;
    const { recompute, woken } = harness();
    await expect(recompute.run()).rejects.toThrow('health recompute failed');
    expect(woken).toEqual([]);
    expect(world.order).not.toContain('read:after');
  });

  it('names no value in anything it prints', async () => {
    world.contextFails = true;
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    await harness().recompute.run();
    expect(lines.join('\n')).not.toMatch(/\d/);
  });
});

describe('the owner\'s day, across a DST change and a change of zone', () => {
  const owingDebt = (...days: string[]) => { world.debts = new Map(days.map((day, i) => [day, debtRow(day, 150 - i * 55)])); };

  it('steps back by calendar days on the 25-hour day, when 24 hours back lands on the same local day', async () => {
    // 23:30 in New York on 1 November 2026, the day the clocks fall back: 24 hours earlier is still that day.
    const days = ['2026-11-01', '2026-10-31', '2026-10-30'];
    owingDebt(...days);
    world.context = { before: row('2026-10-31'), after: row('2026-11-01') };
    const { recompute, woken, scoreReads, zone, clock } = harness();
    zone.name = 'America/New_York'; clock.at = Date.parse('2026-11-02T04:30:00Z');
    await recompute.run();
    expect(woken).toEqual([['2026-11-01', ['sleep_debt_building']]]);
    expect(scoreReads).toEqual(['2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29']);
  });

  it('steps back by calendar days on the 23-hour day too, and just after midnight', async () => {
    owingDebt('2026-03-08', '2026-03-07', '2026-03-06');
    world.context = { before: row('2026-03-07'), after: row('2026-03-08') };
    const { recompute, woken, zone, clock } = harness();
    zone.name = 'America/New_York'; clock.at = Date.parse('2026-03-08T05:05:00Z'); // 00:05 EST, 23 hours before the day ends
    await recompute.run();
    expect(woken).toEqual([['2026-03-08', ['sleep_debt_building']]]);
  });

  it('names the owner\'s today by the zone it is in when the run happens', async () => {
    world.context = { before: row('2026-10-21'), after: row('2026-10-22', NEW_DRIVER) };
    const { recompute, woken, zone, clock } = harness();
    clock.at = Date.parse('2026-10-21T20:00:00Z'); // 16:00 on the 21st in New York, 01:30 on the 22nd in Kolkata
    zone.name = 'America/New_York';
    await recompute.run();
    expect(woken).toEqual([]);
    world.stage = 'before'; zone.name = 'Asia/Kolkata';
    await recompute.run();
    expect(woken).toEqual([['2026-10-22', ['driver_appeared']]]);
  });

  it('compares nothing across a zone change that leaves the row two days behind', async () => {
    world.context = { before: row('2026-10-19'), after: row('2026-10-22', NEW_DRIVER) };
    const { recompute, woken, clock } = harness();
    clock.at = Date.parse('2026-10-21T20:00:00Z'); // 22 October in Kolkata
    await recompute.run();
    expect(woken).toEqual([]);
  });
});
