import { APP_DAY_HISTORY_DAYS_V1, APP_NIGHT_RUNS_MAX_V1, APP_OVERVIEW_PAGE_MAX_V1 } from '../../../contracts/src/app/controls';
import { DAY_CARDS, type CardId } from '../prompt/day-cards';
import type { BackgroundRun, RunBook } from './background-runs';
import { cardDeliveries, latestDelivery, type CardLatest, type DayPlanBook } from './day-cards';
import { localIso, localToEpoch } from './reminders';
import type { UpdateBook } from './update-cards';

type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;

// The first time a build that keeps day history runs for this owner. Days that began before it are shown as incomplete:
// their card pointers and night runs were never kept, and nothing is backfilled.
export const DAY_HISTORY_SINCE_KEY = 'day_history_since_v1';
export const startDayHistory = (kv: Kv, now: number): void => {
  if (kv.get<number>(DAY_HISTORY_SINCE_KEY) === undefined) kv.put(DAY_HISTORY_SINCE_KEY, now);
};

export type DayHistoryDeps = Readonly<{
  book: DayPlanBook; updates: Pick<UpdateBook, 'delivered'>; runs: Pick<RunBook, 'between'>; kv: Kv; timezone: string; now: number;
  // The text the Main chat shows now for each row that still exists, or null when the chat could not be read.
  shown(): Promise<ReadonlyMap<string, string> | null>;
}>;
type HistoryState = 'sent' | 'skipped' | 'pending' | 'not_sent' | 'unknown';
type HistoryCard = Readonly<{ id: CardId; name: string; state: HistoryState; latest?: CardLatest | null }>;
export type DaysList = Readonly<{
  timezone: string; today: string; history_since: string | null;
  days: readonly Readonly<{ date: string; complete: boolean; cards: readonly HistoryCard[]; updates_total: number }>[];
}>;
export type DayDetail = Readonly<{
  timezone: string; date: string; complete: boolean; cards: readonly HistoryCard[];
  updates: Readonly<{ items: readonly CardLatest[]; total: number }>;
  night: Readonly<{ from: number; to: number; complete: boolean; runs: readonly Omit<BackgroundRun, 'parent_id'>[]; total: number }>;
}>;

// Calendar arithmetic on the date itself, so a day across a DST change or a zone change is still one day.
const shiftDay = (day: string, by: number): string => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + by)).toISOString().slice(0, 10);
};
export const historyDays = (now: number, timezone: string): readonly string[] =>
  Array.from({ length: APP_DAY_HISTORY_DAYS_V1 }, (_, back) => shiftDay(localIso(now, timezone).slice(0, 10), -back));

const sinceOf = (kv: Kv): number | undefined => kv.get<number>(DAY_HISTORY_SINCE_KEY);
const keptSince = (since: number | undefined, at: number): boolean => since !== undefined && at >= since;

// The cards planned or delivered on one day, in the order the Home shows them. A card that reached the app is sent even
// before its delivery settles; one that never finished is pending today and not_sent on an earlier day.
const cardsOf = (deps: DayHistoryDeps, day: string, today: string, shown: ReadonlyMap<string, string> | null): readonly HistoryCard[] => {
  const rows = new Map(deps.book.read(day).map(row => [row.card, row]));
  const delivered = cardDeliveries(deps.book, deps.kv, day);
  return DAY_CARDS.flatMap((card): HistoryCard[] => {
    const row = rows.get(card.id), delivery = delivered.get(card.id);
    if (!row && !delivery) return [];
    const state: HistoryState = row?.sent ? row.state === 'sent' || row.state === 'skipped' ? row.state : 'unknown'
      : delivery ? 'sent' : day === today ? 'pending' : 'not_sent';
    const latest = !delivery ? null : shown === null ? undefined : latestDelivery(delivery, shown.get(delivery.message_id));
    return [{ id: card.id, name: card.name, state, ...(latest === undefined ? {} : { latest }) }];
  });
};

// The chat is read once, and only when some card or update on the days read reached it.
const chatFor = async (deps: DayHistoryDeps, days: readonly string[]): Promise<ReadonlyMap<string, string> | null> => {
  const linked = days.some(day => cardDeliveries(deps.book, deps.kv, day).size > 0 || deps.updates.delivered(day).some(row => row.app_row !== null));
  return linked ? deps.shown() : new Map();
};

export const dayHistoryList = async (deps: DayHistoryDeps): Promise<DaysList> => {
  const days = historyDays(deps.now, deps.timezone), since = sinceOf(deps.kv), shown = await chatFor(deps, days);
  return {
    timezone: deps.timezone, today: days[0]!, history_since: since === undefined ? null : localIso(since, deps.timezone).slice(0, 10),
    days: days.map(date => ({
      date, complete: keptSince(since, localToEpoch(`${date}T00:00`, deps.timezone)),
      cards: cardsOf(deps, date, days[0]!, shown), updates_total: deps.updates.delivered(date).length,
    })),
  };
};

// When a card went out, or else when it was planned for, or else its default time, on that day in the owner's zone now.
const cardAt = (deps: DayHistoryDeps, day: string, card: CardId): number => {
  const delivered = cardDeliveries(deps.book, deps.kv, day).get(card);
  if (delivered) return delivered.delivered_at;
  const planned = deps.book.read(day).find(row => row.card === card)?.time;
  return localToEpoch(`${day}T${planned ?? DAY_CARDS.find(entry => entry.id === card)!.defaultTime}`, deps.timezone);
};

// One of the last fourteen days, or null for any other date.
export const dayHistoryDay = async (deps: DayHistoryDeps, date: string): Promise<DayDetail | null> => {
  const days = historyDays(deps.now, deps.timezone);
  if (!days.includes(date)) return null;
  const since = sinceOf(deps.kv), shown = await chatFor(deps, [date]), delivered = deps.updates.delivered(date);
  const from = cardAt(deps, shiftDay(date, -1), 'card:close'), to = Math.max(from, Math.min(cardAt(deps, date, 'card:brief'), deps.now));
  const night = deps.runs.between(from, to, APP_NIGHT_RUNS_MAX_V1);
  return {
    timezone: deps.timezone, date, complete: keptSince(since, localToEpoch(`${date}T00:00`, deps.timezone)),
    cards: cardsOf(deps, date, days[0]!, shown),
    updates: {
      items: delivered.flatMap(row => {
        const latest = row.app_row === null || shown === null ? null : latestDelivery({ message_id: row.app_row, delivered_at: row.delivered_at }, shown.get(row.app_row));
        return latest ? [latest] : [];
      }).slice(0, APP_OVERVIEW_PAGE_MAX_V1),
      total: delivered.length,
    },
    night: { from, to, complete: keptSince(since, from) && night.complete, runs: night.rows.map(({ parent_id: _parent, ...run }) => run), total: night.total },
  };
};
