import { replaceLiteralText, type HistoryEntry, type HistoryKind, type SearchHistoryChainArgs, type SearchHistoryResult } from '@waldo/contracts';
import { HISTORY_ARCHIVE_TABLE_SCHEMA } from '../do-schema';
import { FORGOTTEN, likePrefilter, projectionPredicate, projectionValueHolds } from '../memory/claims';
import type { ForgetStore } from '../memory/forget-purge';

// Retention means archive, never delete: a row past a hot table's cap moves to history_archive in one transaction, and the
// model can still find it through search_history and a forget still reaches it. HISTORY_ARCHIVE picks the behaviour:
//  0    the hot tables' own trims run as they always have (the rollback).
//  dry  nothing is moved and nothing is trimmed; the counts that would move are logged per source.
//  1    rows move: INSERT ... SELECT into the archive, then DELETE from the hot table, with no I/O in between.

type Sql = Pick<SqlStorage, 'exec'>;
export type ArchiveMode = 'off' | 'dry' | 'on';
export const archiveMode = (value: string | undefined): ArchiveMode => value === '1' ? 'on' : value === 'dry' ? 'dry' : 'off';
export type ArchiveSource = 'background_runs' | 'task_jobs' | 'schedule_runs';
export type HistoryArchive = Readonly<{
  mode: ArchiveMode;
  // Moves these rows of the source, or under dry only counts them. Answers how many moved.
  retire(source: ArchiveSource, ids: readonly string[]): number;
}>;
export type ArchiveDeps = Readonly<{
  sql: Sql; transaction: <T>(work: () => T) => T; mode: ArchiveMode; now(): number;
  // Content-free: a source name and a count.
  log(event: Readonly<{ hop: 'history_archive_moved' | 'history_archive_dry'; source: ArchiveSource; count: number }>): void;
}>;

// The columns search reads, from each hot table's own shape. A settled task keeps its title (cut to 80 characters when it
// settled), an approved action's replay its tool, a machine job its job name. Schedule runs carry no text.
const brief = (path: string) => `CASE WHEN json_valid(brief_json) THEN json_extract(brief_json, '${path}') END`;
const PROJECTION: Readonly<Record<ArchiveSource, Readonly<{ kind: string; status: string; started: string; ended: string; summary: string }>>> = {
  background_runs: { kind: 'kind', status: 'status', started: 'started_at', ended: 'ended_at', summary: 'summary' },
  task_jobs: {
    kind: 'kind', status: 'status', started: 'created_at', ended: 'settled_at',
    summary: `COALESCE(${brief('$.title')}, ${brief('$.tool')}, CASE WHEN origin LIKE 'machine:%' THEN substr(origin, 9) END)`,
  },
  schedule_runs: { kind: 'kind', status: 'outcome', started: 'fired_at', ended: 'settled_at', summary: 'NULL' },
};
const GROUP: Readonly<Record<ArchiveSource, HistoryKind>> = { background_runs: 'run', task_jobs: 'task', schedule_runs: 'scheduled' };
const SOURCES = Object.keys(GROUP) as ArchiveSource[];

const tableExists = (sql: Sql, name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
// The whole hot row as one JSON object. A JSON column is kept as JSON, not as a string of it, so the forget's readback of
// decoded leaves sees its words.
const rowJson = (sql: Sql, source: ArchiveSource) => `json_object(${sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${source}') ORDER BY cid`).toArray()
  .map(({ name }) => `'${name}', ${name.endsWith('_json') ? `CASE WHEN json_valid(${name}) THEN json(${name}) ELSE ${name} END` : name}`).join(', ')})`;
const IDS = 'id IN (SELECT value FROM json_each(?))';

export const historyArchive = (deps: ArchiveDeps): HistoryArchive => ({
  mode: deps.mode,
  retire(source, ids) {
    if (!ids.length || deps.mode === 'off') return 0;
    if (deps.mode === 'dry') { deps.log({ hop: 'history_archive_dry', source, count: ids.length }); return 0; }
    const list = JSON.stringify(ids), p = PROJECTION[source];
    // Any failed INSERT throws and rolls the move back, so the DELETE can never remove a row the archive did not receive.
    const moved = deps.transaction(() => {
      for (const statement of HISTORY_ARCHIVE_TABLE_SCHEMA) deps.sql.exec(statement);
      const inserted = deps.sql.exec(
        `INSERT INTO history_archive (source, source_id, kind, status, started_at, ended_at, summary, row_json, archived_at)
         SELECT '${source}', id, ${p.kind}, ${p.status}, ${p.started}, ${p.ended}, ${p.summary}, ${rowJson(deps.sql, source)}, ?
           FROM ${source} WHERE ${IDS} RETURNING seq`, deps.now(), list,
      ).toArray().length;
      // Rows, not rowsWritten, which counts index entries too.
      const deleted = deps.sql.exec(`DELETE FROM ${source} WHERE ${IDS} RETURNING id`, list).toArray().length;
      if (inserted !== deleted) throw new Error('history archive move did not match');
      return deleted;
    });
    deps.log({ hop: 'history_archive_moved', source, count: moved });
    return moved;
  },
});

// Settled schedule runs leave the hot table only as whole occurrences, older than this, and only while nothing still reads
// them: no run of the occurrence is running (hasRunningRun), and the occurrence is not the one its schedule is on now or
// quarantined until (occurrenceDelivery, recordMissed and recordRunStart all read the current occurrence's rows).
export const SCHEDULE_RUNS_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60_000;
// Occurrences moved per sweep; a backlog drains over later sweeps.
export const SCHEDULE_RUNS_ARCHIVE_BATCH = 200;
// The occurrence key of a run id: everything before the ordinal. Ids are `<schedule>:<occurrence>:<ordinal>`.
const OCCURRENCE = 'substr(id, 1, length(id) - length(CAST(attempt AS TEXT)))';
export const scheduleRunsToArchive = (sql: Sql, now: number): readonly string[] => {
  if (!tableExists(sql, 'schedule_runs')) return [];
  const occurrences = sql.exec<{ occurrence: string }>(
    `SELECT schedule_id, ${OCCURRENCE} AS occurrence FROM schedule_runs
      GROUP BY schedule_id, occurrence
     HAVING SUM(outcome = 'running') = 0 AND MAX(fired_at) < ? AND MAX(COALESCE(settled_at, fired_at)) < ?
        AND NOT EXISTS (SELECT 1 FROM schedule WHERE schedule.id = schedule_runs.schedule_id
          AND occurrence IN (schedule.id || ':' || schedule.occurrence_at || ':', schedule.id || ':' || COALESCE(schedule.quarantined_until, schedule.occurrence_at) || ':'))
     ORDER BY MAX(fired_at) LIMIT ?`,
    now - SCHEDULE_RUNS_ARCHIVE_AFTER_MS, now - SCHEDULE_RUNS_ARCHIVE_AFTER_MS, SCHEDULE_RUNS_ARCHIVE_BATCH,
  ).toArray().map(row => row.occurrence);
  if (!occurrences.length) return [];
  return sql.exec<{ id: string }>(`SELECT id FROM schedule_runs WHERE ${OCCURRENCE} IN (SELECT value FROM json_each(?)) ORDER BY id`, JSON.stringify(occurrences)).toArray().map(row => row.id);
};

// The once-a-day sweep of settled schedule runs. The stamp is written only after the sweep returns, so a sweep that throws
// runs again on the next wake. A dry run writes no stamp either, and counts again on each wake.
export const SCHEDULE_RUNS_SWEEP_EVERY_MS = 24 * 60 * 60_000;
export const sweepScheduleRuns = (deps: ArchiveDeps & Readonly<{ kv: Pick<SyncKvStorage, 'get' | 'put'> }>): number => {
  if (deps.mode === 'off') return 0;
  const last = deps.kv.get<number>('history_archive:schedule_runs_swept_at') ?? 0;
  if (deps.now() - last < SCHEDULE_RUNS_SWEEP_EVERY_MS) return 0;
  const moved = historyArchive(deps).retire('schedule_runs', scheduleRunsToArchive(deps.sql, deps.now()));
  if (deps.mode === 'on') deps.kv.put('history_archive:schedule_runs_swept_at', deps.now());
  return moved;
};

// Forget: the archive gets the redaction its hot table gives. A run's summary goes whole; other text loses the words, and a
// copy the literal redaction cannot rewrite (an escape that spells it, a split) is dropped from the row: an archived row
// needs none of it. Answers how many archived rows still carry a text.
const redactLeaves = (value: unknown, redact: (text: string) => string): unknown =>
  typeof value === 'string' ? redact(value)
    : Array.isArray(value) ? value.map(child => redactLeaves(child, redact))
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactLeaves(child, redact)]))
        : value;
type ArchivedText = Readonly<{ seq: number; source: ArchiveSource; summary: string | null; row_json: string }>;
const forgetTopics = (texts: readonly string[]) => [...new Set(texts.map(text => text.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
const holdsAny = (topics: readonly string[]) => (value: unknown) => topics.some(topic => projectionValueHolds(value, topic));
// Archived rows that carry one of the texts, by the forget's own predicate: the prefilter selects a superset.
const carrying = (sql: Sql, topics: readonly string[]): ArchivedText[] => {
  if (!topics.length || !tableExists(sql, 'history_archive')) return [];
  const holds = holdsAny(topics), seen = new Map<number, ArchivedText>();
  for (const topic of topics) {
    const like = likePrefilter(topic);
    for (const row of sql.exec<ArchivedText>(`SELECT seq, source, summary, row_json FROM history_archive WHERE ${projectionPredicate(['summary', 'row_json'])}`, like, like, like, like, like, like).toArray()) seen.set(row.seq, row);
  }
  return [...seen.values()].filter(row => holds(row.summary) || holds(row.row_json));
};
// Whether a forget of these texts would change the archive: the forget tool counts archived history it touches as memory.
export const archiveCarries = (sql: Sql, texts: readonly string[]): boolean => carrying(sql, forgetTopics(texts)).length > 0;
export const historyArchiveForgetStore = (deps: Readonly<{ sql: Sql; transaction: <T>(work: () => T) => T }>): ForgetStore => ({
  name: 'history_archive',
  run: (texts) => {
    const topics = forgetTopics(texts);
    if (!topics.length || !tableExists(deps.sql, 'history_archive')) return 0;
    const holds = holdsAny(topics);
    const redact = (text: string) => topics.reduce((value, topic) => replaceLiteralText(value, topic, FORGOTTEN), text);
    return deps.transaction(() => {
      for (const row of carrying(deps.sql, topics)) {
        let summary = row.summary === null || !holds(row.summary) ? row.summary : row.source === 'background_runs' ? null : redact(row.summary);
        if (summary !== null && holds(summary)) summary = null;
        let fields: Record<string, unknown>;
        try { fields = JSON.parse(row.row_json) as Record<string, unknown>; } catch { fields = {}; }
        fields = redactLeaves(fields, redact) as Record<string, unknown>;
        if (row.source === 'background_runs' && 'summary' in fields) fields.summary = summary;
        for (const [column, value] of Object.entries(fields)) if (holds(typeof value === 'string' ? value : JSON.stringify(value))) fields[column] = column === 'brief_json' ? {} : null;
        deps.sql.exec('UPDATE history_archive SET summary = ?, row_json = ? WHERE seq = ?', summary, JSON.stringify(fields), row.seq);
      }
      return carrying(deps.sql, topics).length;
    });
  },
});

// search_history: newest first across the hot tables, the archive and the decided approval cards. A row moved between two
// pages keeps its ref and its time, so the cursor neither repeats nor skips it.
export type ApprovalSummary = (id: string) => string | null;
const iso = (at: number | null) => at === null ? null : new Date(at).toISOString();
const MAX_WORDS = 8;
// args.ref (recall chain on) reads that one entry.
export const searchHistory = (sql: Sql, args: SearchHistoryChainArgs, approvalSummary: ApprovalSummary): SearchHistoryResult => {
  const kinds = new Set<HistoryKind>(args.kinds ?? ['run', 'task', 'scheduled', 'approval']);
  const parts: string[] = [];
  for (const source of SOURCES) {
    if (!kinds.has(GROUP[source]) || !tableExists(sql, source)) continue;
    const p = PROJECTION[source];
    parts.push(`SELECT '${source}:' || id AS ref, '${GROUP[source]}' AS grp, ${p.kind} AS type, ${p.status} AS status, ${p.started} AS ts, ${p.ended} AS ended, ${p.summary} AS summary, 0 AS archived FROM ${source}`);
  }
  if (tableExists(sql, 'history_archive')) {
    const archived = SOURCES.filter(source => kinds.has(GROUP[source]));
    if (archived.length) parts.push(`SELECT source || ':' || source_id, CASE source ${archived.map(source => `WHEN '${source}' THEN '${GROUP[source]}'`).join(' ')} END, kind, status, started_at, ended_at, summary, 1
      FROM history_archive WHERE source IN (${archived.map(source => `'${source}'`).join(', ')})`);
  }
  if (kinds.has('approval') && tableExists(sql, 'ledger')) {
    // Decided as the desk's own Recent list reads it; an open card is the desk's to show.
    parts.push("SELECT 'ledger:' || id, 'approval', kind, status, COALESCE(decided_at, created_at), decided_at, summary, 0 FROM ledger WHERE status NOT IN ('open', 'changing', 'card_unconfirmed', 'review_only')");
  }
  if (!parts.length) return { entries: [], total: 0, next_cursor: null };
  const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  const filters: string[] = [], params: SqlStorageValue[] = [];
  for (const word of words) { filters.push("instr(lower(COALESCE(summary, '') || ' ' || type || ' ' || status), ?) > 0"); params.push(word); }
  if (args.from !== undefined) { filters.push('ts >= ?'); params.push(Date.parse(args.from)); }
  if (args.to !== undefined) { filters.push('ts < ?'); params.push(Date.parse(args.to)); }
  if (args.ref !== undefined) { filters.push('ref = ?'); params.push(args.ref); }
  const history = `WITH history (ref, grp, type, status, ts, ended, summary, archived) AS (${parts.join(' UNION ALL ')})`;
  const where = (extra: string[]) => extra.length ? ` WHERE ${extra.join(' AND ')}` : '';
  const total = sql.exec<{ n: number }>(`${history} SELECT COUNT(*) AS n FROM history${where(filters)}`, ...params).one().n;
  const page = [...filters], pageParams = [...params];
  if (args.cursor !== undefined) {
    const split = args.cursor.indexOf(':');
    const at = Number(args.cursor.slice(0, split)), ref = args.cursor.slice(split + 1);
    page.push('(ts < ? OR (ts = ? AND ref < ?))'); pageParams.push(at, at, ref);
  }
  type Row = Readonly<{ ref: string; grp: HistoryKind; type: string; status: string; ts: number; ended: number | null; summary: string | null; archived: number }>;
  const rows = sql.exec<Row>(`${history} SELECT * FROM history${where(page)} ORDER BY ts DESC, ref DESC LIMIT ?`, ...pageParams, args.limit + 1).toArray();
  const entries: HistoryEntry[] = rows.slice(0, args.limit).map(row => ({
    ref: row.ref, kind: row.grp, type: row.type, status: row.status,
    summary: row.grp === 'approval' ? approvalSummary(row.ref.slice('ledger:'.length)) : row.summary,
    started_at: iso(row.ts)!, ended_at: iso(row.ended), archived: row.archived === 1,
  }));
  const last = rows.length > args.limit ? rows[args.limit - 1]! : null;
  return { entries, total, next_cursor: last ? `${last.ts}:${last.ref}` : null };
};
