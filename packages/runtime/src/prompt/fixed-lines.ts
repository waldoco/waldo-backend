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
  return `Something kept going wrong while I answered your message from ${said}, so it is still unanswered. Could you send it again?`;
};

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

// A long task's progress note.
export const progressNote = (row: Pick<JobRow, 'brief_json' | 'rounds'>, timezone: string): string => {
  const { title, started } = taskName(row, timezone);
  const name = title === null ? `the background task you started at ${started}` : `"${title}" in the background`;
  return `Still working on ${name} (${row.rounds} step${row.rounds === 1 ? '' : 's'} so far). I'll tell you when it's done.`;
};
