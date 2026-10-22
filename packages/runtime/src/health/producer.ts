import { fromRowZone, toRowZone } from '../../../contracts/src/health/zone-bridge';
import { shiftDay } from './scores/time';
import { formZone, heldZone, recoveryZone, weightZone } from './scores/zones';
import type { DailyScores, DailyScoresInput, DayRecord, HourlyBucket, HrvMethod, Span } from './scores/types';

// The producer turns an owner's stored readings into the derived row the app and the prompt read. It reads one 31-day
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
  // The stored row for one day, or the newest row when the day is null (waldo.health_scores_read). Each zone holds through
  // a steady move from it; without it every zone is the score's own band.
  readScores?: (day: string | null) => Promise<unknown>;
}>;

const WINDOW_DAYS = 30;
const HOUR_MS = 3_600_000;
const MAX_BUSY_MINUTES = 1500;
const DEMAND_GRACE_MS = 5_000;
const SIGNALS = ['sleep_duration', 'sleep_midpoint', 'overnight_hrv', 'resting_heart_rate', 'heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration', 'workout'];
// ADR-0081's confidence order for whole sources (Apple > Oura > WHOOP), then the phone transports. Ranked, not counted:
// a phone's hourly windows outnumber a ring's nightly records, and a choice that flips by count would re-base the owner
// on another wearable from one day to the next.
const SOURCE_RANK = ['apple', 'oura', 'whoop', 'health_connect', 'samsung'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export type Reading = Readonly<{ signal: string; day: string; startAt: string | null; endAt: string | null; timezone: string | null; value: number; method: string | null }>;
type Source = Readonly<{ source: string; epoch: number; readings: readonly Reading[] }>;
export type Series = Readonly<{ readAt: string; sources: readonly Source[] }>;

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

const SCORED_WINDOW_SIGNALS = ['heart_rate_window', 'hrv_window', 'daylight_duration', 'movement_duration'];

const hourlyOf = (readings: readonly Reading[]): HourlyBucket[] => {
  const buckets = new Map<string, { -readonly [K in keyof HourlyBucket]: HourlyBucket[K] }>();
  for (const r of readings) {
    if (!r.startAt || !SCORED_WINDOW_SIGNALS.includes(r.signal)) continue;
    const bucket = buckets.get(r.startAt) ?? { startAt: r.startAt, heartRate: null, hrv: null, hrvMethod: null, daylightMinutes: null, movementMinutes: null };
    if (r.signal === 'heart_rate_window') bucket.heartRate = r.value;
    else if (r.signal === 'hrv_window' && hrvMethod(r.method)) { bucket.hrv = r.value; bucket.hrvMethod = hrvMethod(r.method); }
    else if (r.signal === 'daylight_duration') bucket.daylightMinutes = r.value;
    else if (r.signal === 'movement_duration') bucket.movementMinutes = r.value;
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

// Each day keeps the zone its newest reading was read in; a day that holds readings from two zones is flagged. A day
// holding an overlapping window keeps no hourly windows, so its window-based parts read as unknown, never doubled.
const daysOf = (readings: readonly Reading[], fallbackZone: string): Readonly<{ days: DayRecord[]; zoneChanged: ReadonlySet<string>; overlapped: ReadonlySet<string> }> => {
  const byDay = new Map<string, Reading[]>();
  for (const r of readings) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const zoneChanged = new Set<string>();
  const overlapped = overlappingWindowDays(readings);
  const days = [...byDay].map(([day, rs]): DayRecord => {
    const zones = new Set(rs.flatMap(r => (r.timezone ? [r.timezone] : [])));
    if (zones.size > 1) zoneChanged.add(day);
    const hrv = newest(rs.filter(r => r.signal === 'overnight_hrv' && hrvMethod(r.method)));
    const resting = newest(rs.filter(r => r.signal === 'resting_heart_rate'));
    return {
      day, timezone: newest(rs.filter(r => r.timezone))?.timezone ?? fallbackZone, sleep: sleepOf(rs),
      overnightHrv: hrv ? { value: hrv.value, method: hrvMethod(hrv.method)! } : null,
      restingHeartRate: resting?.value ?? null, hourly: overlapped.has(day) ? [] : hourlyOf(rs),
      workouts: rs.filter(r => r.signal === 'workout').flatMap(r => span(r) ?? []), demand: null,
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

const rowOf = (day: string, scores: DailyScores, basis: Readonly<{ source: string; epoch: number }>, readAt: string, timezone: string, tags: readonly string[]): object => {
  const { recovery, form, weight } = scores;
  const unavailable = (reason: string) => ({ reason });
  return {
    day, timezone, read_at: readAt, basis: [{ source: basis.source, consent_epoch: basis.epoch }],
    recovery: recovery.state === 'unavailable' ? unavailable(recovery.reason)
      : { score: recovery.score, zone: toRowZone('recovery', recovery.zone), confidence: recovery.coverage, algorithm_version: recovery.algorithm_version, activation: recovery.activation, hrv_method: recovery.hrv_method },
    form: form.state === 'unavailable' ? unavailable(form.reason)
      : { score: form.score, zone: toRowZone('form', form.zone), confidence: form.coverage, algorithm_version: form.algorithm_version, activation: form.activation, hrv_method: form.hrv_method },
    weight: weight.state === 'unavailable' ? unavailable(weight.reason)
      : { score: weight.score, zone: toRowZone('weight', weight.zone), confidence: weight.coverage, algorithm_version: weight.algorithm_version, activation: weight.activation, hrv_method: weight.hrv_method },
    ...(recovery.state === 'available' ? { confidence: recovery.coverage } : {}),
    freshness: 'fresh', tags,
  };
};

// The row the writer compares a new one with when it reports a zone change: the row it replaces or, for a day's first row,
// the newest earlier day. A read that fails or answers anything else is no row.
const storedBefore = async (read: ProducerDeps['readScores'], day: string): Promise<Record<string, unknown> | null> => {
  const stored = async (of: string | null) => { try { return asRecord(asRecord(await read?.(of))?.scores); } catch { return null; } };
  const same = await stored(day);
  if (same?.day === day) return same;
  const newest = await stored(null);
  return typeof newest?.day === 'string' && newest.day < day ? newest : null;
};
// Each pillar's zone holds through a steady move from the zone its stored row had, so the writer reports a change only on a
// real crossing. A zone another algorithm version wrote is not the same state and holds nothing.
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
    const parsed = parseSeries(await deps.readSeries({ ...range, signals: SIGNALS }));
    if (parsed.kind !== 'series') return parsed.kind;
    // One source's readings are computed on its own, per day. Two wearables' sleep for one night is never added up. The
    // day's source is the highest-ranked one holding that night's sleep, or the highest-ranked with any reading.
    const present = [...parsed.series.sources].filter(s => s.readings.length > 0);
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
        if (!days.some(d => d.day === day)) days.push({ day, timezone: at.timezone, sleep: null, overnightHrv: null, restingHeartRate: null, hourly: [], workouts: [], demand: { meetingMinutes: minutes, messageCount: null, openTaskMinutes: null, physicalLoad: null } });
      }
      return { readingDays, travelled, days };
    };
    const outcomes: ReturnType<typeof writeOutcome>[] = [];
    for (const targetDay of [shiftDay(today, -1), today]) {
      const chosen = chooseFor(targetDay);
      const { readingDays, travelled, days } = recordsOf(chosen);
      const scores = deps.compute({ access: 'granted', targetDay, days, sleepNeedMinutes: null, asOf: parsed.series.readAt });
      const nothingToShow = [scores.recovery, scores.form, scores.weight].every(p => p.state === 'unavailable');
      if (nothingToShow && !readingDays.some(d => d.day === targetDay)) continue;
      // A day read without a calendar Google reported gone says so, since its Weight saw less than every calendar.
      const tags = [...(travelled.has(targetDay) ? ['zone_changed'] : []), ...(scores.weight.state === 'available' && busy.get(targetDay)?.partial ? ['calendar_partial'] : [])];
      const row = rowOf(targetDay, steadied(scores, await storedBefore(deps.readScores, targetDay)), chosen, parsed.series.readAt, at.timezone, tags);
      const answer = await deps.writeContext(JSON.stringify(row));
      outcomes.push(writeOutcome(answer));
      if (targetDay === today && writeOutcome(answer) === 'written' && pillarMoved(answer)) await deps.onZoneChange?.(today).catch(() => console.error('health zone change notice failed'));
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
