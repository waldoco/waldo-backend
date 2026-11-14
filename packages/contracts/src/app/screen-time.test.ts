import { describe, expect, it } from 'vitest';
import {
  appScreenTimeRoutesV1, screenTimeConsentGrantV1Schema, screenTimeConsentListV1Schema, screenTimeDaySummaryV1Schema, screenTimeDaysQueryV1Schema,
  screenTimeIngestReceiptV1Schema, screenTimeIngestV1Schema,
} from './screen-time';

// Synthetic values.
const day = {
  day: '2026-11-02', timezone: 'Asia/Kolkata', platform: 'android', coverage: 'complete', screen_on_minutes: 214, pickups: 61, unlocks: 48,
  late_night_minutes: 22, late_night_window: '23:00-05:00', first_use_at: '07:12', last_use_at: '24:00', categories: [{ category: 'social', minutes: 70 }],
};
const ingest = { request_id: 'st-ingest-0001', expected_epoch: 1, device_id: '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', days: [day] };

describe('screen time day summary', () => {
  it('accepts the shape the app summariser produces', () => {
    expect(screenTimeDaySummaryV1Schema.safeParse(day).success).toBe(true);
    expect(screenTimeDaySummaryV1Schema.safeParse({ day: '2026-11-02', timezone: 'UTC', platform: 'android', coverage: 'none', late_night_window: '23:00-05:00' }).success).toBe(true);
  });

  it('refuses app or package names, other platforms, and numbers on a day with no coverage', () => {
    for (const bad of [
      { ...day, top_apps: [{ package: 'com.example', minutes: 3 }] },
      { ...day, platform: 'ios' },
      { ...day, coverage: 'none' },
      { ...day, screen_on_minutes: 1441 },
      { ...day, pickups: -1 },
      { ...day, last_use_at: '24:01' },
      { ...day, late_night_window: '11pm-5am' },
      { ...day, categories: [{ category: 'social', minutes: 5 }, { category: 'social', minutes: 6 }] },
      { ...day, categories: [{ category: 'dating', minutes: 5 }] },
      { ...day, categories: [{ category: 'social', minutes: 0 }] },
    ]) expect(screenTimeDaySummaryV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe('screen time routes', () => {
  it('ingest takes 1 to 14 distinct days from one installation', () => {
    expect(screenTimeIngestV1Schema.safeParse(ingest).success).toBe(true);
    expect(screenTimeIngestV1Schema.safeParse({ ...ingest, days: [] }).success).toBe(false);
    expect(screenTimeIngestV1Schema.safeParse({ ...ingest, days: [day, day] }).success).toBe(false);
    expect(screenTimeIngestV1Schema.safeParse({ ...ingest, days: Array.from({ length: 15 }, (_, i) => ({ ...day, day: `2026-10-${String(i + 10)}` })) }).success).toBe(false);
    expect(screenTimeIngestV1Schema.safeParse({ ...ingest, device_id: 'phone-1' }).success).toBe(false);
    expect(screenTimeIngestV1Schema.safeParse({ ...ingest, owner_id: 'someone-else' }).success).toBe(false);
  });

  it('a rejected day says why and an accepted one does not', () => {
    expect(screenTimeIngestReceiptV1Schema.safeParse({ request_id: 'st-ingest-0001', replayed: false, results: [{ day: '2026-11-02', status: 'rejected', reason: 'out_of_window' }] }).success).toBe(true);
    expect(screenTimeIngestReceiptV1Schema.safeParse({ request_id: 'st-ingest-0001', replayed: false, results: [{ day: '2026-11-02', status: 'rejected' }] }).success).toBe(false);
    expect(screenTimeIngestReceiptV1Schema.safeParse({ request_id: 'st-ingest-0001', replayed: false, results: [{ day: '2026-11-02', status: 'accepted', reason: 'out_of_window' }] }).success).toBe(false);
  });

  it('consent names its copy version, and the list holds the two purposes', () => {
    expect(screenTimeConsentGrantV1Schema.safeParse({ request_id: 'st-grant-0001', purpose: 'storage_compute', version: 1, expected_epoch: 0 }).success).toBe(true);
    expect(screenTimeConsentGrantV1Schema.safeParse({ request_id: 'st-grant-0001', purpose: 'storage_compute', version: 2, expected_epoch: 0 }).success).toBe(false);
    expect(screenTimeConsentGrantV1Schema.safeParse({ request_id: 'st-grant-0001', purpose: 'top_apps', version: 1, expected_epoch: 0 }).success).toBe(false);
    const row = (purpose: string) => ({ purpose, version: 1, status: 'not_granted', epoch: 0, granted_at: null, withdrawn_at: null });
    expect(screenTimeConsentListV1Schema.safeParse({ consents: [row('storage_compute'), row('model_processing')] }).success).toBe(true);
  });

  it('the read-back spans at most 31 days, in order', () => {
    expect(screenTimeDaysQueryV1Schema.safeParse({ from: '2026-10-03', to: '2026-11-02' }).success).toBe(true);
    expect(screenTimeDaysQueryV1Schema.safeParse({ from: '2026-10-02', to: '2026-11-02' }).success).toBe(false);
    expect(screenTimeDaysQueryV1Schema.safeParse({ from: '2026-11-02', to: '2026-11-01' }).success).toBe(false);
  });

  it('declares its routes', () => {
    expect(appScreenTimeRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual([
      'GET /app/v1/screen-time/consents', 'POST /app/v1/screen-time/consents', 'POST /app/v1/screen-time/consents/withdraw',
      'POST /app/v1/screen-time/days', 'GET /app/v1/screen-time/days',
    ]);
  });
});
