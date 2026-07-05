import { z } from 'zod';
import { iso8601Schema } from '../core/error';

const goalTextSchema = z.string().min(1).max(500);

// ADR-0064 persistent user objective. Goals are DO-owned agent memory with lifecycle and
// progress fields; they are not a sixth memory hall.
export const goalRecordSchema = z.strictObject({
  id: z.string().min(1),
  user_id: z.string().min(1),
  description: goalTextSchema,
  baseline: goalTextSchema.nullable().default(null),
  target: goalTextSchema.nullable().default(null),
  progress: goalTextSchema.nullable().default(null),
  deadline: iso8601Schema.nullable().default(null),
  active: z.boolean().default(true),
  created_at: z.int().nonnegative(),
  updated_at: z.int().nonnegative(),
});
export type GoalRecord = z.infer<typeof goalRecordSchema>;
