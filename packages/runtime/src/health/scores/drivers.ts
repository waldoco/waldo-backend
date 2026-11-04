import { BASELINE_DAYS, bounded, mean } from './stats';
import type { DayRecord, DayVitals, TemperatureMethod } from './types';

// A driver says that one of the owner's signals is outside their own usual range today, which way, and whether far: a
// fixed description of a statistic, like a zone word. It never says what that means, never weighs a score, and never
// decides anything is worth telling the owner; the model judges that. The subjects are plain words, so a phrase carries
// no digit and no abbreviation. The derived-row writer admits exactly these phrases.
export const DRIVER_SUBJECTS = ['breathing rate', 'wrist temperature', 'blood oxygen', 'awake time in the night', 'walking heart rate'] as const;
type Subject = (typeof DRIVER_SUBJECTS)[number];
// Candidate band constants, ratified with the zone bands: outside from one spread of the owner's own days, far from two. The
// usual band and a part's direction take the same cut, so a band's edge is where the phrase begins.
export const OUTSIDE = 1;
const FAR = 2;
const MAX_DRIVERS = 8;
const TEMPERATURE_ORDER: readonly TemperatureMethod[] = ['absolute', 'baseline_delta'];

type Read = (vitals: DayVitals) => number | null;
// Wrist temperature is read one method at a time, absolute first: a delta is never read against absolute nights.
const READS: readonly (readonly [Subject, readonly (readonly [method: TemperatureMethod | null, read: Read])[]])[] = [
  ['breathing rate', [[null, vitals => vitals.breathingRate]]],
  ['wrist temperature', TEMPERATURE_ORDER.map((method): [TemperatureMethod, Read] => [method, vitals => vitals.wristTemperature.find(entry => entry.method === method)?.value ?? null])],
  ['blood oxygen', [[null, vitals => vitals.bloodOxygen]]],
  ['awake time in the night', [[null, vitals => vitals.awakeMinutes]]],
  ['walking heart rate', [[null, vitals => vitals.walkingHeartRate]]],
];
// The usual-signal each subject is shown under.
export const SUBJECT_SIGNALS: Readonly<Record<Subject, string>> = {
  'breathing rate': 'breathing_rate', 'wrist temperature': 'wrist_temperature', 'blood oxygen': 'spo2', 'awake time in the night': 'awake_time', 'walking heart rate': 'walking_heart_rate',
};

export interface OwnRange { readonly today: number; readonly mean: number; readonly sd: number; readonly days: number }
// The day's value against the owner's own earlier days of the same source and method, with at least fourteen of them. Days
// that never varied give no usual range to be outside of, so they give none. The plain mean and population spread, no prior.
export const ownRange = (target: DayRecord, prior: readonly DayRecord[], read: (day: DayRecord) => number | null): OwnRange | null => {
  const today = read(target);
  if (today === null) return null;
  const past = prior.flatMap(day => { const value = read(day); return value === null ? [] : [value]; });
  if (past.length < BASELINE_DAYS || new Set(past).size <= 1) return null;
  const centre = mean(past);
  return { today, mean: centre, sd: Math.sqrt(mean(past.map(value => (value - centre) ** 2))), days: past.length };
};
const deviation = (range: OwnRange): number => bounded(range.today - range.mean, range.sd);
const vitalsRead = (read: Read) => (day: DayRecord): number | null => (day.vitals ? read(day.vitals) : null);

// The range each subject's reading is judged against today, as the first method that has one reads it; the subjects with no
// range today are left out. A usual band and a driver phrase for one subject are the same statistic.
export const driverRanges = (target: DayRecord, prior: readonly DayRecord[]): { subject: Subject; method: TemperatureMethod | null; range: OwnRange }[] =>
  READS.flatMap(([subject, reads]) => {
    for (const [method, read] of reads) {
      const range = ownRange(target, prior, vitalsRead(read));
      if (range !== null) return [{ subject, method, range }];
    }
    return [];
  });

export const driversOf = (target: DayRecord, prior: readonly DayRecord[]): string[] =>
  driverRanges(target, prior).map(({ subject, range }) => ({ subject, z: deviation(range) }))
    .filter(({ z }) => Math.abs(z) >= OUTSIDE)
    .map(({ subject, z }) => ({ z, phrase: `${subject}${Math.abs(z) >= FAR ? ' far' : ''} ${z > 0 ? 'above' : 'below'} usual` }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, MAX_DRIVERS).map(driver => driver.phrase);
