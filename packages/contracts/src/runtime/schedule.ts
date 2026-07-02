import { z } from 'zod';

// One-shot tracer entry. No recurrence, payload, or quarantine window here — the full
// 7-schedule multiplexer (priority-pop, recurrence-advance, DST/jitter) is deferred to Phase D.
export const scheduleStatusSchema = z.enum(['armed', 'quarantined']);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduleEntrySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal('tracer'),
  occurrence_at: z.int().nonnegative(),
  due_at: z.int().nonnegative(),
  status: scheduleStatusSchema,
  attempts: z.int().nonnegative(),
  created_at: z.int().nonnegative(),
  updated_at: z.int().nonnegative(),
});
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
