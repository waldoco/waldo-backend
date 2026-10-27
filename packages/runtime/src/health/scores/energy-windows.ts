import type { RecoveryZone } from '../../../../contracts/src/health/crs';
import { circularDelta } from './stats';
import { localDayWindow, wallMinute } from './time';
import type { DayRecord } from './types';

// Today's energy windows from the owner's own resting heart rate across the day, read against the curve's own trend: where it
// runs above the line the owner is expected to peak, where it runs below, to dip. Hours are counted from each day's waking so
// a late riser's curve lines up with an early one's. The method follows a published note on circadian energy curves; only the
// method is used. Pure: no clock, no I/O, same input gives the same output.
export const ENERGY_WINDOWS_VERSION = 'energy-windows.v1';

const HOUR_MS = 3_600_000;
// Days whose wake is further than this from the owner's usual describe a different day (a night shift, a flight), not their rhythm.
const USUAL_WAKE_TOLERANCE_MINUTES = 120;
// A resting hour has less movement than this: more is activity, which lifts heart rate for reasons that are not the rhythm.
const RESTING_MOVEMENT_MINUTES = 10;
// The curve follows the first sixteen hours of waking, the span a night's sleep leaves an owner.
const WAKING_HOURS = 16;
// An hour needs this many days behind it before its mean says anything about the owner.
const MIN_DAYS_PER_HOUR = 7;
// A line through fewer hours than this describes no rhythm.
const MIN_HOURS = 8;
// A run shorter than this is a blip, not a stretch of the day.
const MIN_RUN_HOURS = 2;
// Below heart-rate measurement noise a residual is no peak or dip, so a flat curve gives none.
const NOISE_FLOOR = 0.5;
const MAX_PEAKS = 2;
const GRID_MINUTES = 30;
const MINUTES_PER_DAY = 1440;
const DAY_END_CUT = '23:30';
// Peak length kept, by how much the day is expected to give: none, then each step of a poor recovery or building sleep debt.
const PEAK_SHARE_STEPS = [1, 2 / 3, 1 / 2, 1 / 3] as const;
const STEPS_BY_ZONE: Readonly<Record<RecoveryZone, number>> = { excellent: 0, solid: 0, mixed: 1, compromised: 2 };

export type SleepDebtTrend = 'building' | 'easing' | 'steady';
export type EnergyWindow = Readonly<{ start: string; end: string; kind: 'peak' | 'dip' }>;
export type EnergyWindowsInput = Readonly<{
  targetDay: string;
  // The target day and the days before it, each already held to its own local day.
  days: readonly DayRecord[];
  recoveryZone: RecoveryZone | null;
  sleepTrend: SleepDebtTrend;
}>;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const clock = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

type Hours = ReadonlyMap<number, number>;
// A day's resting hours by hours since waking: 1 is the first bucket starting at or after the wake, which is left out, as is
// the last hour before the next sleep. Only an hour with a heart rate, known movement under the resting limit and no
// workout counts.
const restingHours = (record: DayRecord, nextSleepStart: number | null): Hours => {
  const wake = Date.parse(record.sleep!.endAt);
  const workouts = record.workouts.map(workout => [Date.parse(workout.startAt), Date.parse(workout.endAt)] as const);
  const hours = new Map<number, number>();
  for (const bucket of record.hourly) {
    const start = Date.parse(bucket.startAt), end = start + HOUR_MS;
    const hour = Math.floor((start - wake) / HOUR_MS) + 1;
    if (hour < 2 || hour > WAKING_HOURS || bucket.heartRate === null) continue;
    if (bucket.movementMinutes === null || bucket.movementMinutes >= RESTING_MOVEMENT_MINUTES) continue;
    if (workouts.some(([from, to]) => from < end && to > start)) continue;
    if (nextSleepStart !== null && end > nextSleepStart - HOUR_MS) continue;
    hours.set(hour, bucket.heartRate);
  }
  return hours;
};

type Run = Readonly<{ from: number; to: number; weight: number; kind: 'peak' | 'dip' }>;
const runsOf = (residuals: ReadonlyMap<number, number>): Run[] => {
  const runs: Run[] = [];
  let open: { from: number; to: number; weight: number; kind: 'peak' | 'dip' } | null = null;
  for (const hour of [...residuals.keys()].sort((a, b) => a - b)) {
    const residual = residuals.get(hour)!;
    const kind = residual > NOISE_FLOOR ? 'peak' : residual < -NOISE_FLOOR ? 'dip' : null;
    if (open && kind === open.kind && hour === open.to + 1) { open.to = hour; open.weight += Math.abs(residual); continue; }
    if (open) runs.push(open);
    open = kind === null ? null : { from: hour, to: hour, weight: Math.abs(residual), kind };
  }
  if (open) runs.push(open);
  return runs.filter(run => run.to - run.from + 1 >= MIN_RUN_HOURS);
};

export const energyWindows = (input: EnergyWindowsInput): readonly EnergyWindow[] => {
  const target = input.days.find(record => record.day === input.targetDay);
  if (!target?.sleep) return [];
  const prior = input.days.filter(record => record.day < input.targetDay && record.sleep !== null);
  if (prior.length < MIN_DAYS_PER_HOUR) return [];

  const wakeMinute = (record: DayRecord) => wallMinute(Date.parse(record.sleep!.endAt), record.timezone);
  const usual = median(prior.map(wakeMinute));
  const nextDay = (record: DayRecord) => input.days.find(other => Date.parse(`${other.day}T00:00:00Z`) - Date.parse(`${record.day}T00:00:00Z`) === 24 * HOUR_MS);
  const perHour = new Map<number, number[]>();
  for (const record of prior) {
    if (Math.abs(circularDelta(wakeMinute(record), usual)) > USUAL_WAKE_TOLERANCE_MINUTES) continue;
    const next = nextDay(record)?.sleep;
    for (const [hour, heartRate] of restingHours(record, next ? Date.parse(next.startAt) : null)) perHour.set(hour, [...(perHour.get(hour) ?? []), heartRate]);
  }
  const curve = [...perHour].filter(([, values]) => values.length >= MIN_DAYS_PER_HOUR)
    .map(([hour, values]) => [hour, values.reduce((sum, value) => sum + value, 0) / values.length] as const);
  if (curve.length < MIN_HOURS) return [];

  const n = curve.length;
  const meanX = curve.reduce((sum, [hour]) => sum + hour, 0) / n;
  const meanY = curve.reduce((sum, [, value]) => sum + value, 0) / n;
  const sxx = curve.reduce((sum, [hour]) => sum + (hour - meanX) ** 2, 0);
  const slope = curve.reduce((sum, [hour, value]) => sum + (hour - meanX) * (value - meanY), 0) / sxx;
  const residuals = new Map(curve.map(([hour, value]) => [hour, value - (meanY + slope * (hour - meanX))] as const));

  const runs = runsOf(residuals);
  const biggest = (kind: 'peak' | 'dip', count: number) => runs.filter(run => run.kind === kind).sort((a, b) => b.weight - a.weight).slice(0, count);
  const step = Math.min(PEAK_SHARE_STEPS.length - 1, (input.recoveryZone === null ? 0 : STEPS_BY_ZONE[input.recoveryZone]) + (input.sleepTrend === 'building' ? 1 : 0));

  const wake = Date.parse(target.sleep.endAt);
  const dayEnd = localDayWindow(input.targetDay, target.timezone).end;
  const onGrid = (instant: number): number => Math.round(wallMinute(instant, target.timezone) / GRID_MINUTES) * GRID_MINUTES;
  const windows = [...biggest('peak', MAX_PEAKS), ...biggest('dip', 1)].flatMap((run): { at: number; window: EnergyWindow }[] => {
    const length = run.to - run.from + 1;
    const kept = run.kind === 'peak' ? length * PEAK_SHARE_STEPS[step]! : length;
    const trim = (length - kept) / 2;
    const startMs = wake + (run.from - 1 + trim) * HOUR_MS;
    const endMs = wake + (run.to - trim) * HOUR_MS;
    if (startMs >= dayEnd) return [];
    const start = onGrid(startMs), endAt = onGrid(endMs);
    const end = endMs >= dayEnd || endAt >= MINUTES_PER_DAY ? DAY_END_CUT : clock(endAt);
    if (start >= MINUTES_PER_DAY || end <= clock(start)) return [];
    return [{ at: startMs, window: { start: clock(start), end, kind: run.kind } }];
  });
  return windows.sort((a, b) => a.at - b.at).map(({ window }) => window);
};
