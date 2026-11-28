import { endRunArgsSchema, type EndRunArgs, type RunEndOutcome } from '@waldo/contracts';
import { SKIP_UPDATE } from '../prompt/skip-update';

// How a run closed, recorded once on every return of the tool loop: the end the model chose with end_run, or else what the
// loop saw. replied: words with no end chosen, sent as they are. no_reply: no words at all, which no caller reads as a choice.
// handed_off: the loop's last call carried the result (a Mac request, a task worker's finish_task).
export type RunClosedReason = RunEndOutcome | 'replied' | 'no_reply' | 'budget_exhausted' | 'time_exhausted' | 'handed_off';
export type RunEnd = Readonly<{ reason: RunClosedReason; why?: string }>;

export const END_RUN_TOOL = 'end_run';

// The loop's reply for an end that sends nothing now. The callers that deliver a run Waldo started test the reply with
// sendsNothing; the model is never asked to type it. A model that types it anyway is read as the same end.
export const NOTHING_TO_SEND = SKIP_UPDATE;
export const sendsNothing = (reply: string): boolean => reply.trim() === NOTHING_TO_SEND;

// The words of an end_run call the dispatcher already admitted; null for any other call.
export const chosenEnd = (name: string, argumentsJson: string): EndRunArgs | null => {
  if (name !== END_RUN_TOOL) return null;
  try {
    const parsed = endRunArgsSchema.safeParse(JSON.parse(argumentsJson));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
};

export const replyOfEnd = (end: EndRunArgs): string => end.message ?? NOTHING_TO_SEND;

// A loop that returned without an end_run call. One its rounds or time closed is recorded as that, whether or not the model
// had words for its closing step.
export const unchosenEnd = (words: string, exhausted?: 'budget_exhausted' | 'time_exhausted'): RunEnd =>
  exhausted !== undefined ? { reason: exhausted }
    : !words.trim() ? { reason: 'no_reply' }
      : sendsNothing(words) ? { reason: 'nothing_to_send', why: 'typed' }
        : { reason: 'replied' };

// The line a run Waldo starts ends its instructions with.
export const RUN_END_INSTRUCTION = 'End this run with end_run, choosing how it ends: send (message: what the owner should hear now), ask_owner (message: the one question only they can answer), follow_up (nothing now; first set the reminder or loop that brings it back), or nothing_to_send (they gain nothing from hearing from you now). Give the reason in a short line; the owner never sees it.';
