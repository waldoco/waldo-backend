import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import type { TriggerType } from '../core/trigger';

const goalTextSchema = z.string().min(1).max(500);

export const goalWriteSourceSchema = z.enum(['onboarding', 'user_message']);
export type GoalWriteSource = z.infer<typeof goalWriteSourceSchema>;

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
    created_at: iso8601Schema,
    updated_at: iso8601Schema,
  })
  .refine((goal) => Date.parse(goal.updated_at) >= Date.parse(goal.created_at), {
    error: 'updated_at must be greater than or equal to created_at',
    path: ['updated_at'],
  });
export type GoalRecord = z.infer<typeof goalRecordSchema>;

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
