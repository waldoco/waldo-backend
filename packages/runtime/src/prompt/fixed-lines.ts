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

// The retry's promised time came and still no model answered.
export const retryParkedNotice = (brief: RetryBrief, timezone: string): string =>
  `I still can't reach my model, so I couldn't answer your message from ${ownerTime(brief.said_at, timezone)}. Could you send it again in a little while?`;

// Why a task stopped, as the owner hears it.
export const PARK_WORDS: Readonly<Record<ParkReason, string>> = {
  crashed: 'it stopped unexpectedly several times',
  provider_unavailable: 'no model could be reached for too long',
  uncertain_effect: 'it was interrupted in the middle of a step that cannot safely be repeated',
  deadline: 'it ran out of time',
  brief_changed: 'its instructions changed after it started',
};

// A task's report when no model can write it. A settled job keeps neither its result nor its progress, so the words promise
// nothing that could be read back later.
export const fixedReport = (row: Pick<JobRow, 'brief_json' | 'park_reason'>): string => {
  const title = (JSON.parse(row.brief_json) as TaskBrief).title;
  return row.park_reason
    ? `Your background task "${title}" stopped before it finished, because ${PARK_WORDS[row.park_reason]}. Start it again if you still need it.`
    : `Your background task "${title}" finished, but I couldn't write it up and haven't kept what it found. Start it again when you need it.`;
};

// A long task's progress note.
export const progressNote = (row: Pick<JobRow, 'brief_json' | 'rounds'>): string =>
  `Still working on "${(JSON.parse(row.brief_json) as TaskBrief).title}" in the background (${row.rounds} step${row.rounds === 1 ? '' : 's'} so far). I'll tell you when it's done.`;
