import { BASELINE_DAYS, mean } from './stats';
import { shiftDay } from './time';
import { loadOf, methodOf, type LoadMethod, type WorkoutLoad } from './training-load';

// The day's load as a score (day-load.candidate.v1, ADR-0081 amendment of 2 Nov 2026, §5). A day's load is the summated
// heart-rate-zone load of its workouts, each session once, in the one method the whole span of days can be read in (zones,
// then effort, then minutes, never mixed). The score is log-shaped over that load and reaches 100 at one pinned load per
// method: a unit, not a judgment. There is no passive load and no target; the only band is the owner's own usual.
export const DAY_LOAD_VERSION = 'day-load.candidate.v1';
export const DAY_LOAD_WINDOW_DAYS = 28;
// The load at which the score reaches 100. Zone and effort loads are in the units training-load.ts gives them; minutes are minutes.
const FULL_LOAD: Readonly<Record<LoadMethod, number>> = { hr_zones: 600, hr_zones_observed_peak: 600, effort: 600, minutes: 240 };
const round1 = (value: number) => Math.round(value * 10) / 10;
export const dayScoreOf = (load: number, method: LoadMethod): number => round1(Math.min(100, 100 * Math.log1p(load) / Math.log1p(FULL_LOAD[method])));

export type DayLoadBand =
  | Readonly<{ state: 'personal'; low: number; centre: number; high: number; own_days: number; days_until_personal: 0 }>
  | Readonly<{ state: 'provisional'; own_days: number; days_until_personal: number }>;
export type DayLoad =
  | Readonly<{
    state: 'available'; version: typeof DAY_LOAD_VERSION; activation: 'candidate_unaccepted'; score: number; method: LoadMethod; approximate: boolean;
    window_days: typeof DAY_LOAD_WINDOW_DAYS; band: DayLoadBand; direction: 'above_usual' | 'usual' | 'below_usual' | null;
  }>
  | Readonly<{ state: 'unavailable'; reason: 'no_readings' }>;

// observedDays are the days a body-worn sensor reported on; a day with a workout is observed whatever the caller says. An
// observed day with no workout is a rest day and scores 0. A day nothing worn saw is left out, never scored as rest, and
// when the target day itself is unobserved there is no load for it. The target day may still be running: its load is the load so far.
export const dayLoad = (input: Readonly<{ targetDay: string; observedDays: readonly string[]; workouts: readonly WorkoutLoad[] }>): DayLoad => {
  const span = [input.targetDay, ...Array.from({ length: DAY_LOAD_WINDOW_DAYS }, (_, i) => shiftDay(input.targetDay, -(i + 1)))];
  const inSpan = new Set(span);
  const workouts = input.workouts.filter(workout => inSpan.has(workout.day));
  const observed = new Set([...input.observedDays, ...workouts.map(workout => workout.day)].filter(day => inSpan.has(day)));
  if (!observed.has(input.targetDay)) return { state: 'unavailable', reason: 'no_readings' };
  // With no workout anywhere the method says nothing; minutes is the weakest claim and carries no approximate label.
  const method = workouts.length ? methodOf(workouts) : 'minutes';
  const scoreOn = (day: string) => dayScoreOf(workouts.filter(workout => workout.day === day).reduce((sum, workout) => sum + loadOf(workout, method), 0), method);
  const score = scoreOn(input.targetDay);
  const before = span.slice(1).filter(day => observed.has(day)).map(scoreOn);
  const band: DayLoadBand = before.length < BASELINE_DAYS
    ? { state: 'provisional', own_days: before.length, days_until_personal: BASELINE_DAYS - before.length }
    : (() => {
      const centre = mean(before), spread = Math.sqrt(mean(before.map(value => (value - centre) ** 2)));
      return { state: 'personal', low: round1(Math.max(0, centre - spread)), centre: round1(centre), high: round1(Math.min(100, centre + spread)), own_days: before.length, days_until_personal: 0 };
    })();
  const direction = band.state === 'provisional' ? null : score > band.high ? 'above_usual' : score < band.low ? 'below_usual' : 'usual';
  return {
    state: 'available', version: DAY_LOAD_VERSION, activation: 'candidate_unaccepted', score, method, approximate: method === 'hr_zones_observed_peak',
    window_days: DAY_LOAD_WINDOW_DAYS, band, direction,
  };
};
