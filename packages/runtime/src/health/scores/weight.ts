import { ALGORITHM } from './recovery';
import { BASELINE_DAYS, combine, higherIsBetter, zScore, type Component } from './stats';
import { weightZone } from './zones';
import type { DayRecord, DemandInputs, WeightResult } from './types';

const FIELDS = [
  ['calendar', 'meetingMinutes', 0.35], ['tasks', 'openTaskMinutes', 0.3], ['messages', 'messageCount', 0.15], ['physical_load', 'physicalLoad', 0.2],
] as const satisfies readonly (readonly [string, keyof DemandInputs, number])[];

// The day's demand against the owner's own usual. Calendar is the anchor: without it there is no Weight.
export const weightScore = (target: DayRecord, prior: readonly DayRecord[]): WeightResult => {
  const demand = target.demand;
  if (demand?.meetingMinutes === null || demand === null) return { state: 'unavailable', reason: 'calendar_demand_unavailable' };
  const components: Component[] = [];
  const signals: string[] = [];
  const days = new Set<string>([target.day]);
  for (const [name, field, weight] of FIELDS) {
    const value = demand[field];
    if (value === null) continue;
    const history = prior.flatMap(day => { const entry = day.demand?.[field]; return entry === null || entry === undefined ? [] : [{ day: day.day, value: entry }]; });
    if (history.length < BASELINE_DAYS) continue;
    components.push({ name, score: higherIsBetter(zScore(value, history.map(entry => entry.value))), weight });
    signals.push(name);
    history.forEach(entry => days.add(entry.day));
  }
  if (!signals.includes('calendar')) return { state: 'unavailable', reason: 'baseline_immature' };
  const { score, coverage } = combine(components);
  return { state: 'available', score, zone: weightZone(score), algorithm_version: ALGORITHM.weight, activation: 'candidate_unaccepted', coverage, hrv_method: null, used: { signals, days: [...days].sort() } };
};
