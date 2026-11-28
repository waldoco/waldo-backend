import type { ApprovalItem } from './approvals';
import { localDayWindow } from '../health/scores/time';
import { localIso } from './reminders';

// What the owner's day holds right now, for each of their own messages: today's calendar, the reminders they set and how many
// cards wait on them. The open loops and the day's cards already reach every owner turn (standing orders, dayCards), and so
// does their body state (the shared health section). The calendar is what the update sweep last saw (calendar_last_seen, with
// WALDO_DAY_STATE), never a live read: a read on every message would share the Google client's grant probes and re-auth notices
// with the model's own reads.
// The frame carries no one else's words, so it never needs to mark the turn as having read outside content: an event shows only
// its times and how many attend (its title and guests are someone else's words, and query_calendar shows them), a reminder set
// while reading outside text and an approval's summary (which can quote a mail or a page) are counted, not shown, and the
// model reads them with list_reminders and the approval tools, whose results mark the turn as they should.
type Reminder = Readonly<{ note: string; at: string; repeat: string; outside?: true }>;
type SeenTimes = Readonly<{ start: string; end: string; all_day: boolean; attendees?: number }>;
// Today's events as times on the owner's clock; seenDay is the owner day the sweep last read the calendar in full, or null.
export type TodaysCalendar = Readonly<{ events: readonly Readonly<{ from: string; to: string; allDay: boolean; before: boolean; attendees?: number }>[]; day: string; seenDay: string }>;
export type NowFrameSources = Readonly<{ reminders: readonly Reminder[]; waiting: readonly Pick<ApprovalItem, 'kind' | 'state'>[]; calendar?: TodaysCalendar | null }>;

const MAX_EVENTS = 15;
export const todaysCalendar = (seen: readonly SeenTimes[], day: string, timezone: string, seenDay: string | null): TodaysCalendar | null => {
  if (seenDay === null) return null;
  const window = localDayWindow(day, timezone);
  const events = seen.flatMap((event) => {
    if (event.all_day) return event.start <= day && day < event.end ? [{ at: -Infinity, from: '', to: '', allDay: true, before: false, ...(event.attendees ? { attendees: event.attendees } : {}) }] : [];
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (!(start < window.end && end > window.start)) return [];
    const from = Math.max(start, window.start);
    return [{ at: from, from: localIso(from, timezone).slice(11, 16), to: end >= window.end ? '24:00' : localIso(end, timezone).slice(11, 16), allDay: false, before: start < window.start, ...(event.attendees ? { attendees: event.attendees } : {}) }];
  }).sort((a, b) => a.at - b.at).map(({ at: _at, ...event }) => event);
  return { events, day, seenDay };
};

const calendarSection = (calendar: TodaysCalendar): string => {
  const line = (event: TodaysCalendar['events'][number]) => `- ${event.allDay ? 'all day' : `${event.from}-${event.to}`}${event.before ? ' (began the day before)' : ''}${event.attendees ? `, ${event.attendees} attending` : ''}`;
  return [
    `Today's calendar as Waldo last saw it, times only (query_calendar shows titles and who is coming)${calendar.seenDay === calendar.day ? '' : ` (last read in full on ${calendar.seenDay}; changes since are included)`}:`,
    ...(calendar.events.length ? calendar.events.slice(0, MAX_EVENTS).map(line) : ['- nothing on it']),
    ...(calendar.events.length > MAX_EVENTS ? [`- and ${calendar.events.length - MAX_EVENTS} more`] : []),
  ].join('\n');
};

const MAX_REMINDERS = 15;
const STATE_WORDS: Readonly<Record<ApprovalItem['state'], string>> = { open: 'needs their decision', review_only: 'too long to approve on its card', unconfirmed: 'its card is not confirmed delivered', done: 'decided' };

const counted = (counts: ReadonlyMap<string, number>) => [...counts].map(([what, n]) => `${n} ${what}`).join('; ');

export const nowFrameSections = ({ reminders, waiting, calendar }: NowFrameSources): readonly string[] => {
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
    calendar ? calendarSection(calendar) : '',
    reminderLines.length ? [`Reminders set (${reminders.length}), soonest first:`, ...reminderLines].join('\n') : '',
    waiting.length ? `Cards waiting on the owner: ${waiting.length} (${counted(byKind)}). The approval tools show each one.` : '',
  ].filter(Boolean);
};
