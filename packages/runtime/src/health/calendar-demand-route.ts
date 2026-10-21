import { routerSignature } from '../identity/owner-directory';
import type { DemandRequest } from './calendar-demand';

// Worker-to-owner-DO only. The Worker forwards no client request to this path, and the router signature binds the
// owner and the exact range, so no other signed artifact can stand in for it.
export const CALENDAR_DEMAND_PATH = '/app/v1/internal/calendar-demand';
const TIMEOUT_MS = 20_000;

const signature = (secret: string, doName: string, { from, to, timezone }: DemandRequest): Promise<string> =>
  routerSignature(secret, 0, `calendardemand.${doName}.${from}.${to}.${timezone}`);

type OwnerNamespace = Readonly<{ idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }>;

// The answer is whatever the DO returned; the producer parses it and treats anything else as no calendar demand.
export const readOwnerDemand = async (owners: OwnerNamespace, secret: string, doName: string, range: DemandRequest): Promise<unknown> => {
  const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${CALENDAR_DEMAND_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waldo-do-name': doName, 'x-waldo-demand-sig': await signature(secret, doName, range) },
    body: JSON.stringify(range),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error('calendar demand unavailable');
  return response.json();
};

// The range, once the request is proven to come from the Worker for this very object; null otherwise.
export const verifiedDemandRequest = async (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<DemandRequest | null> => {
  const doName = request.headers.get('x-waldo-do-name') ?? '', given = request.headers.get('x-waldo-demand-sig') ?? '';
  if (request.method !== 'POST' || !secret || !doName || !addressesThisObject(doName)) return null;
  let body: unknown;
  try { body = await request.json(); } catch { return null; }
  const { from, to, timezone } = (body ?? {}) as Record<string, unknown>;
  if (typeof from !== 'string' || typeof to !== 'string' || typeof timezone !== 'string') return null;
  const range = { from, to, timezone };
  const expected = new TextEncoder().encode(await signature(secret, doName, range)), supplied = new TextEncoder().encode(given);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (supplied[i] ?? 0);
  return diff === 0 ? range : null;
};
