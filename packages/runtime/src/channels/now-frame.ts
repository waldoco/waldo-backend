import type { ApprovalItem } from './approvals';

// What the owner's day holds right now, for each of their own messages: the reminders they set and how many cards wait on
// them. The open loops and the day's cards already reach every owner turn (standing orders, dayCards), and so does their
// body state (the shared health section). Today's calendar is not read here: a live read on every message would share the
// Google client's grant probes and re-auth notices with the model's own reads, so the model reads it with its calendar tools.
// The frame carries no one else's words, so it never needs to mark the turn as having read outside content: a reminder set
// while reading outside text and an approval's summary (which can quote a mail or a page) are counted, not shown, and the
// model reads them with list_reminders and the approval tools, whose results mark the turn as they should.
type Reminder = Readonly<{ note: string; at: string; repeat: string; outside?: true }>;
export type NowFrameSources = Readonly<{ reminders: readonly Reminder[]; waiting: readonly Pick<ApprovalItem, 'kind' | 'state'>[] }>;

const MAX_REMINDERS = 15;
const STATE_WORDS: Readonly<Record<ApprovalItem['state'], string>> = { open: 'needs their decision', review_only: 'too long to approve on its card', unconfirmed: 'its card is not confirmed delivered', done: 'decided' };

const counted = (counts: ReadonlyMap<string, number>) => [...counts].map(([what, n]) => `${n} ${what}`).join('; ');

export const nowFrameSections = ({ reminders, waiting }: NowFrameSources): readonly string[] => {
  const own = reminders.filter((reminder) => reminder.outside !== true);
  const outside = reminders.length - own.length;
  const reminderLines = [
    ...own.slice(0, MAX_REMINDERS).map((reminder) => `- ${reminder.at.replace('T', ' ')}${reminder.repeat === 'none' ? '' : ` (${reminder.repeat})`}: ${reminder.note}`),
    ...(own.length > MAX_REMINDERS ? [`- and ${own.length - MAX_REMINDERS} more`] : []),
    ...(outside > 0 ? [`- ${outside} set while reading outside content (list_reminders shows them)`] : []),
  ];
  const byKind = new Map<string, number>();
  for (const item of waiting) byKind.set(`${item.kind} (${STATE_WORDS[item.state]})`, (byKind.get(`${item.kind} (${STATE_WORDS[item.state]})`) ?? 0) + 1);
  return [
    reminderLines.length ? [`Reminders set (${reminders.length}), soonest first:`, ...reminderLines].join('\n') : '',
    waiting.length ? `Cards waiting on the owner: ${waiting.length} (${counted(byKind)}). The approval tools show each one.` : '',
  ].filter(Boolean);
};
