import { evaluateForm, formHours, formReading, type FormEvaluation } from './form';
import { ALGORITHM, PROVISIONAL_ALGORITHM } from './recovery';
import { priorDays } from './sleep-debt';
import { isTimeZone, localDayWindow } from './time';
import type { DailyScoresInput, DayRecord, FormResult } from './types';

// Today's measured Form curve and the stress trend word. The curve is the method the row's Form used, run again on the hours that
// had ended at each quarter of an hour from the wake, so it adds no method of its own: its version is the row's Form version.
export type StressTrend = 'rising' | 'steady' | 'easing';
export type FormCurvePoint = Readonly<{ at: string; score: number; kind: 'measured' }>;
export type FormCurveRow = Readonly<{ form_curve: Readonly<{ version: string; points: readonly FormCurvePoint[] }>; stress_trend: StressTrend }>;

const HOUR_MS = 3_600_000;
const QUARTER_MS = 900_000;

// Hours outside the day's own local window are not the day's, as the engine reads it.
const withinLocalDay = (record: DayRecord): DayRecord => {
  const { start, end } = localDayWindow(record.day, record.timezone);
  return { ...record, hourly: record.hourly.filter(bucket => { const at = Date.parse(bucket.startAt); return at >= start && at < end; }) };
};

// The curve of the day `input` asks for, to go on the row whose Form is `rowForm`. None when that Form is unavailable or names a
// method this engine would not have run, when there is no wake to start from, or when the curve's last point is not the row's own
// Form: the latest point of the curve and the score of the row are the same number or there is no curve.
export const formCurveRow = (input: DailyScoresInput, rowForm: FormResult): FormCurveRow | null => {
  if (input.access !== 'granted' || rowForm.state !== 'available') return null;
  const provisional = rowForm.algorithm_version === PROVISIONAL_ALGORITHM.form;
  if (!provisional && rowForm.algorithm_version !== ALGORITHM.form) return null;
  if (input.days.some(record => !isTimeZone(record.timezone))) return null;
  const byDay = new Map(input.days.map(raw => [raw.day, withinLocalDay(raw)] as const));
  const target = byDay.get(input.targetDay);
  if (!target?.sleep) return null;
  const prior = priorDays(input.targetDay, byDay);

  // Form as it would have read at `cutoff`: only the hours that had begun by then, judged as of then, so the hour still
  // filling is left out on both sides, exactly as it is for the row. Cut-offs that read the same hours share one evaluation.
  const evaluated = new Map<string, FormEvaluation>();
  const through = (cutoff: number): FormEvaluation => {
    const hours = { ...target, hourly: target.hourly.filter(bucket => Date.parse(bucket.startAt) < cutoff) };
    const asOf = new Date(cutoff).toISOString();
    const reading = formReading(hours, asOf);
    const key = reading ? `${reading.settled}:${reading.stale}` : 'none';
    const known = evaluated.get(key);
    if (known) return known;
    const fresh = evaluateForm(hours, prior, input.sleepNeedMinutes, asOf, provisional);
    evaluated.set(key, fresh);
    return fresh;
  };
  const last = formReading(target, input.asOf);
  if (last === null || last.stale) return null;

  const wake = Math.max(Date.parse(target.sleep.endAt), localDayWindow(target.day, target.timezone).start);
  const points: FormCurvePoint[] = [];
  for (let at = Math.ceil(wake / QUARTER_MS) * QUARTER_MS; at <= last.settled; at += QUARTER_MS) {
    const { result } = through(at);
    if (result.state === 'available') points.push({ at: new Date(at).toISOString(), score: result.score, kind: 'measured' });
  }
  const latest = points.at(-1);
  if (!latest || latest.at !== new Date(last.settled).toISOString() || latest.score !== rowForm.score) return null;

  return { form_curve: { version: rowForm.algorithm_version, points }, stress_trend: stressTrend(through, formHours(target), last.settled) };
};

// The stress part of Form at the last three hour ends. Form scores the stress part so that higher is calmer, so a lower one is
// worse. Worse at both steps is rising, better at both is easing, and anything else, a missing reading included, is steady.
const stressTrend = (through: (cutoff: number) => FormEvaluation, target: DayRecord, last: number): StressTrend => {
  const ends = [...new Set(target.hourly.map(bucket => Date.parse(bucket.startAt) + HOUR_MS))].filter(end => end <= last).sort((a, b) => a - b).slice(-3);
  if (ends.length < 3) return 'steady';
  const [first, second, third] = ends.map(end => through(end).stress);
  if (first == null || second == null || third == null) return 'steady';
  return second < first && third < second ? 'rising' : second > first && third > second ? 'easing' : 'steady';
};
