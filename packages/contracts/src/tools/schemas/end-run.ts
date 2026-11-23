import { z } from 'zod';

// end_run: how a run Waldo started (a reminder or check-back, a day card, an update, a finished task's result) ends, as the
// model chooses it. send and ask_owner carry the words the owner gets; nothing_to_send and follow_up send nothing now (a
// follow-up is set with the reminder or loop tools before the run ends). The reason is for the run's own record; the owner
// never sees it. Which end fits is the model's call; the host bounds only the shape.
export const RUN_END_OUTCOMES = ['send', 'ask_owner', 'nothing_to_send', 'follow_up'] as const;
export const runEndOutcomeSchema = z.enum(RUN_END_OUTCOMES);
export type RunEndOutcome = z.infer<typeof runEndOutcomeSchema>;
export const END_RUN_REASON_MAX_CHARS = 200;
export const END_RUN_MESSAGE_MAX_CHARS = 8_000;

export const endRunArgsSchema = z.strictObject({
  outcome: runEndOutcomeSchema,
  reason: z.string().trim().min(1).max(END_RUN_REASON_MAX_CHARS),
  message: z.string().trim().min(1).max(END_RUN_MESSAGE_MAX_CHARS).optional(),
}).refine((args) => (args.outcome === 'send' || args.outcome === 'ask_owner') === (args.message !== undefined), {
  error: 'message goes with send and ask_owner, and only with them',
  path: ['message'],
});
export type EndRunArgs = z.infer<typeof endRunArgsSchema>;

export const endRunResultSchema = z.strictObject({ ended: z.literal(true), outcome: runEndOutcomeSchema });
export type EndRunResult = z.infer<typeof endRunResultSchema>;
