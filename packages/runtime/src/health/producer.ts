import { toRowZone } from '../../../contracts/src/health/zone-bridge';
import { shiftDay } from './scores/time';
import type { DailyScores, DailyScoresInput, DayRecord, HourlyBucket, HrvMethod, Span } from './scores/types';

// The producer turns an owner's stored readings into the derived row the app and the prompt read. It reads one 31-day
// series, computes today and yesterday by the owner's own clock with an injected pure function, and writes each row
// through waldo.health_context_write, the only writer of that read model. It never throws: it runs after the response.
export type ProducerOutcome = 'written' | 'stale' | 'refused' | 'no_consent' | 'no_readings' | 'failed';
export type ProducerDeps = Readonly<{
  readSeries: (range: { from: string; to: string; signals: readonly string[] }) => Promise<unknown>;
  writeContext: (payload: string) => Promise<unknown>;
  compute: (input: DailyScoresInput) => DailyScores;
}>;

const WINDOW_DAYS = 30;
const SIGNALS = ['sleep_duration', 'sleep_midpoint', 'overnight_hrv', 'resting_heart_rate', 'heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration', 'workout'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

type Reading = Readonly<{ signal: string; day: string; startAt: string | null; endAt: string | null; timezone: string | null; value: number; method: string | null }>;
type Source = Readonly<{ source: string; epoch: number; readings: readonly Reading[] }>;
type Series = Readonly<{ readAt: string; sources: readonly Source[] }>;

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const instant = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);

// A reading the database returned that does not have the shape the math needs is dropped, never repaired.
const reading = (raw: unknown): Reading | null => {
  const r = asRecord(raw);
  if (!r || typeof r.signal !== 'string' || typeof r.day !== 'string' || !DAY.test(r.day) || typeof r.value !== 'number' || !Number.isFinite(r.value)) return null;
  return {
    signal: r.signal, day: r.day, value: r.value, startAt: instant(r.start_at), endAt: instant(r.end_at),
    timezone: typeof r.timezone === 'string' ? r.timezone : null, method: typeof r.method === 'string' ? r.method : null,
  };
};

type Parsed = { kind: 'series'; series: Series } | { kind: 'no_consent' } | { kind: 'failed' };
const parseSeries = (raw: unknown): Parsed => {
  const body = asRecord(raw);
  if (!body) return { kind: 'failed' };
  if (body.error === 'not_linked') return { kind: 'no_consent' };
  if (typeof body.access !== 'string' || typeof body.read_at !== 'string' || !INSTANT.test(body.read_at) || !Array.isArray(body.sources)) return { kind: 'failed' };
  if (body.access !== 'granted') return { kind: 'no_consent' };
  const sources: Source[] = [];
  for (const entry of body.sources) {
    const s = asRecord(entry);
    if (!s || typeof s.source !== 'string' || !Number.isSafeInteger(s.consent_epoch) || !Array.isArray(s.samples)) return { kind: 'failed' };
    sources.push({ source: s.source, epoch: s.consent_epoch as number, readings: s.samples.map(reading).filter((r): r is Reading => r !== null) });
  }
  return { kind: 'series', series: { readAt: body.read_at, sources } };
};

const newest = <T extends Reading>(readings: readonly T[]): T | undefined =>
  readings.reduce<T | undefined>((best, r) => (!best || (r.startAt ?? '') >= (best.startAt ?? '') ? r : best), undefined);
const hrvMethod = (method: string | null): HrvMethod | null => (method === 'rmssd' || method === 'sdnn' ? method : null);
const span = (r: Reading): Span | null => (r.startAt && r.endAt ? { startAt: r.startAt, endAt: r.endAt } : null);

// The phone sends time in bed and time asleep under one signal; only time asleep is sleep. An unlabelled duration is
// time asleep by the contract; a duration labelled time in bed or unknown is not taken for it.
const sleepOf = (readings: readonly Reading[]): DayRecord['sleep'] => {
  const asleep = newest(readings.filter(r => r.signal === 'sleep_duration' && (r.method === null || r.method === 'asleep_duration')));
  const midpoint = newest(readings.filter(r => r.signal === 'sleep_midpoint'));
  const when = asleep && span(asleep);
  return asleep && midpoint && when ? { ...when, asleepMinutes: asleep.value, midpointMinute: midpoint.value } : null;
};

const hourlyOf = (readings: readonly Reading[]): HourlyBucket[] => {
  const buckets = new Map<string, { -readonly [K in keyof HourlyBucket]: HourlyBucket[K] }>();
  for (const r of readings) {
    if (!r.startAt || !['heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration'].includes(r.signal)) continue;
    const bucket = buckets.get(r.startAt) ?? { startAt: r.startAt, heartRate: null, hrv: null, hrvMethod: null, daylightMinutes: null, movementMinutes: null };
    if (r.signal === 'heart_rate_window') bucket.heartRate = r.value;
    else if (r.signal === 'hrv_window' && hrvMethod(r.method)) { bucket.hrv = r.value; bucket.hrvMethod = hrvMethod(r.method); }
    else if (r.signal === 'daylight_duration') bucket.daylightMinutes = r.value;
    else if (r.signal === 'movement_duration') bucket.movementMinutes = r.value;
    buckets.set(r.startAt, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
};

// Each day keeps the zone its newest reading was read in; a day that holds readings from two zones is flagged.
const daysOf = (readings: readonly Reading[], fallbackZone: string): Readonly<{ days: DayRecord[]; zoneChanged: ReadonlySet<string> }> => {
  const byDay = new Map<string, Reading[]>();
  for (const r of readings) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const zoneChanged = new Set<string>();
  const days = [...byDay].map(([day, rs]): DayRecord => {
    const zones = new Set(rs.flatMap(r => (r.timezone ? [r.timezone] : [])));
    if (zones.size > 1) zoneChanged.add(day);
    const hrv = newest(rs.filter(r => r.signal === 'overnight_hrv' && hrvMethod(r.method)));
    const resting = newest(rs.filter(r => r.signal === 'resting_heart_rate'));
    return {
      day, timezone: newest(rs.filter(r => r.timezone))?.timezone ?? fallbackZone, sleep: sleepOf(rs),
      overnightHrv: hrv ? { value: hrv.value, method: hrvMethod(hrv.method)! } : null,
      restingHeartRate: resting?.value ?? null, hourly: hourlyOf(rs),
      workouts: rs.filter(r => r.signal === 'workout').flatMap(r => span(r) ?? []), demand: null,
    };
  });
  return { days, zoneChanged };
};

const localDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

const rowOf = (day: string, scores: DailyScores, basis: Readonly<{ source: string; epoch: number }>, readAt: string, timezone: string, zoneChanged: boolean): object => {
  const { recovery, form, weight } = scores;
  const unavailable = (reason: string) => ({ reason });
  return {
    day, timezone, read_at: readAt, basis: [{ source: basis.source, consent_epoch: basis.epoch }],
    recovery: recovery.state === 'unavailable' ? unavailable(recovery.reason)
      : { score: recovery.score, zone: toRowZone('recovery', recovery.zone), confidence: recovery.coverage, algorithm_version: recovery.algorithm_version, activation: recovery.activation, hrv_method: recovery.hrv_method },
    form: form.state === 'unavailable' ? unavailable(form.reason)
      : { score: form.score, zone: toRowZone('form', form.zone), confidence: form.confidence, algorithm_version: form.algorithm_version, activation: form.activation, hrv_method: form.hrv_method },
    weight: weight.state === 'unavailable' ? unavailable(weight.reason)
      : { score: weight.score, zone: toRowZone('weight', weight.zone), confidence: weight.coverage, algorithm_version: weight.algorithm_version, activation: weight.activation, hrv_method: weight.hrv_method },
    ...(recovery.state === 'available' ? { confidence: recovery.coverage } : {}),
    freshness: 'fresh', tags: zoneChanged ? ['zone_changed'] : [],
  };
};

const writeOutcome = (answer: unknown): 'written' | 'stale' | 'refused' | 'failed' => {
  const a = asRecord(answer);
  if (a?.written === true) return 'written';
  if (a?.written === false && a.stale === true) return 'stale';
  return a?.error === 'epoch_conflict' || a?.error === 'consent_required' ? 'refused' : 'failed';
};

export const produceHealthScores = async (deps: ProducerDeps, at: Readonly<{ now: number; timezone: string }>): Promise<ProducerOutcome> => {
  try {
    const today = localDay(at.now, at.timezone);
    const parsed = parseSeries(await deps.readSeries({ from: shiftDay(today, -WINDOW_DAYS), to: today, signals: SIGNALS }));
    if (parsed.kind !== 'series') return parsed.kind;
    // One source's readings are computed on its own. Two phones' step counts or sleep for one night are not added up.
    const chosen = [...parsed.series.sources].filter(s => s.readings.length > 0).sort((a, b) => b.readings.length - a.readings.length || a.source.localeCompare(b.source))[0];
    if (!chosen) return 'no_readings';
    const { days, zoneChanged } = daysOf(chosen.readings, at.timezone);
    const outcomes: ReturnType<typeof writeOutcome>[] = [];
    for (const targetDay of [shiftDay(today, -1), today]) {
      const scores = deps.compute({ access: 'granted', targetDay, days, sleepNeedMinutes: null, asOf: parsed.series.readAt, source: chosen.source });
      const nothingToShow = [scores.recovery, scores.form, scores.weight].every(p => p.state === 'unavailable');
      if (nothingToShow && !days.some(d => d.day === targetDay)) continue;
      const row = rowOf(targetDay, scores, chosen, parsed.series.readAt, at.timezone, zoneChanged.has(targetDay));
      outcomes.push(writeOutcome(await deps.writeContext(JSON.stringify(row))));
    }
    for (const outcome of ['failed', 'refused', 'written', 'stale'] as const) if (outcomes.includes(outcome)) return outcome;
    return 'no_readings';
  } catch {
    console.error('health producer failed');
    return 'failed';
  }
};
