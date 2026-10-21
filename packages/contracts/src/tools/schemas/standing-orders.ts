import { z } from 'zod';
import { reminderCronSchema } from './reminders';

// A7 (BUILD_PLAN_2026-09-25): typed standing orders - the owner's persistent programs, in the
// OpenClaw shape (scope + trigger + approval gate + escalation) but typed instead of injected
// workspace files. scope is what the order covers, in the owner's words. trigger is when it
// applies: every chat turn, or a daily local time that also fires a scheduled run. gate says
// what a scheduled run may do: act_and_report does the work and reports; confirm_first
// prepares and reports, then waits for the owner's confirmation before changing anything.
// escalation decides who hears about a failed scheduled run. Orders are set, listed and
// cancelled only on owner-confirmed chat turns; every-turn injection is read-only context.
export const standingGateSchema = z.enum(['act_and_report', 'confirm_first']);
export type StandingGate = z.infer<typeof standingGateSchema>;

export const standingEscalationSchema = z.enum(['message_owner', 'log_only']);
export type StandingEscalation = z.infer<typeof standingEscalationSchema>;

export const setStandingOrderArgsSchema = z.strictObject({
  scope: z.string().min(1).max(500).describe("The standing order, in the owner's words."),
  trigger: z.enum(['every_turn', 'daily', 'weekdays', 'weekly', 'cron']).describe('every_turn applies on each chat turn; other triggers schedule owner-local recurring runs. weekly uses the current local weekday.'),
  at: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .describe("Local HH:MM in the owner's timezone; required when trigger is daily."),
  cron: reminderCronSchema.optional(),
  gate: standingGateSchema.default('act_and_report').describe('confirm_first prepares and reports, then waits for the owner; act_and_report does the work and reports.'),
  escalation: standingEscalationSchema.default('message_owner').describe('Who hears about it when a scheduled run fails.'),
}).refine(({ trigger, cron }) => (trigger === 'cron') === (cron !== undefined), { error: 'cron is required only when trigger is cron.', path: ['cron'] });
export type SetStandingOrderArgs = z.infer<typeof setStandingOrderArgsSchema>;

export const listStandingOrdersArgsSchema = z.strictObject({});
export type ListStandingOrdersArgs = z.infer<typeof listStandingOrdersArgsSchema>;

export const cancelStandingOrderArgsSchema = z.strictObject({
  id: z.string().min(1).max(100).describe('Standing order id from list_standing_orders or set_standing_order.'),
});
export type CancelStandingOrderArgs = z.infer<typeof cancelStandingOrderArgsSchema>;
