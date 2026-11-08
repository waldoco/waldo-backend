import { z } from 'zod';

// Device context: what the owner's phone tells Waldo about the owner's surroundings, one consent per signal. The first signal is
// place: the latest time zone and coarse place per device, so the agent can know the owner's city and zone, and later the weather
// there. The design is the device-context ADR (docs/proposals/ADR_DEVICE_CONTEXT_2026-11-05.md).
//
// - The owner sees one place consent; the server keeps three purposes so each can be withdrawn alone: storage_compute (keep it),
//   model_processing (let Waldo's AI read it) and provider_lookup (send the cell's centre, with no owner or device id, to the
//   weather provider the consent names). The last two sit on top of storage. The server owns status and epoch; an unknown state
//   reads as not granted.
// - Withdrawing storage_compute withdraws all three and deletes every stored place and upload receipt.
// - Coarse is a schema rule: the phone rounds to a 5-character geohash cell (about 4.9 km square) before sending. There is no
//   latitude or longitude field, so the server never holds anything finer.
// - The phone sends its time zone on every wake, with or without a cell; an upload with no cell leaves the last cell in place.
// - What is kept: the latest zone and place per device, overwritten, never a history. Nothing observed more than 30 days ago is
//   accepted, read back or kept: the cell ages by its own time even while daily zone uploads keep the row. Account deletion
//   removes it with the owner.
// - Egress: the cell never reaches the model or a log; the place name and time zone reach the owner's model context in the turn
//   that asked, and the owner's own read-back.

export const DEVICE_CONTEXT_CONSENT_VERSION_V1 = 1;
export const DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 = 4_096;
export const DEVICE_PLACE_MAX_DEVICES_V1 = 8;

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,96}$/);
const epoch = z.int().min(0).max(999_999_999);
const instant = z.iso.datetime();
const line = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*$/);

export const deviceContextSignalV1Schema = z.enum(['place']);
export const deviceContextPurposeV1Schema = z.enum(['storage_compute', 'model_processing', 'provider_lookup']);
export const deviceContextConsentV1Schema = z.strictObject({
  signal: deviceContextSignalV1Schema,
  purpose: deviceContextPurposeV1Schema,
  version: z.int().positive(),
  status: z.enum(['not_granted', 'granted', 'withdrawn']),
  epoch,
  granted_at: instant.nullable(),
  withdrawn_at: instant.nullable(),
});
export const deviceContextConsentListV1Schema = z.strictObject({
  consents: z.array(deviceContextConsentV1Schema).max(deviceContextSignalV1Schema.options.length * deviceContextPurposeV1Schema.options.length),
});
export const deviceContextConsentGrantV1Schema = z.strictObject({
  request_id: requestId, signal: deviceContextSignalV1Schema, purpose: deviceContextPurposeV1Schema,
  version: z.literal(DEVICE_CONTEXT_CONSENT_VERSION_V1), expected_epoch: epoch,
});
export const deviceContextConsentWithdrawV1Schema = z.strictObject({
  request_id: requestId, signal: deviceContextSignalV1Schema, purpose: deviceContextPurposeV1Schema, expected_epoch: epoch,
});
// deletion_routed: what the signal kept was deleted by this withdrawal.
export const deviceContextConsentChangeV1Schema = z.strictObject({ consent: deviceContextConsentV1Schema, replayed: z.boolean(), deletion_routed: z.boolean() });
// The one consent screen in one call: each purpose at the epoch the app last read for it, granted storage first and all or none.
// The answer lists the purposes in that order. A purpose already granted, sent at its current epoch, is answered as it stands,
// so a retry after re-reading the epochs succeeds; a stale epoch on any purpose refuses the whole call with epoch_conflict.
// Withdrawals stay one purpose at a time.
export const deviceContextConsentGrantBatchV1Schema = z.strictObject({
  request_id: requestId, signal: deviceContextSignalV1Schema, version: z.literal(DEVICE_CONTEXT_CONSENT_VERSION_V1),
  purposes: z.array(z.strictObject({ purpose: deviceContextPurposeV1Schema, expected_epoch: epoch }))
    .min(1).max(deviceContextPurposeV1Schema.options.length)
    .refine(items => new Set(items.map(item => item.purpose)).size === items.length, { error: 'each purpose once' }),
});
export const deviceContextConsentBatchV1Schema = z.strictObject({
  consents: z.array(deviceContextConsentV1Schema).min(1).max(deviceContextPurposeV1Schema.options.length),
  replayed: z.boolean(),
});

// A geohash cell of exactly 5 characters in the geohash alphabet (no a, i, l or o).
export const placeCellV1Schema = z.string().regex(/^[0-9b-hjkmnp-z]{5}$/);
const timezone = z.string().min(1).max(64);
// The OS's names for the cell, never a way to carry a position: no decimal number and no degree sign in either, and at most four
// digits across locality and region together ("Sector 128" fits, "12.97,77.59" does not). Digits are any script's decimal
// digits, so a coordinate in Devanagari or fullwidth digits counts the same. The database checks the same.
const placeName = line(80).refine(name => !/\p{Nd}\s*[.,\u00B7\u066B\u066C\uFF0C\uFF0E]\s*\p{Nd}|[\u00B0\u00BA\u02DA]/u.test(name),
  { error: 'a place name carries no position' });
const digits = (name: string | undefined) => (name ?? '').match(/\p{Nd}/gu)?.length ?? 0;
const namesCarryNoPosition = (place: { locality?: string; region?: string } | null) => !place || digits(place.locality) + digits(place.region) <= 4;
const platform = z.enum(['ios', 'android']);
// One reading from the phone: always its time zone, and the cell when the app is open with location allowed. The names are the
// phone's own OS's for that cell, so they come only with it; a phone that cannot name the place still sends the cell.
export const devicePlaceV1Schema = z.strictObject({
  cell: placeCellV1Schema.optional(),
  locality: placeName.optional(),
  region: placeName.optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  timezone,
  platform,
  observed_at: instant,
}).refine(reading => reading.cell !== undefined || [reading.locality, reading.region, reading.country].every(name => name === undefined),
  { error: 'a place name comes only with its cell', path: ['cell'] })
  .refine(namesCarryNoPosition, { error: 'a place name carries no position', path: ['locality'] });

// The zone, and the cell when sent, replace the earlier ones from the same device, each unless the earlier one was observed later;
// an upload that changes neither is answered superseded.
// expected_epoch is the storage_compute epoch the phone read with consent; an upload from before a withdrawal is refused, so it
// cannot repopulate what was deleted. device_id is the app installation id the push registration uses. A reading observed more
// than 30 days ago is refused. A refused reading keeps nothing, its zone included: an app whose OS names fail the place-name
// rule (a 400 invalid_request) sends the same reading again without locality and region.
// arrived: the phone just reached a place the owner named on it (device-context ADR §9). The phone keeps those places and their
// positions; only the word travels, and it is never stored. A backend from before §9 refuses the key, so the app sends it only to
// one that has it.
export const DEVICE_ARRIVAL_PLACES_V1 = ['home', 'gym'] as const;
export const devicePlaceIngestV1Schema = z.strictObject({
  request_id: requestId,
  expected_epoch: epoch,
  device_id: z.uuid(),
  place: devicePlaceV1Schema,
  arrived: z.enum(DEVICE_ARRIVAL_PLACES_V1).optional(),
});
export const devicePlaceIngestReceiptV1Schema = z.strictObject({
  request_id: requestId,
  replayed: z.boolean(),
  status: z.enum(['accepted', 'superseded']),
});

// What Waldo kept, for the owner's own view. Needs storage consent only. place is null until the phone has sent a cell, and again
// once that cell is more than 30 days old; a phone whose zone is that old is left out.
export const devicePlaceStoredV1Schema = z.strictObject({
  device_id: z.uuid(),
  received_at: instant,
  platform,
  timezone,
  timezone_observed_at: instant,
  place: z.strictObject({
    cell: placeCellV1Schema,
    locality: placeName.optional(),
    region: placeName.optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    observed_at: instant,
  }).refine(namesCarryNoPosition, { error: 'a place name carries no position', path: ['locality'] }).nullable(),
});
export const devicePlacesV1Schema = z.strictObject({ places: z.array(devicePlaceStoredV1Schema).max(DEVICE_PLACE_MAX_DEVICES_V1) });

// The runtime may attach a short message; a client acts on `error` only.
export const deviceContextApiErrorV1Schema = z.strictObject({
  error: z.enum(['invalid_request', 'not_linked', 'consent_required', 'consent_withdrawn', 'epoch_conflict', 'idempotency_conflict', 'unavailable']),
  message: z.string().max(1000).optional(),
});

// A Worker with DEVICE_PLACE off answers 404 on every route.
export const appDeviceContextRoutesV1 = [
  { method: 'GET', path: '/app/v1/device-context/consents', response: deviceContextConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/device-context/consents', request: deviceContextConsentGrantV1Schema, response: deviceContextConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/device-context/consents/batch', request: deviceContextConsentGrantBatchV1Schema, response: deviceContextConsentBatchV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/device-context/consents/withdraw', request: deviceContextConsentWithdrawV1Schema, response: deviceContextConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/device-context/place', request: devicePlaceIngestV1Schema, response: devicePlaceIngestReceiptV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/device-context/place', response: devicePlacesV1Schema, authenticated: true, success_status: 200 },
] as const;

export type DevicePlaceV1 = z.infer<typeof devicePlaceV1Schema>;
export type DevicePlaceIngestV1 = z.infer<typeof devicePlaceIngestV1Schema>;
export type DeviceContextConsentV1 = z.infer<typeof deviceContextConsentV1Schema>;
