import { z } from 'zod';

// Per-class cap counter (cap 3/day) + last-send timestamp for the 2h cooldown.
export const classStateSchema = z.strictObject({
  fetch_alert: z.strictObject({
    count: z.int().nonnegative(),
    last_sent_at: z.int().nonnegative().nullable(),
  }),
});
export type ClassState = z.infer<typeof classStateSchema>;

// Present for Phase-D reconciliation. fetch_alert is budget-exempt: the gate never reads or
// writes sends_total. Non-exempt classes will decrement against this in Phase D.
export const dailyPushBudgetSchema = z.strictObject({
  sends_total: z.int().nonnegative(),
});
export type DailyPushBudget = z.infer<typeof dailyPushBudgetSchema>;

// Audit / WIS / push-pressure counter. Exempt sends bypass the daily budget but are still
// counted here so an exempt class cannot silently escape observability.
export const exemptTelemetrySchema = z.strictObject({
  exempt_sends: z.int().nonnegative(),
});
export type ExemptTelemetry = z.infer<typeof exemptTelemetrySchema>;
