import { ALGORITHM } from './recovery';
import { BASELINE_DAYS, combine, higherIsBetter, zScore, type Component } from './stats';
import { weightZone } from './zones';
import type { DayRecord, DemandInputs, WeightResult } from './types';

const FIELDS = [
  ['calendar', 'meetingMinutes', 0.35], ['tasks', 'openTaskMinutes', 0.3], ['messages', 'messageCount', 0.15],
] as const satisfies readonly (readonly [string, keyof DemandInputs, number])[];
const PHYSICAL_LOAD_SHARE = 0.2;

// The day's active energy, the sum of its hours; unknown on a day with no energy reading.
const activeEnergy = (day: DayRecord): number | null => {
  const hours = day.hourly.flatMap(bucket => (bucket.activeEnergyKcal === null ? [] : [bucket.activeEnergyKcal]));
  return hours.length ? hours.reduce((total, kcal) => total + kcal, 0) : null;
};
// Physical load is the day's active energy, which weighs intensity as well as time, read against the owner's own days of
// energy, so a stable per-device bias cancels. Without energy today, or with fewer than fourteen earlier days of it, it is
// movement and workout minutes against the owner's own minutes. The two are never read against each other's days.
const LOAD_MEASURES: readonly ((day: DayRecord) => number | null)[] = [activeEnergy, day => day.demand?.physicalLoad ?? null];

const history = (prior: readonly DayRecord[], read: (day: DayRecord) => number | null | undefined) =>
  prior.flatMap(day => { const value = read(day); return value === null || value === undefined ? [] : [{ day: day.day, value }]; });

// The day's demand against the owner's own usual. Calendar is the anchor: without it there is no Weight.
export const weightScore = (target: DayRecord, prior: readonly DayRecord[]): WeightResult => {
  const demand = target.demand;
  if (demand?.meetingMinutes === null || demand === null) return { state: 'unavailable', reason: 'calendar_demand_unavailable' };
  const components: Component[] = [];
  const signals: string[] = [];
  const days = new Set<string>([target.day]);
  const add = (name: string, value: number, past: readonly { day: string; value: number }[], weight: number) => {
    components.push({ name, score: higherIsBetter(zScore(value, past.map(entry => entry.value))), weight });
    signals.push(name);
    past.forEach(entry => days.add(entry.day));
  };
  for (const [name, field, weight] of FIELDS) {
    const value = demand[field];
    if (value === null) continue;
    const past = history(prior, day => day.demand?.[field]);
    if (past.length >= BASELINE_DAYS) add(name, value, past, weight);
  }
  for (const measure of LOAD_MEASURES) {
    const value = measure(target);
    const past = value === null ? [] : history(prior, measure);
    if (value === null || past.length < BASELINE_DAYS) continue;
    add('physical_load', value, past, PHYSICAL_LOAD_SHARE);
    break;
  }
  if (!signals.includes('calendar')) return { state: 'unavailable', reason: 'baseline_immature' };
  const { score, coverage } = combine(components);
  return { state: 'available', score, zone: weightZone(score), algorithm_version: ALGORITHM.weight, activation: 'candidate_unaccepted', coverage, hrv_method: null, used: { signals, days: [...days].sort() } };
};
