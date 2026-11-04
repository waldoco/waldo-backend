import type { RecallLink, RecallLinkRel } from '@waldo/contracts';
import { surfaceOfTrace, traceSurfacePrefix } from '../channels/owner-turn-envelope';
import type { Claim, ClaimStore } from '../memory/claims';
import { outsideSafe } from '../memory/outside-view';
import { redactNumericHealth } from '../scribe/sanitiser';

// The recall chain: a recalled row names the rows next to it, so the model follows a thread by ref instead of searching
// again. Every link is a row that already exists, found by a column its writer fills: a reply is `<turn>-reply`; a memory
// note names the owner message it was learned from (`owner, <turn>`); a delegated run's parent and a task's origin are the
// turn that started it; a card's payload names the mail thread or calendar event it acts on. Nothing is stored for it.
// Which link matters is the model's call; this only says what is next to what.
// A line is built at read time from a row a forget purge rewrites, and is left out while its row carries a topic still being
// forgotten. Health numbers never reach a line, and a health note is named by its kind alone.

type Sql = Pick<SqlStorage, 'exec'>;
type Holds = (...values: readonly (string | null | undefined)[]) => boolean;
export type RecallChainDeps = Readonly<{
  sql: Sql;
  // The owner's memory as the turn may see it (the forget barrier's view).
  claims: Pick<ClaimStore, 'claims'>;
  // Whether a stored text carries a topic the owner asked to forget whose purge has not finished.
  held: () => Holds;
  approvalSummary: (id: string) => string | null;
}>;
// One tool call's read: memory and the held topics are read once for all its rows.
export type RecallRead = Readonly<{
  // skip: refs the caller already shows (the other hits of a search), which a link would only repeat.
  ofEpisode(ref: string, limit: number, skip?: ReadonlySet<string>): readonly RecallLink[];
  // byRef: a read of this one entry. Only then is the message a run or task came from looked up, since the index can find
  // a message by its entry id only by reading every row.
  ofHistory(ref: string, limit: number, byRef: boolean): readonly RecallLink[];
}>;
export type RecallChain = Readonly<{
  // outside: the call is part of a turn built from outside content, which reads memory without health (outsideSafe).
  open(options?: Readonly<{ outside?: boolean }>): RecallRead;
}>;
export const recallChainOn = (value: string | undefined): boolean => value === '1';
// Links shown inline beside each hit or entry of a search, and on a read of one row by its ref.
export const INLINE_LINKS = 2;
export const REF_LINKS = 6;
export const LINK_LINE_CHARS = 80;
// A reply and the turns around a message are looked for within this many stored rows of it.
const NEAR_ROWS = 200;

const oneLine = (text: string) => redactNumericHealth(text.replace(/\s+/g, ' ').trim(), '[health]');
// Code points, never inside a word.
export const cutLine = (text: string, max: number): string => {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join('');
  return `${/\s/.test(chars[max - 1]!) ? head : head.replace(/\S+$/, '') || head}`.trimEnd() + '…';
};
const line = (text: string) => cutLine(oneLine(text), LINK_LINE_CHARS);
const tableExists = (sql: Sql, name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
const isoDay = (at: number) => at > 0 ? new Date(at).toISOString().slice(0, 10) : 'undated';
const turnOf = (entryId: string) => entryId.endsWith('-reply') ? entryId.slice(0, -'-reply'.length) : entryId;

type EpisodeRow = Readonly<{ row: number; entry_id: string; speaker: string; at: number; text: string }>;
const EPISODE = "SELECT rowid AS row, entry_id, CASE speaker WHEN 'owner_said' THEN 'owner' ELSE speaker END AS speaker, at, text FROM episodes";
// A link to a message names who said it and when; its surface is on the read of its ref.
const episodeLine = (row: EpisodeRow) => line(`${row.speaker} ${isoDay(row.at)}: ${row.text}`);
const claimLine = (claim: Claim) => claim.kind === 'health' ? 'health note' : line(`${claim.kind}: ${claim.text}`);

export const recallChain = (deps: RecallChainDeps): RecallChain => ({ open: (options = {}) => {
  const { sql } = deps;
  const holds = deps.held();
  let claims: readonly Claim[] | undefined;
  const learnedFrom = (turn: string): readonly Claim[] => {
    claims ??= deps.claims.claims().filter(claim => typeof claim.source_ref === 'string' && (!options.outside || outsideSafe(claim)));
    return claims.filter(claim => claim.source_ref === `owner, ${turn}`);
  };
  const episodes = () => tableExists(sql, 'episodes');
  // The first stored row of an entry near a row: an owner message the index split keeps its own words first.
  const entryRow = (entryId: string, near: number): EpisodeRow | undefined =>
    sql.exec<EpisodeRow>(`${EPISODE} WHERE rowid BETWEEN ? AND ? AND entry_id = ? ORDER BY rowid LIMIT 1`, near - NEAR_ROWS, near + NEAR_ROWS, entryId).toArray()[0];
  const anyRow = (entryId: string): EpisodeRow | undefined => episodes() ? sql.exec<EpisodeRow>(`${EPISODE} WHERE entry_id = ? ORDER BY rowid LIMIT 1`, entryId).toArray()[0] : undefined;
  const episodeLink = (rel: RecallLinkRel, row: EpisodeRow | undefined): RecallLink[] =>
    row && !holds(row.text) ? [{ ref: String(row.row), rel, line: episodeLine(row) }] : [];

  const runSummary = (summary: string | null, kind: string, status: string) => line(summary ? `${kind} ${status}: ${summary}` : `${kind} ${status}`);
  // Runs and tasks a turn started, in the hot tables (each bounded by its own cap).
  const started = (turn: string): RecallLink[] => [
    ...(tableExists(sql, 'background_runs') ? sql.exec<{ id: string; kind: string; status: string; summary: string | null }>('SELECT id, kind, status, summary FROM background_runs WHERE parent_id = ? ORDER BY started_at', turn).toArray()
      .filter(run => !holds(run.summary)).map(run => ({ ref: `background_runs:${run.id}`, rel: 'started' as const, line: runSummary(run.summary, run.kind, run.status) })) : []),
    ...(tableExists(sql, 'task_jobs') ? sql.exec<{ id: string; status: string; title: string | null }>("SELECT id, status, CASE WHEN json_valid(brief_json) THEN json_extract(brief_json, '$.title') END AS title FROM task_jobs WHERE origin = ? ORDER BY created_at", turn).toArray()
      .filter(job => !holds(job.title)).map(job => ({ ref: `task_jobs:${job.id}`, rel: 'started' as const, line: runSummary(job.title, 'task', job.status) })) : []),
  ];

  const ofEpisode = (ref: string, limit: number, skip: ReadonlySet<string> = new Set()): RecallLink[] => {
    const at = Number(ref);
    if (!Number.isSafeInteger(at) || at < 1 || String(at) !== ref || !episodes()) return [];
    const row = sql.exec<EpisodeRow>(`${EPISODE} WHERE rowid = ?`, at).toArray()[0];
    if (!row) return [];
    const turn = turnOf(row.entry_id), surface = surfaceOfTrace(row.entry_id);
    const reply = row.entry_id.endsWith('-reply');
    const pair = episodeLink(reply ? 'reply_to' : 'reply', entryRow(reply ? turn : `${turn}-reply`, row.row));
    const learned = reply ? [] : learnedFrom(turn).map(claim => ({ ref: `c${claim.id}`, rel: 'learned' as const, line: claimLine(claim) }));
    // The turns either side on the same surface; the app's threads share one surface, so this reads across them.
    const side = (rel: 'before' | 'after') => surface === null ? [] : episodeLink(rel, sql.exec<EpisodeRow>(
      `${EPISODE} WHERE rowid ${rel === 'before' ? '<' : '>'} ? AND rowid ${rel === 'before' ? '>=' : '<='} ? AND entry_id LIKE ? AND entry_id NOT IN (?, ?) ORDER BY rowid ${rel === 'before' ? 'DESC' : ''} LIMIT 1`,
      row.row, rel === 'before' ? row.row - NEAR_ROWS : row.row + NEAR_ROWS, `${traceSurfacePrefix(surface)}%`, turn, `${turn}-reply`).toArray()[0]);
    return [...pair, ...learned, ...(reply ? [] : started(turn)), ...side('after'), ...side('before')].filter(link => !skip.has(link.ref)).slice(0, limit);
  };

  // The turn a run or task came from, if its message is in the index.
  const fromTurn = (turn: unknown, byRef: boolean): RecallLink[] => byRef && typeof turn === 'string' && surfaceOfTrace(turn) !== null ? episodeLink('from', anyRow(turn)) : [];
  const hotOrArchived = (source: 'background_runs' | 'task_jobs', id: string): Record<string, unknown> | undefined => {
    const hot = tableExists(sql, source) ? sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${source} WHERE id = ?`, id).toArray()[0] : undefined;
    if (hot) return hot;
    if (!tableExists(sql, 'history_archive')) return undefined;
    const archived = sql.exec<{ row_json: string }>('SELECT row_json FROM history_archive WHERE source = ? AND source_id = ? ORDER BY seq DESC LIMIT 1', source, id).toArray()[0];
    try { return archived ? JSON.parse(archived.row_json) as Record<string, unknown> : undefined; } catch { return undefined; }
  };
  const briefOf = (value: unknown): Record<string, unknown> => {
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
    try { return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : {}; } catch { return {}; }
  };
  const actsOn = (id: string): RecallLink[] => {
    if (!tableExists(sql, 'ledger')) return [];
    const card = sql.exec<{ kind: string; payload_json: string }>('SELECT kind, payload_json FROM ledger WHERE id = ?', id).toArray()[0];
    if (!card) return [];
    const payload = briefOf(card.payload_json);
    const text = (key: string) => typeof payload[key] === 'string' && payload[key] ? payload[key] as string : null;
    if (card.kind === 'email_send' && text('thread_id')) return [{ ref: `mail:${text('thread_id')}`, rel: 'acts_on', line: 'the mail thread this card sends in (read_thread)' }];
    if (card.kind === 'calendar_change' && text('event_id')) return [{ ref: `event:${text('event_id')}`, rel: 'acts_on', line: `the calendar event this card changes${text('start') ? `, at ${text('start')}` : ''}` }];
    return [];
  };

  const ofHistory = (ref: string, limit: number, byRef: boolean): RecallLink[] => {
    const split = ref.indexOf(':');
    const source = ref.slice(0, split), id = ref.slice(split + 1);
    if (source === 'background_runs') return fromTurn(hotOrArchived(source, id)?.parent_id, byRef).slice(0, limit);
    if (source === 'task_jobs') {
      const job = hotOrArchived(source, id);
      if (!job) return [];
      const approval = briefOf(job.brief_json).approval_id;
      const card = typeof approval === 'string' ? deps.approvalSummary(approval) : null;
      return [...fromTurn(job.origin, byRef), ...(card !== null && !holds(card) ? [{ ref: `ledger:${approval as string}`, rel: 'card' as const, line: line(card) }] : [])].slice(0, limit);
    }
    if (source === 'ledger') return actsOn(id).slice(0, limit);
    return [];
  };

  return { ofEpisode, ofHistory };
} });
