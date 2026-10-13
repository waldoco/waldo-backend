import {
  getHealthArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type GetHealthArgs, type GetHealthResult, type HealthReadSignal, type ToolHandler,
} from '@waldo/contracts';
import { md5Hex } from '../../channels/md5';
import { parseSeries, type Reading } from '../../health/producer';
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
    const payload = JSON.stringify(range);
    return call('health_series_read', `health.series_read.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload });
  },
});

type Unit = 'minutes' | 'ms' | 'bpm' | 'minute_of_day';
type Method = 'asleep' | 'rmssd' | 'sdnn';
type Fold = 'newest' | 'sum' | 'mean';
const SIGNALS: Record<HealthReadSignal, Readonly<{ stored: string; unit: Unit; fold: Fold }>> = {
  sleep: { stored: 'sleep_duration', unit: 'minutes', fold: 'newest' },
  sleep_midpoint: { stored: 'sleep_midpoint', unit: 'minute_of_day', fold: 'newest' },
  hrv: { stored: 'overnight_hrv', unit: 'ms', fold: 'newest' },
  resting_hr: { stored: 'resting_heart_rate', unit: 'bpm', fold: 'newest' },
  heart_rate: { stored: 'heart_rate_window', unit: 'bpm', fold: 'mean' },
  movement: { stored: 'movement_duration', unit: 'minutes', fold: 'sum' },
  daylight: { stored: 'daylight_duration', unit: 'minutes', fold: 'sum' },
  workouts: { stored: 'workout', unit: 'minutes', fold: 'sum' },
};
const FRESH_MS = 36 * 3_600_000;
const STALE_MS = 72 * 3_600_000;

const round1 = (value: number): number => Math.round(value * 10) / 10;
// A reading's instant is when it ended, so a night's sleep ages from waking, not from falling asleep.
const instantOf = (reading: Reading, timezone: string): number =>
  reading.endAt ? Date.parse(reading.endAt) : reading.startAt ? Date.parse(reading.startAt) : localDayWindow(reading.day, reading.timezone ?? timezone).end;
const localDayOf = (now: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

type Group = Readonly<{ source: string; method: string | null; readings: readonly Reading[] }>;
// One source per signal, the one with the most readings; for HRV one method as well, so rmssd and sdnn never blend.
const chooseGroup = (signal: HealthReadSignal, sources: readonly Readonly<{ source: string; readings: readonly Reading[] }>[]): Group | null => {
  const groups = new Map<string, { source: string; method: string | null; readings: Reading[] }>();
  for (const source of sources) {
    for (const reading of source.readings) {
      if (reading.signal !== SIGNALS[signal].stored) continue;
      if (signal === 'sleep' && reading.method !== null && reading.method !== 'asleep_duration') continue;
      const method = signal === 'hrv' ? (reading.method === 'rmssd' || reading.method === 'sdnn' ? reading.method : null) : null;
      if (signal === 'hrv' && method === null) continue;
      const key = `${source.source}\u0000${method ?? ''}`;
      const group = groups.get(key) ?? { source: source.source, method, readings: [] };
      group.readings.push(reading);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.readings.length - a.readings.length || a.source.localeCompare(b.source) || (a.method ?? '').localeCompare(b.method ?? ''))[0] ?? null;
};

const foldDay = (fold: Fold, readings: readonly Reading[], timezone: string): number | null => {
  if (readings.length === 0) return null;
  if (fold === 'sum') return Math.round(readings.reduce((total, reading) => total + reading.value, 0));
  if (fold === 'mean') return round1(readings.reduce((total, reading) => total + reading.value, 0) / readings.length);
  return [...readings].sort((a, b) => instantOf(b, timezone) - instantOf(a, timezone))[0]!.value;
};

const methodOf = (signal: HealthReadSignal, group: Group): Method | null =>
  signal === 'sleep' ? 'asleep' : signal === 'hrv' ? (group.method as Method) : null;

const allowlist = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_health'));

export const getHealthHandler = (book: HealthReadBook, clock: OwnerClock): ToolHandler<GetHealthArgs, GetHealthResult, ToolDispatcherContext> => ({
  name: 'get_health',
  description:
    "The owner's own readings from their health plane, by local day: time asleep (never time in bed), sleep midpoint, overnight HRV labelled rmssd or sdnn (never blended), resting heart rate, mean heart rate, and movement, daylight and workout minutes. Daily values or a summary, for at most 31 days ending no later than today. One source per signal. When unavailable, the reason says why: consent, link, no readings or a failed read. The numbers stay in this turn: nothing is stored or logged.",
  schema: getHealthArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  turn_only_output: true,
  async handle(args) {
    const timezone = clock.timezone;
    const today = localDayOf(clock.now(), timezone);
    if (daysBetween(args.to, today) < 0) return { ok: false, code: 'invalid_args', error: `to must not be after today (${today}) in the owner's time zone` };
    const unavailable = (reason: Extract<GetHealthResult, { state: 'unavailable' }>['reason']): ReturnType<typeof result> => result({ state: 'unavailable', reason });
    const consent = await book.consent();
    if (consent.kind !== 'granted') return unavailable(consent.kind);
    const signals = [...new Set(args.signals)];
    let raw: unknown;
    try {
      raw = await book.series({ from: args.from, to: args.to, signals: signals.map((signal) => SIGNALS[signal].stored) });
    } catch {
      return unavailable('read_failed');
    }
    if (raw && typeof raw === 'object' && (raw as { error?: unknown }).error === 'not_linked') return unavailable('not_linked');
    const parsed = parseSeries(raw);
    if (parsed.kind === 'no_consent') return unavailable('consent_required');
    if (parsed.kind === 'failed') return unavailable('read_failed');
    const sources = parsed.series.sources.filter((source) => consent.sources.has(source.source));
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
      const values = days.map((day) => ({ day, value: foldDay(SIGNALS[signal].fold, byDay.get(day) ?? [], timezone) }));
      const present = values.map((entry) => entry.value).filter((value): value is number => value !== null);
      valued += present.length;
      const base = { signal, unit: SIGNALS[signal].unit, source: group.source as 'apple' | 'samsung' | 'health_connect', method: methodOf(signal, group) };
      series.push(args.aggregation === 'summary'
        ? { ...base, summary: { mean: present.length ? round1(present.reduce((total, value) => total + value, 0) / present.length) : null, min: present.length ? Math.min(...present) : null, max: present.length ? Math.max(...present) : null, days_with_value: present.length } }
        : { ...base, days: values });
    }
    if (valued === 0) return unavailable('no_readings');
    const age = clock.now().getTime() - newest;
    return result({
      state: 'available', timezone, from: args.from, to: args.to, read_at: parsed.series.readAt, signals: series,
      freshness: age <= FRESH_MS ? 'fresh' : age <= STALE_MS ? 'stale' : 'expired',
      coverage: Math.round((valued / (signals.length * days.length)) * 1000) / 1000,
    });
  },
});

const result = (data: GetHealthResult) => ({ ok: true as const, data, source_taint: null });
