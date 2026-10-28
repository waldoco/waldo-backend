// The owner's day history on the console, read from the app's days view (controls revision 6): the last fourteen days as the app
// Home showed them, and one day at a time with its update cards and the night before it.
import { CHAT_URL, request } from './chat-model';
import type { CardLatest } from './day-cards-model';

export type HistoryCard = { id: string; name: string; state: 'sent' | 'skipped' | 'pending' | 'not_sent' | 'unknown'; latest?: CardLatest | null };
export type HistoryDay = { date: string; complete: boolean; cards: HistoryCard[]; updates_total: number };
export type DaysList = { timezone: string; today: string; history_since: string | null; days: HistoryDay[] };
export type NightRun = { id: string; kind: string; status: string; summary: string | null; started_at: number; ended_at: number | null };
export type DayDetail = {
  timezone: string; date: string; complete: boolean; cards: HistoryCard[];
  updates: { items: CardLatest[]; total: number };
  night: { from: number; to: number; complete: boolean; runs: NightRun[]; total: number };
};

const STATES: readonly string[] = ['sent', 'skipped', 'pending', 'not_sent', 'unknown'];
const unreadable = () => new Error('The day history could not be read.');
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const epoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const latestOf = (value: unknown): CardLatest => {
  if (!object(value) || typeof value.message_id !== 'string' || !value.message_id || !epoch(value.delivered_at) || typeof value.excerpt !== 'string' || !value.excerpt) throw unreadable();
  return { message_id: value.message_id, delivered_at: value.delivered_at, excerpt: value.excerpt };
};
const cardOf = (value: unknown): HistoryCard => {
  if (!object(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.state !== 'string' || !STATES.includes(value.state)) throw unreadable();
  return { id: value.id, name: value.name, state: value.state as HistoryCard['state'], ...(value.latest === undefined ? {} : { latest: value.latest === null ? null : latestOf(value.latest) }) };
};
const dataOf = (value: unknown): Record<string, unknown> => {
  if (!object(value) || value.version !== 1 || value.view !== 'days' || !object(value.data) || typeof value.data.timezone !== 'string') throw unreadable();
  return value.data;
};

export function readDaysList(value: unknown): DaysList {
  const data = dataOf(value);
  if (!day(data.today) || !(data.history_since === null || day(data.history_since)) || !Array.isArray(data.days)) throw unreadable();
  return { timezone: data.timezone as string, today: data.today, history_since: data.history_since, days: data.days.map(entry => {
    if (!object(entry) || !day(entry.date) || typeof entry.complete !== 'boolean' || !Array.isArray(entry.cards) || !Number.isSafeInteger(entry.updates_total)) throw unreadable();
    return { date: entry.date, complete: entry.complete, cards: entry.cards.map(cardOf), updates_total: entry.updates_total as number };
  }) };
}

export function readDayDetail(value: unknown): DayDetail {
  const data = dataOf(value), updates = data.updates, night = data.night;
  if (!day(data.date) || typeof data.complete !== 'boolean' || !Array.isArray(data.cards) || !object(updates) || !Array.isArray(updates.items) || !Number.isSafeInteger(updates.total)
    || !object(night) || !epoch(night.from) || !epoch(night.to) || typeof night.complete !== 'boolean' || !Array.isArray(night.runs) || !Number.isSafeInteger(night.total)) throw unreadable();
  return {
    timezone: data.timezone as string, date: data.date, complete: data.complete, cards: data.cards.map(cardOf),
    updates: { items: updates.items.map(latestOf), total: updates.total as number },
    night: { from: night.from, to: night.to, complete: night.complete, total: night.total as number, runs: night.runs.map(run => {
      if (!object(run) || typeof run.id !== 'string' || typeof run.kind !== 'string' || typeof run.status !== 'string' || !(run.summary === null || typeof run.summary === 'string')
        || !epoch(run.started_at) || !(run.ended_at === null || epoch(run.ended_at))) throw unreadable();
      return { id: run.id, kind: run.kind, status: run.status, summary: run.summary, started_at: run.started_at, ended_at: run.ended_at };
    }) },
  };
}

const CONTRACT = { 'x-waldo-app-contract': 'controls=6' };
export const fetchDaysList = async (signal?: AbortSignal) => readDaysList(await request(`${CHAT_URL}/days`, { signal, headers: CONTRACT }));
export const fetchDayDetail = async (date: string, signal?: AbortSignal) =>
  readDayDetail(await request(`${CHAT_URL}/days?${new URLSearchParams({ date })}`, { signal, headers: CONTRACT }));

/** A calendar day as "Tue 27 Oct". The date is the owner's own local day, so it is drawn as a date, never moved by a zone. */
export const dayLabel = (date: string) => {
  const [year, month, dom] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(year, month - 1, dom)));
};

/** What "Chat about this" puts in the composer: which card and day, and its opening words, so Waldo can find it in Main chat. Nothing is sent. */
export const chatSeed = (card: HistoryCard, date: string): string => {
  const opening = card.latest?.excerpt.split('\n').find(line => line.trim())?.trim();
  const quoted = opening ? ` ("${opening.length > 80 ? `${opening.slice(0, 79).trimEnd()}…` : opening}")` : '';
  return `About ${card.name} on ${dayLabel(date)}${quoted}: `;
};
