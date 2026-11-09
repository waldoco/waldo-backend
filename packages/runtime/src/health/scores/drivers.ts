import { BASELINE_DAYS, zScore } from './stats';
import type { DayRecord, DayVitals, TemperatureMethod } from './types';

// A driver says that one of the owner's signals is outside their own usual range today, which way, and whether far: a
// fixed description of a statistic, like a zone word. It never says what that means, never weighs a score, and never
// decides anything is worth telling the owner; the model judges that. The subjects are plain words, so a phrase carries
// no digit and no abbreviation. The derived-row writer admits exactly these phrases.
export const DRIVER_SUBJECTS = ['breathing rate', 'wrist temperature', 'blood oxygen', 'awake time in the night', 'walking heart rate'] as const;
type Subject = (typeof DRIVER_SUBJECTS)[number];
// Candidate band constants, ratified with the zone bands: outside from one spread of the owner's own days, far from two.
const OUTSIDE = 1;
const FAR = 2;
const MAX_DRIVERS = 8;
const TEMPERATURE_ORDER: readonly TemperatureMethod[] = ['absolute', 'baseline_delta'];

type Read = (vitals: DayVitals) => number | null;
// Wrist temperature is read one method at a time, absolute first: a delta is never read against absolute nights.
const READS: readonly (readonly [Subject, readonly Read[]])[] = [
  ['breathing rate', [vitals => vitals.breathingRate]],
  ['wrist temperature', TEMPERATURE_ORDER.map((method): Read => vitals => vitals.wristTemperature.find(entry => entry.method === method)?.value ?? null)],
  ['blood oxygen', [vitals => vitals.bloodOxygen]],
  ['awake time in the night', [vitals => vitals.awakeMinutes]],
  ['walking heart rate', [vitals => vitals.walkingHeartRate]],
];

// Against the owner's own earlier days of the same source and method, with at least fourteen of them. Days that never
// varied give no usual range to be outside of, so they give no driver.
const deviation = (target: DayRecord, prior: readonly DayRecord[], read: Read): number | null => {
  const today = target.vitals ? read(target.vitals) : null;
  if (today === null) return null;
  const past = prior.flatMap(day => { const value = day.vitals ? read(day.vitals) : null; return value === null ? [] : [value]; });
  return past.length >= BASELINE_DAYS && new Set(past).size > 1 ? zScore(today, past) : null;
};

export const driversOf = (target: DayRecord, prior: readonly DayRecord[]): string[] =>
  READS.flatMap(([subject, reads]) => {
    for (const read of reads) {
      const z = deviation(target, prior, read);
      if (z === null) continue;
      return Math.abs(z) < OUTSIDE ? [] : [{ z, phrase: `${subject}${Math.abs(z) >= FAR ? ' far' : ''} ${z > 0 ? 'above' : 'below'} usual` }];
    }
    return [];
  }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, MAX_DRIVERS).map(driver => driver.phrase);
