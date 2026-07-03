import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { triggerTypeSchema } from '../core/trigger';
import type { TriggerType } from '../core/trigger';

// ADR-0022 pins skill names as kebab-case unique slugs — the slug doubles as the R2 file
// stem and the DO SQLite primary key, so exactly one canonical spelling exists.
export const skillNameSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type SkillName = z.infer<typeof skillNameSchema>;

export const skillProvenanceSchema = z.enum(['system', 'connector', 'user', 'agent_authored']);
export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;

const skillFenceBreakerRegex = /<\/\s*(skill|available-skills)\s*>/i;

// The ADR-0028 loader contract, field-for-field. Curator-lifecycle fields (created_by,
// status, pinned) belong to the ADR-0064 curator contract, not the loader's read shape —
// strictObject keeps them from drifting in.
export const skillSchema = z.strictObject({
  name: skillNameSchema,
  version: z.int().positive(),
  provenance: skillProvenanceSchema,
  identity_locked: z.boolean(),
  provisional: z.boolean(),
  trigger_types: z.array(triggerTypeSchema),
  // Plain English, evaluated by the model at invocation time — the loader never parses it.
  trigger_condition: z.string().min(1),
  required_tools: z.array(z.string().min(1)),
  required_connectors: z.array(z.string().min(1)),
  // Materialised score (rule blend + nightly judge, ADR-0028): the loader reads, never
  // recomputes — the ~5ms load budget depends on it.
  effectiveness: z.number().min(0).max(1),
  invocations: z.int().nonnegative(),
  last_used: iso8601Schema.nullable(),
  body_markdown: z.string().min(1).refine((body) => !skillFenceBreakerRegex.test(body), {
    error: 'skill body must not close the available-skills fence',
  }),
  created_at: iso8601Schema,
});
export type Skill = z.infer<typeof skillSchema>;

// Every drop in the ADR-0028 5-stage filter pipeline names one of these seven — a closed
// enum, so an unexplained exclusion is unrepresentable and Patrol can aggregate by reason.
export const exclusionReasonSchema = z.enum([
  'trigger_mismatch',
  'acl_violation',
  'missing_connector',
  'dismissed_today',
  'effectiveness_below_floor',
  'provisional_revert',
  'identity_drift_detected',
]);
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;

export const skillExclusionSchema = z.strictObject({
  skill_name: skillNameSchema,
  reason: exclusionReasonSchema,
});
export type SkillExclusion = z.infer<typeof skillExclusionSchema>;

export const skillFilterResultSchema = z.strictObject({
  selected: z.array(skillSchema),
  excluded: z.array(skillExclusionSchema),
});
export type SkillFilterResult = z.infer<typeof skillFilterResultSchema>;

// The loader seam (ADR-0028): the model sees skills, not the loader. Ctx is the
// InvocationContext contract owned by a later runtime wave; genericity keeps this a static
// type rather than a Zod schema, like RecallGateway.
export type SkillLoader<Ctx> = {
  loadForTrigger(ctx: Ctx): Promise<SkillFilterResult>;
};

// Stage 5 takes top K per trigger (ADR-0028 K table, verbatim). Keying is the core/trigger
// TriggerType vocabulary — the table does not split brief per variant, so the memory/recall
// RecallKey vocabulary does not apply here. Triggers without a ratified row (handoff_replan,
// pre_activity_spot) are absent and fall to DEFAULT_SKILL_TOP_K.
export const SKILL_TOP_K: Readonly<Partial<Record<TriggerType, number>>> = {
  brief: 5,
  patrol: 3,
  fetch_alert: 3,
  intervention: 2,
  handoff_explore: 7,
  handoff_plan: 4,
  handoff_act: 3,
  user_message: 8,
  dreaming_mode: 4,
};

export const DEFAULT_SKILL_TOP_K = 5;

// Stage 4 floor (ADR-0028): provisional skills below this effectiveness are dropped.
export const PROVISIONAL_EFFECTIVENESS_FLOOR = 0.4;

// Identity-drift rule (ADR-0028): an effectiveness collapse greater than the delta inside
// the window marks the skill identity_drift_detected and excludes it pending Patrol review.
export const IDENTITY_DRIFT_DELTA = 0.3;
export const IDENTITY_DRIFT_WINDOW_DAYS = 7;

// Prompt token envelope (ADR-0028): each selected body costs 300-600 tokens, so a default-K
// load costs 1500-3000 — the prompt bounds are the body bounds times DEFAULT_SKILL_TOP_K.
export const SKILL_TOKEN_BUDGET = {
  body_min: 300,
  body_max: 600,
  prompt_min: 1_500,
  prompt_max: 3_000,
} as const;
