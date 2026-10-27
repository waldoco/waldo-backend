import { describe, expect, it } from 'vitest';
import type { DailyScores } from '../../src/health/scores/types';
import { dayOf, history, mulberry32, scoresAt, typicalOwner, type Events } from './generator';

// Synthetic physiology scenarios S1 to S9 and S12 of the health proposal's evaluation plan. Each asserts direction, timing
// and labels, never an exact score, so a later constant change does not rewrite them. Clauses that need the alertness
// term or the pattern catalogue are deferred with those features and are not asserted here.
const recovery = (scores: DailyScores) => { const r = scores.recovery; if (r.state !== 'available') throw new Error(`recovery ${JSON.stringify(r)}`); return r; };
const weight = (scores: DailyScores) => { const w = scores.weight; if (w.state !== 'available') throw new Error(`weight ${JSON.stringify(w)}`); return w; };
const debt = (scores: DailyScores) => { const d = scores.sleep_debt; if (d.state !== 'available') throw new Error(`sleep debt ${JSON.stringify(d)}`); return d.debt_minutes; };
const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ZONE_RANK = { compromised: 0, mixed: 1, solid: 2, excellent: 3 } as const;

describe('S1 acute restriction: three nights at five hours after thirty at need', () => {
  const events: Events = night => (night >= 30 && night <= 32 ? { sleepMinutes: 300 } : {});
  const nights = history(typicalOwner(11), 34, events);
  it('lowers Recovery below the owner\'s usual on each restricted night, and none reads excellent', () => {
    const usual = mean(range(20, 29).map(n => recovery(scoresAt(nights, n)).score));
    for (const n of [30, 31, 32]) {
      const r = recovery(scoresAt(nights, n));
      expect(r.score).toBeLessThan(usual - 8);
      expect(r.zone).not.toBe('excellent');
    }
  });
  it('raises the sleep debt on every restricted night', () => {
    const owed = range(29, 32).map(n => debt(scoresAt(nights, n)));
    for (let i = 1; i < owed.length; i++) expect(owed[i]!).toBeGreaterThan(owed[i - 1]!);
  });
});

describe('S2 recovery sleep: two nights at need plus an hour and a half after S1', () => {
  const events: Events = night => (night >= 30 && night <= 32 ? { sleepMinutes: 300 } : night === 33 || night === 34 ? { sleepMinutes: 570 } : {});
  const nights = history(typicalOwner(11), 36, events);
  it('lowers the debt without clearing it after one long night', () => {
    const before = debt(scoresAt(nights, 32)), after = debt(scoresAt(nights, 33)), second = debt(scoresAt(nights, 34));
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    expect(second).toBeLessThan(after);
  });
  it('brings Recovery back up, to solid or better by the second night', () => {
    const low = recovery(scoresAt(nights, 32)).score, back = recovery(scoresAt(nights, 34));
    expect(back.score).toBeGreaterThan(low + 8);
    expect(ZONE_RANK[back.zone]).toBeGreaterThanOrEqual(ZONE_RANK.solid);
  });
});

describe('S3 illness onset: resting rate up, variability down, breathing and temperature up, over two nights', () => {
  const events: Events = night => (night === 30 || night === 31 ? { pulseDelta: 6, lnVariabilityDelta: -0.25, breathingDelta: 1.5, temperatureDelta: 0.6 } : {});
  const nights = history(typicalOwner(23), 33, events);
  it('lowers Recovery well below the owner\'s usual', () => {
    const usual = mean(range(20, 29).map(n => recovery(scoresAt(nights, n)).score));
    for (const n of [30, 31]) expect(recovery(scoresAt(nights, n)).score).toBeLessThan(usual - 10);
  });
  it('names breathing rate and wrist temperature as drivers, above usual', () => {
    const drivers = scoresAt(nights, 31).drivers;
    expect(drivers.some(d => d.startsWith('breathing rate') && d.endsWith('above usual'))).toBe(true);
    expect(drivers.some(d => d.startsWith('wrist temperature') && d.endsWith('above usual'))).toBe(true);
    expect(scoresAt(nights, 25).drivers).toEqual([]);
  });
});

describe('S4 overreaching: ten days of load up by sixty percent while variability drifts down', () => {
  const events: Events = night => (night >= 30 && night <= 39 ? { loadFactor: 1.6, lnVariabilityDelta: -0.015 * (night - 29) } : {});
  const nights = history(typicalOwner(37), 40, events);
  it('raises Weight by the end of the ten days', () => {
    const usual = mean(range(20, 29).map(n => weight(scoresAt(nights, n)).score));
    expect(weight(scoresAt(nights, 39)).score).toBeGreaterThan(usual + 8);
  });
  it('lowers Recovery as variability drifts down', () => {
    const usual = mean(range(20, 29).map(n => recovery(scoresAt(nights, n)).score));
    expect(mean(range(37, 39).map(n => recovery(scoresAt(nights, n)).score))).toBeLessThan(usual);
  });
});

describe('S5 a new typical owner, day 1 to 21', () => {
  const OWNERS = range(1, 40), PRE = 30, DAYS = 21;
  const owners = OWNERS.map(seed => history(typicalOwner(seed * 17), PRE + DAYS));
  const own = (records: ReturnType<typeof history>, day: number) => scoresAt(records, PRE + day - 1, { since: PRE });
  const reference = (records: ReturnType<typeof history>, day: number) => scoresAt(records, PRE + day - 1);
  it('scores from the first night and says provisional until fourteen own days', () => {
    for (const records of owners.slice(0, 10)) {
      for (const day of range(1, 14)) expect(recovery(own(records, day)).baseline).toMatchObject({ state: 'provisional', personal_days: day - 1 });
      for (const day of [15, 16, 21]) expect(recovery(own(records, day)).baseline.state).toBe('personal');
    }
  });
  it('drifts toward the score a month of history gives, as days accrue', () => {
    const gap = (day: number) => mean(owners.map(records => Math.abs(recovery(own(records, day)).score - recovery(reference(records, day)).score)));
    const agree = (day: number) => mean(owners.map(records => (recovery(own(records, day)).zone === recovery(reference(records, day)).zone ? 1 : 0)));
    expect(gap(14)).toBeLessThan(gap(1));
    expect(gap(21)).toBeLessThan(gap(1));
    expect(agree(14)).toBeGreaterThanOrEqual(agree(1));
  });
});

describe('S6 a new atypical owner: an endurance athlete with variability near the top of the population', () => {
  const athlete = { ...typicalOwner(53), variabilityMedian: 105 };
  const nights = history(athlete, 31);
  it('reads high against the population on the first night, with the provisional label, then settles on the owner\'s own', () => {
    const first = recovery(scoresAt(nights, 0));
    expect(first.baseline).toEqual({ state: 'provisional', personal_days: 0, needed: 14, prior: 'adults' });
    expect(first.zone).toBe('excellent');
    const settled = mean(range(25, 30).map(n => recovery(scoresAt(nights, n)).score));
    expect(settled).toBeLessThan(first.score - 5);
    expect(recovery(scoresAt(nights, 30)).baseline.state).toBe('personal');
  });
});

describe('S7 an owner whose watch gives SDNN only', () => {
  const spec = { ...typicalOwner(71), hrvMethod: 'sdnn' as const, variabilityMedian: 50 };
  const nights = history(spec, 20);
  it('leaves variability out of Recovery until seven nights of its own exist, with no population prior for it', () => {
    for (const n of range(0, 6)) {
      const r = recovery(scoresAt(nights, n));
      expect(r.used.signals).not.toContain('hrv');
      expect(r.hrv_method).toBeNull();
    }
    const first = history({ ...spec, variabilityMedian: 5 }, 7), loud = history({ ...spec, variabilityMedian: 500 }, 7);
    expect(recovery(scoresAt(first, 3)).score).toBe(recovery(scoresAt(loud, 3)).score);
    for (const n of range(7, 19)) {
      const r = recovery(scoresAt(nights, n));
      expect(r.used.signals).toContain('hrv');
      expect(r.hrv_method).toBe('sdnn');
    }
  });
  it('reads the day\'s hourly SDNN against its own days for Form\'s stress part, from the seventh earlier day', () => {
    const formAt = (records: ReturnType<typeof history>, n: number) => { const f = scoresAt(records, n).form; if (f.state !== 'available') throw new Error(JSON.stringify(f)); return f.score; };
    const calm = (factor: number) => history(spec, 12).map((d, i) => (i === 11 ? { ...d, hourly: d.hourly.map(b => ({ ...b, hrv: b.hrv! * factor })) } : d));
    expect(formAt(calm(2.5), 11)).toBeGreaterThan(formAt(calm(1), 11));
  });
});

describe('S8 a method switch: RMSSD appears on night 40 for an owner who had SDNN', () => {
  const sdnn = history({ ...typicalOwner(83), hrvMethod: 'sdnn', variabilityMedian: 50 }, 45);
  const rmssdFrom39 = sdnn.map((d, i) => (i >= 39 ? { ...d, overnightHrv: [...d.overnightHrv, { value: 41, method: 'rmssd' as const }] } : d));
  it('has no gap in variability, and takes RMSSD as soon as it appears', () => {
    for (const n of range(10, 38)) expect(recovery(scoresAt(rmssdFrom39, n)).hrv_method).toBe('sdnn');
    expect(recovery(scoresAt(rmssdFrom39, 39)).hrv_method).toBe('rmssd');
    expect(recovery(scoresAt(rmssdFrom39, 39)).used.signals).toContain('hrv');
  });
  it('leaves the SDNN baseline untouched, so an SDNN-only night after the switch reads as it would without the RMSSD days', () => {
    const night40 = rmssdFrom39.map((d, i) => (i === 40 ? { ...d, overnightHrv: d.overnightHrv.filter(r => r.method === 'sdnn') } : d));
    expect(JSON.stringify(scoresAt(night40, 40).recovery)).toBe(JSON.stringify(scoresAt(sdnn, 40).recovery));
  });
});

describe('S9 missing nights', () => {
  const shuffled = (seed: number, nights: number, count: number) => {
    const next = mulberry32(seed), pool = range(1, nights - 1);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
    return new Set(pool.slice(0, count));
  };
  const owner = (seed: number, gone: ReadonlySet<number>) => {
    const events: Events = night => ({ missingSleep: gone.has(13 - night) });
    return history(typicalOwner(seed), 14, events);
  };
  it('gives a figure from ten of fourteen nights, with coverage', () => {
    for (const seed of range(1, 25)) {
      const s = scoresAt(owner(seed, shuffled(seed, 14, 4)), 13, { sleepNeedMinutes: 480 }).sleep_debt;
      expect(s.state).toBe('available');
      if (s.state === 'available') { expect(s.observed_nights).toBe(10); expect(s.coverage).toBeGreaterThan(0.6); expect(s.coverage).toBeLessThan(1); }
    }
  });
  it('withholds the figure at nine of fourteen', () => {
    for (const seed of range(1, 25)) {
      const s = scoresAt(owner(seed, shuffled(seed, 14, 5)), 13, { sleepNeedMinutes: 480 }).sleep_debt;
      expect(s.state).toBe('partial');
      if (s.state === 'partial') expect(s.debt_minutes).toBeNull();
    }
  });
});

describe('S12 no calendar: physical load only', () => {
  it('gives Weight at reduced coverage, and the calendar is not among what it used', () => {
    const nights = history({ ...typicalOwner(97), calendar: null }, 12);
    const w = weight(scoresAt(nights, 11));
    expect(w.coverage).toBe(0.2);
    expect(w.used.signals).toEqual(['physical_load']);
    expect(w.baseline.state).toBe('provisional');
  });
  it('has no Weight with nothing to read it from', () => {
    const none = history({ ...typicalOwner(97), calendar: null, load: null }, 12);
    expect(scoresAt(none, 11).weight).toEqual({ state: 'unavailable', reason: 'calendar_demand_unavailable' });
    expect(dayOf(11)).toBe('2026-01-12');
  });
});
