// The owner's cycle phase on a day, from their own period start dates (proposed ADR-0085 D4). Pure: no clock, no I/O.
//
// - Phases: menstrual (inside a recorded period), follicular (after it, before the estimated ovulation), luteal (from the
//   estimated ovulation to the next period), unknown.
// - A day whose cycle has ended is placed on the actual next start. Otherwise cycle length is the median of the owner's complete
//   cycles once there are two; before that a population default places the phase boundaries. Ovulation is the next start, actual
//   or expected, less 14 days, because the luteal half is the more stable one.
// - unknown when no period started in the 60 days up to the day, when a recent cycle falls outside 21-45 days, when recent
//   cycles vary by more than 9 days, or when there is no period to count from. unknown changes nothing downstream.
//
// The kill switch is CYCLE_CONTEXT: only "1" lets the engine place a phase. "paused" keeps the app's routes up, so the owner can
// still see and withdraw, while every day reads as unknown; anything else is off, routes and engine both.
export type CyclePhase = 'menstrual' | 'follicular' | 'luteal' | 'unknown';
export interface PeriodDates { readonly start: string; readonly end: string | null }
export interface PlacedDay { readonly phase: CyclePhase; readonly cycleStart: string | null }

export const cycleEngineOn = (flag: string | undefined): boolean => flag === '1';
export const cycleRoutesOpen = (flag: string | undefined): boolean => flag === '1' || flag === 'paused';

const DEFAULT_CYCLE_DAYS = 28;
const LUTEAL_DAYS = 14;
const MIN_CYCLE_DAYS = 21;
const MAX_CYCLE_DAYS = 45;
const MAX_SPREAD_DAYS = 9;
const RECENT_PERIOD_DAYS = 60;
// The cycles that decide length and regularity: the latest ones only, so an old irregular stretch does not hold the phase unknown.
const RECENT_CYCLES = 6;
// A period with no end date (ongoing, or never closed in the owner's app) is taken to last this long.
const OPEN_PERIOD_DAYS = 5;

const ordinal = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

// Periods from every source, merged: two records that overlap or touch are one period.
const merged = (periods: readonly PeriodDates[]): { start: number; end: number; startDay: string }[] => {
  const spans = periods.map(period => {
    const start = ordinal(period.start);
    return { start, end: period.end === null ? start + OPEN_PERIOD_DAYS - 1 : ordinal(period.end), startDay: period.start };
  }).filter(span => Number.isFinite(span.start) && Number.isFinite(span.end)).sort((a, b) => a.start - b.start);
  const out: typeof spans = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
};

export const cyclePhaseOn = (day: string, periods: readonly PeriodDates[], flag: string | undefined): PlacedDay => {
  const unknown: PlacedDay = { phase: 'unknown', cycleStart: null };
  if (!cycleEngineOn(flag)) return unknown;
  const at = ordinal(day);
  if (!Number.isFinite(at)) return unknown;
  const spans = merged(periods);
  const index = spans.filter(span => span.start <= at).length - 1;
  const current = spans[index], next = spans[index + 1];
  if (!current || at - current.start >= RECENT_PERIOD_DAYS) return unknown;

  const known = spans.slice(0, index + 1);
  const lengths = [...known.slice(1).map((span, i) => span.start - known[i]!.start), ...(next ? [next.start - current.start] : [])].slice(-RECENT_CYCLES);
  if (lengths.some(length => length < MIN_CYCLE_DAYS || length > MAX_CYCLE_DAYS)) return unknown;
  if (lengths.length && Math.max(...lengths) - Math.min(...lengths) > MAX_SPREAD_DAYS) return unknown;
  const cycleDays = next ? next.start - current.start : lengths.length >= 2 ? median(lengths) : DEFAULT_CYCLE_DAYS;

  const placed = (phase: CyclePhase): PlacedDay => ({ phase, cycleStart: current.startDay });
  if (at <= current.end) return placed('menstrual');
  const ovulation = current.start + cycleDays - LUTEAL_DAYS;
  if (at < ovulation) return placed('follicular');
  // Past the expected next start the period is late or unrecorded; nothing is said about it, and the day is unknown.
  return at < current.start + cycleDays ? placed('luteal') : unknown;
};
