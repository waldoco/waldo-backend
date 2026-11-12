import { formReading, formScore } from './form';
import { byLocalDay } from './index';
import { ALGORITHM, PROVISIONAL_ALGORITHM } from './recovery';
import { priorDays } from './sleep-debt';
import { localDayWindow } from './time';
import type { DailyScoresInput, FormResult } from './types';

// Today's measured Form curve. It is the method the row's Form used, run again on the hours that had ended at each quarter of an
// hour from the wake, so it adds no method of its own: its version is the row's Form version.
export type FormCurvePoint = Readonly<{ at: string; score: number; kind: 'measured' }>;
export type FormCurve = Readonly<{ version: string; points: readonly FormCurvePoint[] }>;

const QUARTER_MS = 900_000;

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
  for (let at = Math.ceil(wake / QUARTER_MS) * QUARTER_MS; at <= last.settled; at += QUARTER_MS) {
    const result = through(at);
    if (result.state === 'available') points.push({ at: new Date(at).toISOString(), score: result.score, kind: 'measured' });
  }
  const latest = points.at(-1);
  if (!latest || latest.at !== new Date(last.settled).toISOString() || latest.score !== rowForm.score) return null;
  return { version: rowForm.algorithm_version, points: points.slice(-96) };
};
