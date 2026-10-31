import { fromRowZone, toRowZone } from '../../../contracts/src/health/zone-bridge';
import { ENERGY_WINDOWS_VERSION } from './scores/energy-windows';
import { shiftDay } from './scores/time';
import { trainingLoad, type TrainingLoad, type WorkoutLoad } from './scores/training-load';
import { formZone, heldZone, recoveryZone, weightZone } from './scores/zones';
import type { DailyScores, DailyScoresInput, DayRecord, DayVitals, HourlyBucket, HrvMethod, MethodReading, RestingMethod, Span, TemperatureMethod } from './scores/types';

// The producer turns an owner's stored readings into the derived row the app and the prompt read. It reads a 31-day
// series, computes today and yesterday by the owner's own clock with an injected pure function, and writes each row
// through waldo.health_context_write, the only writer of that read model. It never throws: it runs after the response.
export type ProducerOutcome = 'written' | 'stale' | 'refused' | 'no_consent' | 'no_readings' | 'failed';
export type ProducerDeps = Readonly<{
  readSeries: (range: { from: string; to: string; signals: readonly string[] }) => Promise<unknown>;
  writeContext: (payload: string) => Promise<unknown>;
  compute: (input: DailyScoresInput) => DailyScores;
  // Busy minutes per local day across the owner's calendars, for Weight. Absent, failing or late, Weight is unavailable.
  readDemand?: (range: { from: string; to: string; timezone: string }) => Promise<unknown>;
  demandGraceMs?: number;
  // Told the owner's local today when its row moved to another zone word, against the same sources. It carries the day
  // only: no pillar, zone or score. A failure here never fails the write.
  onZoneChange?: (day: string) => Promise<void>;
  // The stored row for one day (waldo.health_scores_read). Each zone holds through a steady move from it; without it every
  // zone is the score's own band.
  readScores?: (day: string) => Promise<unknown>;
  // Which days in the last `days` local days hold a row (waldo.health_scores_history). The backfill asks it once a run.
  readHistory?: (days: number) => Promise<unknown>;
  // How many past days one run may backfill; the rest wait for the next run.
  backfillLimit?: number;
  // Off unless true. On, today's and yesterday's rows carry the candidate training load, which the row writer must admit.
  trainingLoad?: boolean;
}>;

// Days older than yesterday that hold no row yet are recomputed, oldest first, this many at a time.
export const BACKFILL_DAYS_PER_RUN = 30;

const WINDOW_DAYS = 30;
const HOUR_MS = 3_600_000;
const MAX_BUSY_MINUTES = 1500;
const DEMAND_GRACE_MS = 5_000;
const SIGNALS = ['sleep_duration', 'sleep_midpoint', 'overnight_hrv', 'resting_heart_rate', 'heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration', 'active_energy_window', 'workout'];
// The night's vital signals feed only the drivers. They are read on their own, beside the scores' read: a point signal
// such as breathing rate can be dense, and a read that reached its row cap would shorten the scores' baseline.
const VITAL_SIGNALS = ['respiratory_rate', 'spo2', 'wrist_temperature', 'walking_heart_rate_average'];
const NIGHT_SIGNALS = ['respiratory_rate', 'spo2', 'wrist_temperature'];
const RESTING_METHODS: readonly string[] = ['overnight_resting', 'provider_resting_daily', 'resting_measurement', 'unknown'];
const STAGES = ['light', 'deep', 'rem', 'unspecified', 'awake'] as const;
// ADR-0081's confidence order for whole sources (Apple > Oura > WHOOP), then the phone transports. Ranked, not counted:
// a phone's hourly windows outnumber a ring's nightly records, and a choice that flips by count would re-base the owner
// on another wearable from one day to the next.
const SOURCE_RANK = ['apple', 'oura', 'whoop', 'health_connect', 'samsung'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export type SleepStages = Readonly<Record<(typeof STAGES)[number], number>>;
// samsungWriter is whether Samsung Health wrote the reading, as the read says it; false when another app did or none was recorded.
// A workout's activity, and its zones and effort as the read returns them; detail is the rest of what it stored, unchecked,
// for a reader that checks it. Null for any other signal.
export type Reading = Readonly<{ signal: string; day: string; startAt: string | null; endAt: string | null; timezone: string | null; value: number; method: string | null; stages: SleepStages | null; samsungWriter: boolean; workout?: WorkoutDetail | null }>;
export type WorkoutDetail = Pick<WorkoutLoad, 'zoneSeconds' | 'effort'> & Readonly<{ activity: string | null; detail: Readonly<Record<string, unknown>> }>;
type Source = Readonly<{ source: string; epoch: number; truncated: boolean; readings: readonly Reading[] }>;
export type Series = Readonly<{ readAt: string; sources: readonly Source[] }>;

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const instant = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

// A night's stage totals, or none: a total that is not a finite, non-negative number makes the whole set unreadable.
const stagesOf = (raw: unknown): SleepStages | null => {
  const r = asRecord(raw);
  return r && STAGES.every(stage => typeof r[stage] === 'number' && Number.isFinite(r[stage]) && r[stage] >= 0) ? Object.fromEntries(STAGES.map(stage => [stage, r[stage]])) as SleepStages : null;
};
// A workout's zones and effort, each dropped on its own when it is not the shape the contract admits.
const workoutDetailOf = (activity: unknown, raw: unknown): WorkoutDetail => {
  const r = asRecord(raw);
  const seconds = asRecord(r?.hr_zones)?.seconds;
  const effort = asRecord(r?.effort);
  return {
    zoneSeconds: Array.isArray(seconds) && seconds.length === 5 && seconds.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) ? seconds as number[] : null,
    effort: effort && typeof effort.score === 'number' && effort.score >= 1 && effort.score <= 10 && (effort.method === 'rated' || effort.method === 'estimated')
      ? { score: effort.score, method: effort.method } : null,
    activity: typeof activity === 'string' ? activity : null,
    detail: r ?? {},
  };
};
// A reading the database returned that does not have the shape the math needs is dropped, never repaired.
const reading = (raw: unknown): Reading | null => {
  const r = asRecord(raw);
  if (!r || typeof r.signal !== 'string' || typeof r.day !== 'string' || !DAY.test(r.day) || typeof r.value !== 'number' || !Number.isFinite(r.value)) return null;
  return {
    signal: r.signal, day: r.day, value: r.value, startAt: instant(r.start_at), endAt: instant(r.end_at),
    timezone: typeof r.timezone === 'string' ? r.timezone : null, method: typeof r.method === 'string' ? r.method : null,
    stages: r.signal === 'sleep_duration' ? stagesOf(r.stages) : null,
    samsungWriter: r.samsung_writer === true,
    workout: r.signal === 'workout' ? workoutDetailOf(r.activity, r.workout) : null,
  };
};

export type Parsed = { kind: 'series'; series: Series } | { kind: 'no_consent' } | { kind: 'failed' };
export const parseSeries = (raw: unknown): Parsed => {
  const body = asRecord(raw);
  if (!body) return { kind: 'failed' };
  if (body.error === 'not_linked') return { kind: 'no_consent' };
  if (typeof body.access !== 'string' || typeof body.read_at !== 'string' || !INSTANT.test(body.read_at) || !Array.isArray(body.sources)) return { kind: 'failed' };
  if (body.access !== 'granted') return { kind: 'no_consent' };
  const sources: Source[] = [];
  for (const entry of body.sources) {
    const s = asRecord(entry);
    if (!s || typeof s.source !== 'string' || !Number.isSafeInteger(s.consent_epoch) || !Array.isArray(s.samples)) return { kind: 'failed' };
    sources.push({ source: s.source, epoch: s.consent_epoch as number, truncated: s.truncated === true, readings: s.samples.map(reading).filter((r): r is Reading => r !== null) });
  }
  return { kind: 'series', series: { readAt: body.read_at, sources } };
};

// A read that reached its row cap returned the newest rows, so the oldest day it holds may be partial. That day is
// dropped, never computed from part of its readings.
export const untruncated = (series: Series, code: string): Series => {
  if (!series.sources.some(source => source.truncated)) return series;
  console.log(JSON.stringify({ hop: 'health_series', ok: true, code }));
  return {
    ...series,
    sources: series.sources.map(source => {
      if (!source.truncated || !source.readings.length) return source;
      const oldest = source.readings.reduce((min, r) => (r.day < min ? r.day : min), source.readings[0]!.day);
      return { ...source, readings: source.readings.filter(r => r.day !== oldest) };
    }),
  };
};
// A source takes the vital readings read under the same consent epoch as its scores' readings only, so a withdrawal and
// regrant between the two reads never mixes readings of two grants.
const withVitals = (series: Series, vitals: Series | null): Series => (!vitals ? series : {
  ...series,
  sources: series.sources.map(source => {
    const same = vitals.sources.find(other => other.source === source.source && other.epoch === source.epoch);
    return same ? { ...source, readings: [...source.readings, ...same.readings.filter(r => VITAL_SIGNALS.includes(r.signal))] } : source;
  }),
});

const newest = <T extends Reading>(readings: readonly T[]): T | undefined =>
  readings.reduce<T | undefined>((best, r) => (!best || (r.startAt ?? '') >= (best.startAt ?? '') ? r : best), undefined);
const hrvMethod = (method: string | null): HrvMethod | null => (method === 'rmssd' || method === 'sdnn' ? method : null);
// The contract leaves a resting reading's method optional; an unlabelled one is unknown, never another method.
const restingMethod = (method: string | null): RestingMethod | null => (method === null ? 'unknown' : RESTING_METHODS.includes(method) ? method as RestingMethod : null);
const temperatureMethod = (method: string | null): TemperatureMethod | null => (method === 'absolute' || method === 'baseline_delta' ? method : null);
// The newest reading of each method.
const perMethod = <Method extends string>(readings: readonly Reading[], methodOf: (method: string | null) => Method | null): MethodReading<Method>[] => {
  const byMethod = new Map<Method, Reading[]>();
  for (const r of readings) { const method = methodOf(r.method); if (method !== null) byMethod.set(method, [...(byMethod.get(method) ?? []), r]); }
  return [...byMethod].map(([method, rs]) => ({ value: newest(rs)!.value, method }));
};
const span = (r: Reading): Span | null => (r.startAt && r.endAt ? { startAt: r.startAt, endAt: r.endAt } : null);

// The phone sends time in bed and time asleep under one signal; only time asleep is sleep. An unlabelled duration is
// time asleep by the contract; a duration labelled time in bed or unknown is not taken for it.
const asleepOf = (readings: readonly Reading[]): Reading | undefined => newest(readings.filter(r => r.signal === 'sleep_duration' && (r.method === null || r.method === 'asleep_duration')));
const sleepOf = (readings: readonly Reading[]): DayRecord['sleep'] => {
  const asleep = asleepOf(readings);
  const midpoint = newest(readings.filter(r => r.signal === 'sleep_midpoint'));
  const when = asleep && span(asleep);
  return asleep && midpoint && when ? { ...when, asleepMinutes: asleep.value, midpointMinute: midpoint.value } : null;
};

const SCORED_WINDOW_SIGNALS = ['heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration', 'active_energy_window'];

const hourlyOf = (readings: readonly Reading[]): HourlyBucket[] => {
  const buckets = new Map<string, { -readonly [K in keyof HourlyBucket]: HourlyBucket[K] }>();
  for (const r of readings) {
    if (!r.startAt || !SCORED_WINDOW_SIGNALS.includes(r.signal)) continue;
    const bucket = buckets.get(r.startAt) ?? { startAt: r.startAt, heartRate: null, hrvReadings: [], daylightMinutes: null, movementMinutes: null, activeEnergyKcal: null };
    if (r.signal === 'heart_rate_window') bucket.heartRate = r.value;
    else if (r.signal === 'hrv_window' && hrvMethod(r.method)) {
      const method = hrvMethod(r.method)!;
      bucket.hrvReadings = [...bucket.hrvReadings.filter(reading => reading.method !== method), { value: r.value, method }];
    }
    else if (r.signal === 'daylight_duration') bucket.daylightMinutes = r.value;
    else if (r.signal === 'movement_duration') bucket.movementMinutes = r.value;
    else if (r.signal === 'active_energy_window') bucket.activeEnergyKcal = r.value;
    buckets.set(r.startAt, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
};

// A phone that changes zone can send hours again on a new hour grid, or under the neighbouring day. Those windows overlap
// ones already stored, and summing both would count the same minutes twice. Every day holding either window of an
// overlapping pair is returned, across the whole series. A window repeated on the same day is one bucket, not an overlap.
const overlappingWindowDays = (readings: readonly Reading[]): ReadonlySet<string> => {
  const days = new Set<string>();
  for (const signal of SCORED_WINDOW_SIGNALS) {
    const windows = readings.flatMap(r => (r.signal === signal && r.startAt && r.endAt && r.startAt < r.endAt ? [{ day: r.day, start: r.startAt, end: r.endAt }] : []))
      .sort((a, b) => a.start.localeCompare(b.start));
    const open: typeof windows = [];
    for (const w of windows) {
      open.splice(0, open.length, ...open.filter(o => o.end > w.start));
      for (const o of open) if (o.start !== w.start || o.end !== w.end || o.day !== w.day) days.add(o.day).add(w.day);
      open.push(w);
    }
  }
  return days;
};

const midpointOf = (r: Reading): number | null => (r.startAt && r.endAt ? (Date.parse(r.startAt) + Date.parse(r.endAt)) / 2 : null);
const meanOf = (values: readonly number[]): number | null => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
// A night's vital readings are those whose middle falls inside its asleep span, whatever date they carry, so a reading
// before midnight counts toward the night it falls in, and a daytime reading toward none. A day without a night has none.
const vitalsOf = (rs: readonly Reading[], night: readonly Reading[], sleep: DayRecord['sleep']): DayVitals => {
  const inNight = sleep ? night.filter(r => { const at = midpointOf(r); return at !== null && at >= Date.parse(sleep.startAt) && at <= Date.parse(sleep.endAt); }) : [];
  const valuesOf = (signal: string) => inNight.filter(r => r.signal === signal).map(r => r.value);
  return {
    breathingRate: meanOf(valuesOf('respiratory_rate')), bloodOxygen: meanOf(valuesOf('spo2')),
    wristTemperature: perMethod(inNight.filter(r => r.signal === 'wrist_temperature'), temperatureMethod),
    awakeMinutes: asleepOf(rs)?.stages?.awake ?? null,
    walkingHeartRate: newest(rs.filter(r => r.signal === 'walking_heart_rate_average'))?.value ?? null,
  };
};

const MIN_ASLEEP_HOURS = 3;
const LOW_HOURS = 2;
// A night with no measured resting heart rate takes one from its own heart-rate hours: the mean of the two lowest hour means
// among the hours wholly inside the sleep's span (its time-asleep reading's start to end), from at least three such hours. A
// resting rate lies at the night's low, and it takes two hours, not one, because the read returns each hour's mean without
// its number of readings, so one sparsely read hour must not set it alone. An hour partly outside the span is left out. The
// span decides, not the date, so the hour before midnight, dated the day before, counts. A night touching a day with an
// overlapping window, or begun before the first hour the read holds, was not read whole and takes none.
const asleepLow = (sleep: DayRecord['sleep'], hours: readonly Reading[], overlapped: ReadonlySet<string>, firstHourMs: number): MethodReading<RestingMethod>[] => {
  if (!sleep || Date.parse(sleep.startAt) < firstHourMs) return [];
  const from = Date.parse(sleep.startAt), to = Date.parse(sleep.endAt);
  const asleep = hours.filter(r => Date.parse(r.startAt!) >= from && Date.parse(r.endAt!) <= to);
  if (asleep.length < MIN_ASLEEP_HOURS || asleep.some(r => overlapped.has(r.day))) return [];
  return [{ value: meanOf(asleep.map(r => r.value).sort((a, b) => a - b).slice(0, LOW_HOURS))!, method: 'asleep_hours_low' }];
};

// Each day keeps the zone its newest reading was read in; a day that holds readings from two zones is flagged. A day
// holding an overlapping window keeps no hourly windows, so its window-based parts read as unknown, never doubled.
const daysOf = (readings: readonly Reading[], fallbackZone: string): Readonly<{ days: DayRecord[]; zoneChanged: ReadonlySet<string>; overlapped: ReadonlySet<string> }> => {
  const byDay = new Map<string, Reading[]>();
  for (const r of readings) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const zoneChanged = new Set<string>();
  const overlapped = overlappingWindowDays(readings);
  const night = readings.filter(r => NIGHT_SIGNALS.includes(r.signal));
  // One reading per hour, the later of a repeat, as the hourly buckets take it.
  const heartHours = [...new Map(readings.filter(r => r.signal === 'heart_rate_window' && r.startAt && r.endAt).map(r => [r.startAt, r])).values()];
  const firstHourMs = Math.min(...heartHours.map(r => Date.parse(r.startAt!)));
  const days = [...byDay].map(([day, rs]): DayRecord => {
    const zones = new Set(rs.flatMap(r => (r.timezone ? [r.timezone] : [])));
    if (zones.size > 1) zoneChanged.add(day);
    const sleep = sleepOf(rs);
    const measured = perMethod(rs.filter(r => r.signal === 'resting_heart_rate'), restingMethod);
    return {
      day, timezone: newest(rs.filter(r => r.timezone))?.timezone ?? fallbackZone, sleep,
      overnightHrv: perMethod(rs.filter(r => r.signal === 'overnight_hrv'), hrvMethod),
      restingHeartRate: measured.length ? measured : asleepLow(sleep, heartHours, overlapped, firstHourMs), hourly: overlapped.has(day) ? [] : hourlyOf(rs),
      workouts: rs.filter(r => r.signal === 'workout').flatMap(r => span(r) ?? []), demand: null, vitals: vitalsOf(rs, night, sleep),
    };
  });
  return { days, zoneChanged, overlapped };
};

// Movement minutes, plus workout minutes in hours that carry no movement reading, so a workout the movement count
// already holds is not counted twice. Known only on a day with a movement reading or a workout: heart-rate or daylight
// hours alone say nothing about load.
const physicalLoadOf = (day: DayRecord): number | null => {
  const moving = day.hourly.filter(bucket => bucket.movementMinutes !== null);
  if (!moving.length && !day.workouts.length) return null;
  const workoutMs = day.workouts.reduce((sum, workout) => {
    const from = Date.parse(workout.startAt), to = Date.parse(workout.endAt);
    if (!(from < to)) return sum;
    const counted = moving.reduce((inside, bucket) => { const start = Date.parse(bucket.startAt); return inside + Math.max(0, Math.min(to, start + HOUR_MS) - Math.max(from, start)); }, 0);
    return sum + to - from - counted;
  }, 0);
  return moving.reduce((sum, bucket) => sum + bucket.movementMinutes!, 0) + Math.round(workoutMs / 60_000);
};

type Busy = Readonly<{ minutes: number; partial: boolean }>;
// A day the calendar could not be read is missing here, so it reads as no calendar demand rather than a free day. A
// count outside one local day's minutes is rejected, not clipped.
const busyByDay = (answer: unknown): ReadonlyMap<string, Busy> => {
  const a = asRecord(answer);
  if (a?.state !== 'available' || !Array.isArray(a.days)) return new Map();
  return new Map(a.days.flatMap((raw): [string, Busy][] => {
    const d = asRecord(raw);
    return d && typeof d.day === 'string' && DAY.test(d.day) && typeof d.busy_minutes === 'number' && Number.isFinite(d.busy_minutes)
      && d.busy_minutes >= 0 && d.busy_minutes <= MAX_BUSY_MINUTES ? [[d.day, { minutes: d.busy_minutes, partial: d.partial === true }]] : [];
  }));
};

type DemandRead = Readonly<{ kind: 'answer'; answer: unknown } | { kind: 'failed' } | { kind: 'late' }>;
const within = (read: Promise<unknown>, graceMs: number): Promise<DemandRead> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DemandRead>(resolve => { timer = setTimeout(() => resolve({ kind: 'late' }), graceMs); });
  return Promise.race([read.then((answer): DemandRead => ({ kind: 'answer', answer }), (): DemandRead => ({ kind: 'failed' })), late]).finally(() => clearTimeout(timer));
};

const localDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

// Sleep debt in the shape the app reads. A window with a missing night is partial and carries no figure.
const sleepDebtOf = (debt: DailyScores['sleep_debt'], basis: Readonly<{ accepted: boolean }>): object => {
  if (debt.state === 'unavailable') return { state: 'unavailable', reason: debt.reason };
  const version = { algorithm_version: debt.algorithm_version, activation: basis.accepted ? debt.activation : 'candidate_unaccepted' };
  const trend = debt.trend ? { trend: debt.trend } : {};
  return debt.state === 'available' && debt.debt_minutes !== null ? { state: 'available', debt_minutes: debt.debt_minutes, need_basis: debt.need_basis, ...version, ...trend } : { state: 'partial', confidence: debt.coverage, ...version, ...trend };
};

// The confidence of each source a row can be computed from, as ADR-0081 ranks them. Health Connect is a transport, not a
// source: its readings enter a canonical score only from Samsung Health, at the Samsung confidence.
const SOURCE_CONFIDENCE: Readonly<Record<string, number>> = { apple: 1, oura: 0.85, whoop: 0.8, health_connect: 0.6, samsung: 0.6 };
const LOWEST_SOURCE_CONFIDENCE = 0.6;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// Whether a row computed from this source may carry activation accepted. An unknown source never may. A Health Connect row
// may only when every reading it was computed from was written by Samsung Health, and none without a writer recorded
// counts; otherwise it is computed the same and written as a candidate.
const acceptable = (source: Source): boolean => {
  if (source.source === 'health_connect') {
    const scored = source.readings.filter(r => SIGNALS.includes(r.signal));
    return scored.length > 0 && scored.every(r => r.samsungWriter);
  }
  return Object.hasOwn(SOURCE_CONFIDENCE, source.source);
};

type AvailablePillar = Readonly<{ score: number; coverage: number; algorithm_version: string; activation: string; hrv_method: HrvMethod | null; baseline?: unknown; used: unknown }>;
type RowSource = Readonly<{ source: string; epoch: number; accepted: boolean }>;
// A pillar computed provisionally carries its baseline label, the signals and days it used, and, from an acceptable source,
// a confidence that is its coverage times the source's confidence. From any other it is a candidate, and it is never more
// confident than the lowest source would be: its coverage times the lowest factor. In such a pillar a coverage that is not a number is an
// error, never a null on the row. The earlier engine's pillar keeps its keys and its coverage as the confidence, a non-finite
// one written as the null it always was.
const confidenceOf = (pillar: AvailablePillar, basis: RowSource): number => {
  if (!pillar.baseline) return pillar.coverage;
  if (!Number.isFinite(pillar.coverage)) throw new Error('coverage is not a number');
  return round3(pillar.coverage * (basis.accepted ? SOURCE_CONFIDENCE[basis.source]! : LOWEST_SOURCE_CONFIDENCE));
};
const activationOf = (activation: string, basis: RowSource): string => (basis.accepted ? activation : 'candidate_unaccepted');
const pillarRow = (zone: string, result: AvailablePillar, basis: RowSource): object => ({
  score: result.score, zone, confidence: confidenceOf(result, basis), algorithm_version: result.algorithm_version,
  activation: activationOf(result.activation, basis), hrv_method: result.hrv_method, ...(result.baseline ? { baseline: result.baseline, used: result.used } : {}),
});

// Today's windows ride only an accepted row: they come from the same provisional engine, so a row from a source nothing has
// validated carries none, and a day other than today never does.
const windowsOf = (scores: DailyScores, basis: RowSource, forToday: boolean): object =>
  forToday && basis.accepted && scores.windows && scores.windows.length > 0 ? { windows: scores.windows, windows_version: ENERGY_WINDOWS_VERSION } : {};

// Signals only a body-worn sensor makes. A day the phone alone saw (movement, daylight) shows the phone was about, not that
// a session would have been recorded, so it is not an observed day.
const WORN_SIGNALS = new Set(['heart_rate_window', 'resting_heart_rate', 'overnight_hrv', 'hrv_window']);
// The source's own workouts and observed days for the 28 whole days ending yesterday, for today's row and yesterday's alike.
// Another source's workouts never mix in.
const trainingLoadOf = (source: Source, yesterday: string): TrainingLoad => trainingLoad({
  throughDay: yesterday,
  observedDays: [...new Set(source.readings.filter(r => WORN_SIGNALS.has(r.signal)).map(r => r.day))],
  workouts: source.readings.filter(r => r.signal === 'workout').map(r => ({ day: r.day, minutes: r.value, zoneSeconds: r.workout?.zoneSeconds ?? null, effort: r.workout?.effort ?? null })),
});

const rowOf = (day: string, scores: DailyScores, basis: RowSource, readAt: string, timezone: string, tags: readonly string[], forToday: boolean): object => {
  const { recovery, form, weight } = scores;
  const unavailable = (reason: string) => ({ reason });
  return {
    day, timezone, read_at: readAt, basis: [{ source: basis.source, consent_epoch: basis.epoch }],
    recovery: recovery.state === 'unavailable' ? unavailable(recovery.reason) : pillarRow(toRowZone('recovery', recovery.zone), recovery, basis),
    form: form.state === 'unavailable' ? unavailable(form.reason) : pillarRow(toRowZone('form', form.zone), form, basis),
    weight: weight.state === 'unavailable' ? unavailable(weight.reason) : pillarRow(toRowZone('weight', weight.zone), weight, basis),
    ...(recovery.state === 'available' ? { confidence: confidenceOf(recovery, basis) } : {}),
    sleep_debt: sleepDebtOf(scores.sleep_debt, basis), drivers: scores.drivers,
    freshness: 'fresh', tags, ...windowsOf(scores, basis, forToday),
  };
};

// The row this one replaces: the same day's, written by an earlier upload. A day's first row, a read that fails and an answer
// for another day are no row.
const storedBefore = async (read: ProducerDeps['readScores'], day: string): Promise<Record<string, unknown> | null> => {
  try {
    const same = asRecord(asRecord(await read?.(day))?.scores);
    return same?.day === day ? same : null;
  } catch { return null; }
};
// The days that already hold a row. The window is anchored on the database's today in the owner's latest zone, so ninety
// days covers the thirty-day series with room at a zone edge. Nothing stored (no_readings) is an empty set. Any other answer,
// a consent refusal included, or a read that fails, is unknown, and the run backfills nothing rather than write blind.
const HISTORY_WINDOW_DAYS = 90;
const heldDays = async (read: NonNullable<ProducerDeps['readHistory']>): Promise<ReadonlySet<string> | null> => {
  try {
    const answer = asRecord(await read(HISTORY_WINDOW_DAYS));
    if (answer?.unavailable === 'no_readings') return new Set();
    const days = asRecord(answer?.history)?.days;
    if (!Array.isArray(days)) return null;
    const held = days.map(day => asRecord(day)?.day);
    return held.every((day): day is string => typeof day === 'string' && DAY.test(day)) ? new Set(held) : null;
  } catch { return null; }
};
// Within one day, each pillar's zone holds through a steady move from the zone its stored row had, so the uploads of a day
// report a change only on a real crossing. A day's first row is its own band, so the word never drifts from a fresh night's
// score for longer than that day. A zone another algorithm version wrote is not the same state and holds nothing.
const steadied = (scores: DailyScores, before: Record<string, unknown> | null): DailyScores => {
  const zoneBefore = <P extends 'recovery' | 'form' | 'weight'>(pillar: P, version: string) => {
    const stored = asRecord(before?.[pillar]);
    return stored?.algorithm_version === version ? fromRowZone(pillar, stored.zone) : null;
  };
  const { recovery, form, weight } = scores;
  return {
    ...scores,
    recovery: recovery.state === 'available' ? { ...recovery, zone: heldZone(recoveryZone, recovery.score, zoneBefore('recovery', recovery.algorithm_version)) } : recovery,
    form: form.state === 'available' ? { ...form, zone: heldZone(formZone, form.score, zoneBefore('form', form.algorithm_version)) } : form,
    weight: weight.state === 'available' ? { ...weight, zone: heldZone(weightZone, weight.score, zoneBefore('weight', weight.algorithm_version)) } : weight,
  };
};

// The writer names the pillars whose zone word changed; only whether any did leaves this function.
const pillarMoved = (answer: unknown): boolean => { const changed = asRecord(answer)?.changed; return Array.isArray(changed) && changed.length > 0; };

// The only trace of a written row: that it was written, and whether a pillar of it was provisional. No owner, day or value.
const logWritten = (row: object): void => {
  const provisional = (['recovery', 'form', 'weight'] as const).some(pillar => asRecord(asRecord((row as Record<string, unknown>)[pillar])?.baseline)?.state === 'provisional');
  console.log(JSON.stringify({ hop: 'health_scores', code: 'written', provisional }));
};

const writeOutcome = (answer: unknown): 'written' | 'stale' | 'refused' | 'failed' => {
  const a = asRecord(answer);
  if (a?.written === true) return 'written';
  if (a?.written === false && a.stale === true) return 'stale';
  return a?.error === 'epoch_conflict' || a?.error === 'consent_required' ? 'refused' : 'failed';
};

export const produceHealthScores = async (deps: ProducerDeps, at: Readonly<{ now: number; timezone: string }>): Promise<ProducerOutcome> => {
  let pending: Promise<unknown> | undefined;
  try {
    const today = localDay(at.now, at.timezone), range = { from: shiftDay(today, -WINDOW_DAYS), to: today };
    // Started beside the series read and bounded, so a slow calendar costs Weight, never the Recovery and Form writes.
    pending = deps.readDemand?.({ ...range, timezone: at.timezone });
    const demand = pending ? within(pending, deps.demandGraceMs ?? DEMAND_GRACE_MS) : null;
    const scoresRead = deps.readSeries({ ...range, signals: SIGNALS });
    const vitalsRead = deps.readSeries({ ...range, signals: VITAL_SIGNALS }).then(parseSeries, (): Parsed => ({ kind: 'failed' }));
    const parsed = parseSeries(await scoresRead);
    if (parsed.kind !== 'series') return parsed.kind;
    // Without its vital readings a day still scores exactly as it would with them; only those drivers are missing.
    const vitals = await vitalsRead;
    if (vitals.kind !== 'series') console.log(JSON.stringify({ hop: 'health_series', ok: false, code: 'vitals_unread' }));
    const series = withVitals(untruncated(parsed.series, 'series_truncated'), vitals.kind === 'series' ? untruncated(vitals.series, 'vitals_truncated') : null);
    // One source's readings are computed on its own, per day. Two wearables' sleep for one night is never added up. The
    // day's source is the highest-ranked one holding that night's sleep, or the highest-ranked with any reading.
    const present = [...series.sources].filter(s => s.readings.length > 0);
    if (!present.length) return 'no_readings';
    const rank = (source: string) => { const at = SOURCE_RANK.indexOf(source); return at < 0 ? SOURCE_RANK.length : at; };
    const sleptOn = (s: Source, day: string) => s.readings.some(r => r.signal === 'sleep_duration' && r.day === day);
    const chooseFor = (day: string): Source => [...present].sort((a, b) => Number(sleptOn(b, day)) - Number(sleptOn(a, day)) || rank(a.source) - rank(b.source) || a.source.localeCompare(b.source))[0]!;
    const read = demand && await demand;
    if (read && read.kind !== 'answer') console.log(JSON.stringify({ hop: 'weight_demand', ok: false, code: read.kind === 'late' ? 'demand_late' : 'demand_failed' }));
    const busy = busyByDay(read?.kind === 'answer' ? read.answer : null);
    const recordsOf = (chosen: Source) => {
      const { days: readingDays, zoneChanged: travelled, overlapped } = daysOf(chosen.readings, at.timezone);
      const days = readingDays.map((day): DayRecord => ({ ...day, demand: { meetingMinutes: busy.get(day.day)?.minutes ?? null, messageCount: null, openTaskMinutes: null, physicalLoad: overlapped.has(day.day) ? null : physicalLoadOf(day) } }));
      // A day the calendar reports and the phone sent nothing for still counts toward Weight. It carries no health reading,
      // so Recovery, Form and sleep debt read it as missing, and its physical load is unknown.
      for (const [day, { minutes }] of busy) {
        if (!days.some(d => d.day === day)) days.push({ day, timezone: at.timezone, sleep: null, overnightHrv: [], restingHeartRate: [], hourly: [], workouts: [], demand: { meetingMinutes: minutes, messageCount: null, openTaskMinutes: null, physicalLoad: null } });
      }
      return { readingDays, travelled, days };
    };
    // Recovery and sleep debt for each past day with no row, labelled backfilled: no Form or Weight (they are not reconstructed
    // for past days), no windows, and no zone notice, since a late row is not a change the owner lived through. A day that
    // already holds a row of any kind is left alone, and the database refuses a backfilled row over a live one regardless.
    const recordsBySource = new Map<string, ReturnType<typeof recordsOf>>();
    const backfill = async (readHistory: NonNullable<ProducerDeps['readHistory']>): Promise<void> => {
      const newestBackfilled = shiftDay(today, -2);
      const candidates = [...new Set(present.flatMap(s => s.readings.filter(r => r.signal === 'sleep_duration' && r.day <= newestBackfilled).map(r => r.day)))].sort();
      if (!candidates.length) return;
      const held = await heldDays(readHistory);
      if (!held) return;
      const missing = candidates.filter(day => !held.has(day)).slice(0, deps.backfillLimit ?? BACKFILL_DAYS_PER_RUN);
      for (const day of missing) {
        const chosen = chooseFor(day);
        const records = recordsBySource.get(chosen.source) ?? recordsOf(chosen);
        recordsBySource.set(chosen.source, records);
        const scores = deps.compute({ access: 'granted', targetDay: day, days: records.days, sleepNeedMinutes: null, asOf: series.readAt });
        if (scores.recovery.state === 'unavailable' && scores.sleep_debt.state === 'unavailable') continue;
        const unavailable = (reason: 'intraday_inputs_unavailable' | 'calendar_demand_unavailable') => ({ state: 'unavailable' as const, reason });
        const late = { ...scores, form: unavailable('intraday_inputs_unavailable'), weight: unavailable('calendar_demand_unavailable') };
        const row = { ...rowOf(day, late, { source: chosen.source, epoch: chosen.epoch, accepted: acceptable(chosen) }, series.readAt, at.timezone, [], false), backfilled: true };
        const outcome = writeOutcome(await deps.writeContext(JSON.stringify(row)));
        if (outcome === 'written') logWritten(row);
        // A consent or epoch the database refuses is refused for every later day too.
        if (outcome === 'refused') break;
      }
    };
    const outcomes: ReturnType<typeof writeOutcome>[] = [];
    // Only the provisional engine names its windows, even when there are none; the earlier engine never backfills.
    let provisional = false;
    for (const targetDay of [shiftDay(today, -1), today]) {
      const chosen = chooseFor(targetDay);
      const { readingDays, travelled, days } = recordsOf(chosen);
      const scores = deps.compute({ access: 'granted', targetDay, days, sleepNeedMinutes: null, asOf: series.readAt });
      provisional ||= scores.windows !== undefined;
      const nothingToShow = [scores.recovery, scores.form, scores.weight].every(p => p.state === 'unavailable');
      if (nothingToShow && !readingDays.some(d => d.day === targetDay)) continue;
      // A day read without a calendar Google reported gone says so, since its Weight saw less than every calendar.
      const tags = [...(travelled.has(targetDay) ? ['zone_changed'] : []), ...(scores.weight.state === 'available' && busy.get(targetDay)?.partial ? ['calendar_partial'] : [])];
      const row = {
        ...rowOf(targetDay, steadied(scores, await storedBefore(deps.readScores, targetDay)), { source: chosen.source, epoch: chosen.epoch, accepted: acceptable(chosen) }, series.readAt, at.timezone, tags, targetDay === today),
        ...(deps.trainingLoad ? { training_load: trainingLoadOf(chosen, shiftDay(today, -1)) } : {}),
      };
      const answer = await deps.writeContext(JSON.stringify(row));
      outcomes.push(writeOutcome(answer));
      if (writeOutcome(answer) === 'written') logWritten(row);
      if (targetDay === today && writeOutcome(answer) === 'written' && pillarMoved(answer)) await deps.onZoneChange?.(today).catch(() => console.error('health zone change notice failed'));
    }
    if (provisional && deps.readHistory) {
      // Late days never decide the outcome of the live rows, and a failure here is only a tag.
      try { await backfill(deps.readHistory); } catch { console.error('health backfill failed'); }
    }
    for (const outcome of ['failed', 'refused', 'written', 'stale'] as const) if (outcomes.includes(outcome)) return outcome;
    return 'no_readings';
  } catch {
    console.error('health producer failed');
    return 'failed';
  } finally {
    // A late read still finishes, so the owner object caches it for the next upload.
    await pending?.catch(() => undefined);
  }
};
