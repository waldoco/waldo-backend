import { z } from 'zod';
import { iso8601Schema } from '../../core/error';
import { replacesApprovalSchema } from './approvals';

// A proposed change to the owner's own calendar (owner queue slice 3). Proposal only: the
// write happens after the owner approves it.
export const proposeCalendarChangeArgsSchema = z.strictObject({
  account: z.email().optional(),
  action: z.enum(['create', 'move', 'cancel']),
  event_id: z.string().min(1).max(200).optional().describe('Required for move and cancel; from query_calendar.'),
  title: z.string().min(1).max(200).optional(),
  rename_to: z.string().min(1).max(200).optional().describe('Move only: a new title for the event, to swap it for something else in the same slot (a hard session for an easy one). Keep the times as they are to only rename it. title still names the event as it is now.'),
  start: iso8601Schema.optional(),
  end: iso8601Schema.optional(),
  reason: z.string().min(1).max(300).describe('Why, in a few words, for the owner.'),
  calendar_id: z.string().min(1).max(254).optional().describe('From query_calendar list_calendars; omit for the primary calendar.'),
  attendees: z.array(z.email()).min(1).max(50).optional().describe('Create only: guests to invite.'),
  description: z.string().min(1).max(2_000).optional().describe('Create only: notes on the event.'),
  location: z.string().min(1).max(300).optional().describe('Create only.'),
  add_meet_link: z.boolean().optional().describe('Create only: add a Google Meet link.'),
  send_updates: z.enum(['all', 'none']).optional().describe('Whether Google emails the guests about this change. Required with attendees.'),
  block: z.enum(['rest', 'deep_work']).optional().describe('Create only, for a block of protected time: rest (a break, recovery or a lighter stretch) or deep_work (focused work). Leave it out for any other event.'),
  replaces: replacesApprovalSchema,
}).refine((args) => args.action === 'create' ? Boolean(args.title && args.start && args.end) : Boolean(args.event_id), {
  error: 'create needs title, start and end; move and cancel need event_id',
}).refine((args) => args.action === 'move' || args.rename_to === undefined, { error: 'rename_to is for move only' }).refine((args) => args.action !== 'move' || Boolean(args.start && args.end), { error: 'move needs start and end' })
  .refine((args) => args.action === 'create' || (args.attendees === undefined && args.description === undefined && args.location === undefined && args.add_meet_link === undefined && args.block === undefined), {
    error: 'attendees, description, location, add_meet_link and block are for create only',
  })
  .refine((args) => args.attendees === undefined || args.send_updates !== undefined, { error: 'say whether to email the attendees: send_updates all or none' });
export type ProposeCalendarChangeArgs = z.infer<typeof proposeCalendarChangeArgsSchema>;

// A day plan for one card (approvals revision 9): new blocks on the owner's own primary calendar, in their local time on one
// day. Proposal only: the owner's tap adds every block or none.
const localClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
export const proposeCalendarPlanArgsSchema = z.strictObject({
  account: z.email().optional(),
  day: z.iso.date().describe("The owner's local day, YYYY-MM-DD."),
  blocks: z.array(z.strictObject({
    title: z.string().min(1).max(200),
    start: localClock.describe('Local time.'),
    end: localClock.describe('Local time, after start.'),
    block: z.enum(['rest', 'deep_work']).optional(),
  })).min(2).max(12).describe('New blocks only, in time order; not events already on the calendar.'),
  reason: z.string().min(1).max(300).describe('Why, in a few words, for the owner.'),
  replaces: replacesApprovalSchema,
}).refine(({ blocks }) => blocks.every(({ start, end }) => start < end), { error: 'each block ends after it starts', path: ['blocks'] })
  .refine(({ blocks }) => blocks.every((block, index) => index === 0 || blocks[index - 1]!.end <= block.start), { error: 'blocks run in time order without overlapping', path: ['blocks'] });
export type ProposeCalendarPlanArgs = z.infer<typeof proposeCalendarPlanArgsSchema>;
