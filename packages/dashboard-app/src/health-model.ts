import { SignInRequired } from './model';

// The console's health reads. The owner's page shows the same derived scores and consents the app's Body screen and Waldo
// read; the admin's page shows every tester's uploads as counts, times and closed codes. Each reader keeps only the fields
// its page shows and refuses any shape it does not know.
export const HEALTH_URL = '/console/dashboard/api/v1/health';
export const ADMIN_HEALTH_URL = '/console/dashboard/api/v1/admin/health';

const SOURCES = ['apple', 'samsung', 'health_connect', 'whoop'] as const;
const PURPOSES = ['storage_compute', 'model_processing'] as const;
const REASONS = {
  not_linked: 'Your account isn’t linked to the health service yet.',
  consent_required: 'You haven’t shared health data with Waldo.',
  consent_withdrawn: 'You withdrew health sharing.',
  no_readings: 'No readings have arrived yet.',
  baseline_immature: 'Waldo is still learning your usual range.',
  missing_sleep: 'No sleep was recorded for last night.',
  missing_resting_signal: 'No resting heart rate or HRV was recorded.',
  stale_inputs: 'The readings it needs are too old.',
  conflicting_inputs: 'The readings it needs disagree.',
  intraday_inputs_unavailable: 'Today’s readings haven’t arrived.',
  calendar_demand_unavailable: 'Waldo can’t read your calendar.',
} as const;
export type Source = (typeof SOURCES)[number];
export type Purpose = (typeof PURPOSES)[number];
export type Reason = keyof typeof REASONS;
export type Freshness = 'fresh' | 'stale' | 'expired';
export type Pillar = { state: 'unavailable'; reason: Reason } | { state: 'available'; score: number; zone: string | null };
export type SleepDebt = { state: 'unavailable'; reason: Reason } | { state: 'partial' } | { state: 'available'; debt_minutes: number };
export type Scores = { state: 'unavailable'; day: string | null; reason: Reason }
  | { state: 'available'; day: string; timezone: string; compiled_at: string; freshness: Freshness; recovery: Pillar; form: Pillar; weight: Pillar; sleep_debt: SleepDebt | null };
export type Consent = { source: Source; purpose: Purpose; status: 'granted' | 'withdrawn' | 'not_granted'; granted_at: string | null; withdrawn_at: string | null };
export type SourceUploads = { source: Source; newest_upload_at: string; uploads_7d: number; rejected_readings_7d: { reason: string; count: number }[] };
export type Uploads = { sources: SourceUploads[]; refusals_7d: { code: string; status: number; count: number; newest_at: string }[]; newest_derived: { day: string; compiled_at: string } | null };
export type HealthRecord = { as_of: string; scores: Scores | null; consents: Consent[] | null; freshness: Uploads | null };
export type AdminHealthOwner = { id: string; email: string | null; state: string; created_at: string; consents: Consent[]; freshness: Uploads };
export type AdminHealthRecord = { as_of: string; owners: AdminHealthOwner[] };

export const SOURCE_LABEL: Record<Source, string> = { apple: 'Apple Health', samsung: 'Samsung Health', health_connect: 'Health Connect', whoop: 'WHOOP' };
export const PURPOSE_LABEL: Record<Purpose, string> = { storage_compute: 'Storage and computing', model_processing: 'Model processing' };
export const reasonText = (reason: Reason) => REASONS[reason];

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullableInstant = (v: unknown): v is string | null => v === null || instant(v);
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const among = <T extends string>(options: readonly T[], v: unknown): v is T => typeof v === 'string' && (options as readonly string[]).includes(v);
const reason = (v: unknown): v is Reason => typeof v === 'string' && Object.hasOwn(REASONS, v);
const unsupported = () => new Error('Your health view has an unsupported shape. Reload the console.');
const each = <T>(v: unknown, row: (r: unknown) => T): T[] => { if (!Array.isArray(v)) throw unsupported(); return v.map(row); };

const pillar = (v: unknown): Pillar => {
  if (obj(v) && v.state === 'unavailable' && reason(v.reason)) return { state: 'unavailable', reason: v.reason };
  if (obj(v) && v.state === 'available' && typeof v.score === 'number' && v.score >= 0 && v.score <= 100 && (v.zone === null || typeof v.zone === 'string')) return { state: 'available', score: v.score, zone: v.zone };
  throw unsupported();
};
const sleepDebt = (v: unknown): SleepDebt | null => {
  if (v === undefined) return null;
  if (obj(v) && v.state === 'unavailable' && reason(v.reason)) return { state: 'unavailable', reason: v.reason };
  if (obj(v) && v.state === 'partial') return { state: 'partial' };
  if (obj(v) && v.state === 'available' && typeof v.debt_minutes === 'number' && v.debt_minutes >= 0) return { state: 'available', debt_minutes: v.debt_minutes };
  throw unsupported();
};
const scores = (v: unknown): Scores | null => {
  if (v === null) return null;
  if (!obj(v)) throw unsupported();
  if (v.state === 'unavailable') { if (!(v.day === null || day(v.day)) || !reason(v.reason)) throw unsupported(); return { state: 'unavailable', day: v.day, reason: v.reason }; }
  if (!day(v.day) || typeof v.timezone !== 'string' || !instant(v.compiled_at) || !among(['fresh', 'stale', 'expired'] as const, v.freshness)) throw unsupported();
  return { state: 'available', day: v.day, timezone: v.timezone, compiled_at: v.compiled_at, freshness: v.freshness, recovery: pillar(v.recovery), form: pillar(v.form), weight: pillar(v.weight), sleep_debt: sleepDebt(v.sleep_debt) };
};
const consent = (v: unknown): Consent => {
  if (!obj(v) || !among(SOURCES, v.source) || !among(PURPOSES, v.purpose) || !among(['granted', 'withdrawn', 'not_granted'] as const, v.status) || !nullableInstant(v.granted_at) || !nullableInstant(v.withdrawn_at)) throw unsupported();
  return { source: v.source, purpose: v.purpose, status: v.status, granted_at: v.granted_at, withdrawn_at: v.withdrawn_at };
};
const uploads = (v: unknown): Uploads => {
  if (!obj(v)) throw unsupported();
  const derived = v.newest_derived;
  if (!(derived === null || (obj(derived) && day(derived.day) && instant(derived.compiled_at)))) throw unsupported();
  return {
    sources: each(v.sources, s => {
      if (!obj(s) || !among(SOURCES, s.source) || !instant(s.newest_upload_at) || !count(s.uploads_7d)) throw unsupported();
      return { source: s.source, newest_upload_at: s.newest_upload_at, uploads_7d: s.uploads_7d,
        rejected_readings_7d: each(s.rejected_readings_7d, r => { if (!obj(r) || typeof r.reason !== 'string' || !count(r.count)) throw unsupported(); return { reason: r.reason, count: r.count }; }) };
    }),
    refusals_7d: each(v.refusals_7d, r => {
      if (!obj(r) || typeof r.code !== 'string' || !count(r.status) || !count(r.count) || !instant(r.newest_at)) throw unsupported();
      return { code: r.code, status: r.status, count: r.count, newest_at: r.newest_at };
    }),
    newest_derived: derived === null ? null : { day: derived.day as string, compiled_at: derived.compiled_at as string },
  };
};

export function readHealth(v: unknown): HealthRecord {
  if (!obj(v) || v.version !== 1 || !instant(v.as_of)) throw unsupported();
  return { as_of: v.as_of, scores: scores(v.scores), consents: v.consents === null ? null : each(v.consents, consent), freshness: v.freshness === null ? null : uploads(v.freshness) };
}
export function readAdminHealth(v: unknown): AdminHealthRecord {
  if (!obj(v) || v.version !== 1 || !instant(v.as_of)) throw unsupported();
  return { as_of: v.as_of, owners: each(v.owners, o => {
    if (!obj(o) || typeof o.id !== 'string' || !(o.email === null || typeof o.email === 'string') || typeof o.state !== 'string' || !instant(o.created_at)) throw unsupported();
    return { id: o.id, email: o.email, state: o.state, created_at: o.created_at, consents: each(o.consents, consent), freshness: uploads(o.freshness) };
  }) };
}

const read = (url: string, signal?: AbortSignal) => fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
const failed = (response: Response) => {
  if (response.status === 401) return new SignInRequired();
  if (response.status === 429) return new Error('Health was asked for too often. Wait a minute, then try again.');
  return new Error('Your health view is unavailable right now. Try again.');
};
export async function fetchHealth(signal?: AbortSignal): Promise<HealthRecord> {
  const response = await read(HEALTH_URL, signal);
  if (!response.ok) throw failed(response);
  return readHealth(await response.json());
}
// Null for anyone the read refuses: the page is not advertised to them.
export async function fetchAdminHealth(signal?: AbortSignal): Promise<AdminHealthRecord | null> {
  const response = await read(ADMIN_HEALTH_URL, signal);
  if (response.status === 404) return null;
  if (!response.ok) throw failed(response);
  return readAdminHealth(await response.json());
}
