import { z } from 'zod';
import { APP_QUEST_CHECK_IN_DAYS_MAX_V1, appQuestV1Schema } from '../../app/controls';
import { goalStateSchema } from '../../runtime/goal';

// set_quest starts or changes one of the owner's quests (ADR-0064 GoalRecord): a goal they chose to work toward with Waldo,
// with a plan, where they start against their own usual, a check-in pace and a state. Only the owner's own chat turn may
// call it. On a change, a field left out stays as it is and null clears it.
const questText = z.string().trim().min(1).max(500);
const cleared = <T extends z.ZodType>(field: T) => field.nullable().optional();
export const setQuestArgsSchema = z.strictObject({
  id: appQuestV1Schema.shape.id.optional().describe('The quest to change, as the quests list names it; leave out to start a new one.'),
  title: questText.optional().describe("What the quest is, in the owner's words. Required to start one."),
  plan: cleared(questText).describe('How they will get there, as you agreed it with them.'),
  usual: cleared(questText).describe('Where they start, in words against their own usual.'),
  target: cleared(questText).describe('What done looks like, as they said it.'),
  progress: cleared(questText).describe('How it is going, in words against their own usual.'),
  deadline: cleared(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).describe("The day it ends, YYYY-MM-DD in the owner's own time zone."),
  state: goalStateSchema.optional().describe('active: plan days around it and check in at its pace. ambient: keep it in mind, no check-ins. completed: done or dropped.'),
  check_in_days: cleared(z.int().min(1).max(APP_QUEST_CHECK_IN_DAYS_MAX_V1)).describe('Days between check-ins, as the owner chose (1 daily, 7 weekly); null for none on a schedule.'),
}).refine(args => args.id !== undefined || args.title !== undefined, { error: 'A new quest needs its title', path: ['title'] });
export type SetQuestArgs = z.infer<typeof setQuestArgsSchema>;

export const setQuestResultSchema = z.strictObject({ status: z.enum(['started', 'changed']), quest: appQuestV1Schema });
export type SetQuestResult = z.infer<typeof setQuestResultSchema>;
