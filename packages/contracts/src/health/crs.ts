import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { HEALTH_SIGNAL_GRAINS } from './signals';
import { healthPartKeysV1, healthPartUnavailableReasonV1Schema, healthSignalV1Schema, healthUsualSignalV1Schema } from '../app/health-ingest';

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

// Why the stored row could not compute a pillar, in the score engine's own reason words. A link or consent reason is never
// here: without a live consent there is no view at all.
export const derivedMissingPillarReasonSchema = z.enum([
  'no_readings', 'baseline_immature', 'missing_sleep', 'missing_resting_signal', 'stale_inputs', 'conflicting_inputs',
  'intraday_inputs_unavailable', 'calendar_demand_unavailable',
]);
export type DerivedMissingPillarReason = z.infer<typeof derivedMissingPillarReasonSchema>;
export const derivedMissingPillarsSchema = z.strictObject({
  recovery: derivedMissingPillarReasonSchema.optional(),
  form: derivedMissingPillarReasonSchema.optional(),
  load: derivedMissingPillarReasonSchema.optional(),
  sleep_debt: derivedMissingPillarReasonSchema.optional(),
});
export type DerivedMissingPillars = z.infer<typeof derivedMissingPillarsSchema>;

// One kind of body data the owner's sources sent in the last thirty days, in words: how often it carries a value, how recent
// its newest reading is, on how many of the thirty days it arrived, and from which sources. Never a value.
export const healthInventoryEntrySchema = z.strictObject({
  signal: healthSignalV1Schema,
  grain: z.enum(HEALTH_SIGNAL_GRAINS),
  newest: z.enum(['within_hours', 'today', 'yesterday', 'this_week', 'this_month']),
  regularity: z.enum(['nearly_every_day', 'most_days', 'some_days', 'a_few_days']),
  sources: z.array(z.enum(['apple', 'oura', 'whoop', 'samsung', 'health_connect'])).min(1).max(5),
});
export type HealthInventoryEntry = z.infer<typeof healthInventoryEntrySchema>;
export const healthInventorySchema = z.array(healthInventoryEntrySchema).max(healthSignalV1Schema.options.length);

// What the body read says of today against the owner's own usual, in closed words only: never a value or a score. A reading or a
// part stood above, below, later or earlier than its usual band, or within it, and is far when it lies two of the band's spreads
// or more from the centre (the band itself is one spread either side). A band still short of the owner's fourteen days is forming,
// and says nothing about direction. The sleep part stands against the owner's need, in tenths of it.
const bodyStandingSchema = z.union([
  z.strictObject({ state: z.literal('compared'), direction: z.enum(['above', 'below', 'later', 'earlier', 'within']), far: z.literal(true).optional() })
    .refine((standing) => standing.far === undefined || standing.direction !== 'within', { error: 'a reading within its band is not far', path: ['far'] }),
  z.strictObject({ state: z.literal('forming') }),
]);
export const derivedBodyReadingSchema = z.strictObject({ signal: healthUsualSignalV1Schema, standing: bodyStandingSchema });
// The model calls the Weight pillar Load.
const bodyPillarSchema = z.enum(['recovery', 'form', 'load']);
const BODY_PART_KEYS = { recovery: healthPartKeysV1.recovery, form: healthPartKeysV1.form, load: healthPartKeysV1.weight } as const;
const bodyPartKeySchema = z.enum([...new Set(Object.values(BODY_PART_KEYS).flat())] as [string, ...string[]]);
const partFits = (part: { pillar: z.infer<typeof bodyPillarSchema>; key: string }) => (BODY_PART_KEYS[part.pillar] as readonly string[]).includes(part.key);
// via steps: Form's movement part read on the owner's steps, for a phone that sends no movement minutes.
export const derivedBodyPartSchema = z.union([
  z.strictObject({ pillar: bodyPillarSchema, key: bodyPartKeySchema, standing: bodyStandingSchema, via: z.literal('steps').optional() })
    .refine((part) => part.via === undefined || part.key === 'movement', { error: 'only movement is read on steps', path: ['via'] }),
  z.strictObject({ pillar: z.literal('recovery'), key: z.literal('sleep'), need_tenths: z.int().min(0).max(10) }),
  z.strictObject({ pillar: bodyPillarSchema, key: bodyPartKeySchema, unavailable: healthPartUnavailableReasonV1Schema }),
]).refine(partFits, { error: 'the part belongs to its pillar', path: ['key'] });
// Today's load so far against the owner's usual whole day, or the band still forming. approximate: the zones were set from the
// highest heart rate seen, not a measured maximum.
export const derivedBodyDayLoadSchema = z.union([
  z.strictObject({ state: z.literal('compared'), direction: z.enum(['above', 'below', 'within']), far: z.literal(true).optional(), approximate: z.boolean() })
    .refine((load) => load.far === undefined || load.direction !== 'within', { error: 'a load within its band is not far', path: ['far'] }),
  z.strictObject({ state: z.literal('forming'), approximate: z.boolean() }),
]);
// A stretch of today's settled hours whose strain at rest stood high against the same hours of the owner's earlier days.
export const derivedStrainHoursSchema = z.array(z.strictObject({ start: clockTimeSchema, end: clockTimeSchema })).max(12);
export const derivedBodySchema = z.strictObject({
  readings: z.array(derivedBodyReadingSchema).max(healthUsualSignalV1Schema.options.length)
    .refine((readings) => new Set(readings.map((reading) => reading.signal)).size === readings.length, { error: 'one entry per reading' }),
  parts: z.array(derivedBodyPartSchema).max(12)
    .refine((parts) => new Set(parts.map((part) => `${part.pillar}.${part.key}`)).size === parts.length, { error: 'one entry per part' }),
  day_load: derivedBodyDayLoadSchema.optional(),
  // Present only when today's row holds a stress curve: empty when no settled hour stood high.
  strain_hours: derivedStrainHoursSchema.optional(),
});
export type DerivedBody = z.infer<typeof derivedBodySchema>;

const derivedViewShared = {
  authority: z.literal('backend'),
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
  // The pillars the row could not compute and the reason it stored for each. Absent on a view written before it existed.
  missing_pillars: derivedMissingPillarsSchema.optional(),
  // What body data exists for the owner, whatever any score could make of it. Absent when it was not read.
  inventory: healthInventorySchema.optional(),
  // Today's readings, the parts of each score, the day's load and the hours of high strain at rest, against the owner's usual. Absent
  // when it was not read, or the body read answered for another day than the view's.
  body: derivedBodySchema.optional(),
} as const;

const derivedViewCommon = {
  ...derivedViewShared,
  trend: z.enum(['improving', 'steady', 'declining', 'insufficient']),
  freshness: z.enum(['fresh', 'stale']),
  confidence_band: z.enum(['high', 'medium', 'low']),
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

// The view for a day whose body data could not make a Recovery score, or whose newest row is more than three days old. It
// carries no Recovery or Form zone and no readiness word, only what the row records in words: which sources it was computed
// from, which inputs it shows arrived, which pillars it could not compute and why, and any pillar honest on its own (Load,
// sleep debt, energy windows). An expired view carries nothing from that old day but its age and sources.
export const partialHealthSourceSchema = healthInventoryEntrySchema.shape.sources.element;
export type PartialHealthSource = z.infer<typeof partialHealthSourceSchema>;
// Inputs a stored row shows arrived. A signal the row does not record (steps, heart rate through the day) is never named.
// last_night_sleep is the row's own night, the one that ended on the row's day: last night only for today's row.
export const partialHealthPresentSchema = z.enum(['last_night_sleep', 'recent_sleep', 'calendar', 'activity', 'workouts']);
export type PartialHealthPresent = z.infer<typeof partialHealthPresentSchema>;
export const partialHealthViewSchema = z.strictObject({
  ...derivedViewShared,
  availability: z.literal('partial'),
  freshness: z.enum(['fresh', 'stale', 'expired']),
  // The row's day against the owner's local today.
  as_of_day: z.enum(['today', 'yesterday', 'earlier']),
  sources: z.array(partialHealthSourceSchema).max(5),
  present: z.array(partialHealthPresentSchema).max(5),
  missing_pillars: derivedMissingPillarsSchema,
  load_zone: loadZoneSchema.optional(),
  // No score row is stored for the owner at all: the view stands on the inventory alone, and its day and freshness are those of
  // the newest reading.
  no_score_row: z.literal(true).optional(),
});
export type PartialHealthView = z.infer<typeof partialHealthViewSchema>;

// The narrative beside a partial view: no Form zone and no Recovery descriptor, since neither was computed.
export const partialHealthNarrativeSchema = z.strictObject({
  day_summary: z.string().max(2000),
  active_goals: z.array(z.string().min(1)).default([]),
  upcoming_high_stakes: z.array(z.string().min(1)).default([]),
  compiled_at: iso8601Schema,
});
export type PartialHealthNarrative = z.infer<typeof partialHealthNarrativeSchema>;

// Which pillar a view is about is which zone it carries; no version name is read to decide it. A partial view carries
// neither zone and says so by its availability.
export const derivedHealthDestinationViewSchema = z.union([formHealthViewSchema, recoveryHealthViewSchema, partialHealthViewSchema]);
export type DerivedHealthDestinationView = z.infer<typeof derivedHealthDestinationViewSchema>;

// How large a derived health view can be, read from its own closed schemas: the most fields any view carries, its longest list
// (the inventory, one entry per kind Waldo stores) and how deep it nests. A health view is the only structured payload the
// system prompt accepts, so the Scribe's caps for that destination are these: the schema is the bound, and a view the schema
// admits is never refused for its size. A test builds the largest view the schemas admit and checks it fits.
export const DERIVED_HEALTH_VIEW_BOUNDS = {
  fields: Math.max(...[formHealthViewSchema, recoveryHealthViewSchema, partialHealthViewSchema].map((schema) => Object.keys(schema.shape).length)),
  items: healthSignalV1Schema.options.length,
  // A body reading's standing: the view, its body, the readings, a reading, its standing.
  depth: 5,
} as const;

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
