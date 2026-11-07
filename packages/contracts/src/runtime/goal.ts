import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import type { TriggerType } from '../core/trigger';
import { APP_QUEST_CHECK_IN_DAYS_MAX_V1 } from '../app/controls';

const goalTextSchema = z.string().min(1).max(500);

export const goalWriteSourceSchema = z.enum(['onboarding', 'user_message']);
export type GoalWriteSource = z.infer<typeof goalWriteSourceSchema>;

// A quest is a goal the owner chose to work toward with Waldo: active (planned around, checked in on at their pace),
// ambient (kept in mind, no check-ins) or completed. active stays the ADR-0064 flag and always agrees with state; a goal
// written before quests carries no state and reads from active (goalState).
export const goalStateSchema = z.enum(['active', 'ambient', 'completed']);
export type GoalState = z.infer<typeof goalStateSchema>;

export const goalRecordSchema = z
  .strictObject({
    id: z.string().min(1),
    user_id: z.string().min(1),
    description: goalTextSchema,
    baseline: goalTextSchema.optional(),
    target: goalTextSchema.optional(),
    progress: goalTextSchema.optional(),
    deadline: iso8601Schema.optional(),
    active: z.boolean().default(true),
    plan: goalTextSchema.optional(),
    state: goalStateSchema.optional(),
    // How many days apart the owner wants check-ins; absent means none on a schedule.
    check_in_days: z.int().min(1).max(APP_QUEST_CHECK_IN_DAYS_MAX_V1).optional(),
    last_check_in_at: iso8601Schema.optional(),
    created_at: iso8601Schema,
    updated_at: iso8601Schema,
  })
  .refine((goal) => goal.state === undefined || goal.active === (goal.state !== 'completed'), {
    error: 'active is false exactly when the state is completed',
    path: ['active'],
  })
  .refine((goal) => Date.parse(goal.updated_at) >= Date.parse(goal.created_at), {
    error: 'updated_at must be greater than or equal to created_at',
    path: ['updated_at'],
  });
export type GoalRecord = z.infer<typeof goalRecordSchema>;

export const goalState = (goal: Pick<GoalRecord, 'active' | 'state'>): GoalState => goal.state ?? (goal.active ? 'active' : 'completed');

export function canWriteGoalFromTrigger(trigger: TriggerType): boolean {
  return trigger === 'user_message';
}

export function activeGoalRecords(goals: readonly unknown[]): GoalRecord[] {
  const active: GoalRecord[] = [];

  for (const candidate of goals) {
    const goal = goalRecordSchema.parse(candidate);
    if (goal.active) {
      active.push(goal);
    }
  }

  return active;
}
