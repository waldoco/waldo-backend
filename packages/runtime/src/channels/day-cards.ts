import { DAY_CARDS, dayCardPrompt, SKIP_CARD, type CardId, type DayCard } from '../prompt/day-cards';
import type { CalendarItem, GoogleClient } from '../connectors/google';
import type { Scheduler } from '../scheduler/multiplexer';
import { localIso, localToEpoch } from './reminders';

const DAY_MS = 24 * 60 * 60_000;

type Sql = Pick<SqlStorage, 'exec'>;
export type CardPlan = Readonly<{ card: CardId; time: string | null; reason: string }>;

const isClock = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export const cardFor = (id: string): DayCard | null => DAY_CARDS.find((card) => card.id === id) ?? null;

export const dayPlanBook = (sql: Sql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS day_plan (
    day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, card))`);
  return {
    read(day: string): readonly Readonly<{ card: CardId; time: string | null; reason: string; sent: boolean }>[] {
      return sql.exec<{ card: CardId; time: string | null; reason: string; sent: number }>(
        'SELECT card, time, reason, sent FROM day_plan WHERE day = ? ORDER BY card', day,
      ).toArray().map((row) => ({ ...row, sent: row.sent === 1 }));
    },
    pending(day: string): readonly DayCard[] {
      const sent = new Set(this.read(day).filter((row) => row.sent).map((row) => row.card));
      return DAY_CARDS.filter((card) => !sent.has(card.id));
    },
    save(day: string, plan: CardPlan): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT (day, card) DO UPDATE SET time = excluded.time, reason = excluded.reason WHERE sent = 0`,
        day, plan.card, plan.time, plan.reason,
      );
    },
    sent(day: string, card: CardId): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?, ?, NULL, 'sent', 1)
         ON CONFLICT (day, card) DO UPDATE SET sent = 1`,
        day, card,
      );
    },
  };
};
export type DayPlanBook = ReturnType<typeof dayPlanBook>;

export const defaultPlan = (cards: readonly DayCard[]): readonly CardPlan[] =>
  cards.map((card) => ({ card: card.id, time: card.defaultTime, reason: 'default time' }));

export const parseDayPlan = (raw: string, cards: readonly DayCard[]): readonly CardPlan[] => {
  const { cards: planned } = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { cards?: unknown };
  if (!Array.isArray(planned)) throw new Error('day plan has no cards');
  const byId = new Map(planned.map((entry: { id?: unknown; time?: unknown; reason?: unknown }) => [entry?.id, entry]));
  return cards.map((card) => {
    const entry = byId.get(card.id);
    const time = typeof entry?.time === 'string' ? entry.time.trim() : '';
    const reason = typeof entry?.reason === 'string' && entry.reason ? entry.reason : 'no reason given';
    if (time === 'skip') return { card: card.id, time: null, reason };
    if (isClock(time)) return { card: card.id, time, reason };
    return { card: card.id, time: card.defaultTime, reason: `default time (planned value "${time}" was not HH:MM)` };
  });
};

export const applyDayPlan = async (
  scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number, plan: readonly CardPlan[],
): Promise<readonly CardPlan[]> => {
  const day = localIso(now, timezone).slice(0, 10);
  const pending = new Set(book.pending(day).map((card) => card.id));
  const applied: CardPlan[] = [];
  for (const entry of plan) {
    if (!pending.has(entry.card)) continue;
    book.save(day, entry);
    const at = entry.time === null ? null : localToEpoch(`${day}T${entry.time}`, timezone);
    if (at === null || at <= now) await scheduler.cancel(entry.card);
    else await scheduler.schedule({ id: entry.card, kind: 'brief', payloadRefs: { id: entry.card }, occurrenceAt: at, dueAt: at, recurrence: null });
    applied.push(entry);
  }
  return applied;
};

export const armDayCards = async (scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number): Promise<boolean> => {
  const day = localIso(now, timezone).slice(0, 10);
  if (book.read(day).length > 0) return false;
  await applyDayPlan(scheduler, book, timezone, now, defaultPlan(DAY_CARDS));
  return true;
};

export const dayWindow = (now: number, timezone: string): Readonly<{ from: number; to: number }> => {
  const midnight = localToEpoch(`${localIso(now, timezone).slice(0, 10)}T00:00`, timezone);
  return { from: midnight, to: midnight + DAY_MS };
};

export const cardWindow = (card: DayCard, now: number, timezone: string): Readonly<{ from: number; to: number }> => {
  const { from: midnight } = dayWindow(now, timezone);
  if (card.calendar === 'today') return { from: midnight, to: midnight + DAY_MS };
  if (card.calendar === 'rest_of_today') return { from: now, to: midnight + DAY_MS };
  return { from: midnight + DAY_MS, to: midnight + 2 * DAY_MS };
};

const eventLine = (event: CalendarItem, timezone: string) =>
  JSON.stringify({ ...event, start: event.all_day ? event.start : localIso(Date.parse(event.start), timezone), end: event.all_day ? event.end : localIso(Date.parse(event.end), timezone) });

export const readCalendar = async (
  window: Readonly<{ from: number; to: number }>, timezone: string, google: GoogleClient | null, connectUrl: string | null,
): Promise<string> => {
  if (!google) return connectUrl ? `Google is not connected. The owner can connect it here: ${connectUrl}` : 'Google Calendar is not set up.';
  try {
    const events = await google.events(new Date(window.from).toISOString(), new Date(window.to).toISOString(), 25, false);
    return events.length ? events.map((event) => eventLine(event, timezone)).join('\n') : 'No events.';
  } catch (error) {
    return `Calendar could not be read right now (${error instanceof Error ? error.message : String(error)}). Say so briefly; do not guess the schedule.`;
  }
};

export const composeDayCard = async (
  card: DayCard, now: number, timezone: string,
  sources: Readonly<{ google: GoogleClient | null; connectUrl: string | null; ledger: string; today: string }>,
): Promise<string> => {
  const calendar = await readCalendar(cardWindow(card, now, timezone), timezone, sources.google, sources.connectUrl);
  return dayCardPrompt(card, localIso(now, timezone), { calendar, ledger: sources.ledger, today: sources.today });
};

export const isSkip = (text: string): boolean => text.trim() === SKIP_CARD;
