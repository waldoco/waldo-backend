import type { PlacedDay } from '../cycle/phase';
import { daysBetween } from './time';
import type { DayRecord } from './types';

// ADR-0085 D5: with cycle context on, HRV, resting heart rate, wrist temperature and breathing rate are read against the owner's
// own earlier days in the same phase, once those days span two cycles; otherwise against the ordinary baseline. It is a baseline
// change, never a bonus: a reading that is unusual for this phase still is. Sleep, daylight, movement and load are not phase-read.
export interface CycleContext {
  // The placed phase of the target day and the days before it. A day not in the map is unknown.
  readonly phases: ReadonlyMap<string, PlacedDay>;
  // The days the phase prior reads, up to PHASE_WINDOW_DAYS back. Kept apart from the input's days so the ordinary computation
  // sees exactly what it sees without cycle context.
  readonly lookback: readonly DayRecord[];
}
export interface PhasePrior {
  readonly days: readonly DayRecord[];
  readonly cycleOf: ReadonlyMap<string, string>;
}

// Two cycles of a phase reach back about two months, past the ordinary 30-day window; raw readings are kept 90 days. The prior
// keeps the most recent same-phase days up to the ordinary window's size, so it never stands on more days than a usual does.
export const PHASE_WINDOW_DAYS = 90;
export const PHASE_MAX_DAYS = 30;
export const PHASE_CYCLES = 2;
// The backend's one line for the app, shown only when the phase changed a score, a zone or a driver. It names no phase, date,
// prediction or comparison (D7).
export const CYCLE_PHASE_BASIS = { kind: 'cycle_phase', explanation: 'Read against your own usual for this part of your cycle.' } as const;

export const phasePriorOf = (targetDay: string, cycle: CycleContext): PhasePrior | null => {
  const at = cycle.phases.get(targetDay);
  if (!at || at.phase === 'unknown') return null;
  const same = cycle.lookback
    .filter(record => {
      const age = daysBetween(record.day, targetDay), placed = cycle.phases.get(record.day);
      return age >= 1 && age <= PHASE_WINDOW_DAYS && placed?.phase === at.phase && placed.cycleStart !== null;
    })
    .sort((a, b) => b.day.localeCompare(a.day)).slice(0, PHASE_MAX_DAYS);
  return { days: same, cycleOf: new Map(same.map(record => [record.day, cycle.phases.get(record.day)!.cycleStart!])) };
};

// Whether the days a baseline used come from at least two of the owner's cycles.
export const spansCycles = (phase: PhasePrior, used: readonly string[]): boolean => new Set(used.map(day => phase.cycleOf.get(day))).size >= PHASE_CYCLES;
