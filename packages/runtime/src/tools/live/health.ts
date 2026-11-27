import {
  getHealthArgsSchema, HEALTH_READ_MAX_HOURLY_DAYS, HEALTH_READ_MAX_SESSIONS, HEALTH_SIGNALS, healthWorkoutSessionParts, healthWorkoutSessionSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type GetHealthArgs, type GetHealthResult, type HealthReadSignal, type HealthSignal, type ToolHandler,
} from '@waldo/contracts';
import type { z } from 'zod';
import { md5Hex } from '../../channels/md5';
import { parseSeries, untruncated, withoutWear, type Reading, type SleepStages } from '../../health/producer';
import { localIso } from '../../channels/reminders';
import { daysBetween, localDayWindow, shiftDay } from '../../health/scores/time';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

// The owner's own readings for the owner's own model context. One read path, the router-signed series read the
// scores producer already uses; consent for both purposes is checked on every call; the result lives in the turn that
// asked (turn_only_output), so no value reaches the tool ledger, memory, logs or storage.
type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type ConsentRefusal = 'consent_required' | 'consent_withdrawn' | 'not_linked' | 'read_failed';
type ConsentState = Readonly<{ kind: 'granted'; sources: ReadonlySet<string> }> | Readonly<{ kind: ConsentRefusal }>;
type SeriesRange = Readonly<{ from: string; to: string; signals: readonly string[] }>;

export type HealthReadBook = Readonly<{
  consent(): Promise<ConsentState>;
  series(range: SeriesRange): Promise<unknown>;
}>;

const REQUIRED_PURPOSES = ['storage_compute', 'model_processing'] as const;
type ConsentRow = Readonly<{ source: string; purpose: string; status: string; epoch: number }>;
const consentRow = (raw: unknown): ConsentRow | null => {
  const row = raw as Partial<ConsentRow> | null;
  return row && typeof row === 'object' && typeof row.source === 'string' && typeof row.purpose === 'string' && typeof row.status === 'string' && typeof row.epoch === 'number' ? (row as ConsentRow) : null;
};

// Consent is kept per source and purpose, and a source's epoch counts only its own rows. A source is readable when its
// own newest row for each purpose is granted; the series is cut to those sources, so a withdrawal on one source never
// reads through another. The refusal names what the owner would recognise: a withdrawal anywhere beats "not asked yet".
const consentState = (raw: unknown): ConsentState => {
  if (raw && typeof raw === 'object' && (raw as { error?: unknown }).error === 'not_linked') return { kind: 'not_linked' };
  const rows = (raw as { consents?: unknown } | null)?.consents;
  if (!Array.isArray(rows)) return { kind: 'read_failed' };
  const bySource = new Map<string, Map<string, ConsentRow>>();
  for (const row of rows.map(consentRow)) {
    if (!row) continue;
    const purposes = bySource.get(row.source) ?? new Map<string, ConsentRow>();
    const newest = purposes.get(row.purpose);
    if (!newest || row.epoch > newest.epoch) purposes.set(row.purpose, row);
    bySource.set(row.source, purposes);
  }
  const sources = new Set<string>();
  let withdrawn = false;
  for (const [source, purposes] of bySource) {
    const statuses = REQUIRED_PURPOSES.map((purpose) => purposes.get(purpose)?.status);
    if (statuses.every((status) => status === 'granted')) sources.add(source);
    else if (statuses.includes('withdrawn')) withdrawn = true;
  }
  if (sources.size > 0) return { kind: 'granted', sources };
  return { kind: withdrawn ? 'consent_withdrawn' : 'consent_required' };
};

export const healthReadBook = (call: SignedCall | null, doName: string | null): HealthReadBook => ({
  async consent() {
    if (!call || !doName) return { kind: 'not_linked' };
    try {
      return consentState(await call('health_consent_list', `health.consent_list.${doName}.${md5Hex('{}')}`, { p_do_name: doName, p_payload: '{}' }));
    } catch {
      return { kind: 'read_failed' };
    }
  },
  async series(range) {
    if (!call || !doName) return null;
    // Each stored name goes once. Several read signals share one (sleep and its four stages all read sleep_duration), and the
    // plane refuses a list longer than its known signals before it removes repeats, so a caller asking for every signal would
    // otherwise be refused outright.
    const payload = JSON.stringify({ ...range, signals: [...new Set(range.signals)] });
    return call('health_series_read', `health.series_read.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload });
  },
});

type Available = Extract<GetHealthResult, { state: 'available' }>['signals'][number];
type Method = NonNullable<Available['method']>;
type Fold = 'newest' | 'sum' | 'mean';
// stored: the plane's signal. asleep: only time asleep is read, never time in bed. methods: a signal read one method at a
// time, never blended. value: what the signal reads from the stored reading, when it is not the reading's own value.
type Spec = Readonly<{ stored: HealthSignal; unit: Available['unit']; fold: Fold; asleep?: true; methods?: readonly Method[]; value?: (reading: Reading) => number | null }>;
const stage = (key: keyof SleepStages): Spec => ({ stored: 'sleep_duration', unit: 'minutes', fold: 'newest', asleep: true, value: reading => reading.stages?.[key] ?? null });
export const SIGNALS: Record<HealthReadSignal, Spec> = {
  sleep: { stored: 'sleep_duration', unit: 'minutes', fold: 'newest', asleep: true },
  sleep_midpoint: { stored: 'sleep_midpoint', unit: 'minute_of_day', fold: 'newest' },
  hrv: { stored: 'overnight_hrv', unit: 'ms', fold: 'newest', methods: ['rmssd', 'sdnn'] },
  resting_hr: { stored: 'resting_heart_rate', unit: 'bpm', fold: 'newest' },
  heart_rate: { stored: 'heart_rate_window', unit: 'bpm', fold: 'mean' },
  movement: { stored: 'movement_duration', unit: 'minutes', fold: 'sum' },
  daylight: { stored: 'daylight_duration', unit: 'minutes', fold: 'sum' },
  workouts: { stored: 'workout', unit: 'minutes', fold: 'sum' },
  sleep_light: stage('light'), sleep_deep: stage('deep'), sleep_rem: stage('rem'), sleep_awake: stage('awake'),
  sleep_efficiency: { stored: 'sleep_efficiency', unit: 'ratio', fold: 'newest' },
  respiratory_rate: { stored: 'respiratory_rate', unit: 'breaths_per_minute', fold: 'mean' },
  spo2: { stored: 'spo2', unit: 'percent', fold: 'mean' },
  wrist_temperature: { stored: 'wrist_temperature', unit: 'celsius', fold: 'newest', methods: ['absolute', 'baseline_delta'] },
  walking_hr: { stored: 'walking_heart_rate_average', unit: 'bpm', fold: 'newest' },
  hr_recovery: { stored: 'heart_rate_recovery', unit: 'bpm', fold: 'mean' },
  vo2_max: { stored: 'vo2_max', unit: 'ml_per_kg_min', fold: 'newest' },
  steps: { stored: 'steps_window', unit: 'count', fold: 'sum' },
  active_energy: { stored: 'active_energy_window', unit: 'kcal', fold: 'sum' },
  mindful: { stored: 'mindful_duration', unit: 'minutes', fold: 'sum' },
  body_mass: { stored: 'body_mass', unit: 'kg', fold: 'newest' },
  body_fat: { stored: 'body_fat_percentage', unit: 'percent', fold: 'newest' },
  lean_body_mass: { stored: 'lean_body_mass', unit: 'kg', fold: 'newest' },
  stand_hours: { stored: 'stand_hour', unit: 'count', fold: 'sum' },
  food_energy: { stored: 'nutrition', unit: 'kcal', fold: 'sum' },
  protein: { stored: 'nutrition', unit: 'g', fold: 'sum', value: reading => reading.nutrition?.protein_g ?? null },
  carbs: { stored: 'nutrition', unit: 'g', fold: 'sum', value: reading => reading.nutrition?.carbohydrate_g ?? null },
  fat: { stored: 'nutrition', unit: 'g', fold: 'sum', value: reading => reading.nutrition?.fat_g ?? null },
  daytime_hrv: { stored: 'hrv_window', unit: 'ms', fold: 'mean', methods: ['rmssd', 'sdnn'] },
};
type Session = z.infer<typeof healthWorkoutSessionSchema>;
// One session as the tool shows it: each stored part kept only when it is the shape the result admits, and an average heart
// rate above the maximum keeps neither, since one of the two is wrong and nothing says which.
const sessionOf = (reading: Reading): Session | null => {
  const workout = reading.workout;
  if (!workout?.activity) return null;
  const stored: Record<string, unknown> = { ...workout.detail, zone_minutes: workout.zoneSeconds?.map(seconds => round1(seconds / 60)) };
  const parts = Object.fromEntries(Object.entries(healthWorkoutSessionParts).flatMap(([key, part]) => {
    const parsed = part.safeParse(stored[key]);
    return stored[key] !== undefined && parsed.success ? [[key, parsed.data]] : [];
  }));
  if (typeof parts.avg_hr_bpm === 'number' && typeof parts.max_hr_bpm === 'number' && parts.avg_hr_bpm > parts.max_hr_bpm) { delete parts.avg_hr_bpm; delete parts.max_hr_bpm; }
  const session = healthWorkoutSessionSchema.safeParse({ day: reading.day, activity: workout.activity, minutes: reading.value, ...parts });
  return session.success ? session.data : null;
};
const FRESH_MS = 36 * 3_600_000;
const STALE_MS = 72 * 3_600_000;

const round1 = (value: number): number => Math.round(value * 10) / 10;
// A reading's instant is when it ended, so a night's sleep ages from waking, not from falling asleep.
const instantOf = (reading: Reading, timezone: string): number =>
  reading.endAt ? Date.parse(reading.endAt) : reading.startAt ? Date.parse(reading.startAt) : localDayWindow(reading.day, reading.timezone ?? timezone).end;
export const localDayOf = (now: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

type Group = Readonly<{ source: string; method: Method | null; fromWatch: boolean; readings: readonly Reading[] }>;
// One source per signal, the one with the most readings; for a signal with methods one method as well, so they never blend.
// The readings from Waldo's own watch app are a group of their own inside their source: the phone holds the same hour from
// its own store under another id, so taking both would count an hour's steps twice. On a tie the phone's readings stand.
// For a signal summed over a day, a part of a reading (a food entry's protein) is given for that day only when every reading
// that day carries it, so a day's sum is never a partial one. A signal that takes one reading (a night's deep sleep) is
// unaffected by another reading that lacks the part.
export const chooseGroup = (signal: HealthReadSignal, sources: readonly Readonly<{ source: string; readings: readonly Reading[] }>[]): Group | null => {
  const spec = SIGNALS[signal];
  const groups = new Map<string, { source: string; method: Method | null; fromWatch: boolean; readings: Reading[] }>();
  const partial = new Set<string>();
  for (const source of sources) {
    for (const reading of source.readings) {
      if (reading.signal !== spec.stored) continue;
      if (spec.asleep && reading.method !== null && reading.method !== 'asleep_duration') continue;
      const method = spec.methods?.find(known => known === reading.method) ?? null;
      if (spec.methods && method === null) continue;
      const value = spec.value ? spec.value(reading) : reading.value;
      if (value === null) { if (spec.fold === 'sum') partial.add(`${source.source}\u0000${reading.day}`); continue; }
      const fromWatch = reading.waldoWear === true;
      const key = `${source.source}\u0000${method ?? ''}\u0000${fromWatch ? 'watch' : ''}`;
      const group = groups.get(key) ?? { source: source.source, method, fromWatch, readings: [] };
      group.readings.push({ ...reading, value });
      groups.set(key, group);
    }
  }
  const whole = [...groups.values()].map(group => ({ ...group, readings: group.readings.filter(reading => !partial.has(`${group.source}\u0000${reading.day}`)) })).filter(group => group.readings.length > 0);
  return whole.sort((a, b) => b.readings.length - a.readings.length || a.source.localeCompare(b.source) || (a.method ?? '').localeCompare(b.method ?? '') || Number(a.fromWatch) - Number(b.fromWatch))[0] ?? null;
};

export const foldDay = (fold: Fold, readings: readonly Reading[], timezone: string): number | null => {
  if (readings.length === 0) return null;
  if (fold === 'sum') return Math.round(readings.reduce((total, reading) => total + reading.value, 0));
  if (fold === 'mean') return round1(readings.reduce((total, reading) => total + reading.value, 0) / readings.length);
  return [...readings].sort((a, b) => instantOf(b, timezone) - instantOf(a, timezone))[0]!.value;
};

const methodOf = (signal: HealthReadSignal, group: Group): Method | null => (signal === 'sleep' ? 'asleep' : group.method);
// Heart rate's lowest and highest over a day or an hour: the lowest of its windows' lowest and the highest of their highest,
// each given only when every window carries it, so a range is never read from part of the day.
const rangeOf = (signal: HealthReadSignal, readings: readonly Reading[]): Readonly<{ min?: number; max?: number }> => {
  if (signal !== 'heart_rate' || readings.length === 0) return {};
  const lows = readings.map(reading => reading.min), highs = readings.map(reading => reading.max);
  return {
    ...(lows.every((low): low is number => typeof low === 'number') ? { min: round1(Math.min(...lows)) } : {}),
    ...(highs.every((high): high is number => typeof high === 'number') ? { max: round1(Math.max(...highs)) } : {}),
  };
};

// The read names an hourly or a nightly read takes: those whose stored kind carries a value each hour, or once a night.
const readsOfGrain = (grain: 'hour' | 'night'): HealthReadSignal[] => (Object.keys(SIGNALS) as HealthReadSignal[]).filter((signal) => HEALTH_SIGNALS[SIGNALS[signal].stored].grain === grain);
const GRAIN_OF = { hourly: 'hour', nightly: 'night' } as const;
// Each hour of a day's readings that carries a start, folded within the hour, oldest first.
const byHour = (signal: HealthReadSignal, readings: readonly Reading[], timezone: string) => {
  const hours = new Map<number, Reading[]>();
  for (const reading of readings) if (reading.startAt) { const at = Date.parse(reading.startAt); hours.set(at, [...(hours.get(at) ?? []), reading]); }
  return [...hours.entries()].sort(([a], [b]) => a - b).flatMap(([at, held]) => {
    const value = foldDay(SIGNALS[signal].fold, held, timezone);
    return value === null ? [] : [{ at: localIso(at, timezone), value, ...rangeOf(signal, held) }];
  });
};
// A day's night: its newest reading with a start and an end, and when it began and ended.
const nightOf = (day: string, readings: readonly Reading[], timezone: string) => {
  const night = [...readings].filter((reading) => reading.startAt && reading.endAt).sort((a, b) => instantOf(b, timezone) - instantOf(a, timezone))[0];
  return night ? [{ day, from: localIso(Date.parse(night.startAt!), timezone), to: localIso(Date.parse(night.endAt!), timezone), value: night.value }] : [];
};

const allowlist = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_health'));

// wearHrv and wearAllDay: the wear switches. Off, the night's RMSSD and the all-day readings from Waldo's own watch app are
// each left out here as in every score.
export const getHealthHandler = (book: HealthReadBook, clock: OwnerClock, options: Readonly<{ wearHrv?: boolean; wearAllDay?: boolean }> = {}): ToolHandler<GetHealthArgs, GetHealthResult, ToolDispatcherContext> => ({
  name: 'get_health',
  description:
    "The owner's own health readings, up to 31 days ending today, one source per signal: by local day, a summary, hourly over at most two days (heart_rate, daytime_hrv, steps, movement, daylight, active_energy, stand_hours), or nightly with each night's start and end (sleep and its stages, sleep_midpoint, sleep_efficiency, hrv, wrist_temperature). Sleep is time asleep, never time in bed. HRV, daytime_hrv and wrist temperature carry their method, never blended. heart_rate (with min and max), daytime_hrv, respiratory_rate, spo2 and hr_recovery are day means. food_energy, protein, carbs and fat are what the owner's food app logged; a macro is missing on a day an entry lacked it. Context for a plan, never a judgement of what the owner ate. The numbers stay in this turn and are never stored or logged.",
  schema: getHealthArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  turn_only_output: true,
  async handle(args) {
    const timezone = clock.timezone;
    const today = localDayOf(clock.now(), timezone);
    if (daysBetween(args.to, today) < 0) return { ok: false, code: 'invalid_args', error: `to must not be after today (${today}) in the owner's time zone` };
    const unavailable = (reason: Extract<GetHealthResult, { state: 'unavailable' }>['reason']): ReturnType<typeof result> => result({ state: 'unavailable', reason, next: UNAVAILABLE_NEXT[reason] });
    const signals = [...new Set(args.signals)];
    if (args.aggregation === 'hourly' || args.aggregation === 'nightly') {
      const allowed = readsOfGrain(GRAIN_OF[args.aggregation]);
      const refused = signals.filter((signal) => !allowed.includes(signal));
      if (refused.length > 0) return { ok: false, code: 'invalid_args', error: `${args.aggregation} reads only ${allowed.join(', ')}; not ${refused.join(', ')}` };
      if (args.aggregation === 'hourly' && daysBetween(args.from, args.to) >= HEALTH_READ_MAX_HOURLY_DAYS) return { ok: false, code: 'invalid_args', error: `hourly reads at most ${HEALTH_READ_MAX_HOURLY_DAYS} days` };
    }
    const consent = await book.consent();
    if (consent.kind !== 'granted') return unavailable(consent.kind);
    let raw: unknown;
    try {
      raw = await book.series({ from: args.from, to: args.to, signals: [...new Set(signals.map((signal) => SIGNALS[signal].stored))] });
    } catch {
      return unavailable('read_failed');
    }
    if (raw && typeof raw === 'object' && (raw as { error?: unknown }).error === 'not_linked') return unavailable('not_linked');
    const parsed = parseSeries(raw);
    if (parsed.kind === 'no_consent') return unavailable('consent_required');
    if (parsed.kind === 'failed') return unavailable('read_failed');
    const read = withoutWear(parsed.series, { hrv: options.wearHrv === true, allDay: options.wearAllDay === true });
    const sources = untruncated(read, 'get_health_truncated').sources.filter((source) => consent.sources.has(source.source));
    const days: string[] = [];
    for (let day = args.from; daysBetween(day, args.to) >= 0; day = shiftDay(day, 1)) days.push(day);
    let newest = Number.NEGATIVE_INFINITY;
    let valued = 0;
    const series: Extract<GetHealthResult, { state: 'available' }>['signals'] = [];
    for (const signal of signals) {
      const group = chooseGroup(signal, sources);
      if (!group) continue;
      const byDay = new Map<string, Reading[]>();
      for (const reading of group.readings) {
        if (daysBetween(args.from, reading.day) < 0 || daysBetween(reading.day, args.to) < 0) continue;
        byDay.set(reading.day, [...(byDay.get(reading.day) ?? []), reading]);
        newest = Math.max(newest, instantOf(reading, timezone));
      }
      const values = days.map((day) => ({ day, value: foldDay(SIGNALS[signal].fold, byDay.get(day) ?? [], timezone), ...rangeOf(signal, byDay.get(day) ?? []) }));
      const present = values.map((entry) => entry.value).filter((value): value is number => value !== null);
      valued += present.length;
      const base = { signal, unit: SIGNALS[signal].unit, source: group.source as Available['source'], method: methodOf(signal, group), ...(group.fromWatch ? { from_watch: true as const } : {}) };
      const held = (day: string) => byDay.get(day) ?? [];
      series.push(args.aggregation === 'summary'
        ? { ...base, summary: { mean: present.length ? round1(present.reduce((total, value) => total + value, 0) / present.length) : null, min: present.length ? Math.min(...present) : null, max: present.length ? Math.max(...present) : null, days_with_value: present.length } }
        : args.aggregation === 'hourly' ? { ...base, hours: days.flatMap((day) => byHour(signal, held(day), timezone)) }
        : args.aggregation === 'nightly' ? { ...base, nights: days.flatMap((day) => nightOf(day, held(day), timezone)) }
        : { ...base, days: values });
    }
    if (valued === 0) return unavailable('no_readings');
    const workoutGroup = args.aggregation === 'daily' && signals.includes('workouts') ? chooseGroup('workouts', sources) : null;
    const sessions = workoutGroup?.readings
      .filter(reading => daysBetween(args.from, reading.day) >= 0 && daysBetween(reading.day, args.to) >= 0)
      .sort((a, b) => a.day.localeCompare(b.day) || (a.startAt ?? '').localeCompare(b.startAt ?? ''))
      .flatMap(reading => sessionOf(reading) ?? []).slice(-HEALTH_READ_MAX_SESSIONS);
    const age = clock.now().getTime() - newest;
    return result({
      state: 'available', timezone, from: args.from, to: args.to, read_at: parsed.series.readAt, signals: series,
      freshness: age <= FRESH_MS ? 'fresh' : age <= STALE_MS ? 'stale' : 'expired',
      coverage: Math.round((valued / (signals.length * days.length)) * 1000) / 1000,
      ...(sessions ? { sessions } : {}),
    });
  },
});

// What each unavailable reason means for the reply, so the model neither retries a refusal nor guesses a reading.
const UNAVAILABLE_NEXT: Readonly<Record<Extract<GetHealthResult, { state: 'unavailable' }>['reason'], string>> = {
  consent_required: 'The owner has not turned on health sharing with Waldo, so nothing was read. Answer without their readings and say so; if they want Waldo to see them, sharing is turned on in the Waldo app.',
  consent_withdrawn: 'The owner turned health sharing off, so nothing was read. Answer without their readings, and do not ask them to turn it back on unless they bring it up.',
  not_linked: 'No phone or wearable has sent health data to Waldo for this owner yet, so nothing was read. Answer without readings; they can share health from the Waldo app on their phone.',
  no_readings: 'Sharing is on, but none of these signals has a reading on these days. Try once with a wider range (up to 31 days ending today) or other signals; if there is still none, say the phone or wearable may not have synced, and never invent a value.',
  read_failed: 'The health store could not be read just now. Try the same read once more; if it fails again, tell the owner their readings could not be checked right now.',
};
const result = (data: GetHealthResult) => ({ ok: true as const, data, source_taint: null });
