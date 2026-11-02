import { describe, expect, it } from 'vitest';
import { dayLoad, type DayLoad } from '../src/health/scores/day-load';
import { dayLoads, dayLoadV2, dayScoreV2, DAY_LOAD_V2_VERSION, zoneBasis, type BinsHour, type PassiveInput, type SpanSession } from '../src/health/scores/passive-load';
import { shiftDay } from '../src/health/scores/time';

// day-load.candidate.v2 (ADR-0081 amendment of 2 Nov 2026, §5a). Every value is synthetic and every golden number is worked
// by hand. The world: 30 days, each with a night of 00:00-07:00 at 55 bpm and awake hours that sit at 70-80 with a minute's
// stand-up at 95, under 250 steps. Day peaks are 160, and 190, 188 and 186 on the three days before today, so the usual
// maximum is 186 and Edwards' bounds are 93, 111.6, 130.2, 148.8 and 167.4. The sitting edge is the 95th percentile of
// resting seconds: 3,420 of each 3,600 lands 480 s into the 80 bin's 600, so 84 bpm, under 93, and zone 1 starts at 93.
// Score: 100 x ln(1 + load / 50) / ln(21), to a tenth.
const TODAY = '2026-11-02';
const before = (n: number) => shiftDay(TODAY, -n);
const at = (day: string, h: number, m = 0) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
type Seconds = Readonly<Record<number, number>>;
const hourOf = (day: string, h: number, outside: Seconds, inside: Seconds = {}): BinsHour => {
  const starts = [...Object.keys(outside), ...Object.keys(inside)].map(Number);
  const from = Math.min(...starts), count = (Math.max(...starts) - from) / 5 + 1;
  const spread = (s: Seconds) => Array.from({ length: count }, (_, i) => s[from + 5 * i] ?? 0);
  return { day, startAt: at(day, h), endAt: at(day, h + 1), fromBpm: from, outside: spread(outside), inside: spread(inside) };
};
const SITTING: Seconds = { 70: 1140, 75: 1800, 80: 600, 95: 60 };
const NIGHT: Seconds = { 55: 3600 };
type Plan = Readonly<{ outside?: Readonly<Record<number, Seconds>>; inside?: Readonly<Record<number, Seconds>>; steps?: Readonly<Record<number, number>>; skip?: readonly number[]; only?: readonly number[]; peak?: number | null }>;
type World = { bins: BinsHour[]; steps: { startAt: number; count: number }[]; nights: { startAt: number; endAt: number }[]; peaks: { day: string; bpm: number }[] };
const dayOf = (day: string, plan: Plan = {}): World => {
  const world: World = { bins: [], steps: [], nights: [{ startAt: at(day, 0), endAt: at(day, 7) }], peaks: plan.peak === null ? [] : [{ day, bpm: plan.peak ?? 160 }] };
  for (let h = 0; h < 24; h++) {
    if (plan.skip?.includes(h) || (plan.only && !plan.only.includes(h))) continue;
    world.bins.push(hourOf(day, h, plan.outside?.[h] ?? (h < 7 ? NIGHT : SITTING), plan.inside?.[h] ?? {}));
    world.steps.push({ startAt: at(day, h), count: plan.steps?.[h] ?? (h < 7 ? 0 : 100) });
  }
  return world;
};
const PEAKS: Readonly<Record<string, number>> = { [before(1)]: 190, [before(2)]: 188, [before(3)]: 186 };
const inputOf = (today: Plan = {}, past: (day: string) => Plan = () => ({}), sessions: SpanSession[] = []): PassiveInput => {
  const days = [dayOf(TODAY, today), ...Array.from({ length: 29 }, (_, i) => before(i + 1)).map(day => dayOf(day, { peak: PEAKS[day], ...past(day) }))];
  return { targetDay: TODAY, bins: days.flatMap(d => d.bins), steps: days.flatMap(d => d.steps), nights: days.flatMap(d => d.nights), peaks: days.flatMap(d => d.peaks), sessions };
};
const BOUNDS = [93, 111.6, 130.2, 148.8, 167.4];
const v1Of = (workouts: Parameters<typeof dayLoad>[0]['workouts'] = []): DayLoad =>
  dayLoad({ targetDay: TODAY, observedDays: [TODAY, ...Array.from({ length: 28 }, (_, i) => before(i + 1))], workouts });
const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);
// Three walking hours: 40 minutes at 105 (zone 1) and 10 at 115 (zone 2) is 40 + 20 = 60 each.
const WALK: Seconds = { 75: 600, 105: 2400, 115: 600 };
const walking = { outside: { 10: WALK, 13: WALK, 16: WALK }, steps: { 10: 3000, 13: 3000, 16: 3000 } };

describe('the zone bounds', () => {
  it('are Edwards\' shares of the third-highest day peak, with zone 1 starting no lower than the sitting edge', () => {
    const basis = zoneBasis(inputOf());
    expect(basis.state).toBe('ok');
    if (basis.state === 'ok') basis.bounds.forEach((bound, i) => close(bound, BOUNDS[i]!));
  });
  it('need fourteen days with a peak; fewer is no zone basis, never a population maximum', () => {
    const input = inputOf({ peak: null }, day => (day < before(12) ? { peak: null } : {}));
    expect(zoneBasis(input)).toEqual({ state: 'none', reason: 'no_zone_basis' });
  });
  it('take no zone basis from a maximum too low to set zone 1 apart from sitting: 50 % of 130 under an 84 edge reaches zone 2 at 78', () => {
    const input = inputOf({ peak: 130 }, () => ({ peak: 130 }));
    expect(zoneBasis(input)).toEqual({ state: 'none', reason: 'zone_basis_low' });
  });
  it('do not let near-walking hours of 800 steps lift the floor: they are not resting hours at the 250-step bar', () => {
    // Seven awake hours a day of 800 steps with 20 minutes at 105. Counted as resting, the 95th percentile would be 108.2 and
    // the floor would sit over the walks; at the 250-step bar the edge stays 84 and zone 1 starts at 93.
    const ambling = { outside: Object.fromEntries([8, 9, 11, 12, 14, 15, 17].map(h => [h, { 75: 2400, 105: 1200 }])), steps: Object.fromEntries([8, 9, 11, 12, 14, 15, 17].map(h => [h, 800])) };
    const basis = zoneBasis(inputOf(ambling, () => ambling));
    expect(basis.state).toBe('ok');
    if (basis.state === 'ok') close(basis.bounds[0]!, 93);
  });
  it('need no resting heart rate or movement minutes: the world above has neither, as on Samsung and Health Connect', () => {
    expect(zoneBasis(inputOf()).state).toBe('ok');
  });
});

describe('a day\'s loads', () => {
  it('weigh each second by its zone and split a bin a bound crosses linearly', () => {
    // Twelve observed hours, one at 110-115 across the 111.6 bound: 1.6/5 of it in zone 1, 3.4/5 in zone 2, so 60 x (0.32 + 1.36) = 100.8.
    const input = inputOf({ only: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], outside: Object.fromEntries([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((h): [number, Seconds] => [h, h === 12 ? { 110: 3600 } : { 75: 3600 }])) });
    const loads = dayLoads(TODAY, input, BOUNDS);
    expect(typeof loads).toBe('object');
    if (typeof loads === 'object') { close(loads.passive, 100.8); expect(loads.observedHours).toBe(12); }
  });
  it('count an hour in zone 3 above an hour in zone 1', () => {
    const one = dayLoads(TODAY, inputOf({ outside: { 12: { 100: 3600 } } }), BOUNDS), three = dayLoads(TODAY, inputOf({ outside: { 12: { 135: 3600 } } }), BOUNDS);
    if (typeof one !== 'object' || typeof three !== 'object') throw new Error('expected loads');
    expect(three.passive - one.passive).toBeCloseTo(3 * 60 - 60, 6);
  });
  it('need twelve observed hours: twelve after an overnight charge is a day, eleven is sparse', () => {
    expect(typeof dayLoads(TODAY, inputOf({ only: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] }), BOUNDS)).toBe('object');
    expect(dayLoads(TODAY, inputOf({ only: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] }), BOUNDS)).toBe('sparse');
    expect(dayLoads(TODAY, inputOf({ only: [] }), BOUNDS)).toBe('no_bins');
  });
  it('drop an unobserved hour\'s seconds outside workouts but keep its workout seconds: a run from 7:50 in a thin hour is not lost', () => {
    // 7:00 holds 10 minutes outside and 10 of the run at 150 (zone 4), 20 minutes in all: unobserved, but its 40 still count.
    const run: SpanSession = { day: TODAY, startAt: at(TODAY, 7, 50), endAt: at(TODAY, 8, 40), zoneSeconds: [0, 0, 0, 3000, 0] };
    const thin = { outside: { 7: { 75: 600 }, 8: { 75: 600 } }, inside: { 7: { 150: 600 }, 8: { 150: 3000 } } };
    const loads = dayLoads(TODAY, inputOf(thin, undefined, [run]), BOUNDS);
    const without = dayLoads(TODAY, inputOf({ ...thin, inside: { 8: { 150: 3000 } } }, undefined, [run]), BOUNDS);
    if (typeof loads !== 'object' || typeof without !== 'object') throw new Error('expected loads');
    close(loads.workouts, 40 + 200);
    // Without the phone's 7:00 workout seconds the run's ten minutes there are unseen, and it adds its own zone 4 load for them.
    close(without.workouts, 200 + 40);
  });
  it('count a phone workout and its provider copy once: the kept session\'s seconds are in the bins and it adds nothing', () => {
    const session: SpanSession = { day: TODAY, startAt: at(TODAY, 18), endAt: at(TODAY, 19), zoneSeconds: [0, 0, 3600, 0, 0] };
    const loads = dayLoads(TODAY, inputOf({ outside: { 18: {} }, inside: { 18: { 150: 3600 } } }, undefined, [session]), BOUNDS);
    if (typeof loads !== 'object') throw new Error('expected loads');
    close(loads.workouts, 240);
  });
  it('add a provider session\'s own load for minutes in unobserved hours, and nothing for minutes the bins saw', () => {
    const run: SpanSession = { day: TODAY, startAt: at(TODAY, 18), endAt: at(TODAY, 19), zoneSeconds: [0, 0, 3600, 0, 0] };
    const unseen = dayLoads(TODAY, inputOf({ skip: [18] }, undefined, [run]), BOUNDS);
    const seen = dayLoads(TODAY, inputOf({ outside: { 18: { 150: 3600 } } }, undefined, [run]), BOUNDS);
    if (typeof unseen !== 'object' || typeof seen !== 'object') throw new Error('expected loads');
    close(unseen.workouts, 180);
    close(seen.workouts, 0);
    close(seen.passive - 16, 240);
  });
  it('add 30/90 of a provider run from 7:00 to 8:30 when 7:00 is observed and 8:00 is not, and drop 8:00\'s outside seconds', () => {
    const run: SpanSession = { day: TODAY, startAt: at(TODAY, 7), endAt: at(TODAY, 8, 30), zoneSeconds: [0, 0, 5400, 0, 0] };
    const loads = dayLoads(TODAY, inputOf({ outside: { 7: { 150: 3600 }, 8: { 150: 1200 } } }, undefined, [run]), BOUNDS);
    if (typeof loads !== 'object') throw new Error('expected loads');
    close(loads.workouts, 270 * 30 / 90);
    // 7:00 at zone 4 (240) and the stand-ups of the other 15 awake hours; 8:00's 20 minutes are not counted.
    close(loads.passive, 240 + 15);
  });
});

describe('the score', () => {
  it('is log-shaped over the load, 0 for none, 100 at 1,000 and above, and rises with the load', () => {
    expect(dayScoreV2(0)).toBe(0);
    expect(dayScoreV2(1000)).toBe(100);
    expect(dayScoreV2(5000)).toBe(100);
    for (let load = 0; load < 1000; load += 25) expect(dayScoreV2(load + 25)).toBeGreaterThan(dayScoreV2(load));
  });
  it('puts a desk day well under a busy day on foot, and a busy day on foot with no workout above zero', () => {
    // Desk: 17 stand-up minutes in zone 1, so 17 and 9.6. On foot: three hours of 60 and 14 stand-ups, so 194 and 52.1.
    const desk = dayLoadV2(v1Of(), inputOf()), foot = dayLoadV2(v1Of(), inputOf(walking));
    expect(desk).toMatchObject({ version: DAY_LOAD_V2_VERSION, score: 9.6 });
    expect(foot).toMatchObject({ version: DAY_LOAD_V2_VERSION, score: 52.1 });
    expect(v1Of()).toMatchObject({ score: 0 });
  });
  it('scores a run day from its workout bins: an hour at 150 is zone 4, 240, with 16 stand-ups, so 256 and 59.5', () => {
    const load = dayLoadV2(v1Of(), inputOf({ outside: { 18: {} }, inside: { 18: { 150: 3600 } } }));
    expect(load).toMatchObject({ score: 59.5, parts: { workouts: { share: 0.937 }, passive: { state: 'available', share: 0.063, observed_hours: 24 } } });
  });
});

describe('the v2 day', () => {
  it('names the version, the observed-peak method and its approximate label, and carries the day\'s v1 load beside it', () => {
    const v1 = v1Of();
    const load = dayLoadV2(v1, inputOf(walking));
    expect(load).toMatchObject({ state: 'available', version: 'day-load.candidate.v2', activation: 'candidate_unaccepted', method: 'hr_zones_observed_peak', approximate: true, window_days: 28, v1 });
  });
  it('is compared only with v2 days: a past day too thin for passive is no day of the band', () => {
    // 28 past desk days at 9.6, of which 9 have only 11 hours: 19 own days, all 9.6, so the band is 9.6 to 9.6.
    const load = dayLoadV2(v1Of(), inputOf(walking, day => (day >= before(9) ? { only: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] } : {})));
    expect(load).toMatchObject({ band: { state: 'personal', low: 9.6, centre: 9.6, high: 9.6, own_days: 19 }, direction: 'above_usual' });
  });
  it('shows a provisional band below fourteen v2 days, with no direction', () => {
    const load = dayLoadV2(v1Of(), inputOf(walking, day => (day >= before(15) ? { only: [7] } : {})));
    expect(load).toMatchObject({ band: { state: 'provisional', own_days: 13, days_until_personal: 1 }, direction: null });
  });
});

describe('a day v2 cannot score', () => {
  it('is v1 exactly, with its own v1 band and direction, and says why passive is missing', () => {
    const v1 = v1Of([{ day: TODAY, minutes: 60, zoneSeconds: [0, 1800, 1800, 0, 0], effort: null }]);
    const thin = dayLoadV2(v1, inputOf({ only: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] }));
    expect(thin).toEqual({ ...v1, parts: { workouts: { share: 1 }, passive: { state: 'unavailable', reason: 'sparse' } } });
    expect(dayLoadV2(v1, inputOf({ peak: null }, () => ({ peak: null })))).toMatchObject({ version: 'day-load.candidate.v1', parts: { passive: { reason: 'no_zone_basis' } } });
    expect(dayLoadV2(v1, inputOf({ only: [] }))).toMatchObject({ parts: { passive: { reason: 'no_bins' } } });
  });
  it('has no parts when v1 has no load either', () => {
    const none: DayLoad = { state: 'unavailable', reason: 'no_readings' };
    expect(dayLoadV2(none, inputOf(walking))).toEqual(none);
  });
});
