import {
  SCREEN_TIME_MAX_REQUEST_BYTES_V1, screenTimeApiErrorV1Schema, screenTimeConsentChangeV1Schema, screenTimeConsentGrantV1Schema, screenTimeConsentListV1Schema,
  screenTimeConsentWithdrawV1Schema, screenTimeDaysQueryV1Schema, screenTimeDaysV1Schema, screenTimeIngestReceiptV1Schema, screenTimeIngestV1Schema, screenTimeStoredDayV1Schema,
} from '../../../contracts/src/app/screen-time';
import { md5Hex } from './md5';

// The app's screen-time routes. The Worker checks each body against the app contract and signs a call that binds the operation, the
// owner and the digest of the exact payload; the database owns consent, epochs, idempotency, the day window and retention. The owner
// comes from the authenticated session, never from the request. Nothing here logs a summary or a number from one.
type ZodType<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type ErrorCode = (typeof screenTimeApiErrorV1Schema.shape.error.options)[number];
export type AppScreenTimeInput = Readonly<{
  request: Request; url: URL; doName: string; rpc: Rpc | null;
  readBody: (request: Request, max: number) => Promise<Uint8Array | null>;
}>;

export const APP_SCREEN_TIME_PATH = '/app/v1/screen-time';
const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400, not_linked: 403, consent_required: 403, consent_withdrawn: 403, epoch_conflict: 409, idempotency_conflict: 409, unavailable: 503,
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: ErrorCode, status: number = STATUS[error]) => reply({ error }, status);

export const invokeScreenTime = async (rpc: Rpc | null, doName: string, operation: string, payload: string): Promise<unknown> => {
  if (!rpc) return null;
  try { return await rpc(`screen_time_${operation}`, `screen_time.${operation}.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload }); } catch { return null; }
};

// A database answer is a closed error code or the success shape the contract declares; anything else is a fault on our side.
const settle = <T>(result: unknown, schema: ZodType<T>, tag: string): Response => {
  if (!result || typeof result !== 'object') return refuse('unavailable');
  if ('error' in result) {
    const code = screenTimeApiErrorV1Schema.shape.error.safeParse((result as { error: unknown }).error);
    return refuse(code.success ? code.data : 'unavailable');
  }
  const parsed = schema.safeParse(result);
  if (parsed.success) return reply(parsed.data as object);
  console.error(`app screen time ${tag} shape`);
  return refuse('unavailable');
};

const readJson = async <T>(request: Request, schema: ZodType<T>, readBody: AppScreenTimeInput['readBody']): Promise<{ data: T } | { response: Response }> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { response: refuse('invalid_request') };
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > SCREEN_TIME_MAX_REQUEST_BYTES_V1)) return { response: refuse('invalid_request', 413) };
  const bytes = await readBody(request, SCREEN_TIME_MAX_REQUEST_BYTES_V1);
  if (!bytes) return { response: refuse('invalid_request', 413) };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return { response: refuse('invalid_request') }; }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { response: refuse('invalid_request') };
  // The request id is the idempotency key. A client may also send it as a header; the two must agree.
  const key = request.headers.get('idempotency-key');
  if (key !== null && key !== (parsed.data as { request_id?: string }).request_id) return { response: refuse('invalid_request') };
  return { data: parsed.data };
};

const WRITES: Readonly<Record<string, Readonly<{ operation: string; schema: ZodType; response: ZodType }>>> = {
  '/consents': { operation: 'consent_grant', schema: screenTimeConsentGrantV1Schema, response: screenTimeConsentChangeV1Schema },
  '/consents/withdraw': { operation: 'consent_withdraw', schema: screenTimeConsentWithdrawV1Schema, response: screenTimeConsentChangeV1Schema },
  '/days': { operation: 'ingest', schema: screenTimeIngestV1Schema, response: screenTimeIngestReceiptV1Schema },
};

// The owner's own view of what was kept. A stored day that no longer reads as the contract's is left out with a tag that holds no
// value, so one damaged row never costs the owner the rest.
const days = async ({ url, rpc, doName }: AppScreenTimeInput): Promise<Response> => {
  const query = screenTimeDaysQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return refuse('invalid_request');
  const result = await invokeScreenTime(rpc, doName, 'days_read', JSON.stringify({ from: query.data.from, to: query.data.to, purpose: 'owner' }));
  const rows = (result as { days?: unknown } | null)?.days;
  if (!Array.isArray(rows)) return settle(result, screenTimeDaysV1Schema, 'days');
  const kept = rows.flatMap(row => {
    const { device_id, received_at, summary } = (row ?? {}) as Record<string, unknown>;
    const parsed = screenTimeStoredDayV1Schema.safeParse({ device_id, received_at, summary });
    if (!parsed.success) console.error('app screen time stored day shape');
    return parsed.success ? [parsed.data] : [];
  });
  return settle({ days: kept }, screenTimeDaysV1Schema, 'days');
};

export const handleAppScreenTime = async (input: AppScreenTimeInput): Promise<Response> => {
  const { request, url, doName, rpc } = input;
  const route = url.pathname.slice(APP_SCREEN_TIME_PATH.length);
  if (route === '/consents' && request.method === 'GET') return settle(await invokeScreenTime(rpc, doName, 'consent_list', '{}'), screenTimeConsentListV1Schema, 'consents');
  if (route === '/days' && request.method === 'GET') return days(input);
  const write = WRITES[route];
  if (!write) return refuse('unavailable', 404);
  if (request.method !== 'POST') return refuse('unavailable', 405);
  const body = await readJson(request, write.schema, input.readBody);
  if ('response' in body) return body.response;
  return settle(await invokeScreenTime(rpc, doName, write.operation, JSON.stringify(body.data)), write.response, write.operation);
};
