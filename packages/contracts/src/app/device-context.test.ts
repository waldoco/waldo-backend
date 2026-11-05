import { describe, expect, it } from 'vitest';
import {
  appDeviceContextRoutesV1, deviceContextConsentBatchV1Schema, deviceContextConsentGrantBatchV1Schema, deviceContextConsentGrantV1Schema,
  deviceContextConsentListV1Schema, deviceContextConsentWithdrawV1Schema,
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

  it('accepts a time zone alone, sent on a wake with no location, but never a place name without its cell', () => {
    expect(devicePlaceV1Schema.safeParse({ timezone: 'Asia/Dubai', platform: 'android', observed_at: '2026-11-05T08:00:00Z' }).success).toBe(true);
    expect(devicePlaceV1Schema.safeParse({ locality: 'Testville', timezone: 'Asia/Dubai', platform: 'android', observed_at: '2026-11-05T08:00:00Z' }).success).toBe(false);
    expect(devicePlaceV1Schema.safeParse({ country: 'IN', timezone: 'Asia/Dubai', platform: 'android', observed_at: '2026-11-05T08:00:00Z' }).success).toBe(false);
    expect(devicePlaceV1Schema.safeParse({ platform: 'android', observed_at: '2026-11-05T08:00:00Z' }).success).toBe(false);
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

  it('a place name may hold a short number but never a position', () => {
    expect(devicePlaceV1Schema.safeParse({ ...place, locality: 'Sector 128', region: '5th Block' }).success).toBe(true);
    for (const name of ['12.971599,77.594566', '12,97 77,59', '12°58′N 77°35′E', '1297 7759', 'Near 1.3'])
      for (const field of ['locality', 'region']) expect(devicePlaceV1Schema.safeParse({ ...place, [field]: name }).success).toBe(false);
    for (const name of ['१२.९७१५९९,७७.५९४५६६', '١٢٫٩٧', '１２９７　７７５９', '12º58 N', 'Near 12\u00A0.\u00A09', '\u{11DE0}\u{11DE2}\u{11DE8}\u{11DE7}\u{11DE1}'])
      for (const field of ['locality', 'region']) expect(devicePlaceV1Schema.safeParse({ ...place, [field]: name }).success).toBe(false);
    expect(devicePlaceV1Schema.safeParse({ ...place, locality: 'Sector 128', region: 'Block 45' }).success).toBe(false);
    expect(devicePlaceV1Schema.safeParse({ ...place, locality: 'Sector 12', region: 'Block 45' }).success).toBe(true);
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

  it('the consent screen grants several purposes in one call, each purpose once with its own epoch', () => {
    const batch = { request_id: 'dc-batch-0001', signal: 'place', version: 1, purposes: [
      { purpose: 'storage_compute', expected_epoch: 0 }, { purpose: 'model_processing', expected_epoch: 2 }, { purpose: 'provider_lookup', expected_epoch: 0 }] };
    expect(deviceContextConsentGrantBatchV1Schema.safeParse(batch).success).toBe(true);
    for (const bad of [
      { ...batch, purposes: [] },
      { ...batch, purposes: [batch.purposes[0], batch.purposes[0]] },
      { ...batch, purposes: [{ purpose: 'precise_place', expected_epoch: 0 }] },
      { ...batch, purposes: [{ purpose: 'storage_compute' }] },
      { ...batch, purposes: [{ ...batch.purposes[0], granted: true }] },
      { ...batch, version: 2 },
    ]) expect(deviceContextConsentGrantBatchV1Schema.safeParse(bad).success).toBe(false);
    const row = { signal: 'place', purpose: 'storage_compute', version: 1, status: 'granted', epoch: 1, granted_at: '2026-11-05T08:00:00.000Z', withdrawn_at: null };
    expect(deviceContextConsentBatchV1Schema.safeParse({ consents: [row], replayed: false }).success).toBe(true);
    expect(deviceContextConsentBatchV1Schema.safeParse({ consents: [], replayed: false }).success).toBe(false);
  });

  it('the read-back gives each phone\'s zone and, once sent, its place, each with its own time, for at most eight phones', () => {
    const stored = {
      device_id: ingest.device_id, received_at: '2026-11-05T08:00:01Z', platform: 'android', timezone: 'Asia/Dubai', timezone_observed_at: '2026-11-05T09:00:00Z',
      place: { cell: 'tdr1w', locality: 'Testville', country: 'IN', observed_at: '2026-11-05T08:00:00Z' },
    };
    expect(devicePlacesV1Schema.safeParse({ places: [stored, { ...stored, place: null }] }).success).toBe(true);
    expect(devicePlacesV1Schema.safeParse({ places: [{ ...stored, place: { ...stored.place, cell: 'tdr1wx' } }] }).success).toBe(false);
    expect(devicePlacesV1Schema.safeParse({ places: [{ ...stored, place: { ...stored.place, observed_at: undefined } }] }).success).toBe(false);
    expect(devicePlacesV1Schema.safeParse({ places: [{ ...stored, place: undefined }] }).success).toBe(false);
    expect(devicePlacesV1Schema.safeParse({ places: Array.from({ length: 9 }, () => stored) }).success).toBe(false);
  });

  it('declares its routes', () => {
    expect(appDeviceContextRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/device-context/consents', 'POST /app/v1/device-context/consents', 'POST /app/v1/device-context/consents/batch',
      'POST /app/v1/device-context/consents/withdraw',
      'POST /app/v1/device-context/place', 'GET /app/v1/device-context/place',
    ]);
  });
});
