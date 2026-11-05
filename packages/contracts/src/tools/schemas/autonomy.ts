import { z } from 'zod';
import { AUTONOMY_GRANT_MAX_DAYS, autonomyClassV1Schema } from '../../app/autonomy';

const localTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
// What Waldo asks the owner to let it do without a card. Only Waldo's own blocks on the primary calendar can be asked for now;
// the host fills the start, the end from `days` and the owner's time zone, and raises one card the owner approves before any
// grant exists.
export const proposeStandingGrantArgsSchema = z.strictObject({
  class: z.literal('calendar.move_own_block').describe("Place, move or remove focus blocks Waldo itself created on the owner's primary calendar, with no guests."),
  account: z.email().optional().describe('The Google account whose primary calendar; leave out for the one connected.'),
  window: z.strictObject({ from: localTime, to: localTime }).refine(({ from, to }) => from < to, 'the window ends after it starts')
    .describe("Owner-local HH:MM hours the blocks may sit in, as the owner said or their working day."),
  weekdays: z.array(z.int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length, 'weekdays repeat')
    .describe('Days the blocks may sit on, 0 Sunday to 6 Saturday.'),
  min_lead_minutes: z.int().min(5).max(240).default(30).describe('How far ahead of a block Waldo may still place or move it.'),
  max_per_day: z.int().min(1).max(20).default(3).describe('At most this many changes a day.'),
  days: z.int().min(1).max(AUTONOMY_GRANT_MAX_DAYS).default(30).describe('How many days the grant lasts.'),
});
export type ProposeStandingGrantArgs = z.infer<typeof proposeStandingGrantArgsSchema>;

// Narrowing authority never needs a card: every active grant of the class ends now.
export const revokeStandingGrantArgsSchema = z.strictObject({
  class: autonomyClassV1Schema.describe('Which kind of thing Waldo should stop doing on its own.'),
});
export type RevokeStandingGrantArgs = z.infer<typeof revokeStandingGrantArgsSchema>;

export const pauseAutonomyArgsSchema = z.strictObject({});
export type PauseAutonomyArgs = z.infer<typeof pauseAutonomyArgsSchema>;
