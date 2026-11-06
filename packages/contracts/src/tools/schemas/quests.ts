import { z } from 'zod';
import { APP_QUEST_CHECK_IN_DAYS_MAX_V1, appQuestV1Schema } from '../../app/controls';
import { formZoneSchema, recoveryZoneSchema } from '../../health/crs';
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

// A personal experiment inside a quest: one change the owner tries for a bounded number of days, judged keep or drop against
// their own usual. The verdict and its reason are the model's, offered to the owner and recorded on their own chat turn.
export const EXPERIMENT_DAYS_MIN = 7;
export const EXPERIMENT_DAYS_MAX = 28;
export const EXPERIMENT_DAYS_DEFAULT = 14;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (from: string, days: number): string => new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const experimentIdSchema = z.string().regex(/^exp:[a-z0-9]{1,40}$/);
export const experimentStateSchema = z.enum(['running', 'kept', 'dropped', 'stopped']);
const experimentChange = z.string().trim().min(1).max(300);
const experimentDays = z.int().min(EXPERIMENT_DAYS_MIN).max(EXPERIMENT_DAYS_MAX);
export const experimentSchema = z.strictObject({
  id: experimentIdSchema, quest_id: appQuestV1Schema.shape.id, change: experimentChange, state: experimentStateSchema,
  started_on: day, days: experimentDays, ends_on: day, reason: questText.nullable(), decided_on: day.nullable(),
}).refine(e => e.ends_on === addDays(e.started_on, e.days - 1), { error: 'ends_on is the last day of the trial', path: ['ends_on'] })
  .refine(e => e.state !== 'kept' && e.state !== 'dropped' || e.reason !== null && e.decided_on !== null, { error: 'A verdict carries its reason and day', path: ['reason'] });
export type Experiment = z.infer<typeof experimentSchema>;

export const setExperimentArgsSchema = z.strictObject({
  quest_id: appQuestV1Schema.shape.id.optional().describe('The quest to start an experiment in, by its id. Leave out when deciding one.'),
  change: experimentChange.optional().describe("The one change to try, in the owner's words. Required to start one."),
  days: experimentDays.optional().describe(`How many days to try it, ${EXPERIMENT_DAYS_DEFAULT} when left out.`),
  id: experimentIdSchema.optional().describe('The experiment to decide or stop, by its id. Leave out when starting one.'),
  state: z.enum(['kept', 'dropped', 'stopped']).optional().describe('kept or dropped: the verdict the owner agreed to. stopped: ended early without a verdict.'),
  reason: questText.optional().describe('Why it is kept or dropped, against their own usual, in plain words and with its uncertainty. Required for kept and dropped.'),
}).refine(a => a.quest_id !== undefined
  ? a.change !== undefined && a.id === undefined && a.state === undefined && a.reason === undefined
  : a.id !== undefined && a.state !== undefined && a.change === undefined && a.days === undefined && (a.state === 'stopped' || a.reason !== undefined), {
  error: 'Start with quest_id and change, or decide with id, state and (for kept or dropped) reason',
});
export type SetExperimentArgs = z.infer<typeof setExperimentArgsSchema>;
export const setExperimentResultSchema = z.strictObject({ status: z.enum(['started', 'decided']), experiment: experimentSchema });
export type SetExperimentResult = z.infer<typeof setExperimentResultSchema>;

// The comparison counts days by zone word, the trial so far against the same number of days just before it. A day with no
// zone (no row, no consent for model use, or a pillar not computed that day) is none. Scores and readings never appear.
// A day's Recovery reads the night that ended that morning, so Recovery's days run from the morning after the start; Form
// reads the day itself. Recovery is null until the first morning after the start.
const count = z.int().min(0).max(EXPERIMENT_DAYS_MAX);
const zoneDays = <T extends string>(zones: readonly T[]) =>
  z.strictObject({ ...Object.fromEntries(zones.map(zone => [zone, count])) as Record<T, typeof count>, none: count });
const pillarWindow = <T extends string>(zones: readonly T[]) => z.strictObject({ from: day, to: day, days: zoneDays(zones) });
export const experimentWindowSchema = z.strictObject({ recovery: pillarWindow(recoveryZoneSchema.options).nullable(), form: pillarWindow(formZoneSchema.options) });
export type ExperimentWindow = z.infer<typeof experimentWindowSchema>;
export const reviewExperimentArgsSchema = z.strictObject({ id: experimentIdSchema.describe('The experiment to review, by its id.') });
export type ReviewExperimentArgs = z.infer<typeof reviewExperimentArgsSchema>;
export const reviewExperimentResultSchema = z.strictObject({
  experiment: experimentSchema,
  comparison: z.strictObject({ trial: experimentWindowSchema, usual: experimentWindowSchema }).nullable(),
});
export type ReviewExperimentResult = z.infer<typeof reviewExperimentResultSchema>;
