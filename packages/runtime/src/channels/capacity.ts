import { applyClaimOps, type ClaimStore } from '../memory/claims';
import { localDayWindow, shiftDay } from '../health/scores/time';
import type { CalendarItem, GoogleClient } from '../connectors/google';
import { capacityInput } from '../prompt/capacity';
import { localIso } from './reminders';

// CAPACITY_PLAN: one capacity note per owner, kept in memory as a health claim so the owner's health-notes setting, the
// forget barrier and the numeric-health hold all apply to it. The key names the claim the nightly pass last wrote.
export const CAPACITY_NOTE_KEY = 'capacity:claim_id';
// The calendar the pass reads: the past week, for the load the owner carried, and tomorrow, for what is coming.
export const CAPACITY_PAST_DAYS = 7;
const CALENDAR_LIMIT = 250;
const MINUTE_MS = 60_000;

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }>;
type Sql = Pick<SqlStorage, 'exec'>;
export type CapacityNote = Readonly<{ id: number; text: string; owner: boolean }>;

// The note the pass last wrote, or the owner's own correction of it: a correction supersedes the claim, and the claim that
// replaced it names it. A note forgotten or dismissed is gone, and the key with it.
export const capacityNote = (store: ClaimStore, kv: Kv): CapacityNote | null => {
  const claims = [...store.claims(), ...store.claims('superseded')];
  const seen = new Set<number>();
  for (let id = kv.get<number>(CAPACITY_NOTE_KEY); id !== undefined && !seen.has(id);) {
    seen.add(id);
    const claim = claims.find(found => found.id === id);
    if (claim?.status === 'active') return { id: claim.id, text: claim.text, owner: claim.origin === 'owner' };
    id = claim ? claims.find(found => found.supersedes_id === claim.id)?.id : undefined;
  }
  kv.delete(CAPACITY_NOTE_KEY);
  return null;
};

const clock = (at: number, timezone: string): string => localIso(at, timezone).slice(11, 16);
const span = (minutes: number): string => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
const weekday = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// One line per local day: how many commitments, how much of the day they took, when it started and ended, and the longest
// stretch between them. Shape only: no title, person or place reaches the pass, so outside text cannot steer the note.
export const calendarShape = (items: readonly CalendarItem[], days: readonly string[], timezone: string): string => days.map((day) => {
  const window = localDayWindow(day, timezone);
  const timed = items.filter(item => !item.all_day && item.status !== 'cancelled')
    .map(item => ({ start: Math.max(Date.parse(item.start), window.start), end: Math.min(Date.parse(item.end), window.end), made: item.waldo_made === true }))
    .filter(item => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const allDay = items.filter(item => item.all_day && item.status !== 'cancelled' && item.start.slice(0, 10) <= day && day < item.end.slice(0, 10)).length;
  const commitments = timed.filter(item => !item.made);
  const made = timed.length - commitments.length;
  const extras = [...(allDay ? [`${allDay} all-day`] : []), ...(made ? [`${made} block${made === 1 ? '' : 's'} Waldo made`] : [])];
  if (!commitments.length) return `${weekday(day)}: no commitments${extras.length ? `; ${extras.join('; ')}` : ''}`;
  let busy = 0, gap = 0, reach = commitments[0]!.start, covered = commitments[0]!.start;
  for (const item of commitments) {
    if (item.start > reach) gap = Math.max(gap, item.start - reach);
    busy += Math.max(0, item.end - Math.max(item.start, covered));
    covered = Math.max(covered, item.end);
    reach = Math.max(reach, item.end);
  }
  return `${weekday(day)}: ${commitments.length} commitment${commitments.length === 1 ? '' : 's'}, ${span(Math.round(busy / MINUTE_MS))} committed, ${clock(commitments[0]!.start, timezone)} to ${clock(reach, timezone)}, longest gap ${span(Math.round(gap / MINUTE_MS))}${extras.length ? `; ${extras.join('; ')}` : ''}`;
}).join('\n');

// The days the pass reads, oldest first, ending with tomorrow, in the owner's local calendar.
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

export type CapacityOutcome = 'kept' | 'unchanged' | 'held' | 'owner_held' | 'health_notes_off' | 'no_memory';

// Writes the pass's answer as the new note through the same admission as every background memory write, then retires the
// note it replaces. The owner's own correction is never replaced: the owner owns what they wrote.
export const keepCapacityNote = (store: ClaimStore, kv: Kv, raw: string, at: string): Extract<CapacityOutcome, 'kept' | 'unchanged' | 'held'> => {
  const reply = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { note?: unknown; evidence?: unknown };
  const note = typeof reply.note === 'string' ? reply.note.trim() : '';
  if (!note) return 'unchanged';
  const current = capacityNote(store, kv);
  if (current?.text.trim() === note) return 'unchanged';
  const evidence = typeof reply.evidence === 'string' && reply.evidence.trim() ? reply.evidence.trim() : 'capacity pass';
  const ops = JSON.stringify({ add: [{ kind: 'health', text: note, source: 'inferred', evidence, touches_forgotten: false, aliases: ['capacity', 'deep work', 'focus hours'], aliases_touch_forgotten: false, area: 'mind' }],
    corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, pin: [], unpin: [], areas: [] });
  let written = 0;
  applyClaimOps(store, ops, at, 'capacity pass', undefined, undefined, false, outcome => { written = outcome.written; });
  if (written !== 1) return 'held';
  const added = store.claims().find(claim => claim.text === note && claim.id !== current?.id);
  if (!added) return 'held';
  if (current) store.setStatus(current.id, 'superseded');
  kv.put(CAPACITY_NOTE_KEY, added.id);
  return 'kept';
};

export type CapacityPassDeps = Readonly<{
  store: ClaimStore | undefined; kv: Kv; timezone: string; now: () => number;
  // The owner's health-notes setting: off, Waldo keeps nothing about their health, energy or focus.
  healthNotes: boolean;
  // Their body today, as the zone words every turn reads, or null when they share none.
  health: () => Promise<string | null>;
  google: () => Promise<GoogleClient | null>;
  ask: (input: string) => Promise<string>;
}>;

// The nightly pass. Google is read before the model is asked and the note written after, with no transaction held across it.
export const runCapacityPass = async (deps: CapacityPassDeps): Promise<CapacityOutcome> => {
  if (!deps.store) return 'no_memory';
  if (!deps.healthNotes) return 'health_notes_off';
  const current = capacityNote(deps.store, deps.kv);
  if (current?.owner) return 'owner_held';
  const now = deps.now(), days = capacityDays(now, deps.timezone);
  const client = await deps.google();
  const items = client ? await client.events(new Date(localDayWindow(days[0]!, deps.timezone).start).toISOString(), new Date(localDayWindow(days.at(-1)!, deps.timezone).end).toISOString(), CALENDAR_LIMIT, false) : [];
  const calendar = client ? calendarShape(items, days, deps.timezone) : 'Their calendar is not connected.';
  const raw = await deps.ask(capacityInput({ note: current?.text ?? null, health: await deps.health(), calendar }));
  return keepCapacityNote(deps.store, deps.kv, raw, new Date(deps.now()).toISOString());
};
