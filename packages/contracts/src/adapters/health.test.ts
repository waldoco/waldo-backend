// Owning ADRs: ADR-0010 (Background Delivery + anchor reconciliation as the only sanctioned
// iOS ingest paths) and ADR-0011 (SAFTE-FAST CRS; its device-priority amendment orders the
// HRV-confidence prefix of the source vocabulary).
// Invariants under test: HealthSnapshot carries derived categories and stable source IDs
// only, so the shape is journal/outbox-safe by construction (Art-9 firewall); this module
// single-owns the full source vocabulary with health/crs's hrvSourceSchema as its ordered
// prefix; the result envelope is identical to core/error's AdapterResult; get_crs speaks
// health/crs's CrsResult, never a local clone.
// Failure modes caught: a raw physiological field drifting into the snapshot; source
// spelling drift ('apple_watch'); resurrection of the rejected polling path; envelope or
// CrsResult re-declaration drift; a band field silently rewired to the wrong vocabulary.
import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../core/error';
import type { CrsResult } from '../health/crs';
import { crsResultSchema, hrvSourceSchema } from '../health/crs';
import type { HealthDataSource, HealthSnapshot } from './health';
import {
  BACKGROUND_DELIVERY_WORST_CASE_LATENCY_MIN,
  healthAnchorSyncSchema,
  healthCrsResultSchema,
  healthDeliveryPathSchema,
  healthSnapshotResultSchema,
  healthSnapshotSchema,
  healthSourceSchema,
  sleepQualityCategorySchema,
} from './health';

const baseSnapshot = {
  recovery_category: 'solid',
  sleep_quality_category: 'good',
  strain_level: 'moderate',
  primary_source: 'apple',
  sources_active: ['apple', 'oura'],
  captured_at: '2026-07-02T08:00:00Z',
} as const;

const baseSync = {
  source: 'apple',
  path: 'background_delivery',
  anchor_before: 'anchor-000041',
  anchor_after: 'anchor-000042',
  sample_count: 12,
  synced_at: '2026-07-02T08:05:00Z',
} as const;

describe('healthSource', () => {
  it('is exactly the six canonical sources, in order', () => {
    expect(healthSourceSchema.options).toEqual([
      'apple',
      'oura',
      'whoop',
      'samsung',
      'garmin',
      'manual',
    ]);
  });

  it("rejects the unresolved spelling drift 'apple_watch' and an unknown source", () => {
    expect(healthSourceSchema.safeParse('apple_watch').success).toBe(false);
    expect(healthSourceSchema.safeParse('fitbit').success).toBe(false);
  });

  it('keeps the HRV-confidence sources as its ordered prefix (single-owner agreement)', () => {
    expect(healthSourceSchema.options.slice(0, hrvSourceSchema.options.length)).toEqual([
      ...hrvSourceSchema.options,
    ]);
  });
});

describe('sleepQualityCategory', () => {
  it('is exactly the three bands, in order', () => {
    expect(sleepQualityCategorySchema.options).toEqual(['good', 'ok', 'poor']);
  });

  it('rejects a numeric duration and an unknown band', () => {
    expect(sleepQualityCategorySchema.safeParse(7.5).success).toBe(false);
    expect(sleepQualityCategorySchema.safeParse('restorative').success).toBe(false);
  });
});

describe('healthSnapshot', () => {
  it('accepts a derived-categories-only snapshot', () => {
    expect(healthSnapshotSchema.safeParse(baseSnapshot).success).toBe(true);
  });

  it('carries exactly the derived-category and stable-ID keys', () => {
    expect(Object.keys(healthSnapshotSchema.shape)).toEqual([
      'recovery_category',
      'sleep_quality_category',
      'strain_level',
      'primary_source',
      'sources_active',
      'captured_at',
    ]);
  });

  it('rejects raw physiological fields (Art-9 firewall via strictObject)', () => {
    expect(healthSnapshotSchema.safeParse({ ...baseSnapshot, hrv_ms: 42 }).success).toBe(false);
    expect(healthSnapshotSchema.safeParse({ ...baseSnapshot, heart_rate: 61 }).success).toBe(
      false,
    );
    expect(healthSnapshotSchema.safeParse({ ...baseSnapshot, spo2: 97 }).success).toBe(false);
  });

  it("rejects a Load-only band as recovery_category ('peak' belongs to Load alone)", () => {
    expect(
      healthSnapshotSchema.safeParse({ ...baseSnapshot, recovery_category: 'peak' }).success,
    ).toBe(false);
  });

  it('rejects a Recovery band as strain_level (field wired to the Load vocabulary)', () => {
    expect(
      healthSnapshotSchema.safeParse({ ...baseSnapshot, strain_level: 'compromised' }).success,
    ).toBe(false);
  });

  it('rejects a Form band as sleep_quality_category (field wired to the sleep bands)', () => {
    expect(
      healthSnapshotSchema.safeParse({ ...baseSnapshot, sleep_quality_category: 'steady' })
        .success,
    ).toBe(false);
  });

  it('rejects a primary_source outside the source vocabulary', () => {
    expect(
      healthSnapshotSchema.safeParse({ ...baseSnapshot, primary_source: 'apple_watch' }).success,
    ).toBe(false);
  });

  it('rejects an empty sources_active — a snapshot must name its contributors', () => {
    expect(healthSnapshotSchema.safeParse({ ...baseSnapshot, sources_active: [] }).success).toBe(
      false,
    );
  });

  it('rejects an epoch timestamp where branded ISO8601 is required', () => {
    expect(
      healthSnapshotSchema.safeParse({ ...baseSnapshot, captured_at: 1_700_000_000_000 }).success,
    ).toBe(false);
  });
});

describe('healthDeliveryPath', () => {
  it('is exactly the two sanctioned ingest paths, in order', () => {
    expect(healthDeliveryPathSchema.options).toEqual([
      'background_delivery',
      'app_open_reconciliation',
    ]);
  });

  it("rejects 'polling' — the ADR-0010 rejected option stays unrepresentable", () => {
    expect(healthDeliveryPathSchema.safeParse('polling').success).toBe(false);
  });
});

describe('healthAnchorSync', () => {
  it('accepts a background-delivery anchor advance', () => {
    expect(healthAnchorSyncSchema.safeParse(baseSync).success).toBe(true);
  });

  it('accepts a first-ever reconciliation sweep (null prior anchor, zero samples)', () => {
    expect(
      healthAnchorSyncSchema.safeParse({
        ...baseSync,
        path: 'app_open_reconciliation',
        anchor_before: null,
        sample_count: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects a non-apple source — only the iOS path is sanctioned', () => {
    expect(healthAnchorSyncSchema.safeParse({ ...baseSync, source: 'oura' }).success).toBe(false);
  });

  it('rejects an empty anchor_after', () => {
    expect(healthAnchorSyncSchema.safeParse({ ...baseSync, anchor_after: '' }).success).toBe(
      false,
    );
  });

  it('rejects a negative or fractional sample_count', () => {
    expect(healthAnchorSyncSchema.safeParse({ ...baseSync, sample_count: -1 }).success).toBe(
      false,
    );
    expect(healthAnchorSyncSchema.safeParse({ ...baseSync, sample_count: 2.5 }).success).toBe(
      false,
    );
  });

  it('rejects a payload-bearing extra field (samples never ride the sync shape)', () => {
    expect(healthAnchorSyncSchema.safeParse({ ...baseSync, samples: [] }).success).toBe(false);
  });
});

describe('BACKGROUND_DELIVERY_WORST_CASE_LATENCY_MIN', () => {
  it('pins the ADR-0010 worst-case wake lag at 120 minutes', () => {
    expect(BACKGROUND_DELIVERY_WORST_CASE_LATENCY_MIN).toBe(120);
  });
});

describe('adapter result envelope', () => {
  const snapshot: HealthSnapshot = healthSnapshotSchema.parse(baseSnapshot);
  // Compile-time single-owner check: this fixture is typed as health/crs's CrsResult, so a
  // local re-declaration or drifted get_crs payload would fail to typecheck.
  const crs: CrsResult = crsResultSchema.parse({
    score: 72,
    zone: 'steady',
    computed_at: '2026-07-02T07:55:00Z',
    component_count: 4,
  });

  it('validates the ok arm and matches the static AdapterResult shape', () => {
    const okResult: AdapterResult<HealthSnapshot> = { ok: true, data: snapshot };
    const roundTripped: AdapterResult<HealthSnapshot> =
      healthSnapshotResultSchema.parse(okResult);
    expect(roundTripped).toEqual(okResult);
  });

  it("validates the err arm and rejects a code outside core/error's union", () => {
    expect(
      healthSnapshotResultSchema.safeParse({
        ok: false,
        error: 'wearable link revoked',
        code: 'auth_failed',
      }).success,
    ).toBe(true);
    expect(
      healthSnapshotResultSchema.safeParse({
        ok: false,
        error: 'wearable link revoked',
        code: 'timeout',
      }).success,
    ).toBe(false);
  });

  it('rejects an err arm smuggling a data payload (strictObject)', () => {
    expect(
      healthSnapshotResultSchema.safeParse({
        ok: false,
        error: 'wearable link revoked',
        code: 'transient',
        data: snapshot,
      }).success,
    ).toBe(false);
  });

  it('a conforming fake satisfies the seam and both reads validate at the boundary', async () => {
    const source: HealthDataSource = {
      get_snapshot: async () => ({ ok: true, data: snapshot }),
      get_crs: async () => ({ ok: true, data: crs }),
    };
    expect(healthSnapshotResultSchema.safeParse(await source.get_snapshot()).success).toBe(true);
    expect(healthCrsResultSchema.safeParse(await source.get_crs()).success).toBe(true);
  });
});
