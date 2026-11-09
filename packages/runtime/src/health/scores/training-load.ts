import { shiftDay } from './time';

// Training load, candidate (ADR-0081 amendment of 31 Oct 2026, §2). It compares the owner's last seven whole calendar days
// of training with the twenty-one before them, in one load method, and names the change in a closed, digit-free phrase.
// Whether a change matters is the model's judgment; no injury-risk rule lives here.
export const TRAINING_LOAD_VERSION = 'training-load.candidate.v1';
export const TRAINING_LOAD_PHRASES = ['much lighter than usual', 'lighter than usual', 'about usual', 'heavier than usual', 'much heavier than usual'] as const;
export type TrainingLoadPhrase = (typeof TRAINING_LOAD_PHRASES)[number];
export type LoadMethod = 'hr_zones' | 'hr_zones_observed_peak' | 'effort' | 'minutes';
export interface WorkoutLoad {
  // The local day the workout started on.
  readonly day: string;
  readonly minutes: number;
  // Seconds in zones 1 to 5, as the phone or provider bucketed them.
  readonly zoneSeconds: readonly number[] | null;
  // The zones were set from the highest heart rate seen in a workout, not a measured maximum, so they are approximate.
  readonly zonesFromObservedPeak?: boolean;
  readonly effort: Readonly<{ score: number; method: 'rated' | 'estimated' }> | null;
}
export type TrainingLoad =
  | Readonly<{ state: 'available'; phrase: TrainingLoadPhrase; method: LoadMethod; algorithm_version: typeof TRAINING_LOAD_VERSION; activation: 'candidate_unaccepted' }>
  | Readonly<{ state: 'unavailable'; reason: 'no_readings' | 'baseline_immature' }>;

const ACUTE_DAYS = 7;
const WINDOW_DAYS = 28;
const MIN_OBSERVED_DAYS = 21;

// Edwards' summated heart-rate-zone TRIMP, session RPE (Foster 2001), or minutes. A window takes the first method every
// workout in it carries, so two methods are never added together; an effort window is all rated or all estimated. Zones are
// counted the same way whatever set them; a window with any zones set from an observed peak says so, as approximate.
const methodOf = (workouts: readonly WorkoutLoad[]): LoadMethod => {
  if (workouts.every(w => w.zoneSeconds?.length === 5)) return workouts.some(w => w.zonesFromObservedPeak === true) ? 'hr_zones_observed_peak' : 'hr_zones';
  const kinds = new Set(workouts.map(w => w.effort?.method ?? null));
  return kinds.size === 1 && !kinds.has(null) ? 'effort' : 'minutes';
};
const loadOf = (workout: WorkoutLoad, method: LoadMethod): number =>
  method === 'hr_zones' || method === 'hr_zones_observed_peak' ? workout.zoneSeconds!.reduce((sum, seconds, zone) => sum + (zone + 1) * seconds / 60, 0)
    : method === 'effort' ? workout.minutes * workout.effort!.score
      : workout.minutes;

// Bands on the size of the change, not on risk: within 15 % is about usual, past 50 % (or below 60 %) is much.
const phraseOf = (acute: number, usual: number): TrainingLoadPhrase => {
  if (usual === 0) return acute === 0 ? 'about usual' : 'much heavier than usual';
  const ratio = acute / usual;
  return ratio < 0.6 ? 'much lighter than usual' : ratio < 0.85 ? 'lighter than usual' : ratio <= 1.15 ? 'about usual' : ratio <= 1.5 ? 'heavier than usual' : 'much heavier than usual';
};

// throughDay is the last whole day the load covers, so a day still in progress never counts as a light one. observedDays
// are the days a body-worn sensor reported on; a day with a workout is observed whatever the caller says. Any other day is
// left out of both means rather than counted as rest.
export const trainingLoad = (input: Readonly<{ throughDay: string; observedDays: readonly string[]; workouts: readonly WorkoutLoad[] }>): TrainingLoad => {
  const window = new Set(Array.from({ length: WINDOW_DAYS }, (_, i) => shiftDay(input.throughDay, -i)));
  const acute = new Set([...window].slice(0, ACUTE_DAYS));
  const workouts = input.workouts.filter(w => window.has(w.day));
  if (!workouts.length) return { state: 'unavailable', reason: 'no_readings' };
  const observed = new Set([...input.observedDays, ...workouts.map(w => w.day)].filter(day => window.has(day)));
  const acuteObserved = [...observed].filter(day => acute.has(day)).length;
  if (observed.size < MIN_OBSERVED_DAYS || acuteObserved === 0) return { state: 'unavailable', reason: 'baseline_immature' };
  const method = methodOf(workouts);
  const total = (inAcute: boolean) => workouts.filter(w => acute.has(w.day) === inAcute).reduce((sum, w) => sum + loadOf(w, method), 0);
  const phrase = phraseOf(total(true) / acuteObserved, total(false) / (observed.size - acuteObserved));
  return { state: 'available', phrase, method, algorithm_version: TRAINING_LOAD_VERSION, activation: 'candidate_unaccepted' };
};
