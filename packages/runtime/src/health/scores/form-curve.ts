import { formReading, formScore } from './form';
import { byLocalDay } from './index';
import { ALGORITHM, PROVISIONAL_ALGORITHM } from './recovery';
import { priorDays } from './sleep-debt';
import { circularDelta, clampScore, mean } from './stats';
import { localDayWindow, wallMinute } from './time';
import type { DailyScoresInput, DayRecord, FormResult } from './types';

// Today's measured Form curve. It is the method the row's Form used, run again on the hours that had ended at each quarter of an
// hour from the wake, so it adds no method of its own: its version is the row's Form version.
export type FormCurvePoint = Readonly<{ at: string; score: number; kind: 'measured' | 'projected' }>;
export type FormCurve = Readonly<{ version: string; points: readonly FormCurvePoint[] }>;

const QUARTER_MS = 900_000;
// A day's first quarter of an hour at or after its wake: the slot its curve counts from.
const firstSlot = (wake: number): number => Math.ceil(wake / QUARTER_MS) * QUARTER_MS;

// The curve of the day `input` asks for, to go on the row whose Form is `rowForm`. None when that Form is unavailable or names a
// method this engine would not have run, when there is no wake to start from, or when the curve's last point is not the row's own
// Form: the latest point of the curve and the score of the row are the same number or there is no curve.
export const formCurve = (input: DailyScoresInput, rowForm: FormResult): FormCurve | null => {
  if (input.access !== 'granted' || rowForm.state !== 'available') return null;
  const provisional = rowForm.algorithm_version === PROVISIONAL_ALGORITHM.form;
  if (!provisional && rowForm.algorithm_version !== ALGORITHM.form) return null;
  const byDay = byLocalDay(input.days);
  const target = byDay?.get(input.targetDay);
  if (!byDay || !target?.sleep) return null;
  const prior = priorDays(input.targetDay, byDay);

  // Form as it would have read at `cutoff`: only the hours that had begun by then, judged as of then, so the hour still filling is
  // left out on both sides, exactly as it is for the row. Cut-offs that read the same hours share one evaluation.
  const evaluated = new Map<string, FormResult>();
  const through = (cutoff: number): FormResult => {
    const hours = { ...target, hourly: target.hourly.filter(bucket => Date.parse(bucket.startAt) < cutoff) };
    const asOf = new Date(cutoff).toISOString();
    const reading = formReading(hours, asOf);
    const key = reading ? `${reading.settled}:${reading.stale}` : 'none';
    const known = evaluated.get(key);
    if (known) return known;
    const fresh = formScore(hours, prior, input.sleepNeedMinutes, asOf, provisional);
    evaluated.set(key, fresh);
    return fresh;
  };
  const last = formReading(target, input.asOf);
  if (last === null || last.stale) return null;

  const wake = Math.max(Date.parse(target.sleep.endAt), localDayWindow(target.day, target.timezone).start);
  const points: FormCurvePoint[] = [];
  for (let at = firstSlot(wake); at <= last.settled; at += QUARTER_MS) {
    const result = through(at);
    if (result.state === 'available') points.push({ at: new Date(at).toISOString(), score: result.score, kind: 'measured' });
  }
  const latest = points.at(-1);
  if (!latest || latest.at !== new Date(last.settled).toISOString() || latest.score !== rowForm.score) return null;
  return { version: rowForm.algorithm_version, points: points.slice(-96) };
};

// The projected part of today's curve: the owner's own day shape, and no model of one. A slot is a quarter of an hour counted
// from a day's wake, so a later wake shifts the shape with it. Each slot after today's latest measured point adds, to that
// point's value, the mean change between the same two slots on the owner's earlier days, read from the measured curves those
// days stored and never computed again.
export const FORM_PROJECTION_VERSION = 'form-curve.v1';
// Earlier days whose wake is further than this from today's describe another kind of day.
const WAKE_TOLERANCE_MINUTES = 120;
// Fewer days than this holding both slots say nothing about the owner, so the projection stops there.
const MIN_PROJECTION_DAYS = 7;
const MAX_POINTS = 96;

export type StoredFormCurve = Readonly<{ day: string; points: readonly Readonly<{ at: string; score: number; kind: string }>[] }>;
export type FormProjectionInput = Readonly<{
  targetDay: string;
  // The target day and the days before it, as the scores read them.
  days: readonly DayRecord[];
  // Today's measured points, oldest first.
  measured: readonly FormCurvePoint[];
  // The curves the earlier days hold.
  stored: readonly StoredFormCurve[];
}>;

// The projected points that follow `measured`, oldest first; none when today has no wake or measured point, when fewer than
// seven earlier days with a wake near today's hold both slots, or when the owner's usual sleep start has already come.
export const formProjection = (input: FormProjectionInput): readonly FormCurvePoint[] => {
  const today = input.days.find(record => record.day === input.targetDay);
  const latest = input.measured.at(-1);
  if (!today?.sleep || !latest) return [];
  const wake = Date.parse(today.sleep.endAt);
  const wakeMinute = wallMinute(wake, today.timezone);
  const earlier = input.days.filter(record => record.day < input.targetDay && record.sleep !== null);
  // The owner's usual sleep start, as time awake after a wake at today's clock time: the median over the earlier nights.
  const awake = earlier.map(record => (wallMinute(Date.parse(record.sleep!.startAt), record.timezone) - wakeMinute + 1440) % 1440).sort((a, b) => a - b);
  if (awake.length === 0) return [];
  const mid = Math.floor(awake.length / 2);
  const usualSleepStart = wake + (awake.length % 2 === 1 ? awake[mid]! : (awake[mid - 1]! + awake[mid]!) / 2) * 60_000;

  // Each eligible earlier day's measured scores by slot.
  const shapes = earlier.flatMap((record): ReadonlyMap<number, number>[] => {
    const start = Date.parse(record.sleep!.endAt);
    if (Math.abs(circularDelta(wallMinute(start, record.timezone), wakeMinute)) > WAKE_TOLERANCE_MINUTES) return [];
    const held = input.stored.find(curve => curve.day === record.day);
    if (!held) return [];
    const origin = firstSlot(start);
    return [new Map(held.points.filter(point => point.kind === 'measured').map(point => [Math.round((Date.parse(point.at) - origin) / QUARTER_MS), point.score] as const))];
  });
  const origin = firstSlot(wake);
  const from = Math.round((Date.parse(latest.at) - origin) / QUARTER_MS);
  const points: FormCurvePoint[] = [];
  for (let slot = from + 1; points.length < MAX_POINTS - 1; slot += 1) {
    const at = origin + slot * QUARTER_MS;
    if (at > usualSleepStart) break;
    const changes = shapes.flatMap(shape => { const a = shape.get(from), b = shape.get(slot); return a === undefined || b === undefined ? [] : [b - a]; });
    if (changes.length < MIN_PROJECTION_DAYS) break;
    points.push({ at: new Date(at).toISOString(), score: Math.round(clampScore(latest.score + mean(changes))), kind: 'projected' });
  }
  return points;
};

// Today's curve as the row holds it: the measured points alone in their own method's version, or, with projected points after
// them, in the projection's version. At most ninety-six points, the oldest measured ones giving way first.
export const withProjection = (curve: FormCurve, projected: readonly FormCurvePoint[]): FormCurve =>
  (projected.length === 0 ? curve : { version: FORM_PROJECTION_VERSION, points: [...curve.points, ...projected].slice(-MAX_POINTS) });
