import {
  DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1, deviceContextApiErrorV1Schema, deviceContextConsentChangeV1Schema, deviceContextConsentGrantV1Schema,
  deviceContextConsentListV1Schema, deviceContextConsentWithdrawV1Schema, devicePlaceIngestReceiptV1Schema, devicePlaceIngestV1Schema,
  devicePlaceStoredV1Schema, devicePlacesV1Schema,
} from '../../../contracts/src/app/device-context';
import { md5Hex } from './md5';

// The app's device-context routes, first signal place. The Worker checks each body against the app contract, so nothing finer
// than the contract's coarse cell is ever forwarded, and signs a call that binds the operation, the owner and the digest of the
// exact payload; the database owns consent, epochs, idempotency and retention. The owner comes from the authenticated session,
// never from the request. Nothing here logs a cell, a place name or a time zone.
type ZodType<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type ErrorCode = (typeof deviceContextApiErrorV1Schema.shape.error.options)[number];
export type AppDeviceContextInput = Readonly<{
  request: Request; url: URL; doName: string; rpc: Rpc | null;
  readBody: (request: Request, max: number) => Promise<Uint8Array | null>;
}>;

export const APP_DEVICE_CONTEXT_PATH = '/app/v1/device-context';
const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400, not_linked: 403, consent_required: 403, consent_withdrawn: 403, epoch_conflict: 409, idempotency_conflict: 409, unavailable: 503,
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: ErrorCode, status: number = STATUS[error]) => reply({ error }, status);

export const invokeDeviceContext = async (rpc: Rpc | null, doName: string, operation: string, payload: string): Promise<unknown> => {
  if (!rpc) return null;
  try { return await rpc(`device_context_${operation}`, `device_context.${operation}.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload }); } catch { return null; }
};

// A database answer is a closed error code or the success shape the contract declares; anything else is a fault on our side.
const settle = <T>(result: unknown, schema: ZodType<T>, tag: string): Response => {
  if (!result || typeof result !== 'object') return refuse('unavailable');
  if ('error' in result) {
    const code = deviceContextApiErrorV1Schema.shape.error.safeParse((result as { error: unknown }).error);
    return refuse(code.success ? code.data : 'unavailable');
  }
  const parsed = schema.safeParse(result);
  if (parsed.success) return reply(parsed.data as object);
  console.error(`app device context ${tag} shape`);
  return refuse('unavailable');
};

const readJson = async <T>(request: Request, schema: ZodType<T>, readBody: AppDeviceContextInput['readBody']): Promise<{ data: T } | { response: Response }> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { response: refuse('invalid_request') };
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1)) return { response: refuse('invalid_request', 413) };
  const bytes = await readBody(request, DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1);
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
  '/consents': { operation: 'consent_grant', schema: deviceContextConsentGrantV1Schema, response: deviceContextConsentChangeV1Schema },
  '/consents/withdraw': { operation: 'consent_withdraw', schema: deviceContextConsentWithdrawV1Schema, response: deviceContextConsentChangeV1Schema },
  '/place': { operation: 'place_ingest', schema: devicePlaceIngestV1Schema, response: devicePlaceIngestReceiptV1Schema },
};

// The owner's own view of what was kept. A stored place that no longer reads as the contract's is left out with a tag that holds
// no value, so one damaged row never costs the owner the rest.
const places = async ({ rpc, doName }: AppDeviceContextInput): Promise<Response> => {
  const result = await invokeDeviceContext(rpc, doName, 'place_read', JSON.stringify({ purpose: 'owner' }));
  const rows = (result as { places?: unknown } | null)?.places;
  if (!Array.isArray(rows)) return settle(result, devicePlacesV1Schema, 'places');
  const kept = rows.flatMap(row => {
    const { device_id, received_at, place } = (row ?? {}) as Record<string, unknown>;
    const parsed = devicePlaceStoredV1Schema.safeParse({ device_id, received_at, place });
    if (!parsed.success) console.error('app device context stored place shape');
    return parsed.success ? [parsed.data] : [];
  });
  return settle({ places: kept }, devicePlacesV1Schema, 'places');
};

export const handleAppDeviceContext = async (input: AppDeviceContextInput): Promise<Response> => {
  const { request, url, doName, rpc } = input;
  const route = url.pathname.slice(APP_DEVICE_CONTEXT_PATH.length);
  if (route === '/consents' && request.method === 'GET') return settle(await invokeDeviceContext(rpc, doName, 'consent_list', '{}'), deviceContextConsentListV1Schema, 'consents');
  if (route === '/place' && request.method === 'GET') return places(input);
  const write = WRITES[route];
  if (!write) return refuse('unavailable', 404);
  if (request.method !== 'POST') return refuse('unavailable', 405);
  const body = await readJson(request, write.schema, input.readBody);
  if ('response' in body) return body.response;
  return settle(await invokeDeviceContext(rpc, doName, write.operation, JSON.stringify(body.data)), write.response, write.operation);
};
