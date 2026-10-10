import { z } from 'zod';
import { iso8601Schema } from '../../core/error';

// A proposed change to the owner's own calendar (owner queue slice 3). Proposal only: the
// write happens after the owner approves it.
export const proposeCalendarChangeArgsSchema = z.strictObject({
  account: z.email().optional(),
  calendar_id: z.string().trim().min(1).max(1024).optional(),
  action: z.enum(['create', 'move', 'cancel']),
  event_id: z.string().min(1).max(200).optional().describe('Required for move and cancel; from query_calendar.'),
  title: z.string().min(1).max(200).optional(),
  start: z.union([iso8601Schema, z.iso.date()]).optional(),
  end: z.union([iso8601Schema, z.iso.date()]).optional(),
  attendees: z.array(z.email()).min(1).max(50).optional(),
  send_updates: z.enum(['all', 'externalOnly', 'none']).optional(),
  description: z.string().max(2000).optional(),
  location: z.string().max(1000).optional(),
  reason: z.string().min(1).max(300).describe('Why, in a few words, for the owner.'),
}).refine((args) => args.action === 'create' ? Boolean(args.title && args.start && args.end) : Boolean(args.event_id), {
  error: 'create needs title, start and end; move and cancel need event_id',
}).refine((args) => args.action !== 'move' || Boolean(args.start && args.end), { error: 'move needs start and end' })
  .refine(args => !args.start || !args.end || (args.start.includes('T') === args.end.includes('T') && Date.parse(args.start) < Date.parse(args.end)), { error: 'Calendar endpoints must have the same date/instant semantics and a positive duration' })
  .refine(args => args.action === 'create' || args.attendees === undefined && args.description === undefined && args.location === undefined, { error: 'Move/cancel preserve existing event audience and content' })
  .refine(args => args.attendees === undefined || args.send_updates !== undefined && new Set(args.attendees.map(email => email.toLowerCase())).size === args.attendees.length, { error: 'Invitees require a unique explicit audience and notification choice' });
export type ProposeCalendarChangeArgs = z.infer<typeof proposeCalendarChangeArgsSchema>;
