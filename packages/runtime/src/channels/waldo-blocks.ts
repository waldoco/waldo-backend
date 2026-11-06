import { fenced } from '../prompt/turn-prompt';
import { localIso } from './reminders';
import type { Change } from './update-cards';

// Waldo's own blocks (BLOCK_LIFECYCLE): the protected time Waldo placed on the owner's calendar with their approval, read from
// the approval ledger, the one record of what Waldo created (an applied create keeps its Google event id for undo). Each such
// event also carries Waldo's private waldoBlock key on Google. A block the owner moved, renamed or deleted is theirs from then
// on: the update sweep records that here, in its own transaction, and Waldo leaves it alone. Times and kinds reach a prompt; a
// block's title is the owner's approved words, shown as data.

const DAY_MS = 24 * 60 * 60_000;
type Sql = Pick<SqlStorage, 'exec'>;
export type WaldoBlock = Readonly<{ event_id: string; kind: 'deep_work' | 'rest'; title: string; start: string; end: string; owner_edited: boolean }>;
// A Waldo move in one of these never reached Google; any other state may have.
const NEVER_APPLIED = "('stale', 'failed', 'rejected', 'skipped', 'expired', 'withdrawn')";

const ensure = (sql: Sql) => sql.exec('CREATE TABLE IF NOT EXISTS waldo_block_owner (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
const ledgerExists = (sql: Sql) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").toArray().length > 0;
type Move = Readonly<{ action: string; status: string; start: string | null; end: string | null }>;
// Waldo's moves and cancels of one event since it was made, latest decided first.
const movesOf = (sql: Sql, eventId: string, since: number): readonly Move[] => sql.exec<Move>(
  `SELECT json_extract(payload_json, '$.action') AS action, status, json_extract(payload_json, '$.start') AS start, json_extract(payload_json, '$.end') AS end
   FROM ledger WHERE kind = 'calendar_change' AND json_extract(payload_json, '$.event_id') = ? AND created_at >= ? ORDER BY coalesce(decided_at, created_at) DESC, rowid DESC`,
  eventId, since).toArray();

// The blocks Waldo created that overlap [from, to): each at the times Waldo last gave it (the latest applied move replaces
// them), and none Waldo cancelled.
export const waldoBlocks = (sql: Sql, from: number, to: number): readonly WaldoBlock[] => {
  if (!ledgerExists(sql)) return [];
  ensure(sql);
  const made = sql.exec<{ event_id: string; kind: string; title: string; start: string; end: string; created_at: number }>(
    `SELECT json_extract(undo_json, '$.id') AS event_id, json_extract(payload_json, '$.block') AS kind, json_extract(payload_json, '$.title') AS title,
       json_extract(payload_json, '$.start') AS start, json_extract(payload_json, '$.end') AS end, created_at
     FROM ledger WHERE kind = 'calendar_change' AND status = 'done' AND json_extract(payload_json, '$.action') = 'create'
       AND json_extract(payload_json, '$.block') IN ('deep_work', 'rest') AND json_extract(undo_json, '$.id') IS NOT NULL
       AND created_at >= ? ORDER BY created_at`, from - 14 * DAY_MS).toArray();
  const owned = new Set(sql.exec<{ event_id: string }>('SELECT event_id FROM waldo_block_owner').toArray().map(row => row.event_id));
  return made.flatMap(block => {
    const latest = movesOf(sql, block.event_id, block.created_at).find(move => move.status === 'done');
    if (latest?.action === 'cancel') return [];
    const start = latest?.action === 'move' && latest.start ? latest.start : block.start, end = latest?.action === 'move' && latest.end ? latest.end : block.end;
    if (Date.parse(start) >= to || Date.parse(end) <= from) return [];
    return [{ event_id: block.event_id, kind: block.kind as WaldoBlock['kind'], title: block.title, start, end, owner_edited: owned.has(block.event_id) }];
  });
};

// Runs in the update sweep's transaction with the changes it recorded. A change to one of Waldo's blocks is the owner's when it
// deleted the block, renamed it, or put it at times that are neither where Waldo made it nor where any Waldo move that may
// have applied put it; the block is theirs from then on. An event first seen in this read counts as added, so an edit made
// right after approving is caught too.
export const noteOwnerEdits = (sql: Sql, changes: readonly Change[], now: number): number => {
  const touched = changes.filter(change => change.source === 'calendar' && ['added', 'changed', 'cancelled'].includes(change.kind) && change.ref?.startsWith('event:'));
  if (!touched.length || !ledgerExists(sql)) return 0;
  ensure(sql);
  const made = new Map(sql.exec<{ event_id: string; start: string; end: string; created_at: number }>(
    `SELECT json_extract(undo_json, '$.id') AS event_id, json_extract(payload_json, '$.start') AS start, json_extract(payload_json, '$.end') AS end, created_at
     FROM ledger WHERE kind = 'calendar_change' AND status = 'done' AND json_extract(payload_json, '$.action') = 'create'
       AND json_extract(payload_json, '$.block') IN ('deep_work', 'rest') AND json_extract(undo_json, '$.id') IS NOT NULL AND created_at >= ?`, now - 30 * DAY_MS).toArray()
    .map(row => [row.event_id, row]));
  let noted = 0;
  for (const change of touched) {
    const block = made.get(change.ref!.slice('event:'.length));
    if (!block) continue;
    const moves = movesOf(sql, block.event_id, block.created_at).filter(move => !NEVER_APPLIED.includes(`'${move.status}'`));
    if (change.kind === 'cancelled' && moves.some(move => move.action === 'cancel')) continue;
    const current = JSON.parse(change.detail) as { start?: string; end?: string };
    const at = (start?: string, end?: string) => current.start !== undefined && current.end !== undefined && start !== undefined && end !== undefined
      && Date.parse(current.start) === Date.parse(start) && Date.parse(current.end) === Date.parse(end);
    const waldos = at(block.start, block.end) || moves.some(move => move.action === 'move' && at(move.start ?? undefined, move.end ?? undefined));
    if (change.kind !== 'cancelled' && waldos && !change.before?.title_changed) continue;
    if (sql.exec('INSERT INTO waldo_block_owner (event_id, at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', block.event_id, now).toArray().length) noted += 1;
  }
  sql.exec('DELETE FROM waldo_block_owner WHERE at < ?', now - 30 * DAY_MS);
  return noted;
};

const KIND: Readonly<Record<WaldoBlock['kind'], string>> = { deep_work: 'deep work', rest: 'rest' };
// The blocks as the turn reads them: kind, local times, the approved title as data, the event id to move it by, and whose it is.
export const blocksSection = (blocks: readonly WaldoBlock[], timezone: string): string => blocks.length === 0 ? '' : fenced('the blocks Waldo placed on the owner\'s calendar, each approved by them', blocks.map(block =>
  `- ${KIND[block.kind]}, ${localIso(Date.parse(block.start), timezone).replace('T', ' ').slice(0, 16)}–${localIso(Date.parse(block.end), timezone).slice(11, 16)}: ${JSON.stringify(block.title)} [event id ${block.event_id}]${block.owner_edited ? ' — the owner changed it, so it is theirs now: leave it alone' : ''}`,
).join('\n')).trimStart();

const OUTCOME: Readonly<Record<string, string>> = {
  done: 'they approved it', skipped: 'they declined', expired: 'it expired unanswered', open: 'still waiting', card_unconfirmed: 'still waiting',
};
// For the nightly capacity pass: the blocks and window offers Waldo made lately and what became of each, with the owner's
// answer by what it meant (Do it, Not now, Keep it free) for a window offer. Kinds, days, hours and outcomes: no title.
export const blockOutcomes = (sql: Sql, now: number, timezone: string, days = 14): string => {
  if (!ledgerExists(sql)) return '';
  ensure(sql);
  const owned = new Set(sql.exec<{ event_id: string }>('SELECT event_id FROM waldo_block_owner').toArray().map(row => row.event_id));
  return sql.exec<{ kind: string; offer: string | null; status: string; deferred_at: number | null; start: string | null; created_at: number; event_id: string | null }>(
    `SELECT json_extract(payload_json, '$.block') AS kind, json_extract(payload_json, '$.offer') AS offer, status, deferred_at, json_extract(payload_json, '$.start') AS start,
       created_at, json_extract(undo_json, '$.id') AS event_id
     FROM ledger WHERE kind = 'calendar_change' AND json_extract(payload_json, '$.action') = 'create' AND json_extract(payload_json, '$.block') IN ('deep_work', 'rest')
       AND created_at >= ? ORDER BY json_extract(payload_json, '$.start'), created_at`, now - days * DAY_MS).toArray().map(row => {
    const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: timezone }).format(new Date(row.start ? Date.parse(row.start) : row.created_at));
    const hour = row.start ? localIso(Date.parse(row.start), timezone).slice(11, 13) : null;
    const said = row.offer === 'free_window' && row.status === 'skipped' ? 'they said keep it free'
      : row.offer === 'free_window' && row.deferred_at !== null && row.status !== 'done' ? 'they said not now' : OUTCOME[row.status] ?? 'it did not go ahead';
    return `- ${row.offer === 'free_window' ? 'window offer' : 'block'} for ${KIND[row.kind as WaldoBlock['kind']] ?? row.kind}, ${day}${hour ? ` around ${hour}:00` : ''}: ${said}${row.event_id && owned.has(row.event_id) ? ', then they changed it themselves' : ''}`;
  }).join('\n');
};
