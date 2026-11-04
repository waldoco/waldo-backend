import {
  CYCLE_MAX_REQUEST_BYTES_V1, cycleApiErrorV1Schema, cycleConsentChangeV1Schema, cycleConsentGrantV1Schema, cycleConsentListV1Schema, cycleConsentWithdrawV1Schema,
  cycleIngestReceiptV1Schema, cycleIngestV1Schema, cycleStatusV1Schema,
} from '../../../contracts/src/app/cycle';
import { md5Hex } from './md5';

// The app's cycle routes. The Worker checks each body against the app contract and signs a call that binds the operation, the
// owner and the digest of the exact payload; the database owns consent, epochs, idempotency, the window replacement and
// retention. The owner comes from the authenticated session, never from the request. Nothing here logs a date, a phase or a
// source name.
type ZodType<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type ErrorCode = (typeof cycleApiErrorV1Schema.shape.error.options)[number];
export type AppCycleInput = Readonly<{
  request: Request; url: URL; doName: string; rpc: Rpc | null;
  readBody: (request: Request, max: number) => Promise<Uint8Array | null>;
}>;

export const APP_CYCLE_PATH = '/app/v1/cycle';
const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400, not_linked: 403, consent_required: 403, consent_withdrawn: 403, epoch_conflict: 409, idempotency_conflict: 409, unavailable: 503,
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: ErrorCode, status: number = STATUS[error]) => reply({ error }, status);

export const invokeCycle = async (rpc: Rpc | null, doName: string, operation: string, payload: string): Promise<unknown> => {
  if (!rpc) return null;
  try { return await rpc(`cycle_${operation}`, `cycle.${operation}.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload }); } catch { return null; }
};

// A database answer is a closed error code or the success shape the contract declares; anything else is a fault on our side.
const settle = <T>(result: unknown, schema: ZodType<T>, tag: string): Response => {
  if (!result || typeof result !== 'object') return refuse('unavailable');
  if ('error' in result) {
    const code = cycleApiErrorV1Schema.shape.error.safeParse((result as { error: unknown }).error);
    return refuse(code.success ? code.data : 'unavailable');
  }
  const parsed = schema.safeParse(result);
  if (parsed.success) return reply(parsed.data as object);
  console.error(`app cycle ${tag} shape`);
  return refuse('unavailable');
};

const readJson = async <T>(request: Request, schema: ZodType<T>, readBody: AppCycleInput['readBody']): Promise<{ data: T } | { response: Response }> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { response: refuse('invalid_request') };
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > CYCLE_MAX_REQUEST_BYTES_V1)) return { response: refuse('invalid_request', 413) };
  const bytes = await readBody(request, CYCLE_MAX_REQUEST_BYTES_V1);
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

const READS: Readonly<Record<string, Readonly<{ operation: string; response: ZodType }>>> = {
  '/consents': { operation: 'consent_list', response: cycleConsentListV1Schema },
  '/status': { operation: 'status_read', response: cycleStatusV1Schema },
};
const WRITES: Readonly<Record<string, Readonly<{ operation: string; schema: ZodType; response: ZodType }>>> = {
  '/consents': { operation: 'consent_grant', schema: cycleConsentGrantV1Schema, response: cycleConsentChangeV1Schema },
  '/consents/withdraw': { operation: 'consent_withdraw', schema: cycleConsentWithdrawV1Schema, response: cycleConsentChangeV1Schema },
  '/periods': { operation: 'ingest', schema: cycleIngestV1Schema, response: cycleIngestReceiptV1Schema },
};

export const handleAppCycle = async (input: AppCycleInput): Promise<Response> => {
  const { request, url, doName, rpc } = input;
  const route = url.pathname.slice(APP_CYCLE_PATH.length);
  const read = READS[route];
  if (read && request.method === 'GET') {
    if ([...url.searchParams.keys()].length) return refuse('invalid_request');
    return settle(await invokeCycle(rpc, doName, read.operation, '{}'), read.response, read.operation);
  }
  const write = WRITES[route];
  if (!write) return refuse('unavailable', read ? 405 : 404);
  if (request.method !== 'POST') return refuse('unavailable', 405);
  const body = await readJson(request, write.schema, input.readBody);
  if ('response' in body) return body.response;
  return settle(await invokeCycle(rpc, doName, write.operation, JSON.stringify(body.data)), write.response, write.operation);
};
