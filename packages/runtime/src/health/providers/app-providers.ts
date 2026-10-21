import { appContractRevision, APP_CONTRACT_HEADER } from '../../../../contracts/src/app/core';
import {
  healthProviderConnectResultV1Schema, healthProviderConnectV1Schema, healthProviderDisconnectResultV1Schema, healthProviderDisconnectV1Schema,
  healthProviderListV1Schema, type healthProviderErrorV1Schema,
} from '../../../../contracts/src/app/health-providers';
import { HEALTH_PROVIDER_REVISION_V1 } from '../../../../contracts/src/app/health-ingest';
import { callOwnerProvider } from './provider-route';

// The app's provider routes. The Worker checks the request against the app contract and the owner object does the work:
// it holds the connection's cursor and refreshes its tokens. The owner always comes from the authenticated session.
type ZodType<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type OwnerNamespace = Parameters<typeof callOwnerProvider>[0];
type ErrorCode = ReturnType<typeof healthProviderErrorV1Schema.parse>['error'];
export const APP_PROVIDERS_PATH = '/app/v1/health/providers';
const MAX_BODY = 1_024;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const refuse = (error: ErrorCode, status: number) => reply({ error }, status);

const readJson = async <T>(request: Request, schema: ZodType<T>): Promise<T | null> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  // The request id is the idempotency key. A client may also send it as a header; the two must agree.
  const key = request.headers.get('idempotency-key');
  return key !== null && key !== (parsed.data as { request_id?: string }).request_id ? null : parsed.data;
};

export const handleAppHealthProviders = async (input: Readonly<{ request: Request; url: URL; doName: string; owners: OwnerNamespace; secret: string | undefined }>): Promise<Response> => {
  const { request, url, doName, owners, secret } = input;
  const route = url.pathname.slice(APP_PROVIDERS_PATH.length);
  // A build that does not name health revision 2 has no providers to show or start.
  if (appContractRevision(request.headers.get(APP_CONTRACT_HEADER), 'health') < HEALTH_PROVIDER_REVISION_V1) return refuse('invalid_request', 404);
  if (!secret) return refuse('not_configured', 503);
  const settle = async (op: 'status' | 'connect' | 'disconnect', body: Record<string, unknown>, schema: ZodType): Promise<Response> => {
    const answer = await callOwnerProvider(owners, secret, doName, op, body);
    if (!answer) return refuse('unavailable', 503);
    if (answer.status !== 200) {
      const code = answer.json.error;
      return code === 'consent_required' ? refuse('consent_required', 403) : code === 'not_configured' ? refuse('not_configured', 503) : refuse('unavailable', 503);
    }
    const parsed = schema.safeParse(answer.json);
    if (parsed.success) return reply(parsed.data as object);
    console.error('app health provider response shape');
    return refuse('unavailable', 503);
  };
  if (route === '') return request.method === 'GET' && [...url.searchParams.keys()].length === 0 ? settle('status', {}, healthProviderListV1Schema) : refuse('invalid_request', 405);
  if (route !== '/connect' && route !== '/disconnect') return refuse('invalid_request', 404);
  if (request.method !== 'POST') return refuse('invalid_request', 405);
  if (route === '/connect') return await readJson(request, healthProviderConnectV1Schema) ? settle('connect', {}, healthProviderConnectResultV1Schema) : refuse('invalid_request', 400);
  return await readJson(request, healthProviderDisconnectV1Schema) ? settle('disconnect', {}, healthProviderDisconnectResultV1Schema) : refuse('invalid_request', 400);
};
