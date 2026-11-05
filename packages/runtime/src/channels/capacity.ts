import { applyClaimOps, type ClaimStore } from '../memory/claims';
import { localDayWindow, shiftDay } from '../health/scores/time';
import type { CalendarItem, GoogleClient } from '../connectors/google';
import { capacityInput, NO_CALENDAR } from '../prompt/capacity';
import { localIso } from './reminders';

// CAPACITY_PLAN: one capacity note per owner, kept in memory as a health claim so the owner's health-notes setting, the
// forget barrier and the numeric-health hold all apply to it. The key names the claim the nightly pass last wrote.
export const CAPACITY_NOTE_KEY = 'capacity:claim_id';
// Whether the note was written while the owner shared their health. A note that drew on the body is never shown once they stop.
export const CAPACITY_BODY_KEY = 'capacity:from_body';
// The owner set the note aside: they dismissed or forgot it. Waldo writes no new one; only the owner can reopen it.
export const CAPACITY_SET_ASIDE_KEY = 'capacity:set_aside';
// The note's evidence is fixed: what the model reasoned from could carry the body day by day, and evidence is stored as written.
export const CAPACITY_EVIDENCE = "Waldo's nightly capacity pass: the calendar's shape, the owner's memory and their shared zone words";
// The calendar the pass reads: the past week, for the load the owner carried, and tomorrow, for what is coming.
export const CAPACITY_PAST_DAYS = 7;
const CALENDAR_LIMIT = 250;
const MINUTE_MS = 60_000;

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }>;
type Sql = Pick<SqlStorage, 'exec'>;
export type CapacityNote = Readonly<{ id: number; text: string; owner: boolean }>;

// The note the pass last wrote, or the owner's own correction of it: a correction supersedes the claim, and the claim that
// replaced it names it. A note the owner dismissed or forgot is set aside for good, until they reopen it.
export const capacityNote = (store: ClaimStore, kv: Kv): CapacityNote | null => {
  const claims = [...store.claims(), ...store.claims('promoted'), ...store.claims('superseded')];
  const seen = new Set<number>();
  let setAside = false;
  for (let id = kv.get<number>(CAPACITY_NOTE_KEY); id !== undefined && !seen.has(id);) {
    seen.add(id);
    const claim = claims.find(found => found.id === id);
    if (claim?.status === 'active' || claim?.status === 'promoted') return { id: claim.id, text: claim.text, owner: claim.origin === 'owner' };
    id = claim && claims.find(found => found.supersedes_id === claim.id)?.id;
    // Gone, or replaced by a correction that is gone: the owner dismissed or forgot it, or it is mid-purge. A note the pass
    // replaces or retires moves or drops the key itself, so it never ends here.
    if (id === undefined) setAside = true;
  }
  kv.delete(CAPACITY_NOTE_KEY);
  kv.delete(CAPACITY_BODY_KEY);
  if (setAside) kv.put(CAPACITY_SET_ASIDE_KEY, true);
  return null;
};
export const capacitySetAside = (kv: Kv): boolean => kv.get<boolean>(CAPACITY_SET_ASIDE_KEY) === true;

// The note a day card may read: none while the owner's health notes are off, and none drawn from a body they no longer share.
// A health read that failed says nothing about sharing, so the note stands.
export const cardCapacityNote = (store: ClaimStore, kv: Kv, healthNotes: boolean, healthShared: boolean | 'unknown'): string | null => {
  if (!healthNotes) return null;
  const note = capacityNote(store, kv);
  return note && (healthShared !== false || note.owner || kv.get<boolean>(CAPACITY_BODY_KEY) !== true) ? note.text : null;
};

const clock = (at: number, timezone: string): string => localIso(at, timezone).slice(11, 16);
const span = (minutes: number): string => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
const weekday = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// One line per local day: how many commitments, how much of the day they took, when it started and ended, and the longest
// stretch between them. Shape only: no title, person or place reaches the pass, so outside text cannot steer the note.
export const calendarShape = (items: readonly CalendarItem[], days: readonly string[], timezone: string, now: number): string => days.map((day) => {
  const window = localDayWindow(day, timezone);
  const label = `${weekday(day)} (${window.end <= now ? 'lived' : window.start > now ? 'ahead' : 'under way'})`;
  const timed = items.filter(item => !item.all_day && item.status !== 'cancelled')
    .map(item => ({ start: Math.max(Date.parse(item.start), window.start), end: Math.min(Date.parse(item.end), window.end), made: item.waldo_made === true }))
    .filter(item => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const allDay = items.filter(item => item.all_day && item.status !== 'cancelled' && item.start.slice(0, 10) <= day && day < item.end.slice(0, 10)).length;
  const commitments = timed.filter(item => !item.made);
  const made = timed.length - commitments.length;
  const extras = [...(allDay ? [`${allDay} all-day`] : []), ...(made ? [`${made} block${made === 1 ? '' : 's'} Waldo made`] : [])];
  if (!commitments.length) return `${label}: no commitments${extras.length ? `; ${extras.join('; ')}` : ''}`;
  let busy = 0, gap = 0, reach = commitments[0]!.start, covered = commitments[0]!.start;
  for (const item of commitments) {
    if (item.start > reach) gap = Math.max(gap, item.start - reach);
    busy += Math.max(0, item.end - Math.max(item.start, covered));
    covered = Math.max(covered, item.end);
    reach = Math.max(reach, item.end);
  }
  return `${label}: ${commitments.length} commitment${commitments.length === 1 ? '' : 's'}, ${span(Math.round(busy / MINUTE_MS))} committed, ${clock(commitments[0]!.start, timezone)} to ${clock(reach, timezone)}, longest gap ${span(Math.round(gap / MINUTE_MS))}${extras.length ? `; ${extras.join('; ')}` : ''}`;
}).join('\n');

// The days the pass reads, oldest first, from a week back to the day after today, in the owner's local calendar.
export const capacityDays = (now: number, timezone: string): readonly string[] => {
  const today = localIso(now, timezone).slice(0, 10);
  return Array.from({ length: CAPACITY_PAST_DAYS + 1 }, (_, index) => shiftDay(today, index - CAPACITY_PAST_DAYS + 1));
};

// The protected blocks Waldo proposed lately, as kind, day and what became of each: no title or time leaves the ledger.
export const recentBlocks = (sql: Sql, now: number, timezone: string, days = 14): string => {
  if (!sql.exec('PRAGMA table_info(ledger)').toArray().length) return '';
  return sql.exec<{ block: string; status: string; created_at: number; start: string | null }>(
    `SELECT json_extract(payload_json, '$.block') AS block, status, created_at, json_extract(payload_json, '$.start') AS start FROM ledger
     WHERE kind = 'calendar_change' AND json_extract(payload_json, '$.block') IN ('rest', 'deep_work') AND created_at >= ? ORDER BY created_at`,
    now - days * 24 * 60 * MINUTE_MS,
  ).toArray().map(row => `- ${row.block === 'rest' ? 'rest' : 'deep work'} block${row.start ? ` for ${weekday(localIso(Date.parse(row.start), timezone).slice(0, 10))}` : ''}, proposed ${weekday(localIso(row.created_at, timezone).slice(0, 10))}: ${row.status === 'open' || row.status === 'card_unconfirmed' ? 'waiting on them' : row.status === 'done' ? 'they said yes' : row.status === 'skipped' ? 'they said no' : row.status}`).join('\n');
};

export type CapacityOutcome = 'kept' | 'unchanged' | 'held' | 'retired' | 'owner_held' | 'set_aside' | 'health_unknown' | 'health_notes_off' | 'no_memory';
type Transaction = <T>(work: () => T) => T;

// Writes the pass's answer as the new note through the same admission as every background memory write, then retires the
// note it replaces, in one transaction. The owner's own correction is never replaced, even one made while the model was
// answering, and a note the owner set aside stays aside. A note the model marks as touching a forgotten topic is held.
export const keepCapacityNote = (store: ClaimStore, kv: Kv, raw: string, at: string, body: boolean, transaction: Transaction = work => work()): Extract<CapacityOutcome, 'kept' | 'unchanged' | 'held' | 'owner_held' | 'set_aside'> => {
  const reply = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { note?: unknown; touches_forgotten?: unknown };
  const note = typeof reply.note === 'string' ? reply.note.trim() : '';
  if (!note) return 'unchanged';
  const ops = JSON.stringify({ add: [{ kind: 'health', text: note, source: 'inferred', evidence: CAPACITY_EVIDENCE, touches_forgotten: reply.touches_forgotten !== false, aliases: ['capacity', 'deep work', 'focus hours'], aliases_touch_forgotten: false, area: 'mind' }],
    corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, pin: [], unpin: [], areas: [] });
  return transaction(() => {
    const current = capacityNote(store, kv);
    if (current?.owner) return 'owner_held';
    if (capacitySetAside(kv)) return 'set_aside';
    if (current?.text.trim() === note) return 'unchanged';
    let written = 0;
    applyClaimOps(store, ops, at, 'capacity pass', undefined, undefined, false, outcome => { written = outcome.written; });
    const added = written === 1 ? store.claims().find(claim => claim.text === note && claim.id !== current?.id) : undefined;
    if (!added) return 'held';
    if (current) store.setStatus(current.id, 'superseded');
    kv.put(CAPACITY_NOTE_KEY, added.id);
    kv.put(CAPACITY_BODY_KEY, body);
    return 'kept';
  });
};

// A note drawn from a body the owner no longer shares, which the pass could not rewrite without it, leaves memory, unless
// the owner made it theirs while the model was answering.
const retire = (store: ClaimStore, kv: Kv, transaction: Transaction): 'retired' | 'owner_held' => transaction(() => {
  const current = capacityNote(store, kv);
  if (current?.owner) return 'owner_held';
  if (current) store.setStatus(current.id, 'superseded');
  kv.delete(CAPACITY_NOTE_KEY);
  kv.delete(CAPACITY_BODY_KEY);
  return 'retired';
});

export type CapacityPassDeps = Readonly<{
  store: ClaimStore | undefined; kv: Kv; timezone: string; now: () => number; transaction?: Transaction;
  // The owner's health-notes setting: off, Waldo keeps nothing about their health, energy or focus.
  healthNotes: boolean;
  // Their body today, as the zone words every turn reads; null when they share none; 'unknown' when the read failed.
  health: () => Promise<string | null | 'unknown'>;
  google: () => Promise<GoogleClient | null>;
  ask: (input: string) => Promise<string>;
}>;

// The nightly pass. Google is read before the model is asked and the note written after, with no transaction held across it.
export const runCapacityPass = async (deps: CapacityPassDeps): Promise<CapacityOutcome> => {
  if (!deps.store) return 'no_memory';
  if (!deps.healthNotes) return 'health_notes_off';
  const current = capacityNote(deps.store, deps.kv);
  if (current?.owner) return 'owner_held';
  if (capacitySetAside(deps.kv)) return 'set_aside';
  const transaction = deps.transaction ?? (work => work());
  const now = deps.now(), days = capacityDays(now, deps.timezone);
  const client = await deps.google();
  const items = client ? await client.events(new Date(localDayWindow(days[0]!, deps.timezone).start).toISOString(), new Date(localDayWindow(days.at(-1)!, deps.timezone).end).toISOString(), CALENDAR_LIMIT, false) : [];
  const health = await deps.health();
  // An outage is not a revoke: the note stays as it is until the body can be read again.
  if (health === 'unknown') return 'health_unknown';
  const withdrawn = current !== null && health === null && deps.kv.get<boolean>(CAPACITY_BODY_KEY) === true;
  const raw = await deps.ask(capacityInput({ now: localIso(now, deps.timezone).replace('T', ' ').slice(0, 16), note: current?.text ?? null, health, withdrawn,
    calendar: client ? calendarShape(items, days, deps.timezone, now) : NO_CALENDAR }));
  const outcome = keepCapacityNote(deps.store, deps.kv, raw, new Date(deps.now()).toISOString(), health !== null, transaction);
  return withdrawn && (outcome === 'unchanged' || outcome === 'held') ? retire(deps.store, deps.kv, transaction) : outcome;
};
