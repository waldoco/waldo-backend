import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { errorCodeSchema, iso8601Schema } from '../core/error';
import type { CrsResult } from '../health/crs';
import { crsResultSchema, loadZoneSchema, recoveryZoneSchema } from '../health/crs';

// The full health source-ID vocabulary — single-owned here. health/crs owns only the
// four-member HRV-confidence subset and consumes the full set as opaque strings
// (contributing_sources). The first four literals mirror hrvSourceSchema's order, which IS
// the confirmed device priority (ADR-0011 device-priority amendment); 'garmin' and 'manual'
// carry no confidence row. 'apple' is the ratified spelling — 'apple_watch' is drift.
export const healthSourceSchema = z.enum([
  'apple',
  'oura',
  'whoop',
  'samsung',
  'garmin',
  'manual',
]);
export type HealthSource = z.infer<typeof healthSourceSchema>;

// Sleep quality crosses this seam as a coarse band, never a duration — a numeric sleep
// field anywhere in this contract would breach the Art-9 firewall at every downstream
// journal/outbox sink.
export const sleepQualityCategorySchema = z.enum(['good', 'ok', 'poor']);
export type SleepQualityCategory = z.infer<typeof sleepQualityCategorySchema>;

// Journal/outbox-safe by construction: derived categories and stable source IDs only. Raw
// physiological values live in Supabase under RLS and never cross this seam; strictObject
// turns a drifted-in raw sensor field into a parse failure. recovery_category speaks the
// Recovery vocabulary and strain_level the Load vocabulary, both owned by health/crs — no
// band word is declared twice.
export const healthSnapshotSchema = z.strictObject({
  recovery_category: recoveryZoneSchema,
  sleep_quality_category: sleepQualityCategorySchema,
  strain_level: loadZoneSchema,
  primary_source: healthSourceSchema,
  sources_active: z.array(healthSourceSchema).min(1),
  captured_at: iso8601Schema,
});
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

// ADR-0010: Background Delivery wakes and on-open anchor reconciliation are the only two
// sanctioned ingest paths on iOS. Active polling was rejected (store review, battery,
// cannot fire when the app is killed) and is deliberately unrepresentable.
export const healthDeliveryPathSchema = z.enum([
  'background_delivery',
  'app_open_reconciliation',
]);
export type HealthDeliveryPath = z.infer<typeof healthDeliveryPathSchema>;

// One anchor advance per sync, whichever path produced it (ADR-0010). Anchors are opaque
// HKAnchoredObjectQuery checkpoints; a null anchor_before is the first-ever sync, and a
// reconciliation sweep pulls everything missed since the last checkpoint in one pass.
// sample_count is an ingest aggregate, never a reading. Only 'apple' is legal: ADR-0010
// sanctions the iOS path alone — an Android source first needs its own ADR.
export const healthAnchorSyncSchema = z.strictObject({
  source: z.literal('apple'),
  path: healthDeliveryPathSchema,
  anchor_before: z.string().min(1).nullable(),
  anchor_after: z.string().min(1),
  sample_count: z.int().nonnegative(),
  synced_at: iso8601Schema,
});
export type HealthAnchorSync = z.infer<typeof healthAnchorSyncSchema>;

// ADR-0010 consequence, pinned as the SLA ceiling: an OS-throttled wake can lag this many
// minutes behind the sample, so product copy says "near-real-time", never real-time.
export const BACKGROUND_DELIVERY_WORST_CASE_LATENCY_MIN = 120;

// Runtime form of core/error's AdapterResult for this seam's two payloads. core/error
// keeps AdapterResult a static type (a generic schema would be a factory, not a value);
// the concrete unions below are the validators run at the adapter boundary.
const adapterResultSchema = <Data extends z.ZodType>(dataSchema: Data) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: dataSchema }),
    z.strictObject({ ok: z.literal(false), error: z.string().min(1), code: errorCodeSchema }),
  ]);

export const healthSnapshotResultSchema = adapterResultSchema(healthSnapshotSchema);
export type HealthSnapshotResult = z.infer<typeof healthSnapshotResultSchema>;

export const healthCrsResultSchema = adapterResultSchema(crsResultSchema);
export type HealthCrsResult = z.infer<typeof healthCrsResultSchema>;

// The HealthDataSource seam: agent-side reads of derived health state go through exactly
// these two methods, and every provider or in-memory fake is an adapter here. Failures are
// coded AdapterResult values, never throws, so the agent loop degrades deterministically.
// CrsResult is owned by health/crs — imported, never re-declared.
export interface HealthDataSource {
  get_snapshot(): Promise<AdapterResult<HealthSnapshot>>;
  get_crs(): Promise<AdapterResult<CrsResult>>;
}
