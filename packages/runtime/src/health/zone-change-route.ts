import { routerSignature } from '../identity/owner-directory';

// Worker-to-owner-DO only: "today's derived row moved zone" for one owner. The body is the owner's local day and nothing
// else, so no pillar, zone or reading crosses it. The router signature binds the owner and the day; a replay only marks a
// day that is already marked.
export const HEALTH_ZONE_CHANGE_PATH = '/app/v1/internal/health-zone-change';
const TIMEOUT_MS = 20_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const signature = (secret: string, doName: string, day: string): Promise<string> => routerSignature(secret, 0, `healthzone.${doName}.${day}`);

type OwnerNamespace = Readonly<{ idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }>;

export const notifyOwnerZoneChange = async (owners: OwnerNamespace, secret: string, doName: string, day: string): Promise<void> => {
  const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${HEALTH_ZONE_CHANGE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waldo-do-name': doName, 'x-waldo-zone-sig': await signature(secret, doName, day) },
    body: JSON.stringify({ day }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error('health zone change not taken');
};

// The day, once the request is proven to come from the Worker for this very object; null otherwise.
export const verifiedZoneChange = async (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<string | null> => {
  const doName = request.headers.get('x-waldo-do-name') ?? '', given = request.headers.get('x-waldo-zone-sig') ?? '';
  if (request.method !== 'POST' || !secret || !doName || !addressesThisObject(doName)) return null;
  let body: unknown;
  try { body = await request.json(); } catch { return null; }
  const day = (body ?? {}) as Record<string, unknown>;
  if (typeof day.day !== 'string' || !DAY.test(day.day) || Object.keys(day).length !== 1) return null;
  const expected = new TextEncoder().encode(await signature(secret, doName, day.day)), supplied = new TextEncoder().encode(given);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (supplied[i] ?? 0);
  return diff === 0 ? day.day : null;
};
