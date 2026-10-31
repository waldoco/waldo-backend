import { deriveContextBudgetChars, SANITISE_DESTINATION_POLICIES, WALDO_AUXILIARY_MODEL, type ModelName, type ScheduleEntry } from '@waldo/contracts';
import { turnMemoryPrompt, type ClaimStore } from '../memory/claims';
import { DAY_CARDS, dayCardPrompt, SKIP_CARD, type CardId, type DayCard } from '../prompt/day-cards';
import { calendarPromptProjection, type CalendarItem, type GoogleClient } from '../connectors/google';
import { QUARANTINE_AFTER_ATTEMPTS, type Scheduler } from '../scheduler/multiplexer';
import { ModelUnavailableError } from '../llm/provider';
import { localIso, localToEpoch } from './reminders';
import { APP_CARD_EXCERPT_MAX_V1 } from '../../../contracts/src/app/controls';

const DAY_MS = 24 * 60 * 60_000;

type Sql = Pick<SqlStorage, 'exec'>;
export type CardPlan = Readonly<{ card: CardId; time: string | null; reason: string }>;
export type CardState = 'pending' | 'held' | 'waiting_on_model' | 'sent' | 'skipped';

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
  // Whether a finished card went out or was skipped. Cards finished before the column existed have none.
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(day_plan)').toArray().map(column => column.name));
  if (!columns.has('outcome')) sql.exec('ALTER TABLE day_plan ADD COLUMN outcome TEXT');
  // The Main chat row the card was last delivered to, and when: ids and times only, so the day's history reads the words
  // from the chat as it is now, and a forgotten or deleted row takes them with it.
  if (!columns.has('delivered_message_id')) sql.exec('ALTER TABLE day_plan ADD COLUMN delivered_message_id TEXT');
  if (!columns.has('delivered_at')) sql.exec('ALTER TABLE day_plan ADD COLUMN delivered_at INTEGER');
  // Revisions of a delivered card, when the owner's day changed after it: how many reached the owner, the latest one's time and
  // outbox record, and the Main chat row a revision became when that was the app, with that revision's record. The original
  // delivery stays as it was.
  if (!columns.has('revision')) sql.exec('ALTER TABLE day_plan ADD COLUMN revision INTEGER');
  if (!columns.has('revised_at')) sql.exec('ALTER TABLE day_plan ADD COLUMN revised_at INTEGER');
  if (!columns.has('revised_message_id')) sql.exec('ALTER TABLE day_plan ADD COLUMN revised_message_id TEXT');
  if (!columns.has('revised_record')) sql.exec('ALTER TABLE day_plan ADD COLUMN revised_record TEXT');
  if (!columns.has('revised_row_record')) sql.exec('ALTER TABLE day_plan ADD COLUMN revised_row_record TEXT');
  return {
    pins(): Readonly<Record<string, string>> {
      return Object.fromEntries(sql.exec<{ card: string; time: string }>('SELECT card, time FROM card_pins').toArray().map((row) => [row.card, row.time]));
    },
    pin(card: CardId, time: string | null): void {
      if (time === null) sql.exec('DELETE FROM card_pins WHERE card = ?', card);
      else sql.exec('INSERT INTO card_pins (card, time) VALUES (?, ?) ON CONFLICT (card) DO UPDATE SET time = excluded.time', card, time);
    },
    read(day: string): readonly Readonly<{ card: CardId; time: string | null; reason: string; sent: boolean; state?: CardState }>[] {
      return sql.exec<{ card: CardId; time: string | null; reason: string; sent: number; outcome: 'sent' | 'skipped' | null }>(
        'SELECT card, time, reason, sent, outcome FROM day_plan WHERE day = ? ORDER BY card', day,
      ).toArray().map(({ outcome, ...row }) => {
        const state = row.sent === 1 ? outcome ?? undefined : row.sent === 2 ? 'held' : row.sent === 3 ? 'waiting_on_model' : 'pending';
        return { ...row, sent: row.sent === 1, ...(state ? { state } : {}) };
      });
    },
    // A card's delivery to the app, on the card's own day. It may come before the card is recorded sent, and a Try again's
    // delivery replaces the earlier one.
    delivered(day: string, card: CardId, messageId: string, at: number): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason, delivered_message_id, delivered_at) VALUES (?, ?, NULL, 'sent', ?, ?)
         ON CONFLICT (day, card) DO UPDATE SET delivered_message_id = excluded.delivered_message_id, delivered_at = excluded.delivered_at`,
        day, card, messageId, at,
      );
    },
    deliveries(day: string): ReadonlyMap<string, CardDelivery> {
      return new Map(sql.exec<{ card: string; message_id: string; delivered_at: number }>(
        'SELECT card, delivered_message_id AS message_id, delivered_at FROM day_plan WHERE day = ? AND delivered_message_id IS NOT NULL', day,
      ).toArray().map(({ card, ...delivery }) => [card, delivery]));
    },
    // Whether the card reached the owner today, on any surface, so a change can revise it.
    reached(day: string, card: string): boolean {
      return this.read(day).some(row => row.card === card && row.sent && row.state !== 'skipped');
    },
    revisedRow(day: string, card: CardId, messageId: string, record: string): void {
      sql.exec('UPDATE day_plan SET revised_message_id = ?, revised_row_record = ? WHERE day = ? AND card = ?', messageId, record, day, card);
    },
    // Counted once per outbox record: a settle the outbox repeats after a restart does not count it again.
    revised(day: string, card: CardId, at: number, record: string): void {
      sql.exec(`UPDATE day_plan SET revision = COALESCE(revision, 0) + 1, revised_at = ?, revised_record = ?
        WHERE day = ? AND card = ? AND revised_record IS NOT ?`, at, record, day, card, record);
    },
    // message_id: the newest revision's Main chat row, or null when it reached the owner outside the app.
    revisions(day: string): ReadonlyMap<string, Readonly<{ revision: number; revised_at: number; message_id: string | null }>> {
      return new Map(sql.exec<{ card: string; revision: number; revised_at: number; message_id: string | null }>(
        `SELECT card, revision, revised_at, CASE WHEN revised_row_record = revised_record THEN revised_message_id END AS message_id
         FROM day_plan WHERE day = ? AND revision IS NOT NULL AND revised_at IS NOT NULL`, day,
      ).toArray().map(({ card, ...revision }) => [card, revision]));
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
        `INSERT INTO day_plan (day, card, time, reason, sent, outcome) VALUES (?, ?, NULL, 'sent', 1, 'sent')
         ON CONFLICT (day, card) DO UPDATE SET sent = 1, outcome = 'sent'`,
        day, card,
      );
    },
    // A card that came due and sent nothing finishes for the day as skipped. A card that already finished keeps what it
    // recorded, so a send is never turned into a skip and an unknown outcome is never turned into one.
    skipped(day: string, card: CardId, reason?: string): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason, sent, outcome) VALUES (?, ?, NULL, ?, 1, 'skipped')
         ON CONFLICT (day, card) DO UPDATE SET sent = 1, outcome = CASE WHEN day_plan.sent = 1 THEN day_plan.outcome ELSE 'skipped' END,
           reason = CASE WHEN day_plan.sent = 1 OR ? IS NULL THEN day_plan.reason ELSE ? END`,
        day, card, reason ?? 'skipped', reason ?? null, reason ?? null,
      );
    },
    // No model could write the card: it stays unsent (sent=3) and its schedule row probes again, until the model is back or
    // the card is too late to send.
    waitingOnModel(day: string, card: CardId): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?, ?, NULL, 'waiting on model', 3)
         ON CONFLICT (day, card) DO UPDATE SET sent = 3 WHERE sent <> 1`,
        day, card,
      );
    },
    waitingForModel(day: string): readonly CardId[] {
      return sql.exec<{ card: CardId }>('SELECT card FROM day_plan WHERE day = ? AND sent = 3 ORDER BY card', day).toArray().map((row) => row.card);
    },
    // Quiet-hours hold (H1b): sent=2 records "held", never "sent" - a held card stays truthfully
    // unsent until the heartbeat's release re-arms it and the real send marks sent=1. The
    // WHERE sent = 0 guard keeps a card that already genuinely sent from regressing to held.
    held(day: string, card: CardId): void {
      sql.exec(
        `INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?, ?, NULL, 'held: quiet hours', 2)
         ON CONFLICT (day, card) DO UPDATE SET sent = 2 WHERE sent IN (0, 3)`,
        day, card,
      );
    },
    // A card written and waiting for its surface (WhatsApp outside its window) is no longer held for quiet hours: it stays unsent
    // until it is delivered, and the heartbeat's release does not fire it again.
    waiting(day: string, card: CardId): void {
      sql.exec('UPDATE day_plan SET sent = 0 WHERE day = ? AND card = ? AND sent IN (2, 3)', day, card);
    },
    heldToday(day: string): readonly CardId[] {
      return sql.exec<{ card: CardId }>('SELECT card FROM day_plan WHERE day = ? AND sent = 2 ORDER BY card', day).toArray().map((row) => row.card);
    },
  };
};
export type DayPlanBook = ReturnType<typeof dayPlanBook>;

export const defaultPlan = (cards: readonly DayCard[]): readonly CardPlan[] =>
  cards.map((card) => ({ card: card.id, time: card.defaultTime, reason: 'default time' }));

// A card the reply leaves out or times badly falls back to its default; with `keep`, a re-plan's, it is left as it is.
export const parseDayPlan = (raw: string, cards: readonly DayCard[], keep = false): readonly CardPlan[] => {
  const { cards: planned } = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { cards?: unknown };
  if (!Array.isArray(planned)) throw new Error('day plan has no cards');
  const byId = new Map(planned.map((entry: { id?: unknown; time?: unknown; reason?: unknown }) => [entry?.id, entry]));
  return cards.flatMap((card): CardPlan[] => {
    const entry = byId.get(card.id);
    const time = typeof entry?.time === 'string' ? entry.time.trim() : '';
    const reason = typeof entry?.reason === 'string' && entry.reason ? entry.reason : 'no reason given';
    if (time === 'skip') return [{ card: card.id, time: null, reason }];
    if (isClock(time)) return [{ card: card.id, time, reason }];
    return keep ? [] : [{ card: card.id, time: card.defaultTime, reason: `default time (planned value "${time}" was not HH:MM)` }];
  });
};

export const applyDayPlan = async (
  scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number, plan: readonly CardPlan[], respectPins = true, enabled = true,
): Promise<readonly CardPlan[]> => {
  if (!enabled) { for (const planned of plan) await scheduler.cancelReadable(planned.card); return []; }
  const pins = respectPins ? book.pins() : {};
  const day = localIso(now, timezone).slice(0, 10);
  const pending = new Set(book.pending(day).map((card) => card.id));
  const applied: CardPlan[] = [];
  for (const planned of plan) {
    const pinned = pins[planned.card];
    const entry: CardPlan = pinned ? { card: planned.card, time: pinned, reason: 'pinned by you' } : planned;
    if (!pending.has(entry.card)) continue;
    // A card row this Worker cannot read is left for the Worker that wrote it, and nothing is planned that no row backs.
    if (scheduler.lookup(entry.card).state === 'unreadable') continue;
    book.save(day, entry);
    const at = entry.time === null ? null : localToEpoch(`${day}T${entry.time}`, timezone);
    if (at === null || at <= now) await scheduler.cancel(entry.card);
    else await scheduler.schedule({ id: entry.card, kind: 'brief', payloadRefs: { id: entry.card }, occurrenceAt: at, dueAt: at, recurrence: null });
    applied.push(entry);
  }
  return applied;
};

// The reason a card's time carries when the owner set it for today: a re-plan keeps it, as it keeps a pin.
export const SET_FOR_TODAY = 'set by you for today';
// What a re-plan after today's calendar changed may move: a card the planner timed (or skipped) that is still pending and not
// yet due, with its current time. One the owner set for today or pinned keeps its time, as does a card held for quiet hours,
// waiting on the model, or already sent; a card with no plan yet waits for the day's own plan.
export type MovableCard = Readonly<{ card: DayCard; time: string | null }>;
export const movableCards = (book: DayPlanBook, timezone: string, now: number): readonly MovableCard[] => {
  const day = localIso(now, timezone).slice(0, 10);
  const pins = book.pins();
  const rows = new Map(book.read(day).map(row => [row.card, row]));
  return DAY_CARDS.flatMap((card): MovableCard[] => {
    const row = rows.get(card.id);
    if (!row || row.state !== 'pending' || pins[card.id] || row.reason === SET_FOR_TODAY) return [];
    const at = row.time === null ? null : localToEpoch(`${day}T${row.time}`, timezone);
    return row.time === null || (at !== null && at > now) ? [{ card, time: row.time }] : [];
  });
};
// A re-plan applies only to the cards it may move. A time already past keeps the card where it was: a re-plan moves a card or,
// when the model says so, skips it; it never sends one early by accident or cancels it for being late.
export const applyReplan = async (scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number, plan: readonly CardPlan[],
  movable: readonly MovableCard[], enabled = true): Promise<readonly CardPlan[]> => {
  const day = localIso(now, timezone).slice(0, 10);
  const ids = new Set(movable.map(entry => entry.card.id));
  const ahead = plan.filter(entry => {
    if (!ids.has(entry.card)) return false;
    if (entry.time === null) return true;
    const at = localToEpoch(`${day}T${entry.time}`, timezone);
    return at !== null && at > now;
  });
  return applyDayPlan(scheduler, book, timezone, now, ahead, true, enabled);
};

// One re-plan waits at a time: requests while it waits share it, and a request while it runs queues one more, so the last
// change is always planned on and a burst costs at most two model calls.
export const coalesced = <A,>(enqueue: (job: () => Promise<void>) => void, work: (arg: A) => Promise<void>) => {
  let queued = false;
  return (arg: A): void => {
    if (queued) return;
    queued = true;
    enqueue(() => { queued = false; return work(arg); });
  };
};

export const armDayCards = async (scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number): Promise<boolean> => {
  const day = localIso(now, timezone).slice(0, 10);
  if (book.read(day).length > 0) return false;
  // Nothing seeded (every card unreadable) means nothing to plan, so no plan is asked for on each start.
  return (await applyDayPlan(scheduler, book, timezone, now, defaultPlan(DAY_CARDS))).length > 0;
};

export const dayWindow = (now: number, timezone: string): Readonly<{ from: number; to: number }> => {
  const midnight = localToEpoch(`${localIso(now, timezone).slice(0, 10)}T00:00`, timezone);
  return { from: midnight, to: midnight + DAY_MS };
};

// A card waiting for the owner (WhatsApp outside its 24-hour window) is current until the owner's next card is due, which
// covers the same day with newer facts, and never past its own day. Then it expires unsent: a reply after a quiet stretch
// brings no burst of old cards.
export const cardExpiry = (occurrenceAt: number, timezone: string, laterDue: readonly number[]): number =>
  Math.min(dayWindow(occurrenceAt, timezone).to, ...laterDue.filter(due => due > occurrenceAt));

// How late a card that waited for the model may still go out: the Brief until local midday, the Check-in until the Close is
// due, the Close until quiet hours start. Never past the card's own day.
export type CardFreshness = Readonly<{ closeDue: number | null; quietStart: string | null }>;
export const cardFreshUntil = (card: DayCard, occurrenceAt: number, timezone: string, freshness: CardFreshness): number => {
  const day = localIso(occurrenceAt, timezone).slice(0, 10);
  const end = dayWindow(occurrenceAt, timezone).to;
  const after = (at: number | null) => (at !== null && at > occurrenceAt ? Math.min(at, end) : end);
  if (card.id === 'card:brief') return after(localToEpoch(`${day}T12:00`, timezone));
  if (card.id === 'card:midday') return after(freshness.closeDue);
  return after(freshness.quietStart && isClock(freshness.quietStart) ? localToEpoch(`${day}T${freshness.quietStart}`, timezone) : null);
};

const MODEL_OUTAGE_SKIP: Readonly<Record<CardId, string>> = {
  'card:brief': "Waldo couldn't reach its model this morning",
  'card:midday': "Waldo couldn't reach its model this afternoon",
  'card:close': "Waldo couldn't reach its model this evening",
};

// One scheduled run of a day card. A card that waited for the model and is now too late is skipped with the reason, never
// sent stale. A run no model could answer leaves the card waiting, and the scheduler probes again without counting it.
export const runDayCard = async (input: Readonly<{
  entry: ScheduleEntry; book: DayPlanBook; timezone: string; now: number; freshness: CardFreshness;
  generate: (card: DayCard, day: string) => Promise<void>;
}>): Promise<void | 'waiting_on_model'> => {
  const card = cardFor(input.entry.id);
  if (card === null) return;
  const day = localIso(input.entry.occurrence_at, input.timezone).slice(0, 10);
  const waited = input.book.read(day).some((row) => row.card === card.id && row.state === 'waiting_on_model');
  // A Try again is the owner asking for the card now, so its own run goes ahead whatever the hour. A try that met the outage
  // was parked to a later probe (due after its occurrence) and is judged like any waiting card.
  const asked = input.entry.payload_refs.retry_id !== undefined && input.entry.due_at === input.entry.occurrence_at;
  if (waited && !asked && input.now >= cardFreshUntil(card, input.entry.occurrence_at, input.timezone, input.freshness)) {
    input.book.skipped(day, card.id, MODEL_OUTAGE_SKIP[card.id]);
    return;
  }
  try {
    await input.generate(card, day);
  } catch (error) {
    if (!(error instanceof ModelUnavailableError)) throw error;
    input.book.waitingOnModel(day, card.id);
    return 'waiting_on_model';
  }
};

// The model is back: today's cards still waiting run now. A card past its freshness is skipped when it runs. A row left
// waiting on an earlier day is not resumed, so its id's next occurrence is never pulled forward in its place.
export const resumeWaitingCards = async (scheduler: Scheduler, book: DayPlanBook, timezone: string, now: number): Promise<readonly CardId[]> => {
  const resumed: CardId[] = [];
  for (const card of book.waitingForModel(localIso(now, timezone).slice(0, 10))) if (await scheduler.pullForward(card, now)) resumed.push(card);
  return resumed;
};

export const CARD_RETRIES_PER_DAY = 3;
const RETRIES_KEY = 'day_card_retries_v1';
export type CardRetry = 'started' | 'running' | 'sent' | 'not_needed' | 'limit' | 'unknown_card' | 'unreadable';

// Try again on one of today's cards, as the owner. The card's own schedule row is armed to run now, so the scheduled card
// job writes it and an upsert lifts a quarantine on the row. Each try carries its own retry_id, which keys the card's
// delivery apart from the day's earlier attempt. Only a stuck card is tried (cardStatus gives it tries left); one being made
// now is left alone, so a double tap makes one card. Three tries a day per owner.
export const retryDayCard = async (deps: CardDeps, id: string): Promise<CardRetry> => {
  const card = cardFor(id);
  if (card === null) return 'unknown_card';
  if (deps.scheduler.lookup(card.id).state === 'unreadable') return 'unreadable';
  const day = localIso(deps.now, deps.timezone).slice(0, 10);
  const row = deps.book.read(day).find((planned) => planned.card === card.id);
  // A finished card whose outcome predates recording one is taken as sent: it may have gone out.
  if (row?.sent && row.state !== 'skipped') return 'sent';
  const status = cardStatus(deps, card);
  if (status.state === 'generating') return 'running';
  if (status.retriesLeft === undefined) return 'not_needed';
  if (status.retriesLeft === 0) return 'limit';
  const count = triesUsed(deps.kv, day);
  deps.kv.put(RETRIES_KEY, { day, count: count + 1 });
  await deps.scheduler.schedule({ id: card.id, kind: 'brief', payloadRefs: { id: card.id, retry_id: `${day}.${count + 1}` },
    occurrenceAt: deps.now, dueAt: deps.now, recurrence: null });
  return 'started';
};

// A card is being made when its run is in flight, or a Try again is due now. A try parked to wait for the model is not, so
// the owner may try again.
const inFlight = (scheduler: Scheduler, entry: ScheduleEntry, now: number): boolean =>
  scheduler.runningRunId(entry.id, entry.occurrence_at) !== null
  || (entry.status === 'armed' && entry.payload_refs.retry_id !== undefined && entry.due_at <= now);

const triesUsed = (kv: Kv, day: string): number => {
  const tries = kv.get<{ day: string; count: number }>(RETRIES_KEY);
  return tries?.day === day ? tries.count : 0;
};

const OUTAGE_REASONS: ReadonlySet<string> = new Set(Object.values(MODEL_OUTAGE_SKIP));
export type CardViewState = Exclude<CardState, 'waiting_on_model'> | 'generating' | 'failed' | 'paused';
// `retriesLeft` is present only while the card is stuck, so that is where Try again is offered and accepted.
export type CardStatus = Readonly<{ state?: CardViewState; reason?: string; retriesLeft?: number }>;
export type CardDeps = Readonly<{
  scheduler: Scheduler; book: DayPlanBook; kv: Kv; timezone: string; now: number;
  // Whether the day's card has a delivery that may still go out, or may already have.
  queued(day: string, card: CardId): boolean;
}>;

// Where one of today's cards stands, as the console and the app show it. The plan book says how a card finished or that it
// waits for the model; its schedule row says whether it is paused or being made now. A state the owner can act on carries a
// short fixed reason, never error text. A card is stuck, and may be tried again, only while it waits for the model or is
// paused and nothing for it is on its way: one that went out, is queued, is finished for the day or has not come due is not.
export const cardStatus = (deps: CardDeps, card: DayCard): CardStatus => {
  const day = localIso(deps.now, deps.timezone).slice(0, 10);
  const row = deps.book.read(day).find((planned) => planned.card === card.id);
  const found = deps.scheduler.lookup(card.id);
  const entry = found.state === 'entry' ? found.entry : null;
  if (row?.state === 'skipped') return { state: 'skipped', ...(OUTAGE_REASONS.has(row.reason) ? { reason: row.reason } : {}) };
  if (row?.sent) return row.state === 'sent' ? { state: 'sent' } : {};
  if (row?.state === 'held') return { state: 'held' };
  if (entry !== null && inFlight(deps.scheduler, entry, deps.now)) return { state: 'generating', reason: 'Waldo is making it now' };
  const tries = deps.queued(day, card.id) ? {} : { retriesLeft: Math.max(0, CARD_RETRIES_PER_DAY - triesUsed(deps.kv, day)) };
  if (entry?.status === 'quarantined') return { state: 'paused', reason: `Paused after ${QUARANTINE_AFTER_ATTEMPTS} failed tries in a row`, ...tries };
  if (row?.state === 'waiting_on_model') return { state: 'failed', reason: MODEL_OUTAGE_SKIP[card.id], ...tries };
  return row === undefined || row.state === 'pending' ? { state: 'pending' } : {};
};

// Where today's cards stand, as one host fact for the owner's own turns, so a turn on any surface knows whether the Brief
// reached them, and where, before it decides what to offer. States and times only: a card's words stay in the chat it went to.
export const dayCardsLine = (deps: CardDeps): string => {
  const day = localIso(deps.now, deps.timezone).slice(0, 10);
  const rows = new Map(deps.book.read(day).map((row) => [row.card, row]));
  const delivered = deps.book.deliveries(day);
  const clockOf = (at: number) => localIso(at, deps.timezone).slice(11, 16);
  const said = DAY_CARDS.flatMap((card) => {
    const status = cardStatus(deps, card);
    const found = deps.scheduler.lookup(card.id);
    const due = rows.get(card.id)?.time ?? (found.state === 'entry' && localIso(found.entry.due_at, deps.timezone).startsWith(day) ? clockOf(found.entry.due_at) : null);
    const app = delivered.get(card.id);
    if (app) return [`${card.name} reached them in the app at ${clockOf(app.delivered_at)}`];
    switch (rows.get(card.id)?.sent && status.state !== 'skipped' ? 'sent' : status.state) {
      case 'sent': return [`${card.name} was sent`];
      case 'skipped': return [status.reason ? `${card.name} was not sent (${status.reason})` : `${card.name} was skipped: nothing worth sending`];
      case 'held': return [`${card.name} is held for quiet hours`];
      case 'generating': return [`${card.name} is being written now`];
      case 'failed': case 'paused': return [`${card.name} could not be written (${status.reason})`];
      default: return deps.queued(day, card.id) ? [`${card.name} is on its way`] : due ? [`${card.name} is due at ${due}`] : [];
    }
  });
  return said.length ? `Today's cards: ${said.join('; ')}.` : '';
};

export const cardWindow = (card: DayCard, now: number, timezone: string): Readonly<{ from: number; to: number }> => {
  const { from: midnight } = dayWindow(now, timezone);
  if (card.calendar === 'today') return { from: midnight, to: midnight + DAY_MS };
  if (card.calendar === 'rest_of_today') return { from: now, to: midnight + DAY_MS };
  return { from: midnight + DAY_MS, to: midnight + 2 * DAY_MS };
};

const eventLine = (event: CalendarItem, timezone: string) =>
  JSON.stringify({ ...calendarPromptProjection(event), start: event.all_day ? event.start : localIso(Date.parse(event.start), timezone), end: event.all_day ? event.end : localIso(Date.parse(event.end), timezone) });

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

const wireSize = (content: string) => JSON.stringify([{ role: 'user', content }]).length;

// Keeps whole lines from one end and says how many were left out, so the model can tell the owner what it did not read.
const fitLines = (text: string, room: number, keep: 'head' | 'tail'): string => {
  if (text.length <= room) return text;
  const lines = text.split('\n');
  const note = (omitted: number) => `[${omitted} ${keep === 'head' ? 'later' : 'older'} lines omitted to fit; look them up if the card needs them]`;
  const kept: string[] = [];
  let used = note(lines.length).length;
  for (const line of keep === 'head' ? lines : [...lines].reverse()) {
    if (used + line.length + 1 > room) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (keep === 'tail') kept.reverse();
  const omitted = lines.length - kept.length;
  return keep === 'head' ? [...kept, note(omitted)].join('\n') : [note(omitted), ...kept].join('\n');
};

// A card reads in seconds, so it gets half the provider budget; an unbounded ledger or an update backlog
// that a failed card never folds must not push the one message past the Scribe size cap and cost the owner the card.
export const composeDayCard = async (
  card: DayCard, now: number, timezone: string,
  sources: Readonly<{ google: GoogleClient | null; connectable: boolean; ledger: string; today: string; updates: string; waiting?: string }>,
  model: ModelName = WALDO_AUXILIARY_MODEL,
): Promise<string> => {
  const cap = Math.floor(deriveContextBudgetChars(model, SANITISE_DESTINATION_POLICIES.internal_context.max_chars) / 2);
  const calendar = await readCalendar(cardWindow(card, now, timezone), timezone, sources.google, sources.connectable);
  const localNow = localIso(now, timezone);
  const build = (sections: Readonly<{ ledger: string; today: string; updates: string }>) => dayCardPrompt(card, localNow, { calendar, ...sections, ...(sources.waiting ? { waiting: sources.waiting } : {}) });
  const whole = { ledger: sources.ledger, today: sources.today, updates: sources.updates };
  if (wireSize(build(whole)) <= cap) return build(whole);
  const wanted = [
    { key: 'updates', text: sources.updates, keep: 'tail' },
    { key: 'today', text: sources.today, keep: 'tail' },
    { key: 'ledger', text: sources.ledger, keep: 'head' },
  ] as const;
  let room = cap - wireSize(build({ ledger: '', today: '', updates: '' })) - 256;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ordered = [...wanted].sort((a, b) => a.text.length - b.text.length);
    const fitted: Record<string, string> = {};
    let left = Math.max(room, 0);
    ordered.forEach((section, index) => {
      const share = Math.floor(left / (ordered.length - index));
      fitted[section.key] = fitLines(section.text, share, section.keep);
      left -= Math.min(fitted[section.key]!.length, share);
    });
    const prompt = build({ ledger: fitted.ledger!, today: fitted.today!, updates: fitted.updates! });
    const excess = wireSize(prompt) - cap;
    if (excess <= 0) return prompt;
    room -= excess + 64;
  }
  return build({ ledger: '', today: '', updates: '' });
};

export const isSkip = (text: string): boolean => text.trim() === SKIP_CARD;

// The Main chat row each card was delivered to is kept on its day_plan row. A build before that kept today's in one KV
// entry, which is still read for its own day, so the day it deploys keeps the cards delivered before it.
const LEGACY_CARD_DELIVERY_KEY = 'day_card_delivery_v1';
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
type CardDelivery = Readonly<{ message_id: string; delivered_at: number }>;
type LegacyCardDeliveries = Readonly<{ day: string; cards: Readonly<Record<string, CardDelivery>> }>;
export type CardLatest = CardDelivery & Readonly<{ excerpt: string }>;

export const cardDeliveries = (book: DayPlanBook, kv: Kv, day: string): ReadonlyMap<string, CardDelivery> => {
  const legacy = kv.get<LegacyCardDeliveries>(LEGACY_CARD_DELIVERY_KEY);
  return new Map([...(legacy?.day === day ? Object.entries(legacy.cards) : []), ...book.deliveries(day)]);
};

// The card's latest delivery as the app shows it: a prefix of the row's text, never splitting a surrogate pair. A row
// that is gone or shows no text gives null.
export const latestDelivery = (delivery: CardDelivery | undefined, shown: string | undefined): CardLatest | null => {
  if (!delivery || !shown?.trim()) return null;
  const max = APP_CARD_EXCERPT_MAX_V1, cut = shown.length > max && /[\uD800-\uDBFF]/.test(shown[max - 1]!) ? max - 1 : max;
  return { message_id: delivery.message_id, delivered_at: delivery.delivered_at, excerpt: shown.slice(0, cut) };
};

// planDay sends this as one user message; the sanitiser budgets its JSON wire form.
export const composeDayPlanInput = (input: string, memory?: ClaimStore, model: ModelName = WALDO_AUXILIARY_MODEL): string => {
  const limit = deriveContextBudgetChars(model, SANITISE_DESTINATION_POLICIES.internal_context.max_chars);
  const wireSize = (content: string) => JSON.stringify([{ role: 'user', content }]).length;
  if (wireSize(input) > limit) throw new Error('day plan input exceeds provider context budget');
  if (!memory) return input;
  let room = limit - wireSize(`\n\n${input}`);
  while (room >= 0) {
    const content = `${turnMemoryPrompt(memory, input, room)}\n\n${input}`;
    const excess = wireSize(content) - limit;
    if (excess <= 0) return content;
    // Escaping costs depend on the kept claims; tighten by the measured excess, not a count cap.
    room -= excess;
  }
  throw new Error('day plan input leaves no room for memory omission reporting');
};
