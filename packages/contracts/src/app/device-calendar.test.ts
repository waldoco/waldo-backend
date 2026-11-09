import { describe, expect, it } from 'vitest';
import {
  appDeviceCalendarRoutesV1, DEVICE_CALENDAR_MAX_EVENTS_V1, deviceCalendarConsentGrantBatchV1Schema, deviceCalendarConsentWithdrawV1Schema,
  deviceCalendarIngestReceiptV1Schema, deviceCalendarSnapshotV1Schema, deviceCalendarStoredV1Schema, deviceContextConsentListV1Schema,
  deviceContextSignalV1Schema,
} from './device-context';

// Synthetic calendars and events: made-up names, ids and times.
const calendars = [
  { calendar_id: '7', name: 'Work', account_type: 'exchange' },
  { calendar_id: '3', name: 'Personal', account_type: 'local' },
];
const event = {
  device_event_id: '1042', calendar_id: '7', start: '2026-11-09T09:00:00Z', end: '2026-11-09T09:30:00Z', all_day: false,
  title: 'Weekly sync', location: 'Room 4', availability: 'busy', ical_uid: '040000008200E00074C5B7101A82E008@example.test',
};
const snapshot = {
  request_id: 'dcal-0001-abcd', expected_epoch: 1, device_id: '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', platform: 'android', timezone: 'Asia/Kolkata',
  observed_at: '2026-11-08T08:00:00Z', window: { from: '2026-11-07T08:00:00Z', to: '2026-11-22T08:00:00Z' }, times_only: false, complete: true,
  calendars, events: [event, { device_event_id: '1043', calendar_id: '3', start: '2026-11-10', end: '2026-11-11', all_day: true, title: 'Holiday', availability: 'free' }],
};

describe('device calendar', () => {
  it('calendar is a device-context signal with its own consent', () => {
    expect(deviceContextSignalV1Schema.options).toEqual(['place', 'calendar']);
    const row = (purpose: string) => ({ signal: 'calendar', purpose, version: 1, status: 'granted', epoch: 1, granted_at: '2026-11-08T08:00:00.000Z', withdrawn_at: null });
    expect(deviceContextConsentListV1Schema.safeParse({ consents: [row('storage_compute'), row('model_processing')] }).success).toBe(true);
    expect(deviceContextConsentListV1Schema.safeParse({ consents: [row('storage_compute'), row('storage_compute')] }).success).toBe(false);
  });

  it('the calendar consent screen grants storage and model use together, and withdraws one at a time', () => {
    const batch = { request_id: 'dcal-grant-0001', signal: 'calendar', version: 1, purposes: [{ purpose: 'storage_compute', expected_epoch: 0 }, { purpose: 'model_processing', expected_epoch: 0 }] };
    expect(deviceCalendarConsentGrantBatchV1Schema.safeParse(batch).success).toBe(true);
    for (const bad of [
      { ...batch, signal: 'place' },
      { ...batch, purposes: [{ purpose: 'provider_lookup', expected_epoch: 0 }] },
      { ...batch, purposes: [batch.purposes[0], batch.purposes[0]] },
      { ...batch, purposes: [] },
      { ...batch, version: 2 },
    ]) expect(deviceCalendarConsentGrantBatchV1Schema.safeParse(bad).success).toBe(false);
    expect(deviceCalendarConsentWithdrawV1Schema.safeParse({ request_id: 'dcal-wd-0001', signal: 'calendar', purpose: 'model_processing', expected_epoch: 1 }).success).toBe(true);
    expect(deviceCalendarConsentWithdrawV1Schema.safeParse({ request_id: 'dcal-wd-0001', signal: 'calendar', purpose: 'provider_lookup', expected_epoch: 1 }).success).toBe(false);
    expect(deviceCalendarConsentWithdrawV1Schema.safeParse({ request_id: 'dcal-wd-0001', signal: 'place', purpose: 'storage_compute', expected_epoch: 1 }).success).toBe(false);
  });

  it('a snapshot carries the shared calendars and their events in the window the phone read', () => {
    expect(deviceCalendarSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(deviceCalendarSnapshotV1Schema.safeParse({ ...snapshot, events: [] }).success).toBe(true);
    expect(deviceCalendarSnapshotV1Schema.safeParse({ ...snapshot, events: [{ ...event, title: undefined, location: undefined, ical_uid: undefined }] }).success).toBe(true);
  });

  it('times only means no titles and no places on any event', () => {
    const timesOnly = { ...snapshot, times_only: true, events: [{ ...event, title: undefined, location: undefined }] };
    expect(deviceCalendarSnapshotV1Schema.safeParse(timesOnly).success).toBe(true);
    expect(deviceCalendarSnapshotV1Schema.safeParse({ ...timesOnly, events: [event] }).success).toBe(false);
    expect(deviceCalendarSnapshotV1Schema.safeParse({ ...timesOnly, events: [{ ...event, title: undefined }] }).success).toBe(false);
  });

  it('refuses events outside the shape: unknown calendar, inverted or mixed times, extra fields, too many', () => {
    for (const bad of [
      { ...snapshot, events: [{ ...event, calendar_id: '99' }] },
      { ...snapshot, events: [{ ...event, end: event.start }] },
      { ...snapshot, events: [{ ...event, all_day: true }] },
      { ...snapshot, events: [{ ...event, start: '2026-11-10', end: '2026-11-11' }] },
      { ...snapshot, events: [{ ...event, attendees: ['someone@example.test'] }] },
      { ...snapshot, events: [{ ...event, title: 'Line one\nLine two' }] },
      { ...snapshot, events: [{ ...event, availability: 'maybe' }] },
      { ...snapshot, events: [event, event] },
      { ...snapshot, events: Array.from({ length: DEVICE_CALENDAR_MAX_EVENTS_V1 + 1 }, (_, index) => ({ ...event, device_event_id: String(index) })) },
      { ...snapshot, calendars: [{ ...calendars[0], account_type: 'outlook.com' }] },
      { ...snapshot, calendars: [calendars[0], calendars[0]] },
      { ...snapshot, window: { from: snapshot.window.to, to: snapshot.window.from } },
      { ...snapshot, window: { from: '2026-10-01T00:00:00Z', to: '2026-11-22T08:00:00Z' } },
      { ...snapshot, device_id: 'phone-1' },
      { ...snapshot, owner_id: 'someone-else' },
      { ...snapshot, request_id: 'short' },
    ]) expect(deviceCalendarSnapshotV1Schema.safeParse(bad).success).toBe(false);
  });

  it('a receipt says whether the snapshot was kept or a later one already was', () => {
    expect(deviceCalendarIngestReceiptV1Schema.safeParse({ request_id: snapshot.request_id, replayed: false, status: 'accepted' }).success).toBe(true);
    expect(deviceCalendarIngestReceiptV1Schema.safeParse({ request_id: snapshot.request_id, replayed: false, status: 'rejected' }).success).toBe(false);
  });

  it('the owner\'s read-back says what each phone shared, never the events themselves', () => {
    const stored = { devices: [{ device_id: snapshot.device_id, platform: 'android', received_at: '2026-11-08T08:00:01.000Z', observed_at: snapshot.observed_at, times_only: false, complete: true, calendars, events: 2 }] };
    expect(deviceCalendarStoredV1Schema.safeParse(stored).success).toBe(true);
    expect(deviceCalendarStoredV1Schema.safeParse({ devices: [{ ...stored.devices[0], events: [event] }] }).success).toBe(false);
    expect(deviceCalendarStoredV1Schema.safeParse({ devices: [] }).success).toBe(true);
  });

  it('declares its routes', () => {
    expect(appDeviceCalendarRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/device/calendar/consents', 'POST /app/v1/device/calendar/consents/batch', 'POST /app/v1/device/calendar/consents/withdraw',
      'POST /app/v1/device/calendar', 'GET /app/v1/device/calendar',
    ]);
  });
});
