import { z } from 'zod';
import { scheduleCronExpressionSchema } from '../../runtime/schedule';
import { parseCronExpression } from '../../runtime/cron';

export const reminderCronSchema = scheduleCronExpressionSchema.refine(value => parseCronExpression(value) !== null, { error: 'Invalid numeric five-field cron expression.' });

// Owner-set reminders and routines (owner queue slice 2). `at` is wall-clock time in the
// owner's timezone; `daily` repeats at that time every day.
export const setReminderArgsSchema = z.strictObject({
  note: z.string().min(1).max(500).describe('What to remind the owner about, in their words.'),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe("When, as YYYY-MM-DDTHH:MM in the owner's local time."),
  repeat: z.enum(['none', 'daily', 'weekdays', 'weekly', 'cron']).default('none').describe('Repeats at the owner-local time; weekly uses the weekday of at; cron uses cron.'),
  cron: reminderCronSchema.optional(),
}).refine(({ repeat, cron }) => (repeat === 'cron') === (cron !== undefined), { error: 'cron is required only when repeat is cron.', path: ['cron'] });
export type SetReminderArgs = z.infer<typeof setReminderArgsSchema>;

export const listRemindersArgsSchema = z.strictObject({});
export type ListRemindersArgs = z.infer<typeof listRemindersArgsSchema>;

export const cancelReminderArgsSchema = z.strictObject({
  id: z.string().min(1).max(100).optional().describe('Reminder id from list_reminders or set_reminder.'),
  all: z.boolean().optional().describe('true cancels all reminders belonging to the owner. Leave it out when cancelling one id.'),
}).refine(({ id, all }) => (id !== undefined) !== (all === true), { error: 'Supply one reminder id or all: true, not both.' });
export type CancelReminderArgs = z.infer<typeof cancelReminderArgsSchema>;
