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

export const deviceContextSignalV1Schema = z.enum(['place', 'calendar']);
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
  consents: z.array(deviceContextConsentV1Schema).max(deviceContextSignalV1Schema.options.length * deviceContextPurposeV1Schema.options.length)
    .refine(rows => new Set(rows.map(row => `${row.signal}.${row.purpose}`)).size === rows.length, { error: 'one row per signal and purpose' }),
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
export const devicePlaceIngestV1Schema = z.strictObject({
  request_id: requestId,
  expected_epoch: epoch,
  device_id: z.uuid(),
  place: devicePlaceV1Schema,
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

// A Worker with DEVICE_PLACE off answers 404 on every route. These routes serve place only: a calendar consent sent here is
// refused invalid_request, and the list never names calendar, so a build that reads place alone keeps parsing it.
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

// Device calendar: the events on the owner's phone, so Waldo sees the calendars it has no account for (a work Outlook or Exchange
// account, a local calendar). One consent screen lists the phone's calendars; the owner picks which to share and may choose
// "times only", which drops every title and place on the phone before sending.
//
// - Consent: the signal calendar, with purposes storage_compute (keep it) and model_processing (let Waldo's AI read it). The
//   calendar is kept only for Waldo to read, so the phone sends a snapshot only while both are granted, and withdrawing either
//   withdraws both and deletes everything kept from every phone in the same step. The owner's Durable Object holds this consent, its epochs and
//   the events, so the deletion and the withdrawal are one write. The server owns status and epoch.
// - What is kept: the latest snapshot per phone, from a day back to two weeks ahead, overwritten, never a history. Each event
//   keeps its times, all-day flag, availability, calendar and, unless times only, its title and place. Nothing else from the
//   phone: no attendees, notes or links. Events that end more than a day ago are dropped; a phone not heard from in 30 days
//   is dropped whole. Account deletion removes it with the owner's object.
// - Egress: the events reach the owner's model context when a turn reads them (query_phone_calendar), and the change
//   between two snapshots reaches the day's update judge as calendar changes; titles reach the owner's own pushes as Google
//   titles do. Nothing reaches logs: they carry counts and codes only. Calendar text is other people's words: it is data in
//   every prompt, never instructions.
// - Google: the same meeting often sits on a phone calendar and a connected Google calendar. When the phone gives an event's
//   iCal UID and a connected Google event has the same one, the read leaves the phone's copy out. Without a UID the model is
//   told the two may be the same event; code never guesses by title or time.
export const DEVICE_CALENDAR_PURPOSES_V1 = ['storage_compute', 'model_processing'] as const;
export const DEVICE_CALENDAR_MAX_REQUEST_BYTES_V1 = 262_144;
export const DEVICE_CALENDAR_MAX_EVENTS_V1 = 500;
export const DEVICE_CALENDAR_MAX_CALENDARS_V1 = 32;
// The phone reads from a day back to two weeks ahead; the window may run a day either side of that for clock skew.
export const DEVICE_CALENDAR_BACK_MS_V1 = 24 * 60 * 60_000;
export const DEVICE_CALENDAR_AHEAD_MS_V1 = 14 * 24 * 60 * 60_000;
const DEVICE_CALENDAR_WINDOW_MAX_MS = DEVICE_CALENDAR_BACK_MS_V1 + DEVICE_CALENDAR_AHEAD_MS_V1 + 2 * 24 * 60 * 60_000;

const calendarPurpose = z.enum(DEVICE_CALENDAR_PURPOSES_V1);
export const deviceCalendarConsentGrantBatchV1Schema = z.strictObject({
  request_id: requestId, signal: z.literal('calendar'), version: z.literal(DEVICE_CONTEXT_CONSENT_VERSION_V1),
  purposes: z.array(z.strictObject({ purpose: calendarPurpose, expected_epoch: epoch })).min(1).max(DEVICE_CALENDAR_PURPOSES_V1.length)
    .refine(items => new Set(items.map(item => item.purpose)).size === items.length, { error: 'each purpose once' }),
});
export const deviceCalendarConsentWithdrawV1Schema = z.strictObject({
  request_id: requestId, signal: z.literal('calendar'), purpose: calendarPurpose, expected_epoch: epoch,
});

const day = z.iso.date();
// The OS's own ids: Android's are numbers, iOS's are opaque strings. Never shown to the owner.
const deviceRef = z.string().min(1).max(256).regex(/^[^\r\n]*$/);
export const deviceCalendarAccountTypeV1Schema = z.enum(['local', 'exchange', 'google', 'icloud', 'caldav', 'other']);
export const deviceCalendarV1Schema = z.strictObject({
  calendar_id: deviceRef,
  name: line(120).optional(),
  account_type: deviceCalendarAccountTypeV1Schema,
});
// An all-day event's start and end are dates (the end the day after its last), as Google gives them; any other event's are
// instants. availability is the phone's own busy or free flag; unknown when the phone has none.
export const deviceCalendarEventV1Schema = z.strictObject({
  device_event_id: deviceRef,
  calendar_id: deviceRef,
  start: z.union([instant, day]),
  end: z.union([instant, day]),
  all_day: z.boolean(),
  title: line(300).optional(),
  location: line(300).optional(),
  availability: z.enum(['busy', 'free', 'tentative', 'unknown']),
  ical_uid: line(512).optional(),
}).refine(event => event.all_day === (day.safeParse(event.start).success && day.safeParse(event.end).success)
  && (event.all_day || (instant.safeParse(event.start).success && instant.safeParse(event.end).success)), { error: 'an all-day event has dates, any other instants', path: ['start'] })
  .refine(event => Date.parse(event.end) > Date.parse(event.start), { error: 'an event ends after it starts', path: ['end'] });

// One phone's whole view of its shared calendars in the window it read, replacing that phone's last snapshot. complete is false
// when the phone stopped at the event cap: an event missing from an incomplete snapshot is not read as cancelled.
// expected_epoch is the storage_compute epoch the phone read with consent; a snapshot from before a withdrawal is refused.
// The server also refuses a window that does not cover now, and a snapshot observed more than a day ago.
export const deviceCalendarSnapshotV1Schema = z.strictObject({
  request_id: requestId,
  expected_epoch: epoch,
  device_id: z.uuid(),
  platform,
  timezone,
  observed_at: instant,
  window: z.strictObject({ from: instant, to: instant }),
  times_only: z.boolean(),
  complete: z.boolean(),
  calendars: z.array(deviceCalendarV1Schema).max(DEVICE_CALENDAR_MAX_CALENDARS_V1)
    .refine(items => new Set(items.map(item => item.calendar_id)).size === items.length, { error: 'each calendar once' }),
  events: z.array(deviceCalendarEventV1Schema).max(DEVICE_CALENDAR_MAX_EVENTS_V1)
    .refine(items => new Set(items.map(item => item.device_event_id)).size === items.length, { error: 'each event once' }),
}).refine(snapshot => Date.parse(snapshot.window.to) > Date.parse(snapshot.window.from)
  && Date.parse(snapshot.window.to) - Date.parse(snapshot.window.from) <= DEVICE_CALENDAR_WINDOW_MAX_MS, { error: 'a window of at most sixteen days', path: ['window'] })
  .refine(snapshot => snapshot.events.every(event => snapshot.calendars.some(calendar => calendar.calendar_id === event.calendar_id)), { error: 'each event on a shared calendar', path: ['events'] })
  .refine(snapshot => !snapshot.times_only || snapshot.events.every(event => event.title === undefined && event.location === undefined), { error: 'times only carries no title or place', path: ['events'] });
export const deviceCalendarIngestReceiptV1Schema = z.strictObject({
  request_id: requestId,
  replayed: z.boolean(),
  status: z.enum(['accepted', 'superseded']),
});

// What Waldo kept, for the owner's own view: per phone, which calendars it shared and how many events are kept, never the events.
export const deviceCalendarStoredV1Schema = z.strictObject({
  devices: z.array(z.strictObject({
    device_id: z.uuid(),
    platform,
    received_at: instant,
    observed_at: instant,
    times_only: z.boolean(),
    complete: z.boolean(),
    calendars: z.array(deviceCalendarV1Schema).max(DEVICE_CALENDAR_MAX_CALENDARS_V1),
    events: z.int().min(0).max(DEVICE_CALENDAR_MAX_EVENTS_V1),
  })).max(DEVICE_PLACE_MAX_DEVICES_V1),
});

// A Worker with DEVICE_CALENDAR off answers 404 on every route, which the app reads as "not offered". Errors are
// deviceContextApiErrorV1Schema's. The consent list answers both calendar purposes.
export const appDeviceCalendarRoutesV1 = [
  { method: 'GET', path: '/app/v1/device/calendar/consents', response: deviceContextConsentListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/device/calendar/consents/batch', request: deviceCalendarConsentGrantBatchV1Schema, response: deviceContextConsentBatchV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/device/calendar/consents/withdraw', request: deviceCalendarConsentWithdrawV1Schema, response: deviceContextConsentChangeV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CONTEXT_MAX_REQUEST_BYTES_V1 },
  { method: 'POST', path: '/app/v1/device/calendar', request: deviceCalendarSnapshotV1Schema, response: deviceCalendarIngestReceiptV1Schema, authenticated: true, success_status: 200, idempotency_field: 'request_id', max_request_bytes: DEVICE_CALENDAR_MAX_REQUEST_BYTES_V1 },
  { method: 'GET', path: '/app/v1/device/calendar', response: deviceCalendarStoredV1Schema, authenticated: true, success_status: 200 },
] as const;

export type DeviceCalendarSnapshotV1 = z.infer<typeof deviceCalendarSnapshotV1Schema>;
export type DeviceCalendarEventV1 = z.infer<typeof deviceCalendarEventV1Schema>;
export type DeviceCalendarStoredV1 = z.infer<typeof deviceCalendarStoredV1Schema>;
