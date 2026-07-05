import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import type { TriggerType } from '../core/trigger';
import { skillSchema } from '../prompt/skill';
import type { SkillProvenance } from '../prompt/skill';

export const skillStatusSchema = z.enum(['active', 'stale', 'archived']);
export type SkillStatus = z.infer<typeof skillStatusSchema>;

// ADR-0022 provenance table: git-shipped skills (system, connector) are identity-locked and
// PR-only; R2 user-workspace skills (user, agent_authored) are mutable. The row stores the
// flag because the loader reads it, but the value is determined by provenance — drift between
// the two is unrepresentable.
export const IDENTITY_LOCKED_BY_PROVENANCE: Readonly<Record<SkillProvenance, boolean>> = {
  system: true,
  connector: true,
  user: false,
  agent_authored: false,
};

// ADR-0022 authoring cap: safety-critical triggers stay system-only — Waldo can never author
// itself into the intervention or fetch-alert path.
export const AGENT_AUTHORED_TRIGGER_DENYLIST: readonly TriggerType[] = [
  'intervention',
  'fetch_alert',
];

// ADR-0022 threshold action, owned by the Curator (deferred under ADR-0071): effectiveness
// under the floor for this many consecutive invocations reverts a provisional skill or
// surfaces a permanent one in Patrol. Distinct from the load-time floor in prompt/skill,
// which only drops a skill from one prompt build — this rule retires it.
export const EFFECTIVENESS_REVERT_FLOOR = 0.4;
export const EFFECTIVENESS_REVERT_CONSECUTIVE_INVOCATIONS = 3;

// ADR-0022 trial: an agent-authored skill runs provisional for the trial window, then
// graduates at the permanence threshold or auto-reverts under the revert floor.
export const PROVISIONAL_TRIAL_DAYS = 7;
export const PROVISIONAL_PERMANENT_THRESHOLD = 0.6;

// The DO SQLite storage row (ADR-0022): the loader shape plus the ADR-0064 curator-lifecycle
// fields — contract now, loop later. V1 values are founder-curated on the 15 bundled skills;
// the loader filters status 'active'; pinned exempts a skill from any future auto-archival.
export const skillRowSchema = skillSchema
  .extend({
    created_by: z.string().min(1),
    status: skillStatusSchema.default('active'),
    pinned: z.boolean().default(false),
    last_curated_at: iso8601Schema.nullable().default(null),
    archived_at: iso8601Schema.nullable().default(null),
  })
  .refine((row) => row.identity_locked === IDENTITY_LOCKED_BY_PROVENANCE[row.provenance], {
    error: 'identity_locked is determined by provenance',
    path: ['identity_locked'],
  })
  .refine(
    (row) =>
      row.provenance !== 'agent_authored' ||
      !row.trigger_types.some((t) => AGENT_AUTHORED_TRIGGER_DENYLIST.includes(t)),
    {
      error: 'agent-authored skills may not claim safety-critical triggers',
      path: ['trigger_types'],
    },
  )
  // Provisional is the agent-authored trial state (ADR-0022): every other provenance ships
  // proven (system, connector) or user-owned, never on trial.
  .refine((row) => !row.provisional || row.provenance === 'agent_authored', {
    error: 'only agent-authored skills can be provisional',
    path: ['provisional'],
  });
export type SkillRow = z.infer<typeof skillRowSchema>;
