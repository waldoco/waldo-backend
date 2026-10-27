import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STEADY_SCORE_MOVE } from '../src/health/scores/zones';
import { detectHealthWakes, healthSnapshot, type HealthWakeReason } from '../src/health/wakes';

// What changed in the owner's stored rows, decided from the rows alone. Every row here is synthetic: a figure is a plain
// number that no real reading is meant to match, and a driver is one of the closed phrases.
const TODAY = '2026-10-21';
const SOURCES = [{ source: 'apple', consent_epoch: 1 }];
const LOAD_NOW = 30;

const pillar = (zone: string, score: number) => ({ score, zone, algorithm_version: 'p.candidate.v1', activation: 'candidate_unaccepted' });
// The model-use read of the newest row, as the database answers it.
const context = (day: string, over: Record<string, unknown> = {}) => ({
  context: {
    id: `ctx-${day}`, day, compiled_at: `${day}T03:00:00Z`, basis: SOURCES, confidence: 0.8, freshness: 'fresh', tags: [], drivers: [] as string[],
    recovery: pillar('good', 70), form: pillar('good', 70), weight: { ...pillar('moderate', LOAD_NOW), algorithm_version: 'weight.candidate.v3' },
    ...over,
  },
  previous: null,
});
const snapshot = (day: string, over: Record<string, unknown> = {}) => healthSnapshot(context(day, over))!;
const loadScore = (score: number, zone = 'moderate', version = 'weight.candidate.v3') => ({ weight: { score, zone, algorithm_version: version, activation: 'candidate_unaccepted' } });

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
type Debt = { minutes: number; version?: string; trend?: unknown } | 'partial' | 'unavailable' | null;
// The stored row for each day back from today, newest first; null is a day with no row.
const debts = (...days: Debt[]) => {
  const reads: string[] = [];
  const readDebt = async (day: string): Promise<unknown> => {
    reads.push(day);
    const spot = days[Date.parse(`${TODAY}T00:00:00Z`) / 86_400_000 - Date.parse(`${day}T00:00:00Z`) / 86_400_000];
    if (spot === undefined || spot === null) return { unavailable: 'no_readings' };
    const sleep_debt = spot === 'unavailable' ? { state: 'unavailable', reason: 'missing_sleep' }
      : spot === 'partial' ? { state: 'partial', confidence: 0.5, algorithm_version: 'sleep-debt.v1', activation: 'candidate_unaccepted' }
        : { state: 'available', debt_minutes: spot.minutes, need_basis: 'own_average', algorithm_version: spot.version ?? 'sleep-debt.v1', activation: 'candidate_unaccepted', ...('trend' in spot ? { trend: spot.trend } : {}) };
    return { scores: { day, timezone: 'Asia/Kolkata', compiled_at: `${day}T03:00:00Z`, freshness: 'fresh', sleep_debt } };
  };
  return { readDebt, reads };
};
const none = debts();
const wakes = async (over: { before?: ReturnType<typeof snapshot> | null; after?: ReturnType<typeof snapshot>; debt?: ReturnType<typeof debts> }): Promise<HealthWakeReason[]> =>
  detectHealthWakes({ before: over.before === undefined ? null : over.before, after: over.after ?? snapshot(TODAY), today: TODAY, readDebt: (over.debt ?? none).readDebt });

describe('a new or stronger driver', () => {
  const BEFORE = ['breathing rate above usual'];
  it('wakes when a phrase appears that the row before did not carry, on the same day or the day before', async () => {
    const after = snapshot(TODAY, { drivers: [...BEFORE, 'wrist temperature above usual'] });
    expect(await wakes({ before: snapshot(TODAY, { drivers: BEFORE }), after })).toEqual(['driver_appeared']);
    expect(await wakes({ before: snapshot(addDays(TODAY, -1), { drivers: BEFORE }), after })).toEqual(['driver_appeared']);
  });

  it('wakes when a driver already there turns far, and says only that', async () => {
    expect(await wakes({ before: snapshot(TODAY, { drivers: BEFORE }), after: snapshot(TODAY, { drivers: ['breathing rate far above usual'] }) })).toEqual(['driver_far']);
  });

  it('reads the same subject on the other side of usual as a new driver', async () => {
    expect(await wakes({ before: snapshot(TODAY, { drivers: BEFORE }), after: snapshot(TODAY, { drivers: ['breathing rate below usual'] }) })).toEqual(['driver_appeared']);
  });

  it('does not wake when nothing changed, when a driver goes away or eases from far, or when the order moves', async () => {
    const far = ['breathing rate far above usual', 'blood oxygen below usual'];
    expect(await wakes({ before: snapshot(TODAY, { drivers: far }), after: snapshot(TODAY, { drivers: far }) })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { drivers: far }), after: snapshot(TODAY, { drivers: [...far].reverse() }) })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { drivers: far }), after: snapshot(TODAY, { drivers: ['breathing rate above usual', 'blood oxygen below usual'] }) })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { drivers: far }), after: snapshot(TODAY, { drivers: [] }) })).toEqual([]);
  });

  it('has nothing to compare with when there is no earlier row, it is older than yesterday, or it came from another wearable', async () => {
    const after = snapshot(TODAY, { drivers: ['wrist temperature above usual'] });
    expect(await wakes({ before: null, after })).toEqual([]);
    expect(await wakes({ before: snapshot(addDays(TODAY, -2), { drivers: [] }), after })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { drivers: [], basis: [{ source: 'whoop', consent_epoch: 1 }] }), after })).toEqual([]);
  });

  it('wakes on nothing when the row has no readable drivers, and ignores a phrase outside the closed vocabulary', async () => {
    const before = snapshot(TODAY, { drivers: BEFORE });
    for (const drivers of [undefined, null, 'wrist temperature above usual', [7], { phrase: 'x' }]) {
      expect(await wakes({ before, after: snapshot(TODAY, { drivers }) }), JSON.stringify(drivers)).toEqual([]);
    }
    expect(await wakes({ before, after: snapshot(TODAY, { drivers: [...BEFORE, 'mood far above usual'] }) })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { drivers: undefined }), after: snapshot(TODAY, { drivers: BEFORE }) })).toEqual([]);
  });
});

describe('a Weight jump that no zone change covers', () => {
  const before = snapshot(TODAY, loadScore(LOAD_NOW));
  it('wakes when the score moves by more than a steady move inside the same zone, up or down', async () => {
    expect(await wakes({ before, after: snapshot(TODAY, loadScore(LOAD_NOW + STEADY_SCORE_MOVE + 1)) })).toEqual(['load_jump']);
    expect(await wakes({ before, after: snapshot(TODAY, loadScore(LOAD_NOW - STEADY_SCORE_MOVE - 1)) })).toEqual(['load_jump']);
  });

  it('does not wake on a steady move, on no move, or when a zone moved (that wake already exists)', async () => {
    expect(await wakes({ before, after: snapshot(TODAY, loadScore(LOAD_NOW + STEADY_SCORE_MOVE)) })).toEqual([]);
    expect(await wakes({ before, after: snapshot(TODAY) })).toEqual([]);
    expect(await wakes({ before, after: snapshot(TODAY, loadScore(LOAD_NOW + 20, 'heavy')) })).toEqual([]);
    expect(await wakes({ before, after: snapshot(TODAY, { ...loadScore(LOAD_NOW + 20), recovery: pillar('low', 20) }) })).toEqual([]);
  });

  it('compares only the same day and the same algorithm, and only when both Weights are there', async () => {
    const jumped = snapshot(TODAY, loadScore(LOAD_NOW + 20));
    expect(await wakes({ before: snapshot(addDays(TODAY, -1), loadScore(LOAD_NOW)), after: jumped })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, loadScore(LOAD_NOW, 'moderate', 'weight.candidate.v2')), after: jumped })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { weight: { reason: 'calendar_demand_unavailable' } }), after: jumped })).toEqual([]);
    expect(await wakes({ before, after: snapshot(TODAY, { weight: { reason: 'calendar_demand_unavailable' } }) })).toEqual([]);
    expect(await wakes({ before, after: snapshot(TODAY, { weight: { score: 'high', zone: 'moderate', algorithm_version: 'weight.candidate.v3' } }) })).toEqual([]);
    expect(await wakes({ before, after: snapshot(TODAY, { weight: undefined }) })).toEqual([]);
    expect(await wakes({ before: snapshot(TODAY, { basis: [{ source: 'whoop', consent_epoch: 1 }] }), after: jumped })).toEqual([]);
  });
});

describe('sleep debt that the stored rows say is building', () => {
  it('wakes the day the figure has risen on each of the last two steps', async () => {
    expect(await wakes({ debt: debts({ minutes: 150 }, { minutes: 90 }, { minutes: 40 }) })).toEqual(['sleep_debt_building']);
  });

  it('wakes only when it was not already building the day before, so a long run of worse nights is one wake', async () => {
    expect(await wakes({ debt: debts({ minutes: 150 }, { minutes: 90 }, { minutes: 40 }, { minutes: 10 }) })).toEqual([]);
    expect(await wakes({ debt: debts({ minutes: 150 }, { minutes: 90 }, { minutes: 40 }, { minutes: 60 }) })).toEqual(['sleep_debt_building']);
  });

  it('does not wake on a flat, falling or recovering figure', async () => {
    for (const figures of [[90, 90, 40], [150, 90, 90], [150, 40, 90], [40, 90, 150], [150, 150, 150]]) {
      expect(await wakes({ debt: debts(...figures.map(minutes => ({ minutes }))) }), figures.join()).toEqual([]);
    }
  });

  it('does not wake when a row is missing, partial or without a figure', async () => {
    const day = { minutes: 150 }, mid = { minutes: 90 }, old = { minutes: 40 };
    for (const rows of [[day, null, old], [day, mid, null], [null, mid, old], [day, 'partial', old], [day, mid, 'unavailable'], ['unavailable', mid, old], []] as Debt[][]) {
      expect(await wakes({ debt: debts(...rows) }), JSON.stringify(rows)).toEqual([]);
    }
  });

  it('never reads a figure from another version of the method as a step', async () => {
    const [v1, v2] = ['sleep-debt.v1', 'sleep-debt.v2'];
    expect(await wakes({ debt: debts({ minutes: 150, version: v2 }, { minutes: 90, version: v2 }, { minutes: 40, version: v1 }) })).toEqual([]);
    expect(await wakes({ debt: debts({ minutes: 150, version: v2 }, { minutes: 90, version: v1 }, { minutes: 40, version: v1 }) })).toEqual([]);
    // The version that wrote the day before the run is no reason to hide the run itself.
    expect(await wakes({ debt: debts({ minutes: 150, version: v2 }, { minutes: 90, version: v2 }, { minutes: 40, version: v2 }, { minutes: 10, version: v1 }) })).toEqual(['sleep_debt_building']);
  });

  it('refuses a figure that is not a plain non-negative number of minutes', async () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, '150' as unknown as number]) {
      expect(await wakes({ debt: debts({ minutes: bad }, { minutes: 90 }, { minutes: 40 }) }), String(bad)).toEqual([]);
    }
  });

  it('reads as few rows as the answer needs, and walks days by the calendar', async () => {
    const quiet = debts('partial');
    await wakes({ debt: quiet });
    expect(quiet.reads).toEqual([TODAY]);
    const building = debts({ minutes: 150 }, { minutes: 90 }, { minutes: 40 }, { minutes: 10 });
    await wakes({ debt: building });
    expect(building.reads).toEqual([TODAY, addDays(TODAY, -1), addDays(TODAY, -2), addDays(TODAY, -3)]);
  });
});

describe('sleep debt that a stored row names as building', () => {
  const trended = (trend: unknown, ...minutes: number[]) => debts(...minutes.map((figure, step) => (step === 0 ? { minutes: figure, trend } : { minutes: figure })));

  it('wakes on the row\'s own word, whatever the last two figures did', async () => {
    expect(await wakes({ debt: trended('building', 150, 160, 170) })).toEqual(['sleep_debt_building']);
    expect(await wakes({ debt: trended('building', 150) })).toEqual(['sleep_debt_building']);
  });

  it('does not wake on any other word, even when the figure has risen on each of the last two steps', async () => {
    for (const trend of ['easing', 'steady']) expect(await wakes({ debt: trended(trend, 150, 90, 40) }), trend).toEqual([]);
  });

  it('wakes only the day the word first says building, so a run of building rows is one wake', async () => {
    const days = (...trend: unknown[]) => debts(...trend.map(word => ({ minutes: 150, trend: word })));
    expect(await wakes({ debt: days('building', 'building') })).toEqual([]);
    expect(await wakes({ debt: days('building', 'steady') })).toEqual(['sleep_debt_building']);
    expect(await wakes({ debt: days('building', undefined) })).toEqual(['sleep_debt_building']);
    expect(await wakes({ debt: debts({ minutes: 150, trend: 'building' }, null) })).toEqual(['sleep_debt_building']);
  });

  it('ignores a word outside the three, and then decides from the figures as it does for a row with no word', async () => {
    for (const trend of ['rising', 'Building', '', 7, null, {}]) {
      expect(await wakes({ debt: trended(trend, 150, 90, 40) }), JSON.stringify(trend)).toEqual(['sleep_debt_building']);
      expect(await wakes({ debt: trended(trend, 150, 160, 170) }), JSON.stringify(trend)).toEqual([]);
    }
  });

  it('still needs a whole-day figure: a partial or figureless row with the word wakes nothing', async () => {
    const stored = (sleep_debt: unknown) => ({ readDebt: async (day: string) => ({ scores: { day, timezone: 'Asia/Kolkata', sleep_debt } }) });
    for (const sleep_debt of [{ state: 'partial', confidence: 0.5, trend: 'building' }, { state: 'unavailable', reason: 'missing_sleep', trend: 'building' }, { state: 'available', trend: 'building' }]) {
      expect(await wakes({ debt: { ...stored(sleep_debt), reads: [] } }), JSON.stringify(sleep_debt)).toEqual([]);
    }
  });

  it('reads one row for a word that is not building and two for one that is', async () => {
    const steady = trended('steady', 150, 90, 40);
    await wakes({ debt: steady });
    expect(steady.reads).toEqual([TODAY]);
    const building = trended('building', 150, 90, 40);
    await wakes({ debt: building });
    expect(building.reads).toEqual([TODAY, addDays(TODAY, -1)]);
  });
});

describe('several reasons at once', () => {
  it('lists each once, drivers first', async () => {
    const found = await wakes({
      before: snapshot(TODAY, { drivers: [] }), after: snapshot(TODAY, { drivers: ['blood oxygen far below usual'], ...loadScore(LOAD_NOW + 20) }),
      debt: debts({ minutes: 150 }, { minutes: 90 }, { minutes: 40 }),
    });
    expect(found).toEqual(['driver_appeared', 'load_jump', 'sleep_debt_building']);
  });
});

describe('the snapshot of a row', () => {
  it('is nothing for a missing, malformed or dayless row', () => {
    for (const raw of [null, undefined, 'row', [], {}, { context: null }, { context: { day: 7 } }, { context: { day: 'today' } }]) expect(healthSnapshot(raw), JSON.stringify(raw)).toBeNull();
  });
});

beforeEach(() => { vi.restoreAllMocks(); });
