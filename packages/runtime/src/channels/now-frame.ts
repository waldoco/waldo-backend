import type { ApprovalItem } from './approvals';
import { waitingSection } from '../prompt/day-cards';

// What the owner's day holds right now, for each of their own messages: their reminders and the cards waiting on them. The
// open loops and the day's cards already reach every owner turn (standing orders, dayCards), and so does their body state
// (the shared health section). Today's calendar is not read here: a live read on every message would share the Google
// client's grant probes and re-auth notices with the model's own reads, so the model reads it with its calendar tools.
// Each section is its own item, so the owner turn admits or drops each on its own. A reminder set while reading outside text
// and an approval's summary can carry other people's words, so the owner turn shows them as outside data; showing them does
// not taint the turn, as earlier tool results do not.
type Reminder = Readonly<{ note: string; at: string; repeat: string }>;
export type NowFrameSources = Readonly<{ reminders: readonly Reminder[]; waiting: readonly ApprovalItem[] }>;

const MAX_REMINDERS = 15;

export const nowFrameSections = ({ reminders, waiting }: NowFrameSources): readonly string[] => [
  reminders.length ? [`Reminders set (${reminders.length}), soonest first:`, ...reminders.slice(0, MAX_REMINDERS).map((reminder) => `- ${reminder.at.replace('T', ' ')}${reminder.repeat === 'none' ? '' : ` (${reminder.repeat})`}: ${reminder.note}`),
    ...(reminders.length > MAX_REMINDERS ? [`- and ${reminders.length - MAX_REMINDERS} more (list_reminders)`] : [])].join('\n') : '',
  waiting.length ? waitingSection(waiting) : '',
].filter(Boolean);
