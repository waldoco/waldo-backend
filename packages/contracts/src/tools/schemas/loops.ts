import { z } from 'zod';

// Open loops (W6): things Waldo took on for the owner, kept until closed so nothing is dropped silently.
export const openLoopArgsSchema = z.strictObject({
  source_ref: z.string().min(1).max(200).optional().describe('Observed mail source_ref from update context. This records a follow-up hypothesis with unknown completion, never an owner commitment or permission.'),
  title: z.string().min(1).max(200).describe('What Waldo took on, in a few plain words.'),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).nullable().default(null).describe("When it is due, as YYYY-MM-DD or YYYY-MM-DDTHH:MM in the owner's local time, or null."),
});
export type OpenLoopArgs = z.infer<typeof openLoopArgsSchema>;

export const closeLoopArgsSchema = z.strictObject({
  id: z.string().min(1).max(100).describe('Loop id from the ledger or open_loop.'),
  outcome: z.enum(['done', 'dropped']).describe('done when it was finished, dropped when the owner no longer wants it.'),
});
export type CloseLoopArgs = z.infer<typeof closeLoopArgsSchema>;

const proactivityWindowSchema = z.strictObject({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});
const proactivityTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('owner') }),
  z.strictObject({ scope: z.literal('account'), account_id: z.string().min(1).max(200) }),
  z.strictObject({ scope: z.literal('collection'), source: z.enum(['mail', 'calendar', 'tasks', 'drive']), account_id: z.string().min(1).max(200), collection: z.string().min(1).max(2048) }),
]);

// Owner-set proactivity (W6). Quiet hours hold every unrequested message; owner-set reminders still fire.
export const setProactivityArgsSchema = z.strictObject({
  quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().describe('Local HH:MM when quiet hours start, or null for none.'),
  quiet_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().describe('Local HH:MM when quiet hours end, or null for none.'),
  volume: z.enum(['low', 'normal', 'high']).describe('low: only the main day cards. normal: plus updates that change the day. high: plus smaller useful updates.'),
  followups: z.boolean().optional().describe('Source-grounded follow-ups from mail and calendar (deadlines, prep); on by default. Set false only when the owner asks to turn them off, true to turn them back on; omit to keep the current value.'),
  target: proactivityTargetSchema.optional().describe('Omit for owner settings. Select an actual connected account or exact known collection to control that area; this never grants connector access.'),
  policy_revision: z.number().int().min(1).optional().describe('Current policy revision from owner controls; a stale revision is rejected.'),
  processing_windows: z.array(proactivityWindowSchema).max(28).optional().describe('When background source reads and checking may run, independently of sending. Empty means unrestricted time; omit to keep current windows. Days are Sunday 0 through Saturday 6 in the owner timezone.'),
  notification_windows: z.array(proactivityWindowSchema).max(28).optional().describe('When prepared unrequested notifications may be delivered. Empty means unrestricted time; omit to keep current windows. Quiet hours still apply. This does not authorize out-of-window processing.'),
});
export type SetProactivityArgs = z.infer<typeof setProactivityArgsSchema>;

// Owner-set schedule preferences: every out-of-the-box scheduled behavior can be turned off, back on, or reset.
export const SCHEDULE_KINDS = ['daily_brief', 'followups', 'event_briefs', 'nightly', 'heartbeat'] as const;
export const setSchedulePreferenceArgsSchema = z.strictObject({
  action: z.enum(['off', 'on', 'reset']).describe("off: stop that behavior. on: turn it back on. reset: restore every scheduled behavior to its out-of-the-box default (kind is ignored)."),
  kind: z.enum(SCHEDULE_KINDS).optional().describe('daily_brief: the day cards. followups: mail and calendar follow-ups. event_briefs: prep notes before events. nightly: overnight memory consolidation. heartbeat: periodic open-loop check. Required for on and off.'),
});
export type SetSchedulePreferenceArgs = z.infer<typeof setSchedulePreferenceArgsSchema>;
