import { z } from 'zod';
import { pushClassSchema } from './delivery-policy';

export const deliveryClassCounterSchema = z.strictObject({
  count: z.int().nonnegative(),
  last_sent_at: z.int().nonnegative().nullable(),
});
export type DeliveryClassCounter = z.infer<typeof deliveryClassCounterSchema>;

export const classStateSchema = z.partialRecord(pushClassSchema, deliveryClassCounterSchema);
export type ClassState = z.infer<typeof classStateSchema>;

export const dailyPushBudgetSchema = z.strictObject({
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sends_total: z.int().nonnegative(),
  exempt_sends: z.int().nonnegative().default(0),
  class_state: classStateSchema.default({}),
});
export type DailyPushBudget = z.infer<typeof dailyPushBudgetSchema>;

export const exemptTelemetrySchema = z.strictObject({
  exempt_sends: z.int().nonnegative(),
});
export type ExemptTelemetry = z.infer<typeof exemptTelemetrySchema>;
