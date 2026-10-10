import { fromRowZone } from '@waldo/contracts';
import {
  HEALTH_INGEST_MAX_REQUEST_BYTES_V1,
  healthApiErrorV1Schema, healthConsentChangeV1Schema, healthConsentGrantV1Schema, healthConsentListV1Schema, healthConsentWithdrawV1Schema,
  healthIngestReceiptV1Schema, healthIngestV1Schema, healthScoresQueryV1Schema, healthScoresResponseV1Schema, healthScoresUnavailableV1Schema,
} from '../../../contracts/src/app/health-ingest';
import { md5Hex } from './md5';

// The app's health routes. The Worker validates request shape against the app contract and signs a call that binds the
// operation, the owner and the digest of the exact payload it sends; the database owns consent, epochs, idempotency,
// revisions and retention. The owner always comes from the authenticated session, never from the request.
// The runtime does not depend on zod directly; a contract schema is used only through safeParse.
type ZodType<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type ErrorCode = (typeof healthApiErrorV1Schema.shape.error.options)[number];
export type AppHealthInput = Readonly<{
  request: Request; url: URL; doName: string; rpc: Rpc | null;
  readBody: (request: Request, max: number) => Promise<Uint8Array | null>;
}>;

export const APP_HEALTH_PATH = '/app/v1/health';
const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400, not_linked: 403, consent_required: 403, consent_withdrawn: 403,
  epoch_conflict: 409, idempotency_conflict: 409, anchor_conflict: 409, sample_conflict: 409, unavailable: 503,
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: ErrorCode, status: number = STATUS[error]) => reply({ error }, status);

// Zone names are validated by the contract, but the platform's zone database is the authority on what exists.
const knownZone = (zone: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; } };

const invoke = async (rpc: Rpc | null, doName: string, operation: string, payload: string): Promise<unknown> => {
  if (!rpc) return null;
  try { return await rpc(`health_${operation}`, `health.${operation}.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload }); } catch { return null; }
};

const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

// A database answer is either a closed error code or the success shape the contract declares; anything else is a
// fault on our side and never reaches the client as detail.
const failure = (result: unknown): Response | null => {
  const answer = asObject(result);
  if (!answer) return refuse('unavailable');
  if (!('error' in answer)) return null;
  const code = healthApiErrorV1Schema.shape.error.safeParse(answer.error);
  return refuse(code.success ? code.data : 'unavailable');
};
const settle = <T>(result: unknown, schema: ZodType<T>): Response => {
  const failed = failure(result);
  if (failed) return failed;
  const parsed = schema.safeParse(result);
  if (parsed.success) return reply(parsed.data as object);
  console.error('app health response shape');
  return refuse('unavailable');
};

const readJson = async <T>(request: Request, schema: ZodType<T>, readBody: AppHealthInput['readBody']): Promise<{ data: T } | { response: Response }> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { response: refuse('invalid_request') };
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > HEALTH_INGEST_MAX_REQUEST_BYTES_V1)) return { response: refuse('invalid_request', 413) };
  const bytes = await readBody(request, HEALTH_INGEST_MAX_REQUEST_BYTES_V1);
  if (!bytes) return { response: refuse('invalid_request', 413) };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return { response: refuse('invalid_request') }; }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { response: refuse('invalid_request') };
  // The request id is the idempotency key. A client may also send it as a header; the two must agree.
  const requestId = (parsed.data as { request_id?: string }).request_id;
  const key = request.headers.get('idempotency-key');
  if (key !== null && key !== requestId) return { response: refuse('invalid_request') };
  return { data: parsed.data };
};

type Pillar = 'recovery' | 'form' | 'weight';
// The stored read model holds one zone vocabulary; the contract uses words that carry their own direction. A stored
// 'unknown' is a score whose algorithm version has no ratified zone bands yet: it is shown without a zone word.
const pillarView = (pillar: Pillar, stored: unknown): object | null => {
  const row = asObject(stored);
  if (!row) return null;
  if (typeof row.reason === 'string') return { state: 'unavailable', reason: row.reason };
  const zone = row.zone === 'unknown' ? null : fromRowZone(pillar, row.zone);
  if (zone === null && row.zone !== 'unknown') return null;
  return {
    state: 'available', score: row.score, zone, algorithm_version: row.algorithm_version, activation: row.activation,
    confidence: row.confidence ?? null, hrv_method: row.hrv_method ?? null,
  };
};

const scores = async (input: AppHealthInput): Promise<Response> => {
  const { url, doName, rpc } = input;
  const unknown = [...url.searchParams.keys()].some(key => key !== 'day');
  const query = healthScoresQueryV1Schema.safeParse({ ...(url.searchParams.has('day') ? { day: url.searchParams.get('day') } : {}) });
  if (unknown || !query.success) return refuse('invalid_request');
  const day = query.data.day ?? null;
  // No row to show is an answer, not an error: a 200 that says why, never a zero score.
  const nothing = (reason: unknown): Response => {
    const body = healthScoresUnavailableV1Schema.safeParse({ state: 'unavailable', day, reason });
    if (body.success) return reply(body.data);
    console.error('app health scores reason');
    return refuse('unavailable');
  };
  const result = asObject(await invoke(rpc, doName, 'scores_read', JSON.stringify(query.data)));
  if (result?.error === 'not_linked') return nothing('not_linked');
  const failed = failure(result);
  if (failed) return failed;
  if (typeof result?.unavailable === 'string') return nothing(result.unavailable);
  const stored = asObject(result?.scores);
  const body = stored && {
    day: stored.day, timezone: stored.timezone, compiled_at: stored.compiled_at, freshness: stored.freshness,
    recovery: pillarView('recovery', stored.recovery), form: pillarView('form', stored.form), weight: pillarView('weight', stored.weight),
  };
  const parsed = healthScoresResponseV1Schema.safeParse(body);
  if (parsed.success) return reply(parsed.data);
  console.error('app health scores shape');
  return refuse('unavailable');
};

export const handleAppHealth = async (input: AppHealthInput): Promise<Response> => {
  const { request, url, doName, rpc, readBody } = input;
  const route = url.pathname.slice(APP_HEALTH_PATH.length);
  const writes: Readonly<Record<string, readonly [string, ZodType, ZodType]>> = {
    '/consents': ['consent_grant', healthConsentGrantV1Schema, healthConsentChangeV1Schema],
    '/consents/withdraw': ['consent_withdraw', healthConsentWithdrawV1Schema, healthConsentChangeV1Schema],
    '/ingest': ['ingest', healthIngestV1Schema, healthIngestReceiptV1Schema],
  };
  if (route === '/consents' && request.method === 'GET') return settle(await invoke(rpc, doName, 'consent_list', '{}'), healthConsentListV1Schema);
  if (route === '/scores') return request.method === 'GET' ? scores(input) : refuse('unavailable', 405);
  const write = writes[route];
  if (!write) return refuse('unavailable', 404);
  if (request.method !== 'POST') return refuse('unavailable', 405);
  const [operation, requestSchema, responseSchema] = write;
  const body = await readJson(request, requestSchema, readBody);
  if ('response' in body) return body.response;
  if (operation === 'ingest' && !knownZone((body.data as { timezone: string }).timezone)) return refuse('invalid_request');
  return settle(await invoke(rpc, doName, operation, JSON.stringify(body.data)), responseSchema);
};
