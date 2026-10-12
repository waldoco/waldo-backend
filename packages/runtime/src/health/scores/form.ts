import {
  FORM_V2_EXERTION_MOVEMENT_MINUTES, FORM_V2_SDNN_CONFIDENCE_FACTOR, FORM_V2_SHARES_PER_10K, FORM_V2_SOURCE_CONFIDENCE,
  formV2PillarSchema, type FormV2Pillar,
} from '../../../../contracts/src/health/crs';
import { ALGORITHM, usualSleepMinutes } from './recovery';
import { BASELINE_DAYS, circularZScore, clampScore, higherIsBetter, logZScore, lowerIsBetter, mean, nearUsual, zScore } from './stats';
import { formZone } from './zones';
import type { DayRecord, FormResult, HourlyBucket, HrvMethod, Span, UnavailableReason } from './types';

// Candidate form.safte-fast.v2 (ADR-0081 2026-10-12 amendment). Shares are per 10,000 so the composite rounds half up exactly.
const PILLARS = formV2PillarSchema.options;
const SOURCE_ORDER = Object.keys(FORM_V2_SOURCE_CONFIDENCE);
const HOUR_MS = 3_600_000;
// Age of the night's data: fresh up to 36 hours, stale (confidence x0.75) up to 72, unavailable beyond.
const FRESH_HOURS = 36;
const STALE_HOURS = 72;
const MIN_DAY_HOURS = 8;
const MIN_STRESS_HOURS = 8;
const MIN_STRESS_HRV_HOURS = 4;

// Sleep and hrv are required, plus circadian, motion or stress. A missing optional pillar is not imputed: the formula
// renormalises over the pillars present.
export const formComposite = (scores: Readonly<Record<FormV2Pillar, number | null>>): { score: number; coverage: number } | null => {
  if (scores.sleep === null || scores.hrv === null || (scores.circadian === null && scores.motion === null && scores.stress === null)) return null;
  let total = 0;
  let present = 0;
  for (const pillar of PILLARS) {
    const score = scores[pillar];
    if (score === null) continue;
    total += FORM_V2_SHARES_PER_10K[pillar] * score;
    present += FORM_V2_SHARES_PER_10K[pillar];
  }
  return { score: Math.min(100, Math.max(0, Math.floor((2 * total + present) / (2 * present)))), coverage: present / 10_000 };
};

export type FormSource = Readonly<{ source: string; target: DayRecord; prior: readonly DayRecord[] }>;
type Pillar = Readonly<{ score: number; days: readonly string[]; hrvMethod?: HrvMethod }>;
type Attempt = Pillar | Readonly<{ reason: UnavailableReason }>;
type Chosen = Readonly<{ source: FormSource; pillar: Pillar }>;

const integer = (score: number): number => Math.round(clampScore(score));
const history = <T,>(prior: readonly DayRecord[], read: (day: DayRecord) => T | null) =>
  prior.flatMap(day => { const value = read(day); return value === null ? [] : [{ day: day.day, value }]; });
// A day total counts only hours that carry the reading, and needs eight of them.
const dayTotal = (day: DayRecord, pick: (bucket: HourlyBucket) => number | null): number | null => {
  const values = day.hourly.flatMap(bucket => { const value = pick(bucket); return value === null ? [] : [value]; });
  return values.length >= MIN_DAY_HOURS ? values.reduce((sum, value) => sum + value, 0) : null;
};
const nearUsualTotal = (target: DayRecord, prior: readonly DayRecord[], pick: (bucket: HourlyBucket) => number | null): Pillar | null => {
  const value = dayTotal(target, pick);
  const usual = history(prior, day => dayTotal(day, pick));
  return value !== null && usual.length >= BASELINE_DAYS ? { score: nearUsual(zScore(value, usual.map(entry => entry.value))), days: usual.map(entry => entry.day) } : null;
};
const overlaps = (startMs: number, span: Span): boolean => {
  const from = Date.parse(span.startAt);
  const to = Date.parse(span.endAt);
  return !Number.isNaN(from) && !Number.isNaN(to) && startMs < to && startMs + HOUR_MS > from;
};
// Awake hours outside every workout, with known movement under the exertion line (ADR-0010 2026-10-10 rule 2): an hour
// that cannot be attributed is not read as stress.
const stressReading = (day: DayRecord): Readonly<{ heartRate: number; hrv: number | null }> | null => {
  const hours = day.hourly.filter(bucket => {
    const start = Date.parse(bucket.startAt);
    return bucket.heartRate !== null && bucket.movementMinutes !== null && bucket.movementMinutes < FORM_V2_EXERTION_MOVEMENT_MINUTES
      && !(day.sleep && overlaps(start, day.sleep)) && !day.workouts.some(workout => overlaps(start, workout));
  });
  if (hours.length < MIN_STRESS_HOURS) return null;
  const hrvs = hours.flatMap(bucket => (bucket.hrv === null || bucket.hrvMethod !== 'rmssd' ? [] : [bucket.hrv]));
  return { heartRate: mean(hours.map(bucket => bucket.heartRate!)), hrv: hrvs.length >= MIN_STRESS_HRV_HOURS ? mean(hrvs) : null };
};

const sleepPillar = ({ target, prior }: FormSource, sleepNeedMinutes: number | null): Attempt => {
  if (!target.sleep) return { reason: 'missing_sleep' };
  const need = sleepNeedMinutes ?? usualSleepMinutes(prior);
  if (need === null || need <= 0) return { reason: 'baseline_immature' };
  return { score: integer(target.sleep.asleepMinutes / need * 100), days: [target.day] };
};
const hrvPillar = ({ target, prior }: FormSource): Attempt => {
  const night = target.overnightHrv;
  if (!night) return { reason: 'missing_resting_signal' };
  // RMSSD and SDNN are different measures: a reading is only compared with its own method.
  const usual = history(prior, day => (day.overnightHrv?.method === night.method ? day.overnightHrv.value : null));
  if (usual.length < BASELINE_DAYS) return { reason: 'baseline_immature' };
  return { score: integer(higherIsBetter(logZScore(night.value, usual.map(entry => entry.value)))), days: [target.day, ...usual.map(entry => entry.day)], hrvMethod: night.method };
};
const circadianPillar = ({ target, prior }: FormSource): Pillar | null => {
  const parts: number[] = [];
  const days: string[] = [];
  const midpoints = history(prior, day => day.sleep?.midpointMinute ?? null);
  const z = target.sleep && midpoints.length >= BASELINE_DAYS ? circularZScore(target.sleep.midpointMinute, midpoints.map(entry => entry.value)) : null;
  if (z !== null) { parts.push(nearUsual(z)); days.push(...midpoints.map(entry => entry.day)); }
  const daylight = nearUsualTotal(target, prior, bucket => bucket.daylightMinutes);
  if (daylight) { parts.push(daylight.score); days.push(...daylight.days); }
  return parts.length ? { score: integer(mean(parts)), days } : null;
};
const motionPillar = ({ target, prior }: FormSource): Pillar | null => {
  const motion = nearUsualTotal(target, prior, bucket => bucket.movementMinutes);
  return motion && { score: integer(motion.score), days: motion.days };
};
const stressPillar = ({ target, prior }: FormSource): Pillar | null => {
  const today = stressReading(target);
  const usual = history(prior, stressReading);
  if (!today || usual.length < BASELINE_DAYS) return null;
  const parts = [lowerIsBetter(zScore(today.heartRate, usual.map(entry => entry.value.heartRate)))];
  const hrvUsual = usual.flatMap(entry => (entry.value.hrv === null ? [] : [entry.value.hrv]));
  if (today.hrv !== null && hrvUsual.length >= BASELINE_DAYS) parts.push(higherIsBetter(logZScore(today.hrv, hrvUsual)));
  return { score: integer(mean(parts)), days: usual.map(entry => entry.day) };
};

export const isFormSource = (source: string): boolean => FORM_V2_SOURCE_CONFIDENCE[source] !== undefined;
// Higher confidence first; equal confidence falls back to the table's order.
export const byFormTrust = (a: string, b: string): number =>
  FORM_V2_SOURCE_CONFIDENCE[b]! - FORM_V2_SOURCE_CONFIDENCE[a]! || SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b);

const nightAge = (source: FormSource, asOf: string | null): number => {
  if (asOf === null || !source.target.sleep) return 0;
  const age = Date.parse(asOf) - Date.parse(source.target.sleep.endAt);
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY;
};

// Per pillar, the most trusted source that yields it wins. A source whose night ended more than 72 hours ago is stale
// for every pillar, so a fresh night from a less trusted source can carry Form.
export const formScore = (inputs: readonly FormSource[], sleepNeedMinutes: number | null, asOf: string | null): FormResult => {
  const known = inputs.filter(input => isFormSource(input.source)).sort((a, b) => byFormTrust(a.source, b.source));
  if (!known.length) return { state: 'unavailable', reason: 'no_readings' };
  if (!known.some(source => source.target.sleep)) return { state: 'unavailable', reason: 'missing_sleep' };
  const sources = known.filter(source => nightAge(source, asOf) <= STALE_HOURS * HOUR_MS);
  if (!sources.some(source => source.target.sleep)) return { state: 'unavailable', reason: 'stale_inputs' };

  const required = (attempt: (source: FormSource) => Attempt): Chosen | Readonly<{ reason: UnavailableReason | null }> => {
    let firstReason: UnavailableReason | null = null;
    for (const source of sources) {
      const result = attempt(source);
      if ('reason' in result) firstReason ??= result.reason;
      else return { source, pillar: result };
    }
    return { reason: firstReason };
  };
  const optional = (attempt: (source: FormSource) => Pillar | null): Chosen | null => {
    for (const source of sources) { const pillar = attempt(source); if (pillar) return { source, pillar }; }
    return null;
  };

  const sleep = required(source => sleepPillar(source, sleepNeedMinutes));
  if ('reason' in sleep) return { state: 'unavailable', reason: sleep.reason ?? 'missing_sleep' };
  const hrv = required(hrvPillar);
  if ('reason' in hrv) return { state: 'unavailable', reason: hrv.reason ?? 'missing_resting_signal' };
  const chosen: Record<FormV2Pillar, Chosen | null> = {
    sleep, hrv, circadian: optional(circadianPillar), motion: optional(motionPillar), stress: optional(stressPillar),
  };
  const scores = Object.fromEntries(PILLARS.map(name => [name, chosen[name]?.pillar.score ?? null])) as Record<FormV2Pillar, number | null>;
  const composite = formComposite(scores);
  if (!composite) return { state: 'unavailable', reason: 'baseline_immature' };

  const present = PILLARS.filter(name => chosen[name] !== null);
  const pillarConfidence = (name: FormV2Pillar) => {
    const entry = chosen[name]!;
    return FORM_V2_SOURCE_CONFIDENCE[entry.source.source]! * (entry.pillar.hrvMethod === 'sdnn' ? FORM_V2_SDNN_CONFIDENCE_FACTOR : 1);
  };
  const shares = present.reduce((sum, name) => sum + FORM_V2_SHARES_PER_10K[name], 0);
  const sourceConfidence = present.reduce((sum, name) => sum + FORM_V2_SHARES_PER_10K[name] * pillarConfidence(name), 0) / shares;
  const freshness = Math.max(nightAge(sleep.source, asOf), nightAge(hrv.source, asOf)) > FRESH_HOURS * HOUR_MS ? 0.75 : 1;
  const days = new Set(present.flatMap(name => chosen[name]!.pillar.days));
  return {
    state: 'available', score: composite.score, zone: formZone(composite.score), algorithm_version: ALGORITHM.form, activation: 'candidate_unaccepted',
    coverage: composite.coverage, confidence: Math.round(composite.coverage * sourceConfidence * freshness * 1000) / 1000,
    hrv_method: hrv.pillar.hrvMethod ?? null, sources: [...new Set(present.map(name => chosen[name]!.source.source))].sort(),
    used: { signals: present, days: [...days].sort() },
  };
};
