import { crsPillarSchema, type CrsPillar } from '../../../../contracts/src/health/crs';
import { ALGORITHM, usualSleepMinutes } from './recovery';
import { BASELINE_DAYS, circularZScore, clampScore, higherIsBetter, logZScore, mean, nearUsual, zScore } from './stats';
import { formZone } from './zones';
import type { DayRecord, FormResult, HourlyBucket } from './types';

// ADR-0081 form.safte-fast.v1 shares in thousandths, in the contract's pillar order (sleep, hrv, circadian, motion),
// so the composite rounds half up exactly.
const PILLARS = crsPillarSchema.options;
const SHARE_PER_MILLE = [500, 350, 75, 75] as const;
type Pillar = CrsPillar;
// The accepted v1 source table. A source outside it cannot enter the score.
const SOURCE_CONFIDENCE: Readonly<Record<string, number>> = { apple: 1, samsung: 0.6 };
const HOUR_MS = 3_600_000;
// Age of the night's data: fresh up to 36 hours, stale (confidence x0.75) up to 72, unavailable beyond.
const FRESH_HOURS = 36;
const STALE_HOURS = 72;
const MIN_DAY_BUCKETS = 8;

// Sleep and hrv are required, plus circadian or motion. A missing optional pillar is not imputed: the formula
// renormalises over the pillars present, so coverage is 0.925 or 1.
export const formComposite = (scores: Readonly<Record<Pillar, number | null>>): { score: number; coverage: number } | null => {
  if (scores.sleep === null || scores.hrv === null || (scores.circadian === null && scores.motion === null)) return null;
  let total = 0;
  let present = 0;
  PILLARS.forEach((pillar, index) => {
    const score = scores[pillar];
    if (score === null) return;
    total += SHARE_PER_MILLE[index]! * score;
    present += SHARE_PER_MILLE[index]!;
  });
  return { score: Math.min(100, Math.max(0, Math.floor((2 * total + present) / (2 * present)))), coverage: present / 1000 };
};

const integer = (score: number): number => Math.round(clampScore(score));
const history = <T,>(prior: readonly DayRecord[], read: (day: DayRecord) => T | null) =>
  prior.flatMap(day => { const value = read(day); return value === null ? [] : [{ day: day.day, value }]; });
const dayTotal = (day: DayRecord, pick: (bucket: HourlyBucket) => number | null): number | null =>
  (day.hourly.length >= MIN_DAY_BUCKETS ? day.hourly.reduce((sum, bucket) => sum + (pick(bucket) ?? 0), 0) : null);
// A day total against the owner's usual, scored highest at the usual.
const nearUsualTotal = (target: DayRecord, prior: readonly DayRecord[], pick: (bucket: HourlyBucket) => number | null) => {
  const value = dayTotal(target, pick);
  const usual = history(prior, day => dayTotal(day, pick));
  return value !== null && usual.length >= BASELINE_DAYS ? { score: nearUsual(zScore(value, usual.map(entry => entry.value))), days: usual.map(entry => entry.day) } : null;
};

export const formScore = (target: DayRecord, prior: readonly DayRecord[], sleepNeedMinutes: number | null, asOf: string | null, source: string | null): FormResult => {
  const sourceConfidence = source === null ? undefined : SOURCE_CONFIDENCE[source];
  if (sourceConfidence === undefined) return { state: 'unavailable', reason: 'no_readings' };
  if (!target.sleep) return { state: 'unavailable', reason: 'missing_sleep' };
  let freshness = 1;
  if (asOf !== null) {
    const age = Date.parse(asOf) - Date.parse(target.sleep.endAt);
    if (!Number.isFinite(age) || age > STALE_HOURS * HOUR_MS) return { state: 'unavailable', reason: 'stale_inputs' };
    if (age > FRESH_HOURS * HOUR_MS) freshness = 0.75;
  }
  const need = sleepNeedMinutes ?? usualSleepMinutes(prior);
  if (need === null || need <= 0) return { state: 'unavailable', reason: 'baseline_immature' };
  const hrv = target.overnightHrv;
  if (!hrv) return { state: 'unavailable', reason: 'missing_resting_signal' };
  // RMSSD and SDNN are different measures: a reading is only compared with its own method.
  const hrvUsual = history(prior, day => (day.overnightHrv?.method === hrv.method ? day.overnightHrv.value : null));
  if (hrvUsual.length < BASELINE_DAYS) return { state: 'unavailable', reason: 'baseline_immature' };

  const days = new Set<string>([target.day, ...hrvUsual.map(entry => entry.day)]);
  const midpoints = history(prior, day => day.sleep?.midpointMinute ?? null);
  const midpointZ = midpoints.length >= BASELINE_DAYS ? circularZScore(target.sleep.midpointMinute, midpoints.map(entry => entry.value)) : null;
  const daylight = nearUsualTotal(target, prior, bucket => bucket.daylightMinutes);
  const circadianParts = [...(midpointZ === null ? [] : [nearUsual(midpointZ)]), ...(daylight ? [daylight.score] : [])];
  if (midpointZ !== null) midpoints.forEach(entry => days.add(entry.day));
  daylight?.days.forEach(day => days.add(day));
  const motion = nearUsualTotal(target, prior, bucket => bucket.movementMinutes);
  motion?.days.forEach(day => days.add(day));

  const pillars: Record<Pillar, number | null> = {
    sleep: integer(target.sleep.asleepMinutes / need * 100),
    hrv: integer(higherIsBetter(logZScore(hrv.value, hrvUsual.map(entry => entry.value)))),
    circadian: circadianParts.length ? integer(mean(circadianParts)) : null,
    motion: motion ? integer(motion.score) : null,
  };
  const composite = formComposite(pillars);
  if (!composite) return { state: 'unavailable', reason: 'baseline_immature' };
  const signals = PILLARS.filter(pillar => pillars[pillar] !== null);
  return {
    state: 'available', score: composite.score, zone: formZone(composite.score), algorithm_version: ALGORITHM.form, activation: 'candidate_unaccepted',
    coverage: composite.coverage, confidence: Math.round(composite.coverage * sourceConfidence * freshness * 1000) / 1000,
    hrv_method: hrv.method, used: { signals, days: [...days].sort() },
  };
};
