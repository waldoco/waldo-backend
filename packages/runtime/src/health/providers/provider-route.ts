import { md5Hex } from '../../channels/md5';
import { routerSignature } from '../../identity/owner-directory';
import type { WhoopOwner } from './whoop-owner';

// Worker-to-owner-DO only: the cloud-provider operations that need the owner's object (it holds the cursor and refreshes
// the tokens). The router signature binds the owner, the operation and the exact body, so a client request can never stand
// in for it and one operation's signature cannot be replayed as another.
export const HEALTH_PROVIDER_PATH = '/app/v1/internal/health-provider';
export const PROVIDER_OPS = ['connect', 'exchange', 'status', 'disconnect', 'hint'] as const;
export type ProviderOp = (typeof PROVIDER_OPS)[number];
const TIMEOUT_MS = 25_000;

const signature = (secret: string, doName: string, op: ProviderOp, body: string): Promise<string> => routerSignature(secret, 0, `healthprov.${doName}.${op}.${md5Hex(body)}`);

type OwnerNamespace = Readonly<{ idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }>;
export type ProviderAnswer = Readonly<{ status: number; json: Record<string, unknown> }>;

// The owner object's answer, or null when it could not be reached or did not answer in the expected shape.
export const callOwnerProvider = async (owners: OwnerNamespace, secret: string, doName: string, op: ProviderOp, body: Record<string, unknown>): Promise<ProviderAnswer | null> => {
  const text = JSON.stringify(body);
  try {
    const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${HEALTH_PROVIDER_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-waldo-do-name': doName, 'x-waldo-provider-op': op, 'x-waldo-provider-sig': await signature(secret, doName, op, text) },
      body: text, signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    const json: unknown = await response.json().catch(() => null);
    return json && typeof json === 'object' && !Array.isArray(json) ? { status: response.status, json: json as Record<string, unknown> } : null;
  } catch { return null; }
};

// The operation and its body, once the request is proven to come from the Worker for this very object; null otherwise.
export const verifiedProviderCall = async (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<Readonly<{ op: ProviderOp; body: Record<string, unknown> }> | null> => {
  const doName = request.headers.get('x-waldo-do-name') ?? '', given = request.headers.get('x-waldo-provider-sig') ?? '';
  const op = PROVIDER_OPS.find(candidate => candidate === request.headers.get('x-waldo-provider-op'));
  if (request.method !== 'POST' || !secret || !doName || !op || !addressesThisObject(doName)) return null;
  const text = await request.text().catch(() => null);
  if (text === null || text.length > 4_096) return null;
  const expected = new TextEncoder().encode(await signature(secret, doName, op, text)), supplied = new TextEncoder().encode(given);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (supplied[i] ?? 0);
  if (diff !== 0) return null;
  try { const body = JSON.parse(text); return body && typeof body === 'object' && !Array.isArray(body) ? { op, body } : null; } catch { return null; }
};

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

// What the owner object does for each operation. Answers carry codes and ids, never a token or a reading.
export const dispatchProviderCall = async (owner: WhoopOwner, op: ProviderOp, body: Record<string, unknown>): Promise<ProviderAnswer> => {
  if (op === 'connect') {
    const result = await owner.connect();
    if (!('error' in result)) return { status: 200, json: { provider: 'whoop', ...result } };
    if (result.error === 'consent_required') return { status: 403, json: { error: result.error, missing: result.missing } };
    return { status: 503, json: { error: result.error } };
  }
  if (op === 'exchange') return { status: 200, json: { outcome: await owner.exchange({ code: text(body.code, 2_048), denied: body.denied === true }) } };
  if (op === 'status') return { status: 200, json: { providers: [await owner.status()] } };
  if (op === 'disconnect') return { status: 200, json: { provider: 'whoop', state: 'not_connected', ...(await owner.disconnect()) } };
  const type = text(body.type, 64), id = text(body.id, 64), trace = text(body.trace, 64);
  return type && id && trace ? { status: 200, json: { result: await owner.hint({ type, id, trace }) } } : { status: 400, json: { error: 'invalid_request' } };
};
