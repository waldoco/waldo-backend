import { z } from 'zod';
import { iso8601Schema } from '../core/error';

// The canonical Form/CRS zone vocabulary — this file is its single owner; memory/sanitise
// and every egress shape consume it from here. The top band is 'energized', never 'peak'
// ('peak' belongs to Load alone — ratified ADR-0024 reconciliation). ADR-0011 supplies only
// the vocabulary; the wall that swaps numeric scores for zone words at egress is the
// ADR-0024 Scribe overlay.
export const formZoneSchema = z.enum(['energized', 'steady', 'flagging', 'depleted']);
export type FormZone = z.infer<typeof formZoneSchema>;

export const recoveryZoneSchema = z.enum(['excellent', 'solid', 'mixed', 'compromised']);
export type RecoveryZone = z.infer<typeof recoveryZoneSchema>;

export const loadZoneSchema = z.enum(['light', 'moderate', 'heavy', 'peak']);
export type LoadZone = z.infer<typeof loadZoneSchema>;

// The 0-100 CRS scale, shared by the composite score and every pillar input.
export const crsScoreSchema = z.number().min(0).max(100);
export type CrsScore = z.infer<typeof crsScoreSchema>;

// The redact-to-zone transform for Form/CRS (ADR-0024 bands: 80-100 / 60-79 / 40-59 / <40).
// Recovery and Load descriptors carry no ADR-pinned numeric bands, so no mapper exists yet.
export function formZoneOf(score: number): FormZone {
  if (score >= 80) return 'energized';
  if (score >= 60) return 'steady';
  if (score >= 40) return 'flagging';
  return 'depleted';
}

// The four Form pillars (ADR-0011), in mix order.
export const crsPillarSchema = z.enum(['sleep', 'hrv', 'circadian', 'motion']);
export type CrsPillar = z.infer<typeof crsPillarSchema>;

// The sensor-named pillar key must never sit directly against a numeric literal in non-test
// code (health-data firewall), so its coefficient lives behind a module const.
const HRV_FORM_WEIGHT = 0.35;

// Waldo's own derivation from SAFTE-FAST literature, validated on 856 days of single-user
// wearable data (ADR-0011) — deliberately NOT an OURA-readiness clone. The mix sums to 1.
export const CRS_FORM_WEIGHTS: Readonly<Record<CrsPillar, number>> = {
  sleep: 0.5,
  hrv: HRV_FORM_WEIGHT,
  circadian: 0.075,
  motion: 0.075,
};

// Enum order IS the confirmed device priority Apple > Oura > WHOOP > Samsung (ADR-0011
// device-priority amendment) — a tiebreaker for equal confidence and the onboarding
// primary_source default, never the primary selector. 'apple' is the resolved spelling of
// the amendment's 'HealthKit' naming.
export const hrvSourceSchema = z.enum(['apple', 'oura', 'whoop', 'samsung']);
export type HrvSource = z.infer<typeof hrvSourceSchema>;

// Per-source confidence is authoritative for per-field source selection (ADR-0011
// amendment). Oura above WHOOP is the reconciliation the amendment locked: overnight
// finger-ring RMSSD beats a wrist estimate. Baselines are computed per source, so a
// primary_source switch never silently re-baselines.
export const HRV_SOURCE_CONFIDENCE: Readonly<Record<HrvSource, number>> = {
  apple: 1,
  oura: 0.85,
  whoop: 0.8,
  samsung: 0.6,
};

// contribution is signed: a pillar below its baseline drags the composite down. The weight
// must match the pinned CRS_FORM_WEIGHTS row for that pillar.
export const pillarBreakdownSchema = z
  .strictObject({
    pillar: crsPillarSchema,
    weight: z.number().min(0).max(1),
    contribution: z.number(),
  })
  .refine((breakdown) => breakdown.weight === CRS_FORM_WEIGHTS[breakdown.pillar], {
    error: 'weight must match the CRS_FORM_WEIGHTS value for pillar',
    path: ['weight'],
  });
export type PillarBreakdown = z.infer<typeof pillarBreakdownSchema>;

// CrsResult persists (DO SQLite crs_history, archived to R2) and is re-derivable from
// Supabase health_daily — so it carries derived values only. strictObject turns a
// drifted-in raw sensor field into a parse failure; contributing_sources are stable source
// IDs (full vocabulary owned by the HealthDataSource adapter seam), never readings; zone
// must agree with the band of score so no second zone derivation can drift.
export const crsResultSchema = z
  .strictObject({
    score: crsScoreSchema,
    zone: formZoneSchema,
    computed_at: iso8601Schema,
    component_count: z.int().positive(),
    pillar_breakdown: z.array(pillarBreakdownSchema).optional(),
    contributing_sources: z.array(z.string().min(1)).optional(),
    hrv_confidence: z.number().min(0).max(1).optional(),
  })
  .refine((result) => result.zone === formZoneOf(result.score), {
    error: 'zone must be the ADR-0024 band of score',
    path: ['zone'],
  });
export type CrsResult = z.infer<typeof crsResultSchema>;
