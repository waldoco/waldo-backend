import { DAY_CARDS, dayCardPrompt, SKIP_CARD, type CardId, type DayCard } from '../prompt/day-cards';
import type { CalendarItem, GoogleClient } from '../connectors/google';
import type { Scheduler } from '../scheduler/multiplexer';
import { localIso, localToEpoch } from './reminders';

const DAY_MS = 24 * 60 * 60_000;

type Sql = Pick<SqlStorage, 'exec'>;
export type CardPlan = Readonly<{ card: CardId; time: string | null; reason: string }>;

// The day_plan hop is whitelisted for the gated trace sinks, so its detail must stay
// content-free: planned times reveal the owner's daily schedule, so the trace keeps the count.
export const dayPlanTraceDetail = (plans: readonly CardPlan[]): string => `${plans.length} planned`;

export const isClock = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export const cardFor = (id: string): DayCard | null => DAY_CARDS.find((card) => card.id === id) ?? null;

export const dayPlanBook = (sql: Sql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS day_plan (
    day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, card))`);
  sql.exec('CREATE TABLE IF NOT EXISTS card_pins (card TEXT PRIMARY KEY, time TEXT NOT NULL)');
  return {
    pins(): Readonly<Record<string, string>> {
      return Object.fromEntries(sql.exec<{ card: string; time: string }>('SELECT card, time FROM card_pins').toArray().map((row) => [row.card, row.time]));
    },
    pin(card: CardId, time: string | null): void {
      if (time === null) sql.exec('DELETE FROM card_pins WHERE card = ?', card);
      else sql.exec('INSERT INTO card_pins (card, time) VALUES (?, ?) ON CONFLICT (card) DO UPDATE SET time = excluded.time', card, time);
    },
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
    // Quiet-hours hold (H1b): sent=2 records "held", never "sent" - a held card stays truthfully
    // unsent until the heartbeat's release re-arms it and the real send marks sent=1. The
    // WHERE sent = 0 guard keeps a card that already genuinely sent from regressing to held.
    held(day: string, card: CardId): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?, ?, NULL, 'held: quiet hours', 2)
         ON CONFLICT (day, card) DO UPDATE SET sent = 2 WHERE sent = 0`,
        day, card,
      );
    },
    heldToday(day: string): readonly CardId[] {
      return sql.exec<{ card: CardId }>('SELECT card FROM day_plan WHERE day = ? AND sent = 2 ORDER BY card', day).toArray().map((row) => row.card);
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
  scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number, plan: readonly CardPlan[], respectPins = true,
): Promise<readonly CardPlan[]> => {
  const pins = respectPins ? book.pins() : {};
  const day = localIso(now, timezone).slice(0, 10);
  const pending = new Set(book.pending(day).map((card) => card.id));
  const applied: CardPlan[] = [];
  for (const planned of plan) {
    const pinned = pins[planned.card];
    const entry: CardPlan = pinned ? { card: planned.card, time: pinned, reason: 'pinned by you' } : planned;
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
  window: Readonly<{ from: number; to: number }>, timezone: string, google: GoogleClient | null, connectable: boolean,
): Promise<string> => {
  if (!google) return connectable ? 'Google is not connected, so there are no events to show. The owner can ask you to connect it; do not write a link.' : 'Google Calendar is not set up.';
  try {
    const events = await google.events(new Date(window.from).toISOString(), new Date(window.to).toISOString(), 25, false);
    return events.length ? events.map((event) => eventLine(event, timezone)).join('\n') : 'No events.';
  } catch (error) {
    return `Calendar could not be read right now (${error instanceof Error ? error.message : String(error)}). Say so briefly; do not guess the schedule.`;
  }
};

export const composeDayCard = async (
  card: DayCard, now: number, timezone: string,
  sources: Readonly<{ google: GoogleClient | null; connectable: boolean; ledger: string; today: string; updates: string }>,
): Promise<string> => {
  const calendar = await readCalendar(cardWindow(card, now, timezone), timezone, sources.google, sources.connectable);
  return dayCardPrompt(card, localIso(now, timezone), { calendar, ledger: sources.ledger, today: sources.today, updates: sources.updates });
};

export const isSkip = (text: string): boolean => text.trim() === SKIP_CARD;
