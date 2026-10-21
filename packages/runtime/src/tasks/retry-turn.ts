import { SKIP_UPDATE } from '../prompt/update-cards';
import type { FloorTurn } from '../llm/owner-routes';
import { numericHealthIn } from '../scribe/sanitiser';
import type { JobBook, RetryBrief } from './jobs';

// R-4, the parked retry. When no model provider can answer the owner's own message, the floor reply promises a time, and
// the brain keeps that promise: a retry job, written before the floor text goes out, answers the message once a provider
// is back. If none is by the promised time, the owner hears so then, in fixed words that need no model.

// How long the floor reply promises. Provider incidents mostly clear within minutes; half an hour covers most of them
// without leaving the owner waiting longer than they would wait for a person.
export const RETRY_WINDOW_MS = 30 * 60_000;
// The first retry waits a little: an outage that just failed every provider rarely clears within seconds.
export const RETRY_FIRST_TRY_MS = 2 * 60_000;


// The owner's local wall-clock time, as the floor reply and the notice say it.
export const ownerTime = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

// The promise, rounded up to the next five minutes so the time reads naturally.
export const promisedBy = (now: number): number => Math.ceil((now + RETRY_WINDOW_MS) / 300_000) * 300_000;

export const floorReplyText = (promised: number, timezone: string): string =>
  `I can't answer properly right now. I'll come back to you by ${ownerTime(promised, timezone)}.`;

export const retryParkedNotice = (brief: RetryBrief, timezone: string): string =>
  `I still can't reach my model, so I couldn't answer your message from ${ownerTime(brief.said_at, timezone)}. Could you send it again in a little while?`;

export const retryTurnText = (brief: RetryBrief, timezone: string): string => [
  `[You could not answer the owner's message from ${ownerTime(brief.said_at, timezone)} because no model was reachable then, and you told them you would come back to them by ${ownerTime(brief.promised_by, timezone)}. ${brief.text ? 'Their message, as they wrote it:]' : 'Its text was not kept, because it held health details. It may be in this conversation just before that reply; if it is not, say you could not answer it then and ask them to send it again.]'}`,
  ...(brief.text ? [`<owner_message>\n${brief.text}\n</owner_message>`] : []),
  'Answer it now, saying briefly that this is the late answer. Look at what has happened since first (the conversation after it, and anything already done for it) so nothing is done twice.',
  `If it no longer needs an answer, reply with exactly ${SKIP_UPDATE}.`,
].join('\n\n');

// Writes the retry job for a floor reply and returns the reply text. Synchronous: the provider renders the floor inside its
// own call, so the job row is committed before the promise reaches the owner. One job per owner turn: a second floor in
// the same turn returns the same promise.
export const promiseRetry = (book: JobBook, turn: FloorTurn, timezone: string, now: number): string => {
  const promised = promisedBy(now);
  // The job stores the message so the retry can quote it, unless it carries health values, which a job never stores: then
  // the retry reads it from the conversation, where the owner's turn already put it.
  const text = numericHealthIn(turn.text) ? '' : turn.text;
  const brief: RetryBrief = { message_ref: turn.messageRef ?? turn.traceId, text, conversation_ref: turn.conversationRef, said_at: turn.receivedAt, promised_by: promised };
  const { job } = book.create({
    kind: 'retry_turn', profile: null, idempotencyKey: `retry:${turn.traceId}`, origin: turn.traceId, surface: turn.surface,
    brief, dueAt: now + RETRY_FIRST_TRY_MS, deadlineAt: promised,
  });
  return floorReplyText((JSON.parse(job.brief_json) as RetryBrief).promised_by, timezone);
};
