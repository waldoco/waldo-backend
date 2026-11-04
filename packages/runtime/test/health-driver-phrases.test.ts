import { describe, expect, it } from 'vitest';
import { healthDriverPhraseV1Schema } from '../../contracts/src/app/health-ingest';
import { DRIVER_SUBJECTS, driversOf } from '../src/health/scores/drivers';
import type { DayRecord, DayVitals } from '../src/health/scores/types';

// The contract names the drivers as a literal list because contracts cannot import the runtime. This is what keeps that
// list and the phrases the backend writes from drifting apart. Every value here is synthetic.
const NO_VITALS: DayVitals = { breathingRate: null, bloodOxygen: null, wristTemperature: [], awakeMinutes: null, walkingHeartRate: null };
type Subject = (typeof DRIVER_SUBJECTS)[number];
const vitalsFor = (subject: Subject, value: number): DayVitals => {
  switch (subject) {
    case 'breathing rate': return { ...NO_VITALS, breathingRate: value };
    case 'wrist temperature': return { ...NO_VITALS, wristTemperature: [{ value, method: 'absolute' }] };
    case 'blood oxygen': return { ...NO_VITALS, bloodOxygen: value };
    case 'awake time in the night': return { ...NO_VITALS, awakeMinutes: value };
    case 'walking heart rate': return { ...NO_VITALS, walkingHeartRate: value };
  }
};
const record = (day: string, vitals: DayVitals): DayRecord => ({ day, timezone: 'Europe/London', sleep: null, overnightHrv: [], restingHeartRate: [], hourly: [], workouts: [], demand: null, vitals });
// Sixteen earlier days one unit either side of a middle, so one spread is 1 and a reading 1.5 or 3 away is near or far.
const earlier = (subject: Subject): DayRecord[] => Array.from({ length: 16 }, (_, i) => record(`2026-03-${String(i + 1).padStart(2, '0')}`, vitalsFor(subject, i % 2 === 0 ? 49 : 51)));
const readings = [{ value: 51.5, far: '', way: 'above' }, { value: 53, far: ' far', way: 'above' }, { value: 48.5, far: '', way: 'below' }, { value: 47, far: ' far', way: 'below' }] as const;

describe('driver phrases the contract names', () => {
  const written = DRIVER_SUBJECTS.flatMap(subject => readings.map(({ value, far, way }) => ({
    label: `${subject}${far} ${way} usual`, phrases: driversOf(record('2026-03-20', vitalsFor(subject, value)), earlier(subject)),
  })));
  it('are exactly the phrases driversOf writes: every subject, above and below, near and far', () => {
    expect(written).toHaveLength(20);
    for (const { label, phrases } of written) expect(phrases, label).toEqual([label]);
    expect(new Set(written.flatMap(({ phrases }) => phrases))).toEqual(new Set(healthDriverPhraseV1Schema.options));
  });
  it('are the cross product of the runtime subjects, so a new subject fails here until the contract names it', () => {
    const product = DRIVER_SUBJECTS.flatMap(subject => ['', ' far'].flatMap(far => ['above', 'below'].map(way => `${subject}${far} ${way} usual`)));
    expect(new Set(healthDriverPhraseV1Schema.options)).toEqual(new Set(product));
    for (const { phrases } of written) for (const phrase of phrases) expect(healthDriverPhraseV1Schema.safeParse(phrase).success, phrase).toBe(true);
  });
});
