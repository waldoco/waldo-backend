import { computeDailyScores } from '../../src/health/scores';
import type { DailyScores, DayRecord, HourlyBucket } from '../../src/health/scores/types';

// Synthetic owners from a seeded generator. A night's noise is drawn in a fixed order whatever the injected event, so an
// event changes only what it names and two runs of one seed are the same owner. Values come from published spreads, never
// from a real person.
export const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const normal = (next: () => number) => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

export interface OwnerSpec {
  readonly seed: number;
  readonly sleepMinutes: number;
  readonly sleepSd: number;
  // The owner's usual overnight variability in milliseconds, and its night-to-night spread on the natural-log scale.
  readonly variabilityMedian: number;
  readonly variabilitySd: number;
  readonly pulseMean: number;
  readonly pulseSd: number;
  readonly hrvMethod: 'rmssd' | 'sdnn';
  readonly load: number | null;
  readonly calendar: number | null;
}
export const typicalOwner = (seed: number): OwnerSpec => ({
  seed, sleepMinutes: 480, sleepSd: 20, variabilityMedian: 40, variabilitySd: 0.15, pulseMean: 62, pulseSd: 2.5, hrvMethod: 'rmssd', load: 100, calendar: 240,
});

// What an event does to one night, on top of the owner's usual.
export interface NightEvent {
  readonly sleepMinutes?: number;
  readonly pulseDelta?: number;
  readonly lnVariabilityDelta?: number;
  readonly loadFactor?: number;
  readonly breathingDelta?: number;
  readonly temperatureDelta?: number;
  readonly missingSleep?: boolean;
  readonly missingVariability?: boolean;
}
export type Events = (night: number) => NightEvent;

export const FIRST_DAY = '2026-01-01';
export const dayOf = (night: number) => new Date(Date.parse(`${FIRST_DAY}T00:00:00Z`) + night * 86_400_000).toISOString().slice(0, 10);

const hourlyOf = (day: string, hrvMethod: 'rmssd' | 'sdnn', hrv: number, pulse: number, daylight: number, movement: number): HourlyBucket[] =>
  [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(hour => ({
    startAt: new Date(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000).toISOString(),
    heartRate: pulse, hrv, hrvMethod, daylightMinutes: daylight, movementMinutes: movement, activeEnergyKcal: null,
  }));

export const history = (spec: OwnerSpec, nights: number, events: Events = () => ({})): DayRecord[] => {
  const next = mulberry32(spec.seed);
  return Array.from({ length: nights }, (_, night): DayRecord => {
    const draws = Array.from({ length: 10 }, () => normal(next));
    const e = events(night), day = dayOf(night), previous = dayOf(night - 1);
    const variability = Math.exp(Math.log(spec.variabilityMedian) + spec.variabilitySd * draws[1]! + (e.lnVariabilityDelta ?? 0));
    const pulse = spec.pulseMean + spec.pulseSd * draws[2]! + (e.pulseDelta ?? 0);
    const sleep = e.missingSleep ? null : { startAt: `${previous}T23:00:00.000Z`, endAt: `${day}T07:00:00.000Z`, asleepMinutes: e.sleepMinutes ?? spec.sleepMinutes + spec.sleepSd * draws[0]!, midpointMinute: 180 + 15 * draws[3]! };
    const load = spec.load === null ? null : (spec.load + 10 * draws[4]!) * (e.loadFactor ?? 1);
    return {
      day, timezone: 'UTC', sleep,
      overnightHrv: e.missingVariability ? [] : [{ value: variability, method: spec.hrvMethod }],
      restingHeartRate: [{ value: pulse, method: 'overnight_resting' }],
      hourly: hourlyOf(day, spec.hrvMethod, variability * 1.1, 72 + 2 * draws[5]!, 20 + 2 * draws[6]!, 12 + 2 * draws[7]!), workouts: [],
      demand: { meetingMinutes: spec.calendar === null ? null : spec.calendar + 40 * draws[8]!, messageCount: null, openTaskMinutes: null, physicalLoad: load },
      vitals: {
        breathingRate: 14 + 0.5 * draws[9]! + (e.breathingDelta ?? 0), bloodOxygen: null, awakeMinutes: null, walkingHeartRate: null,
        wristTemperature: [{ value: 34 + 0.25 * draws[6]! + (e.temperatureDelta ?? 0), method: 'absolute' }],
      },
    };
  });
};

// The scores for night `night` of an owner, from that night and every earlier one the caller kept.
export const scoresAt = (records: readonly DayRecord[], night: number, over: { sleepNeedMinutes?: number | null; provisional?: boolean; since?: number } = {}): DailyScores =>
  computeDailyScores({
    access: 'granted', targetDay: dayOf(night), days: records.filter((_, i) => i <= night && i >= (over.since ?? 0)), sleepNeedMinutes: over.sleepNeedMinutes ?? null,
    asOf: `${dayOf(night)}T20:00:00.000Z`, provisional: over.provisional ?? true,
  });
