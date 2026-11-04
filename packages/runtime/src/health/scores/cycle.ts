import type { PlacedDay } from '../cycle/phase';
import { daysBetween } from './time';
import type { DayRecord } from './types';

// Proposed ADR-0085 D5: with cycle context on, HRV, resting heart rate, wrist temperature and breathing rate are read against the
// owner's own earlier days in the same phase, once those days span two cycles; otherwise against the ordinary baseline. It is a
// baseline change, never a bonus: a reading that is unusual for this phase still is. Sleep, daylight, movement and load are not
// phase-read.
export interface CycleContext {
  // The placed phase of the target day and the days before it. A day not in the map is unknown.
  readonly phases: ReadonlyMap<string, PlacedDay>;
  // The days the phase prior reads, up to 90 back. Kept apart from the input's days so the ordinary computation sees exactly
  // what it sees without cycle context.
  readonly lookback: readonly DayRecord[];
}
export interface PhasePrior {
  readonly days: readonly DayRecord[];
  readonly cycleOf: ReadonlyMap<string, string>;
}

// Two cycles of a phase reach back about two months, past the ordinary 30-day window; raw readings are kept 90 days.
export const PHASE_WINDOW_DAYS = 90;
export const PHASE_CYCLES = 2;
export const CYCLE_PHASE_BASIS = { kind: 'cycle_phase', explanation: 'Read against your own usual readings for this part of your cycle.' } as const;

export const phasePriorOf = (targetDay: string, days: Iterable<DayRecord>, cycle: CycleContext | undefined): PhasePrior | null => {
  const at = cycle?.phases.get(targetDay);
  if (!cycle || !at || at.phase === 'unknown') return null;
  const same: DayRecord[] = [];
  const cycleOf = new Map<string, string>();
  for (const record of days) {
    const age = daysBetween(record.day, targetDay);
    const placed = cycle.phases.get(record.day);
    if (age < 1 || age > PHASE_WINDOW_DAYS || placed?.phase !== at.phase || placed.cycleStart === null) continue;
    same.push(record);
    cycleOf.set(record.day, placed.cycleStart);
  }
  return { days: same, cycleOf };
};

export const spansCycles = (phase: PhasePrior, used: readonly string[]): boolean => new Set(used.map(day => phase.cycleOf.get(day))).size >= PHASE_CYCLES;
