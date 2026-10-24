import { HEALTH_PROVIDER_REVISION_V1, healthApiErrorV1Schema, healthChangeRejectionReasonV1Schema, healthPurposeV1Schema, healthSourceV1Schema } from '../../../contracts/src/app/health-ingest';
import { healthConsentView, healthScoresView, invokeHealth } from './app-health';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';

// The console's health reads. The owner sees what the app and the agent see: the scores_read and consent_list answers through
// the app's own projection, and their upload freshness. The admin sees every owner's freshness and consent state as counts,
// times, dates and closed codes, never a value. Every read is a signed call for the session's owner; neither takes a selector.
export const DASHBOARD_HEALTH_PATH = '/console/dashboard/api/v1/health';
export const DASHBOARD_ADMIN_HEALTH_PATH = '/console/dashboard/api/v1/admin/health';
// Per minute, in the owner's own object. The admin read scans every owner, so it gets the tighter window.
export const HEALTH_READ_LIMIT = 30;
export const ADMIN_HEALTH_READ_LIMIT = 10;
const WINDOW_MS = 60_000;

type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
export type ConsoleHealthInput = Readonly<{ request: Request; kv: Kv; doName: string | undefined; rpc: SignedCall | null; now: number }>;

const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const oneOf = (options: readonly string[]) => (v: unknown): v is string => typeof v === 'string' && options.includes(v);
const source = oneOf(healthSourceV1Schema.options), purpose = oneOf(healthPurposeV1Schema.options);
const reason = oneOf(healthChangeRejectionReasonV1Schema.options), code = oneOf(healthApiErrorV1Schema.shape.error.options);
const status = oneOf(['granted', 'withdrawn', 'not_granted']);
const list = <T>(v: unknown, row: (r: unknown) => T | null): T[] | null => {
  if (!Array.isArray(v)) return null;
  const rows = v.map(row);
  return rows.every((r): r is T => r !== null) ? rows : null;
};

// Picks only the named fields, so nothing the database adds can ride along; any field out of shape fails the whole part.
const sourceRow = (s: unknown) => {
  if (!obj(s) || !source(s.source) || !instant(s.newest_upload_at) || !count(s.uploads_7d)) return null;
  const rejected = list(s.rejected_readings_7d, r => (obj(r) && reason(r.reason) && count(r.count) ? { reason: r.reason, count: r.count } : null));
  return rejected && { source: s.source, newest_upload_at: s.newest_upload_at, uploads_7d: s.uploads_7d, rejected_readings_7d: rejected };
};
const refusalRow = (r: unknown) => (obj(r) && code(r.code) && Number.isInteger(r.status) && (r.status as number) >= 400 && (r.status as number) <= 599 && count(r.count) && instant(r.newest_at)
  ? { code: r.code, status: r.status as number, count: r.count, newest_at: r.newest_at } : null);
const freshnessView = (v: unknown) => {
  if (!obj(v)) return null;
  const sources = list(v.sources, sourceRow), refusals = list(v.refusals_7d, refusalRow);
  const derived = v.newest_derived === null ? null : obj(v.newest_derived) && day(v.newest_derived.day) && instant(v.newest_derived.compiled_at)
    ? { day: v.newest_derived.day, compiled_at: v.newest_derived.compiled_at } : undefined;
  return sources && refusals && derived !== undefined ? { sources, refusals_7d: refusals, newest_derived: derived } : null;
};
const consentRow = (c: unknown) => obj(c) && source(c.source) && purpose(c.purpose) && status(c.status) && (c.granted_at === null || instant(c.granted_at)) && (c.withdrawn_at === null || instant(c.withdrawn_at))
  ? { source: c.source, purpose: c.purpose, status: c.status, granted_at: c.granted_at as string | null, withdrawn_at: c.withdrawn_at as string | null } : null;
const adminOwner = (o: unknown) => {
  if (!obj(o) || typeof o.id !== 'string' || !(o.email === null || typeof o.email === 'string') || typeof o.state !== 'string' || !instant(o.created_at)) return null;
  const consents = list(o.consents, consentRow), freshness = freshnessView(o.freshness);
  return consents && freshness && { id: o.id, email: o.email, state: o.state, created_at: o.created_at, consents, freshness };
};

// A fixed window per route, in the owner's own storage, counted before any database call.
const admitted = (kv: Kv, key: string, limit: number, now: number): boolean => {
  const counter = kv.get<{ start: number; count: number }>(key);
  const current = counter && now - counter.start < WINDOW_MS ? counter : { start: now, count: 0 };
  if (current.count >= limit) return false;
  kv.put(key, { start: current.start, count: current.count + 1 });
  return true;
};

const ownerRead = async ({ rpc, doName, now }: ConsoleHealthInput): Promise<Response> => {
  const read = (operation: string) => (rpc && doName ? invokeHealth(rpc, doName, operation, '{}') : Promise.resolve(null));
  const [scored, listed, fresh] = await Promise.all([read('scores_read'), read('consent_list'), read('freshness_read')]);
  const scores = healthScoresView(scored, null, now), consents = healthConsentView(listed, HEALTH_PROVIDER_REVISION_V1);
  // An error answer (not linked, unavailable) is no freshness to show; a freshness out of shape is a fault on our side.
  const freshness = obj(fresh) && 'freshness' in fresh ? freshnessView(fresh.freshness) : null;
  if (obj(fresh) && 'freshness' in fresh && !freshness) console.error('console health freshness shape');
  return reply({
    version: 1, as_of: new Date(now).toISOString(),
    scores: 'body' in scores ? scores.body : null,
    consents: 'body' in consents ? (consents.body as { consents: unknown[] }).consents : null,
    freshness,
  });
};

const adminRead = async ({ rpc, doName, now }: ConsoleHealthInput): Promise<Response> => {
  if (!rpc || !doName) return reply({ error: 'not_found' }, 404);
  let answer: unknown;
  try { answer = await rpc('admin_health_freshness', `admin_health.${doName}`, { p_do_name: doName }); }
  catch { return reply({ error: 'health_unavailable' }, 503); }
  if (answer === null) return reply({ error: 'not_found' }, 404);
  const owners = obj(answer) ? list(answer.owners, adminOwner) : null;
  if (!owners) {
    console.error('console admin health shape');
    return reply({ error: 'health_unavailable' }, 503);
  }
  return reply({ version: 1, as_of: new Date(now).toISOString(), owners });
};

export const consoleHealth = async (input: ConsoleHealthInput): Promise<Response> => {
  const url = new URL(input.request.url);
  const admin = url.pathname === DASHBOARD_ADMIN_HEALTH_PATH;
  if (input.request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  if (url.search) return reply({ error: 'invalid_query' }, 400);
  if (!admitted(input.kv, admin ? 'console:admin-health-rate' : 'console:health-rate', admin ? ADMIN_HEALTH_READ_LIMIT : HEALTH_READ_LIMIT, input.now)) {
    return reply({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  }
  return admin ? adminRead(input) : ownerRead(input);
};
