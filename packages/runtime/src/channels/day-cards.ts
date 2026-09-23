import { DAY_CARDS, dayCardPrompt, SKIP_CARD, type DayCard } from '../prompt/day-cards';
import type { CalendarItem, GoogleClient } from '../connectors/google';
import type { Scheduler } from '../scheduler/multiplexer';
import { localIso, localToEpoch, nextAfter } from './reminders';

const DAY_MS = 24 * 60 * 60_000;

export const armDayCards = async (scheduler: Scheduler, timezone: string, now: number): Promise<void> => {
  const today = localIso(now, timezone).slice(0, 10);
  for (const card of DAY_CARDS) {
    if (scheduler.read(card.id)) continue;
    const at = nextAfter(localToEpoch(`${today}T${card.time}`, timezone), now);
    await scheduler.schedule({
      id: card.id, kind: 'brief', payloadRefs: { id: card.id }, occurrenceAt: at, dueAt: at,
      recurrence: { type: 'daily_local', time: card.time, timezone },
    });
  }
};

export const cardFor = (id: string): DayCard | null => DAY_CARDS.find((card) => card.id === id) ?? null;

export const cardWindow = (card: DayCard, now: number, timezone: string): Readonly<{ from: number; to: number }> => {
  const midnight = localToEpoch(`${localIso(now, timezone).slice(0, 10)}T00:00`, timezone);
  if (card.calendar === 'today') return { from: midnight, to: midnight + DAY_MS };
  if (card.calendar === 'rest_of_today') return { from: now, to: midnight + DAY_MS };
  return { from: midnight + DAY_MS, to: midnight + 2 * DAY_MS };
};

const eventLine = (event: CalendarItem, timezone: string) =>
  JSON.stringify({ ...event, start: event.all_day ? event.start : localIso(Date.parse(event.start), timezone), end: event.all_day ? event.end : localIso(Date.parse(event.end), timezone) });

export const composeDayCard = async (
  card: DayCard, now: number, timezone: string,
  sources: Readonly<{ google: GoogleClient | null; connectUrl: string | null; ledger: string; today: string }>,
): Promise<string> => {
  const window = cardWindow(card, now, timezone);
  let calendar = sources.connectUrl ? `Google is not connected. The owner can connect it here: ${sources.connectUrl}` : 'Google Calendar is not set up.';
  if (sources.google) {
    try {
      const events = await sources.google.events(new Date(window.from).toISOString(), new Date(window.to).toISOString(), 25, false);
      calendar = events.length ? events.map((event) => eventLine(event, timezone)).join('\n') : 'No events.';
    } catch (error) {
      calendar = `Calendar could not be read right now (${error instanceof Error ? error.message : String(error)}). Say so briefly; do not guess the schedule.`;
    }
  }
  return dayCardPrompt(card, localIso(now, timezone), { calendar, ledger: sources.ledger, today: sources.today });
};

export const isSkip = (text: string): boolean => text.trim() === SKIP_CARD;
