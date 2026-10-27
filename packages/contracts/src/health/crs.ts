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

// Purpose-prefixed digest shape prevents subject, provider-account, and database identifiers from
// becoming provenance references while remaining opaque to every destination consumer.
export const opaqueHealthProvenanceRefSchema = z.string().regex(/^hpr_[0-9a-f]{32}$/);
export type OpaqueHealthProvenanceRef = z.infer<typeof opaqueHealthProvenanceRefSchema>;

export const derivedHealthDestinationEligibilitySchema = z.enum([
  'trigger_prompt',
  'volatile_run',
  'r2_today_summary',
  'r2_baselines_summary',
  'runtime_trace',
]);
export type DerivedHealthDestinationEligibility = z.infer<
  typeof derivedHealthDestinationEligibilitySchema
>;

// Whether a pillar's score leans on the owner's own history yet, in the words the model is given.
export const derivedBaselineStateSchema = z.enum(['provisional', 'personal']);
export type DerivedBaselineState = z.infer<typeof derivedBaselineStateSchema>;

// Sleep debt reaches the model as words, never as minutes: how much is owed, and only when the stored row itself names one,
// which way it is going. The direction words are the stored row's vocabulary and mean the same to every reader.
export const derivedSleepDebtAmountSchema = z.enum(['little', 'some', 'partial', 'unknown']);
export const derivedSleepDebtTrendSchema = z.enum(['building', 'easing', 'steady']);
export const derivedSleepDebtSchema = z.strictObject({
  amount: derivedSleepDebtAmountSchema,
  trend: derivedSleepDebtTrendSchema.optional(),
});
export type DerivedSleepDebtTrend = z.infer<typeof derivedSleepDebtTrendSchema>;
export type DerivedSleepDebt = z.infer<typeof derivedSleepDebtSchema>;

// A stretch of the owner's local day as clock times. A time of day is not a reading, and this is the only shape in which a
// digit reaches the derived view, so the format is fixed here and never taken from free text.
const clockTimeSchema = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
export const derivedEnergyWindowSchema = z.strictObject({
  start: clockTimeSchema,
  end: clockTimeSchema,
  kind: z.enum(['peak', 'dip']),
});
export type DerivedEnergyWindow = z.infer<typeof derivedEnergyWindowSchema>;
export const derivedEnergyWindowsSchema = z.array(derivedEnergyWindowSchema).max(4);

const derivedViewCommon = {
  authority: z.literal('backend'),
  trend: z.enum(['improving', 'steady', 'declining', 'insufficient']),
  freshness: z.enum(['fresh', 'stale']),
  confidence_band: z.enum(['high', 'medium', 'low']),
  provenance_refs: z.array(opaqueHealthProvenanceRefSchema).min(1).max(4),
  destination_eligibility: z.array(derivedHealthDestinationEligibilitySchema).min(1),
  // Each pillar the view tells the model about, by its own baseline state; a pillar the row did not label is absent.
  baseline_state: z
    .strictObject({
      recovery: derivedBaselineStateSchema.optional(),
      form: derivedBaselineStateSchema.optional(),
      load: derivedBaselineStateSchema.optional(),
    })
    .optional(),
  sleep_debt: derivedSleepDebtSchema.optional(),
  energy_windows: derivedEnergyWindowsSchema.optional(),
} as const;

// A version name as a stored row carries it, e.g. form.v9 or recovery.candidate.v4: the pillar's own name, optional middle
// parts that are words and a numbered revision. The pillar prefix stops a Form view naming a Recovery version, and digits only
// in the last part stop a measurement from riding in a name.
const versionOf = (pillar: 'form' | 'recovery') =>
  z.string().max(64).regex(new RegExp(`^${pillar}(?:\\.[a-z][a-z-]*)*\\.v[0-9]+$`));

export const formHealthViewSchema = z.strictObject({
  ...derivedViewCommon,
  algorithm_version: versionOf('form'),
  form_zone: formZoneSchema,
  missing_components: z.array(crsPillarSchema),
});
export type FormHealthView = z.infer<typeof formHealthViewSchema>;

// Recovery is built from sleep and HRV, so those are the only components that can be reported missing.
export const recoveryComponentSchema = z.enum(['sleep', 'hrv']);
export const recoveryHealthViewSchema = z.strictObject({
  ...derivedViewCommon,
  algorithm_version: versionOf('recovery'),
  recovery_zone: recoveryZoneSchema,
  missing_components: z.array(recoveryComponentSchema),
});
export type RecoveryHealthView = z.infer<typeof recoveryHealthViewSchema>;

// Which pillar a view is about is which zone it carries; no version name is read to decide it.
export const derivedHealthDestinationViewSchema = z.union([formHealthViewSchema, recoveryHealthViewSchema]);
export type DerivedHealthDestinationView = z.infer<typeof derivedHealthDestinationViewSchema>;

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
