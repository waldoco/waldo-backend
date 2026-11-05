import { describe, expect, it } from 'vitest';
import {
  appDeviceContextRoutesV1, deviceContextConsentGrantV1Schema, deviceContextConsentListV1Schema, deviceContextConsentWithdrawV1Schema,
  devicePlaceIngestReceiptV1Schema, devicePlaceIngestV1Schema, devicePlaceV1Schema, devicePlacesV1Schema,
} from './device-context';

// Synthetic values: a made-up cell and place.
const place = { cell: 'tdr1w', locality: 'Testville', region: 'Test Region', country: 'IN', timezone: 'Asia/Kolkata', platform: 'android', observed_at: '2026-11-05T08:00:00Z' };
const ingest = { request_id: 'dc-place-0001', expected_epoch: 1, device_id: '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', place };

describe('device place', () => {
  it('accepts a coarse cell with or without the OS place names', () => {
    expect(devicePlaceV1Schema.safeParse(place).success).toBe(true);
    expect(devicePlaceV1Schema.safeParse({ cell: '0zzzz', timezone: 'UTC', platform: 'ios', observed_at: '2026-11-05T08:00:00.000Z' }).success).toBe(true);
  });

  it('refuses anything finer than the cell, and any extra field', () => {
    for (const bad of [
      { ...place, cell: 'tdr1wx' },
      { ...place, cell: 'tdr1' },
      { ...place, cell: 'tdr1a' },
      { ...place, cell: 'TDR1W' },
      { ...place, latitude: 12.97, longitude: 77.59 },
      { ...place, accuracy_m: 3000 },
      { ...place, street: '1 Test Road' },
      { ...place, locality: '' },
      { ...place, locality: 'Testville\n1 Test Road' },
      { ...place, locality: 'x'.repeat(81) },
      { ...place, country: 'IND' },
      { ...place, platform: 'web' },
      { ...place, observed_at: '2026-11-05 08:00' },
      { ...place, timezone: '' },
    ]) expect(devicePlaceV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe('device context routes', () => {
  it('ingest takes one place from one installation', () => {
    expect(devicePlaceIngestV1Schema.safeParse(ingest).success).toBe(true);
    expect(devicePlaceIngestV1Schema.safeParse({ ...ingest, device_id: 'phone-1' }).success).toBe(false);
    expect(devicePlaceIngestV1Schema.safeParse({ ...ingest, owner_id: 'someone-else' }).success).toBe(false);
    expect(devicePlaceIngestV1Schema.safeParse({ ...ingest, place: [place] }).success).toBe(false);
    expect(devicePlaceIngestV1Schema.safeParse({ ...ingest, request_id: 'short' }).success).toBe(false);
  });

  it('a receipt says whether the place was kept or a later one already was', () => {
    expect(devicePlaceIngestReceiptV1Schema.safeParse({ request_id: 'dc-place-0001', replayed: false, status: 'superseded' }).success).toBe(true);
    expect(devicePlaceIngestReceiptV1Schema.safeParse({ request_id: 'dc-place-0001', replayed: false, status: 'rejected' }).success).toBe(false);
  });

  it('consent names its signal, purpose and copy version; the list holds at most one row per signal and purpose', () => {
    expect(deviceContextConsentGrantV1Schema.safeParse({ request_id: 'dc-grant-0001', signal: 'place', purpose: 'provider_lookup', version: 1, expected_epoch: 0 }).success).toBe(true);
    expect(deviceContextConsentGrantV1Schema.safeParse({ request_id: 'dc-grant-0001', signal: 'place', purpose: 'storage_compute', version: 2, expected_epoch: 0 }).success).toBe(false);
    expect(deviceContextConsentGrantV1Schema.safeParse({ request_id: 'dc-grant-0001', signal: 'precise_place', purpose: 'storage_compute', version: 1, expected_epoch: 0 }).success).toBe(false);
    expect(deviceContextConsentGrantV1Schema.safeParse({ request_id: 'dc-grant-0001', purpose: 'storage_compute', version: 1, expected_epoch: 0 }).success).toBe(false);
    expect(deviceContextConsentWithdrawV1Schema.safeParse({ request_id: 'dc-wd-0001', signal: 'place', purpose: 'storage_compute', expected_epoch: 1 }).success).toBe(true);
    expect(deviceContextConsentWithdrawV1Schema.safeParse({ request_id: 'dc-wd-0001', signal: 'place', purpose: 'storage_compute', version: 1, expected_epoch: 1 }).success).toBe(false);
    const row = (purpose: string) => ({ signal: 'place', purpose, version: 1, status: 'not_granted', epoch: 0, granted_at: null, withdrawn_at: null });
    expect(deviceContextConsentListV1Schema.safeParse({ consents: [row('storage_compute'), row('model_processing'), row('provider_lookup')] }).success).toBe(true);
    expect(deviceContextConsentListV1Schema.safeParse({ consents: [row('storage_compute'), row('model_processing'), row('provider_lookup'), row('storage_compute')] }).success).toBe(false);
  });

  it('the read-back holds at most eight devices', () => {
    const stored = { device_id: ingest.device_id, received_at: '2026-11-05T08:00:01Z', place };
    expect(devicePlacesV1Schema.safeParse({ places: [stored] }).success).toBe(true);
    expect(devicePlacesV1Schema.safeParse({ places: Array.from({ length: 9 }, () => stored) }).success).toBe(false);
  });

  it('declares its routes', () => {
    expect(appDeviceContextRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/device-context/consents', 'POST /app/v1/device-context/consents', 'POST /app/v1/device-context/consents/withdraw',
      'POST /app/v1/device-context/place', 'GET /app/v1/device-context/place',
    ]);
  });
});
