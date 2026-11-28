import { readingFreshness, whoopScoresViewSchema, type WhoopScoresView } from '../../../../contracts/src/health/crs';
import { localIso } from '../../channels/reminders';
import type { Reading, Series } from '../producer';

// WHOOP's own scores for the model's standing health block, in words: each against the owner's own WHOOP days, how fresh it is
// and which day it is for. Pure, and never a value: the numbers stay with get_health, in the turn that asks.
export const WHOOP_CONTEXT_SIGNALS = ['provider_recovery', 'provider_day_strain', 'provider_sleep_need', 'sleep_duration', 'workout'] as const;
const PERSONAL_DAYS = 14;
const HOUR_MS = 3_600_000;
type Clock = Readonly<{ now(): Date; timezone: string }>;

const endOf = (reading: Reading): number => Date.parse(reading.endAt ?? reading.startAt ?? `${reading.day}T12:00:00Z`);
const newestFirst = (readings: readonly Reading[]) => [...readings].sort((a, b) => endOf(b) - endOf(a));
const dayWord = (day: string, clock: Clock) => {
  const now = clock.now().getTime();
  return day === localIso(now, clock.timezone).slice(0, 10) ? 'today' as const : day === localIso(now - 24 * HOUR_MS, clock.timezone).slice(0, 10) ? 'yesterday' as const : 'earlier' as const;
};
const at = (reading: Reading, clock: Clock) => ({ as_of_day: dayWord(reading.day, clock), freshness: readingFreshness(clock.now().getTime() - endOf(reading)) });
// The newest reading against one spread either side of the mean of the earlier ones, one per day: the statistic the driver
// phrases use, so "above usual" means the same in both.
const againstUsual = (newest: Reading, earlier: readonly Reading[]): 'above_usual' | 'usual' | 'below_usual' | 'no_usual_yet' => {
  const byDay = new Map<string, number>();
  for (const reading of newestFirst(earlier)) if (reading.day !== newest.day && !byDay.has(reading.day)) byDay.set(reading.day, reading.value);
  const values = [...byDay.values()];
  if (values.length < PERSONAL_DAYS) return 'no_usual_yet';
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
  return newest.value > mean + sd ? 'above_usual' : newest.value < mean - sd ? 'below_usual' : 'usual';
};

export const whoopScoresView = (series: Series, clock: Clock): WhoopScoresView | null => {
  const whoop = series.sources.find(source => source.source === 'whoop');
  if (!whoop) return null;
  const of = (signal: string) => newestFirst(whoop.readings.filter(r => r.signal === signal));
  const view: Record<string, unknown> = {};
  const [recovery, ...recoveries] = of('provider_recovery');
  if (recovery && typeof recovery.provider?.calibrating === 'boolean') view.recovery = { ...at(recovery, clock), against_usual: againstUsual(recovery, recoveries), calibrating: recovery.provider.calibrating };
  const [need] = of('provider_sleep_need');
  const asleep = need && of('sleep_duration').find(r => r.day === need.day && (r.method === null || r.method === 'asleep_duration'));
  if (need && asleep) view.sleep = { ...at(need, clock), against_need: asleep.value >= need.value ? 'met' : 'short', need_counts_debt: typeof need.provider?.debt_minutes === 'number' && need.provider.debt_minutes > 0 };
  const [strain, ...strains] = of('provider_day_strain');
  if (strain) view.strain = { ...at(strain, clock), against_usual: againstUsual(strain, strains.filter(r => r.provider?.open !== true)), open: strain.provider?.open === true };
  const [workout] = of('workout');
  if (workout?.workout) view.workout = { ...at(workout, clock), strain: typeof (workout.workout.detail.strain as { value?: unknown } | undefined)?.value === 'number', zones: workout.workout.zoneSeconds !== null };
  const parsed = whoopScoresViewSchema.safeParse(view);
  return parsed.success ? parsed.data : null;
};
