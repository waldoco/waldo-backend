import { fenced } from '../prompt/turn-prompt';
import { localIso } from './reminders';
import type { Change } from './update-cards';

// Waldo's own blocks (BLOCK_LIFECYCLE): the protected time Waldo placed on the owner's calendar with their approval, read from
// the approval ledger, the one record of what Waldo created (an applied create keeps its Google event id for undo). A block the
// owner moved, renamed or otherwise edited is theirs from then on: the update sweep records that here, in its own transaction,
// and Waldo leaves it alone. Times and kinds only reach a prompt; a block's title is the owner's approved words.

const DAY_MS = 24 * 60 * 60_000;
type Sql = Pick<SqlStorage, 'exec'>;
export type WaldoBlock = Readonly<{ event_id: string; kind: 'deep_work' | 'rest'; title: string; start: string; end: string; owner_edited: boolean }>;

const ensure = (sql: Sql) => sql.exec('CREATE TABLE IF NOT EXISTS waldo_block_owner (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
const ledgerExists = (sql: Sql) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").toArray().length > 0;

// The blocks Waldo created that overlap [from, to): each at the times Waldo last gave it (a later Waldo move that applied
// replaces them), and none Waldo later cancelled.
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
    const later = sql.exec<{ action: string; start: string | null; end: string | null }>(
      `SELECT json_extract(payload_json, '$.action') AS action, json_extract(payload_json, '$.start') AS start, json_extract(payload_json, '$.end') AS end
       FROM ledger WHERE kind = 'calendar_change' AND status = 'done' AND json_extract(payload_json, '$.event_id') = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
      block.event_id, block.created_at).toArray()[0];
    if (later?.action === 'cancel') return [];
    const start = later?.action === 'move' && later.start ? later.start : block.start, end = later?.action === 'move' && later.end ? later.end : block.end;
    if (Date.parse(start) >= to || Date.parse(end) <= from) return [];
    return [{ event_id: block.event_id, kind: block.kind as WaldoBlock['kind'], title: block.title, start, end, owner_edited: owned.has(block.event_id) }];
  });
};

// Runs in the update sweep's transaction with the changes it recorded: a change to one of Waldo's blocks that is not where
// Waldo last put it (other times, or a new title) is the owner's edit, and the block is theirs from then on.
export const noteOwnerEdits = (sql: Sql, changes: readonly Change[], now: number): number => {
  const edited = changes.filter(change => change.source === 'calendar' && change.kind === 'changed' && change.ref?.startsWith('event:'));
  if (!edited.length || !ledgerExists(sql)) return 0;
  const blocks = new Map(waldoBlocks(sql, now - 14 * DAY_MS, now + 30 * DAY_MS).map(block => [block.event_id, block]));
  let noted = 0;
  for (const change of edited) {
    const block = blocks.get(change.ref!.slice('event:'.length));
    if (!block || block.owner_edited) continue;
    const current = JSON.parse(change.detail) as { start?: string; end?: string };
    const moved = (current.start !== undefined && Date.parse(current.start) !== Date.parse(block.start)) || (current.end !== undefined && Date.parse(current.end) !== Date.parse(block.end));
    if (!moved && !change.before?.title_changed) continue;
    sql.exec('INSERT INTO waldo_block_owner (event_id, at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING', block.event_id, now);
    noted += 1;
  }
  return noted;
};

const KIND: Readonly<Record<WaldoBlock['kind'], string>> = { deep_work: 'deep work', rest: 'rest' };
// The blocks as the turn reads them: kind, local times, the approved title as data, the event id to move it by, and whose it is.
export const blocksSection = (blocks: readonly WaldoBlock[], timezone: string): string => blocks.length === 0 ? '' : fenced('the blocks Waldo placed on the owner\'s calendar, each approved by them', blocks.map(block =>
  `- ${KIND[block.kind]}, ${localIso(Date.parse(block.start), timezone).replace('T', ' ').slice(0, 16)}–${localIso(Date.parse(block.end), timezone).slice(11, 16)}: ${JSON.stringify(block.title)} [event id ${block.event_id}]${block.owner_edited ? ' — the owner changed it, so it is theirs now: leave it alone' : ''}`,
).join('\n')).trimStart();

const OUTCOME: Readonly<Record<string, string>> = {
  done: 'they took it', skipped: 'they declined', expired: 'it expired unanswered', open: 'still waiting', card_unconfirmed: 'still waiting', stale: 'the calendar changed first',
};
// For the nightly capacity pass: the blocks and window offers Waldo made lately and what became of each, with the owner's
// answer by what it meant (Do it, Not now, Keep it free) for a window offer. Kinds, days and outcomes: no title, no time.
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
      : row.offer === 'free_window' && row.deferred_at !== null && row.status !== 'done' ? 'they said not now' : OUTCOME[row.status] ?? row.status;
    return `- ${row.offer === 'free_window' ? 'window offer' : 'block'} for ${KIND[row.kind as WaldoBlock['kind']] ?? row.kind}, ${day}${hour ? ` around ${hour}:00` : ''}: ${said}${row.event_id && owned.has(row.event_id) ? ', then they changed it themselves' : ''}`;
  }).join('\n');
};
