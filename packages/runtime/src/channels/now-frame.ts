import type { GoogleClient } from '../connectors/google';
import { localDayWindow } from '../health/scores/time';
import type { ApprovalItem } from './approvals';
import { readCalendar } from './day-cards';
import { waitingSection } from '../prompt/day-cards';
import { localIso } from './reminders';

// What the owner's day holds right now, for each of their own messages: the rest of today's calendar, their reminders and the
// cards waiting on them. The open loops and the day's cards already reach every owner turn (standing orders, dayCards), and
// so does their body state (the shared health section); this adds what a Brief reads and a chat turn did not.
// Each section is its own item, so the owner turn admits or drops each on its own. A calendar title, a reminder set while
// reading outside text and an approval's summary can all carry other people's words, so the owner turn shows them as outside
// data; showing them does not taint the turn, as earlier tool results do not.
type Reminder = Readonly<{ note: string; at: string; repeat: string }>;
export type NowFrameSources = Readonly<{
  now: number; timezone: string; calendar: GoogleClient | null; reminders: readonly Reminder[]; waiting: readonly ApprovalItem[];
}>;

const MAX_REMINDERS = 15;

export const nowFrameSections = async ({ now, timezone, calendar, reminders, waiting }: NowFrameSources): Promise<readonly string[]> => {
  const day = localDayWindow(localIso(now, timezone).slice(0, 10), timezone);
  const events = calendar ? await readCalendar({ from: now, to: day.end }, timezone, calendar, false) : '';
  return [
    events ? `The rest of today's calendar (${timezone}):\n${events}` : '',
    reminders.length ? [`Reminders set (${reminders.length}), soonest first:`, ...reminders.slice(0, MAX_REMINDERS).map((reminder) => `- ${reminder.at.replace('T', ' ')}${reminder.repeat === 'none' ? '' : ` (${reminder.repeat})`}: ${reminder.note}`),
      ...(reminders.length > MAX_REMINDERS ? [`- and ${reminders.length - MAX_REMINDERS} more (list_reminders)`] : [])].join('\n') : '',
    waiting.length ? waitingSection(waiting) : '',
  ].filter(Boolean);
};
