import { z } from 'zod';

// Open loops (W6): things Waldo took on for the owner, kept until closed so nothing is dropped silently.
export const openLoopArgsSchema = z.strictObject({
  title: z.string().min(1).max(200).describe('What Waldo took on, in a few plain words.'),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/).nullable().default(null).describe("When it is due, as YYYY-MM-DD or YYYY-MM-DDTHH:MM in the owner's local time, or null."),
});
export type OpenLoopArgs = z.infer<typeof openLoopArgsSchema>;

export const closeLoopArgsSchema = z.strictObject({
  id: z.string().min(1).max(100).describe('Loop id from the ledger or open_loop.'),
  outcome: z.enum(['done', 'dropped']).describe('done when it was finished, dropped when the owner no longer wants it.'),
});
export type CloseLoopArgs = z.infer<typeof closeLoopArgsSchema>;

// Owner-set proactivity (W6). Quiet hours hold every unrequested message; owner-set reminders still fire.
export const setProactivityArgsSchema = z.strictObject({
  quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().describe('Local HH:MM when quiet hours start, or null for none.'),
  quiet_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().describe('Local HH:MM when quiet hours end, or null for none.'),
  volume: z.enum(['low', 'normal', 'high']).describe('low: only the main day cards. normal: plus updates that change the day. high: plus smaller useful updates.'),
});
export type SetProactivityArgs = z.infer<typeof setProactivityArgsSchema>;
