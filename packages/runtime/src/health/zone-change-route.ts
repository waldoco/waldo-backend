import { routerSignature } from '../identity/owner-directory';

// Worker-to-owner-DO only, two value-free health notices. "Today's derived row moved zone" carries the owner's local day;
// "this owner's readings changed" carries nothing. Neither carries a pillar, zone word or reading. The router signature
// binds the owner and the body; a replay marks a day already marked, or asks for a recompute that one already waiting covers.
export const HEALTH_ZONE_CHANGE_PATH = '/app/v1/internal/health-zone-change';
export const HEALTH_SAMPLES_PATH = '/app/v1/internal/health-samples';
const TIMEOUT_MS = 20_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type OwnerNamespace = Readonly<{ idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }>;
type Body = Readonly<Record<string, unknown>>;
// What the router signs for a notice: the owner and the notice's whole body. A body the notice does not take has none.
type Notice = Readonly<{ path: string; header: string; statement: (doName: string, body: Body) => string | null }>;

const ZONE_CHANGE: Notice = {
  path: HEALTH_ZONE_CHANGE_PATH, header: 'x-waldo-zone-sig',
  statement: (doName, { day, ...rest }) => (typeof day === 'string' && DAY.test(day) && Object.keys(rest).length === 0 ? `healthzone.${doName}.${day}` : null),
};
const SAMPLES: Notice = {
  path: HEALTH_SAMPLES_PATH, header: 'x-waldo-samples-sig',
  statement: (doName, body) => (Object.keys(body).length === 0 ? `healthsamples.${doName}` : null),
};

const send = async (notice: Notice, owners: OwnerNamespace, secret: string, doName: string, body: Body): Promise<void> => {
  const statement = notice.statement(doName, body);
  if (statement === null) throw new Error(`health notice not sent: ${notice.path}`);
  const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${notice.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waldo-do-name': doName, [notice.header]: await routerSignature(secret, 0, statement) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error(`health notice not taken: ${notice.path}`);
};

// The notice's body, once the request is proven to come from the Worker for this very object; null otherwise.
const verified = async (notice: Notice, request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<Body | null> => {
  const doName = request.headers.get('x-waldo-do-name') ?? '', given = request.headers.get(notice.header) ?? '';
  if (request.method !== 'POST' || !secret || !doName || !addressesThisObject(doName)) return null;
  let body: unknown;
  try { body = await request.json(); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const statement = notice.statement(doName, body as Body);
  if (statement === null) return null;
  const expected = new TextEncoder().encode(await routerSignature(secret, 0, statement)), supplied = new TextEncoder().encode(given);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (supplied[i] ?? 0);
  return diff === 0 ? body as Body : null;
};

export const notifyOwnerZoneChange = (owners: OwnerNamespace, secret: string, doName: string, day: string): Promise<void> => send(ZONE_CHANGE, owners, secret, doName, { day });
export const verifiedZoneChange = async (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<string | null> => {
  const body = await verified(ZONE_CHANGE, request, secret, addressesThisObject);
  return typeof body?.day === 'string' ? body.day : null;
};
export const notifyOwnerHealthSamples = (owners: OwnerNamespace, secret: string, doName: string): Promise<void> => send(SAMPLES, owners, secret, doName, {});
export const verifiedHealthSamples = async (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<boolean> =>
  (await verified(SAMPLES, request, secret, addressesThisObject)) !== null;
