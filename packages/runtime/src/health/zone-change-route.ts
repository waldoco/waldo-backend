import { routerSignature } from '../identity/owner-directory';

// Worker-to-owner-DO only, two value-free health notices. "Today's derived row moved zone" carries the owner's local day;
// "this owner's readings changed" carries the zone the batch was read in. Neither carries a pillar, zone word or reading.
// The router signature binds the owner and the body; a replay marks a day already marked, or asks for a recompute that
// one already waiting covers.
export const HEALTH_ZONE_CHANGE_PATH = '/app/v1/internal/health-zone-change';
export const HEALTH_SAMPLES_PATH = '/app/v1/internal/health-samples';
const TIMEOUT_MS = 20_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type OwnerNamespace = Readonly<{ idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }>;
type Notice = Readonly<{ path: string; header: string; signed: (doName: string, value: string) => string; field: string; valid: (value: string) => boolean }>;

const ZONE_CHANGE: Notice = { path: HEALTH_ZONE_CHANGE_PATH, header: 'x-waldo-zone-sig', signed: (doName, day) => `healthzone.${doName}.${day}`, field: 'day', valid: day => DAY.test(day) };
const SAMPLES: Notice = {
  path: HEALTH_SAMPLES_PATH, header: 'x-waldo-samples-sig', signed: (doName, timezone) => `healthsamples.${doName}.${timezone}`, field: 'timezone',
  valid: timezone => { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return timezone.length <= 64; } catch { return false; } },
};

const send = async (notice: Notice, owners: OwnerNamespace, secret: string, doName: string, value: string): Promise<void> => {
  const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${notice.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waldo-do-name': doName, [notice.header]: await routerSignature(secret, 0, notice.signed(doName, value)) },
    body: JSON.stringify({ [notice.field]: value }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error(`health notice not taken: ${notice.field}`);
};

// The notice's one value, once the request is proven to come from the Worker for this very object; null otherwise.
const verified = async (notice: Notice, request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<string | null> => {
  const doName = request.headers.get('x-waldo-do-name') ?? '', given = request.headers.get(notice.header) ?? '';
  if (request.method !== 'POST' || !secret || !doName || !addressesThisObject(doName)) return null;
  let body: unknown;
  try { body = await request.json(); } catch { return null; }
  const fields = (body ?? {}) as Record<string, unknown>, value = fields[notice.field];
  if (typeof value !== 'string' || !notice.valid(value) || Object.keys(fields).length !== 1) return null;
  const expected = new TextEncoder().encode(await routerSignature(secret, 0, notice.signed(doName, value))), supplied = new TextEncoder().encode(given);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (supplied[i] ?? 0);
  return diff === 0 ? value : null;
};

export const notifyOwnerZoneChange = (owners: OwnerNamespace, secret: string, doName: string, day: string): Promise<void> => send(ZONE_CHANGE, owners, secret, doName, day);
export const verifiedZoneChange = (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<string | null> =>
  verified(ZONE_CHANGE, request, secret, addressesThisObject);
export const notifyOwnerHealthSamples = (owners: OwnerNamespace, secret: string, doName: string, timezone: string): Promise<void> => send(SAMPLES, owners, secret, doName, timezone);
export const verifiedHealthSamples = (request: Request, secret: string | undefined, addressesThisObject: (doName: string) => boolean): Promise<string | null> =>
  verified(SAMPLES, request, secret, addressesThisObject);
