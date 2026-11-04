import type { JobRow, ParkReason, RetryBrief, TaskBrief } from '../tasks/jobs';

// The fixed owner-facing lines of background tasks and retried turns: the only words the owner gets that no model wrote,
// because no model could be reached or none is needed. They follow the voice in messaging-behavior.ts (plain, short, no
// apology padding, no numbers beyond a time) and belong to it.

// The owner's local wall-clock time, as these lines say it.
export const ownerTime = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));

// The floor reply when every provider failed on the owner's message: a time the retry keeps.
export const floorReplyText = (promised: number, timezone: string): string =>
  `I can't answer properly right now. I'll come back to you by ${ownerTime(promised, timezone)}.`;

// A retry that stopped without answering, said for why it stopped: no model by the promised time, a wake that came only after
// it, or a run that kept failing.
export const retryParkedNotice = (brief: RetryBrief, timezone: string, reason: ParkReason): string => {
  const said = ownerTime(brief.said_at, timezone);
  if (reason === 'provider_unavailable') return `I still can't reach my model, so I couldn't answer your message from ${said}. Could you send it again in a little while?`;
  if (reason === 'deadline') return `I couldn't get back to you by ${ownerTime(brief.promised_by, timezone)} as I said, so your message from ${said} is still unanswered. Could you send it again?`;
  // The turn holds the owner's tools and was lost partway, so it may have acted: asking for the message again could do it twice.
  if (reason === 'uncertain_effect') return `I was interrupted partway through answering your message from ${said}, so I can't tell what I'd already done about it. Check before you send it again.`;
  return `Something kept going wrong while I answered your message from ${said}, so it is still unanswered. Could you send it again?`;
};

// An owner turn that stopped before it finished, said as retryParkedNotice says its own uncertain stop, naming what to look
// at. Each keeps what is known: a change may still go through, may already have gone through, or a result was saved unsent.
const CHANGING = 'anything I was changing for you, such as your calendar, sent mail or reminders';
export const INTERRUPTED_NOTICES = {
  unfinished: `I was interrupted partway through your message, so I can't tell what I'd already done about it, and a change I'd started may still go through. Check ${CHANGING} before you send it again.`,
  stopped: `Stopped. A change I'd already started may still go through, so check ${CHANGING}.`,
  uncertain: `I was interrupted partway through your message, so I can't tell what I'd already done about it, and some of it may already have gone through. Check ${CHANGING} before you send it again.`,
  unconfirmed: 'The task ran out of time before I could confirm its result reached you. The result may already be saved privately, so I didn\'t send it unconfirmed or run the work again. Check for that saved result before you ask again.',
  steer: `I used the message you added, but I was interrupted before I finished, so I can't tell what I'd already done about it, and a change I'd started may still go through. Check ${CHANGING} before you send it again.`,
} as const;

// Why a task stopped, as the owner hears it.
export const PARK_WORDS: Readonly<Record<ParkReason, string>> = {
  crashed: 'it stopped unexpectedly several times',
  provider_unavailable: 'no model could be reached for too long',
  uncertain_effect: 'it was interrupted in the middle of a step that cannot safely be repeated',
  deadline: 'it ran out of time',
  brief_changed: 'its instructions changed after it started',
};

// How these lines name a task. A title written in a turn that read someone else's words could say anything in Waldo's voice,
// so that task is named by when it started.
const taskName = (row: Pick<JobRow, 'brief_json'>, timezone: string): Readonly<{ title: string | null; started: string }> => {
  const brief = JSON.parse(row.brief_json) as TaskBrief;
  return { title: brief.outside_text ? null : brief.title, started: ownerTime(brief.started_at, timezone) };
};

// A task's report when no model can write it. A settled job keeps neither its result nor its progress, so the words promise
// nothing that could be read back later.
export const fixedReport = (row: Pick<JobRow, 'brief_json' | 'park_reason'>, timezone: string): string => {
  const { title, started } = taskName(row, timezone);
  const name = title === null ? `The background task you started at ${started}` : `Your background task "${title}"`;
  return row.park_reason
    ? `${name} stopped before it finished, because ${PARK_WORDS[row.park_reason]}. Start it again if you still need it.`
    : `${name} finished, but I couldn't write it up and haven't kept what it found. Start it again when you need it.`;
};

// A report whose apply turn was lost partway: that turn holds the owner's tools and may have acted, so it is not run again.
export const interruptedReport = (row: Pick<JobRow, 'brief_json'>, timezone: string): string => {
  const { title, started } = taskName(row, timezone);
  const name = title === null ? `the background task you started at ${started}` : `your background task "${title}"`;
  return `I was interrupted while telling you about ${name}, so I can't tell what I'd already done about it. Check before you start it again.`;
};

// A long task's progress note. A step count is machinery to the owner, and "0 steps" reads as no progress.
export const progressNote = (row: Pick<JobRow, 'brief_json'>, timezone: string): string => {
  const { title, started } = taskName(row, timezone);
  const name = title === null ? `the background task you started at ${started}` : `"${title}"`;
  return `Still working on ${name}. I'll tell you when it's done.`;
};
