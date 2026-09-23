import { z } from 'zod';
import { iso8601Schema } from '../../core/error';

// A proposed change to the owner's own calendar (owner queue slice 3). Proposal only: the
// write happens after the owner approves it.
export const proposeCalendarChangeArgsSchema = z.strictObject({
  action: z.enum(['create', 'move', 'cancel']),
  event_id: z.string().min(1).max(200).optional().describe('Required for move and cancel; from query_calendar.'),
  title: z.string().min(1).max(200).optional(),
  start: iso8601Schema.optional(),
  end: iso8601Schema.optional(),
  reason: z.string().min(1).max(300).describe('Why, in a few words, for the owner.'),
}).refine((args) => args.action === 'create' ? Boolean(args.title && args.start && args.end) : Boolean(args.event_id), {
  error: 'create needs title, start and end; move and cancel need event_id',
}).refine((args) => args.action !== 'move' || Boolean(args.start && args.end), { error: 'move needs start and end' });
export type ProposeCalendarChangeArgs = z.infer<typeof proposeCalendarChangeArgsSchema>;
