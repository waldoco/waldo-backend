import { BASELINE_DAYS, mean } from './stats';
import { shiftDay } from './time';
import { DAY_LOAD_WINDOW_DAYS, type DayLoad, type DayLoadBand } from './day-load';
import { loadOf } from './training-load';

// The day's load counting every observed minute, not only workouts (day-load.candidate.v2, ADR-0081 amendment of 2 Nov 2026,
// §5a). The phone sends each hour's heart rate as seconds per 5 bpm, inside and outside workouts; the server buckets them on
// the owner's own zone bounds and adds them up as Edwards' summated zone load. A day the bins cannot carry is scored by v1 and
// says why, and each kind of day is compared only with its own kind.
export const DAY_LOAD_V2_VERSION = 'day-load.candidate.v2';
export const PASSIVE_UNAVAILABLE = ['no_bins', 'sparse', 'no_zone_basis', 'zone_basis_low'] as const;
export type PassiveUnavailable = (typeof PASSIVE_UNAVAILABLE)[number];

const BIN_BPM = 5;
// Edwards' zones start at these shares of the maximum heart rate; zone 1 also never starts below the sitting edge.
const ZONE_SHARES = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
const PEAK_RANGE = [100, 230] as const;
const MIN_PEAK_DAYS = 14;
// The third-highest day peak, so two days of sensor spikes cannot set the maximum.
const PEAK_RANK = 3;
// A resting hour holds under this many steps: a couple of minutes on foot, not a walk.
const RESTING_STEPS = 250;
const MIN_RESTING_DAYS = 14;
const SITTING_PERCENTILE = 0.95;
// An hour covered for less than this is unobserved; a day needs this many observed hours for its passive part.
const OBSERVED_HOUR_SECONDS = 1_800;
const MIN_OBSERVED_HOURS = 12;
// Units of the score, pinned to the version: the load at which it reaches 100, and the knee of its log shape.
const FULL_LOAD = 1_000;
const KNEE_LOAD = 50;

export interface BinsHour { readonly day: string; readonly startAt: number; readonly endAt: number; readonly fromBpm: number; readonly outside: readonly number[]; readonly inside: readonly number[] }
// A counted session of the source, with its span and its own zones as the phone or provider bucketed them.
export interface SpanSession { readonly day: string; readonly startAt: number; readonly endAt: number; readonly zoneSeconds: readonly number[] | null }
export interface PassiveInput {
  readonly targetDay: string;
  readonly bins: readonly BinsHour[];
  // Each day's highest heart rates: hourly window maxima and workout maxima.
  readonly peaks: readonly Readonly<{ day: string; bpm: number }>[];
  readonly steps: readonly Readonly<{ startAt: number; count: number }>[];
  readonly nights: readonly Readonly<{ startAt: number; endAt: number }>[];
  readonly sessions: readonly SpanSession[];
}
export type ZoneBasis = Readonly<{ state: 'ok'; bounds: readonly number[] }> | Readonly<{ state: 'none'; reason: 'no_zone_basis' | 'zone_basis_low' }>;
type Loads = Readonly<{ workouts: number; passive: number; observedHours: number }>;

const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const total = (seconds: readonly number[]) => seconds.reduce((sum, s) => sum + s, 0);
const overlap = (a: Readonly<{ startAt: number; endAt: number }>, b: Readonly<{ startAt: number; endAt: number }>) => Math.max(0, Math.min(a.endAt, b.endAt) - Math.max(a.startAt, b.startAt));

const usualMax = (peaks: PassiveInput['peaks']): number | null => {
  const byDay = new Map<string, number>();
  for (const { day, bpm } of peaks) if (bpm >= PEAK_RANGE[0] && bpm <= PEAK_RANGE[1]) byDay.set(day, Math.max(byDay.get(day) ?? 0, bpm));
  if (byDay.size < MIN_PEAK_DAYS) return null;
  return [...byDay.values()].sort((a, b) => b - a)[PEAK_RANK - 1]!;
};

// The heart rate below which the owner's resting hours spend this share of their seconds, read across the bins linearly.
const percentileOf = (bins: ReadonlyMap<number, number>, share: number): number => {
  const ordered = [...bins].sort(([a], [b]) => a - b);
  const target = share * total(ordered.map(([, s]) => s));
  let seen = 0;
  for (const [from, seconds] of ordered) {
    if (seen + seconds >= target) return from + BIN_BPM * (seconds ? (target - seen) / seconds : 0);
    seen += seconds;
  }
  return ordered.at(-1)![0] + BIN_BPM;
};

// Hours outside workouts and nights with few steps: the heart rate the owner sits at, as a statistic of their own seconds.
const sittingEdge = (input: PassiveInput): number | null => {
  const steps = new Map(input.steps.map(s => [s.startAt, s.count]));
  const seconds = new Map<number, number>(), days = new Set<string>();
  for (const hour of input.bins) {
    const count = steps.get(hour.startAt);
    if (count === undefined || count >= RESTING_STEPS || total(hour.inside) > 0) continue;
    if (input.sessions.some(s => overlap(s, hour) > 0) || input.nights.some(n => overlap(n, hour) > 0)) continue;
    hour.outside.forEach((s, i) => { if (s > 0) seconds.set(hour.fromBpm + BIN_BPM * i, (seconds.get(hour.fromBpm + BIN_BPM * i) ?? 0) + s); });
    if (total(hour.outside) > 0) days.add(hour.day);
  }
  return days.size < MIN_RESTING_DAYS ? null : percentileOf(seconds, SITTING_PERCENTILE);
};

export const zoneBasis = (input: PassiveInput): ZoneBasis => {
  const max = usualMax(input.peaks), edge = sittingEdge(input);
  if (max === null || edge === null) return { state: 'none', reason: 'no_zone_basis' };
  const bounds = ZONE_SHARES.map(share => share * max);
  bounds[0] = Math.max(bounds[0]!, edge);
  return bounds[0]! >= bounds[1]! ? { state: 'none', reason: 'zone_basis_low' } : { state: 'ok', bounds };
};

// Edwards' load of one hour's bins: each second weighs its zone (0 below zone 1), a bin split by a bound shared linearly.
const binLoad = (fromBpm: number, seconds: readonly number[], bounds: readonly number[]): number => seconds.reduce((sum, s, i) => {
  if (!s) return sum;
  const lo = fromBpm + BIN_BPM * i, hi = lo + BIN_BPM;
  const cuts = [lo, ...bounds.filter(b => b > lo && b < hi), hi];
  return sum + cuts.slice(1).reduce((part, to, j) => part + bounds.filter(b => b <= cuts[j]!).length * s * (to - cuts[j]!) / BIN_BPM, 0) / 60;
}, 0);

const isObserved = (hour: BinsHour) => total(hour.outside) + total(hour.inside) >= OBSERVED_HOUR_SECONDS;

export const dayLoads = (day: string, input: PassiveInput, bounds: readonly number[]): Loads | PassiveUnavailable => {
  const hours = input.bins.filter(h => h.day === day);
  if (!hours.length) return 'no_bins';
  const observed = hours.filter(isObserved);
  if (observed.length < MIN_OBSERVED_HOURS) return 'sparse';
  const inside = hours.reduce((sum, h) => sum + binLoad(h.fromBpm, h.inside, bounds), 0);
  const passive = observed.reduce((sum, h) => sum + binLoad(h.fromBpm, h.outside, bounds), 0);
  // A session's minutes in observed hours are already in the bins. For its minutes in unobserved hours, less what the phone put
  // in those hours' workout bins, it adds its own zone load pro rata. A session without zones adds nothing.
  const added = input.sessions.filter(s => s.day === day && s.zoneSeconds?.length === 5 && s.endAt > s.startAt).reduce((sum, s) => {
    const minutes = (s.endAt - s.startAt) / 60_000;
    const seen = input.bins.reduce((m, h) => m + (isObserved(h) ? overlap(s, h) / 60_000 : Math.min(overlap(s, h) / 60_000, total(h.inside) / 60)), 0);
    const share = Math.max(0, minutes - seen) / minutes;
    return sum + share * loadOf({ day: s.day, minutes, zoneSeconds: s.zoneSeconds, effort: null }, 'hr_zones');
  }, 0);
  return { workouts: inside + added, passive, observedHours: observed.length };
};

export const dayScoreV2 = (load: number): number => round1(Math.min(100, 100 * Math.log1p(load / KNEE_LOAD) / Math.log1p(FULL_LOAD / KNEE_LOAD)));

const bandOf = (before: readonly number[]): DayLoadBand => {
  if (before.length < BASELINE_DAYS) return { state: 'provisional', own_days: before.length, days_until_personal: BASELINE_DAYS - before.length };
  const centre = mean(before), spread = Math.sqrt(mean(before.map(value => (value - centre) ** 2)));
  return { state: 'personal', low: round1(Math.max(0, centre - spread)), centre: round1(centre), high: round1(Math.min(100, centre + spread)), own_days: before.length, days_until_personal: 0 };
};

type Parts = Readonly<{ workouts: Readonly<{ share: number }>; passive: Readonly<{ state: 'available'; share: number; observed_hours: number }> | Readonly<{ state: 'unavailable'; reason: PassiveUnavailable }> }>;
export type DayLoadV2 =
  | Readonly<{
    state: 'available'; version: typeof DAY_LOAD_V2_VERSION; activation: 'candidate_unaccepted'; score: number; method: 'hr_zones_observed_peak'; approximate: true;
    window_days: typeof DAY_LOAD_WINDOW_DAYS; band: DayLoadBand; direction: 'above_usual' | 'usual' | 'below_usual' | null; parts: Parts; v1: DayLoad;
  }>
  | (Extract<DayLoad, { state: 'available' }> & Readonly<{ parts: Parts }>)
  | Extract<DayLoad, { state: 'unavailable' }>;

// v1 is S4's load for the same day. A day v2 can score carries it beside, for a build below the passive revision; a day it cannot
// is v1 with the reason. Nothing v1 could not see becomes a score here.
export const dayLoadV2 = (v1: DayLoad, input: PassiveInput): DayLoadV2 => {
  if (v1.state === 'unavailable') return v1;
  const fallback = (reason: PassiveUnavailable): DayLoadV2 => ({ ...v1, parts: { workouts: { share: v1.score > 0 ? 1 : 0 }, passive: { state: 'unavailable', reason } } });
  const basis = zoneBasis(input);
  if (basis.state === 'none') return fallback(basis.reason);
  const today = dayLoads(input.targetDay, input, basis.bounds);
  if (typeof today === 'string') return fallback(today);
  const load = today.workouts + today.passive, score = dayScoreV2(load);
  const before = Array.from({ length: DAY_LOAD_WINDOW_DAYS }, (_, i) => dayLoads(shiftDay(input.targetDay, -(i + 1)), input, basis.bounds))
    .filter((loads): loads is Loads => typeof loads !== 'string').map(loads => dayScoreV2(loads.workouts + loads.passive));
  const band = bandOf(before);
  const direction = band.state === 'provisional' ? null : score > band.high ? 'above_usual' : score < band.low ? 'below_usual' : 'usual';
  const passiveShare = load > 0 ? round3(today.passive / load) : 0;
  return {
    state: 'available', version: DAY_LOAD_V2_VERSION, activation: 'candidate_unaccepted', score, method: 'hr_zones_observed_peak', approximate: true,
    window_days: DAY_LOAD_WINDOW_DAYS, band, direction,
    parts: { workouts: { share: load > 0 ? round3(1 - passiveShare) : 0 }, passive: { state: 'available', share: passiveShare, observed_hours: today.observedHours } },
    v1,
  };
};
