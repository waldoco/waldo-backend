import { z } from 'zod';

// A9 (BUILD_PLAN_2026-09-25): meal + workout logging. Health-adjacent data: log and nudge,
// never diagnose. Calorie values are model-inferred estimates, stored and presented as
// estimates. Writes happen only on owner-confirmed chat turns (same class as set_reminder);
// the proactive beats read recent entries through the ledger, not the tool ACL.
const atLocal = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .describe("When it happened, as YYYY-MM-DDTHH:MM in the owner's local time; omit for now.");

export const logMealArgsSchema = z.strictObject({
  description: z.string().min(1).max(500).describe("What the owner ate, in their words; for a food photo, what you see."),
  items: z.array(z.string().min(1).max(100)).max(20).optional().describe('Itemized list, only when the owner gave one.'),
  calories_estimate: z
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Rough estimate, only when honestly inferable from the description; never presented as measured.'),
  at: atLocal.optional(),
});
export type LogMealArgs = z.infer<typeof logMealArgsSchema>;

export const logWorkoutArgsSchema = z.strictObject({
  type: z.string().min(1).max(100).describe('Workout type, e.g. run, lifting, swim.'),
  duration_minutes: z.int().min(1).max(1440).optional().describe('Duration in minutes when the owner gave one.'),
  notes: z.string().min(1).max(500).optional(),
  at: atLocal.optional(),
});
export type LogWorkoutArgs = z.infer<typeof logWorkoutArgsSchema>;

export const listHealthLogsArgsSchema = z.strictObject({
  kind: z.enum(['meal', 'workout']).optional().describe('Filter to one kind; omit for both.'),
  limit: z.int().min(1).max(50).default(10),
});
export type ListHealthLogsArgs = z.infer<typeof listHealthLogsArgsSchema>;
