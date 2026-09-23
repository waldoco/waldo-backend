import { z } from 'zod';

// Owner-set reminders and routines (owner queue slice 2). `at` is wall-clock time in the
// owner's timezone; `daily` repeats at that time every day.
export const setReminderArgsSchema = z.strictObject({
  note: z.string().min(1).max(500).describe('What to remind the owner about, in their words.'),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe("When, as YYYY-MM-DDTHH:MM in the owner's local time."),
  repeat: z.enum(['none', 'daily']).default('none').describe('daily repeats at the same local time every day.'),
});
export type SetReminderArgs = z.infer<typeof setReminderArgsSchema>;

export const listRemindersArgsSchema = z.strictObject({});
export type ListRemindersArgs = z.infer<typeof listRemindersArgsSchema>;

export const cancelReminderArgsSchema = z.strictObject({
  id: z.string().min(1).max(100).describe('Reminder id from list_reminders or set_reminder.'),
});
export type CancelReminderArgs = z.infer<typeof cancelReminderArgsSchema>;
