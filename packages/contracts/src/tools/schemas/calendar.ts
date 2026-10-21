import { z } from 'zod';
import { iso8601Schema } from '../../core/error';

// A proposed change to the owner's own calendar (owner queue slice 3). Proposal only: the
// write happens after the owner approves it.
export const proposeCalendarChangeArgsSchema = z.strictObject({
  account: z.email().optional(),
  action: z.enum(['create', 'move', 'cancel']),
  event_id: z.string().min(1).max(200).optional().describe('Required for move and cancel; from query_calendar.'),
  title: z.string().min(1).max(200).optional(),
  start: iso8601Schema.optional(),
  end: iso8601Schema.optional(),
  reason: z.string().min(1).max(300).describe('Why, in a few words, for the owner.'),
  calendar_id: z.string().min(1).max(254).optional().describe('From query_calendar list_calendars; omit for the primary calendar.'),
  attendees: z.array(z.email()).min(1).max(50).optional().describe('Create only: guests to invite.'),
  description: z.string().min(1).max(2_000).optional().describe('Create only: notes on the event.'),
  location: z.string().min(1).max(300).optional().describe('Create only.'),
  add_meet_link: z.boolean().optional().describe('Create only: add a Google Meet link.'),
  send_updates: z.enum(['all', 'none']).optional().describe('Whether Google emails the guests about this change. Required with attendees.'),
}).refine((args) => args.action === 'create' ? Boolean(args.title && args.start && args.end) : Boolean(args.event_id), {
  error: 'create needs title, start and end; move and cancel need event_id',
}).refine((args) => args.action !== 'move' || Boolean(args.start && args.end), { error: 'move needs start and end' })
  .refine((args) => args.action === 'create' || (args.attendees === undefined && args.description === undefined && args.location === undefined && args.add_meet_link === undefined), {
    error: 'attendees, description, location and add_meet_link are for create only',
  })
  .refine((args) => args.attendees === undefined || args.send_updates !== undefined, { error: 'say whether to email the attendees: send_updates all or none' });
export type ProposeCalendarChangeArgs = z.infer<typeof proposeCalendarChangeArgsSchema>;
