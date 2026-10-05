import { carriesTopic, hidesTopic } from './forget-guard';
import { projectionValueHolds, decodedLeafHit, LITERAL_REDACTED_STORES, likePrefilter, PROJECTION_STORES, projectionKeyHit, projectionPredicate, projectionRawHit, projectionValueHit } from './claims';

// Owner-only diagnostic: the shape of stored rows that hold a forget, never their content.
// A row is listed only when the real hold predicate is true for a pending topic (named t1, t2 by order, never by text):
// guard_escape (hidesTopic), nul (a NUL beside the topic), or projection (the topic is a raw substring, JSON value or JSON key).
export const HELD_ROW_TABLES: Readonly<Record<string, readonly string[]>> = {
  update_cards: ['changes', 'text'], day_plan: ['reason'], standing_orders: ['scope', 'escalation'],
  core_file_revisions: ['content'], memory_backups: ['payload'], spots: ['text', 'evidence'],
  run_candidates: ['candidate_json'], held_candidates: ['candidate_json'], outbox: ['payload'], schedule: ['payload_json'],
  claims: ['text', 'evidence', 'aliases', 'source_ref'], thread_topic_index: ['topic'], memory_blocks: ['content', 'decision_log'],
  memory_inbox: ['claim', 'content'], patrol_log: ['summary'], goals: ['description', 'baseline', 'target', 'progress'],
  // Mirrors the collect() list in claims.ts forgetSources (a hand copy; keep in step with it).
  episodes: ['text'], constellation_nodes: ['label', 'summary'], loops: ['title'], background_runs: ['summary'], reminder_notes: ['note'],
};

type Sql = Pick<SqlStorage, 'exec'>;
export type HeldTopic = Readonly<{ topic: string; state: 'incomplete' | 'pending' }>;

// The harness reply is cut at this length before it is sent (telegram-owner-do), so the output is capped to it and the cut is announced inside it.
export const HARNESS_MESSAGE_LIMIT = 4000;

const escapeCounts = (value: string) => {
  const counts = { u: 0, bad_u: 0, quote_slash: 0, ctl: 0, other: 0 };
  for (let index = value.indexOf('\\'); index !== -1; index = value.indexOf('\\', index + 2)) {
    const next = value[index + 1];
    if (next === 'u') { if (/^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) counts.u++; else counts.bad_u++; }
    else if (next === '"' || next === '\\' || next === '/') counts.quote_slash++;
    else if (next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') counts.ctl++;
    else counts.other++;
  }
  return counts;
};

// Iterative so a deeply nested value cannot overflow the stack.
const jsonShape = (value: string): { json: 'none' | 'ok' | 'bad' | 'unreadable'; depth: number; values: string[]; keys: string[] } => {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { json: /^\s*[[{]/.test(value) ? 'bad' : 'none', depth: 0, values: [], keys: [] }; }
  const values: string[] = []; const keys: string[] = []; let depth = 0;
  const stack: Array<[unknown, number]> = [[parsed, 1]];
  for (let step = 0; stack.length; step++) {
    if (step > 1_000_000) return { json: 'unreadable', depth, values, keys };
    const [node, level] = stack.pop()!;
    depth = Math.max(depth, level);
    if (typeof node === 'string') values.push(node);
    else if (Array.isArray(node)) for (const child of node) stack.push([child, level + 1]);
    else if (node !== null && typeof node === 'object') for (const [key, child] of Object.entries(node)) { keys.push(key); stack.push([child, level + 1]); }
  }
  return { json: 'ok', depth, values, keys };
};

// The hold verdict comes from the real guard (`real` is claimStore.forgetSources), so this view cannot disagree with it.
// Row shapes cover only what the guard's own row test selects: a row with a backslash or NUL (SQL instr, no case folding),
// judged by hidesTopic and the NUL rule. carries/val/key are facts about the row, not holds.
export type RealHold = (topic: string) => Readonly<{ incomplete: boolean; heldBy?: readonly Readonly<{ table: string; rule: string; rows: number }>[] }>;
// Rows read per call; a larger store continues from the printed rowid.
export const HELDROWS_SCAN_BUDGET = 200;
// Characters the per-topic block may use; the rest of the 4000 is kept for the summary, the label and the truncation notice.
export const HELDROWS_TOPIC_BUDGET = 2400;

export const heldRowShapes = (sql: Sql, table: string, topics: readonly HeldTopic[], limit: number, real: RealHold, from?: number | 'invalid'): string => {
  const usage = `Usage: /heldrows <${Object.keys(HELD_ROW_TABLES).join(' | ')}> [fromRowid]`;
  // The topic block shares a fixed budget so the summary and notices below always fit inside the delivery cap.
  // Verdicts run the real forgetSources, so they are computed only for the topics shown.
  const head: string[] = []; let headSize = 0; let shown = 0;
  for (const [index, { topic, state }] of topics.entries()) {
    const room = HELDROWS_TOPIC_BUDGET - headSize - 1;
    if (room < 24) break;
    const r = real(topic);
    const full = `t${index + 1}: ${state} ${r.incomplete ? 'incomplete' : 'complete'}${r.heldBy?.length ? ` held by ${r.heldBy.map(h => `${h.table}:${h.rule}:${h.rows}`).join(' ')}` : ''}`;
    // A topic is evaluated only if it will be shown; a line longer than the room is cut, not dropped.
    const line = full.length > room ? `${full.slice(0, room - 3)}...` : full;
    head.push(line); headSize += line.length + 1; shown++;
  }
  const headLines = topics.length ? [`topics ${topics.length}${shown < topics.length ? ` (+${topics.length - shown} more topics not shown)` : ''}`, ...head] : ['topics none pending'];
  if (table === '') return [...headLines, usage].join('\n');
  if (!Object.hasOwn(HELD_ROW_TABLES, table) || from === 'invalid') return usage;
  const columns = HELD_ROW_TABLES[table]!;
  if (!sql.exec('SELECT 1 FROM sqlite_master WHERE name = ?', table).toArray().length) return `${table}: no such table`;
  const present = columns.filter(column => sql.exec('SELECT name FROM pragma_table_info(?) WHERE name = ?', table, column).toArray().length);
  if (!present.length || !topics.length) return [...headLines, `${table}: nothing to inspect`].join('\n');
  const first = sql.exec<{ m: number | null }>(`SELECT MIN(rowid) AS m FROM ${table}`).toArray()[0]?.m ?? 0;
  let after = from !== undefined ? from : first - 1;
  // Budget bounds rows read per call, not bytes or CPU; the topic block runs the real forgetSources per topic (the cost of a real forget).
  const selector = present.map(column => `instr(${column}, char(92)) > 0 OR instr(CAST(${column} AS BLOB), x'00') > 0`).join(' OR ');
  const page = sql.exec<Record<string, SqlStorageValue>>(`SELECT rowid AS rid, ${present.join(', ')} FROM ${table} WHERE rowid > ? AND (${selector}) ORDER BY rowid LIMIT ?`, after, HELDROWS_SCAN_BUDGET + 1).toArray();
  const more = page.length > HELDROWS_SCAN_BUDGET;
  const lines: string[] = []; let scanned = 0;
  for (const row of page.slice(0, HELDROWS_SCAN_BUDGET)) {
    scanned++; after = Number(row.rid);
    const parts: string[] = [];
    for (const column of present) {
      const value = row[column];
      if (typeof value !== 'string') continue;
      const escapes = escapeCounts(value); const nul = value.split('\0').length - 1; const shape = jsonShape(value);
      const holds = topics.flatMap(({ topic }, index) => {
        const rules = [...(hidesTopic(value, topic) ? ['guard_escape'] : []), ...(nul && !hidesTopic(value, topic) && carriesTopic(value, topic) ? ['nul'] : [])];
        return rules.length ? [`t${index + 1}[${rules.join('+')} carries=${carriesTopic(value, topic) ? 1 : 0} val=${shape.values.some(v => carriesTopic(v, topic)) ? 1 : 0} key=${shape.keys.some(k => carriesTopic(k, topic)) ? 1 : 0}]`] : [];
      });
      if (holds.length) parts.push(`${column} len=${value.length} json=${shape.json} depth=${shape.depth} esc[u=${escapes.u} bad_u=${escapes.bad_u} q=${escapes.quote_slash} ctl=${escapes.ctl} other=${escapes.other}] nul=${nul} ${holds.join(' ')}`);
    }
    if (parts.length) lines.push(`#${String(row.rid)} ${parts.join(' | ')}`);
  }
  const summary = `${table}: ${lines.length} listed of ${scanned} rows with a backslash or NUL${more ? `; PARTIAL, continue with /heldrows ${table} ${after}` : ''}`;
  // Projection and decoded-leaf holds: the same predicate and decoder forgetSources uses (shared code in claims.ts), names and sizes only.
  const extra: string[] = []; const notes: string[] = []; let stopped = false; const after0 = from !== undefined ? from : first - 1;
  const projection = PROJECTION_STORES.find(([name]) => name === table);
  const leafStore = LITERAL_REDACTED_STORES.find(([name]) => name === table);
  for (const [index, { topic }] of topics.slice(0, Math.max(shown, 1)).entries()) {
    if (extra.length > limit) { stopped = true; break; }
    const like = likePrefilter(topic);
    if (projection) {
      const cols = present.filter(column => (projection[1] as readonly string[]).includes(column));
      if (cols.length) {
        const flags = cols.map(column => `${column} AS ${column}_v, length(${column}) AS ${column}_len, json_valid(${column}) AS ${column}_json, ${projectionRawHit(column)} AS ${column}_raw, ${projectionValueHit(column)} AS ${column}_val, ${projectionKeyHit(column)} AS ${column}_key`).join(', ');
        // Every prefilter candidate holds the forget (same predicate as forgetSources), so every candidate is listed.
        const candidates = sql.exec<Record<string, number | string | null>>(`SELECT rowid AS rid, ${flags} FROM ${table} WHERE (${projectionPredicate(cols)}) AND rowid > ? ORDER BY rowid LIMIT ?`, ...cols.flatMap(() => [like, like, like]), ...cols.flatMap(() => [like, like, like]), after0, HELDROWS_SCAN_BUDGET + 1).toArray();
        const scanned = candidates.slice(0, HELDROWS_SCAN_BUDGET);
        const rows = scanned;
        for (const row of rows.slice(0, limit)) extra.push(`#${String(row.rid)} t${index + 1}[projection ${cols.map(column => `${column} len=${row[`${column}_len`] ?? 'null'} json=${row[`${column}_json`] ? 1 : 0} raw=${row[`${column}_raw`] ? 1 : 0} val=${row[`${column}_val`] ? 1 : 0} key=${row[`${column}_key`] ? 1 : 0}`).join(' | ')}]`);
        if (rows.length > limit) notes.push(`t${index + 1}: more projection rows not shown, continue with /heldrows ${table} ${String(rows[limit - 1]!.rid)}`);
        else if (candidates.length > HELDROWS_SCAN_BUDGET) notes.push(`t${index + 1}: projection scan PARTIAL, continue with /heldrows ${table} ${String(scanned[HELDROWS_SCAN_BUDGET - 1]!.rid)}`);
      }
    }
    if (leafStore) for (const column of present.filter(name => (leafStore[1] as readonly string[]).includes(name))) {
      const rows = sql.exec<{ rid: number; value: string }>(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != '' AND ${column} NOT LIKE ? ESCAPE '\\' AND rowid > ? ORDER BY rowid LIMIT ?`, like, after0, HELDROWS_SCAN_BUDGET + 1).toArray();
      for (const row of rows.slice(0, HELDROWS_SCAN_BUDGET)) if (decodedLeafHit(row.value, topic)) extra.push(`#${row.rid} t${index + 1}[decoded_leaf_or_unreadable ${column} len=${row.value.length}]`);
      if (rows.length > HELDROWS_SCAN_BUDGET) notes.push(`t${index + 1}: decoded-leaf scan of ${column} PARTIAL, continue with /heldrows ${table} ${rows[HELDROWS_SCAN_BUDGET - 1]!.rid}`);
    }
  }
  if (stopped) notes.push('further topics not scanned for projection or decoded-leaf rows');
  if (notes.length > 5) notes.splice(5, notes.length - 5, `+${notes.length - 5} more notes not shown`);
  lines.push(...extra);
  const out = [...headLines, summary, 'row listing: escape/NUL rows (summary above), then projection and decoded-leaf rows chosen by the same predicate as the hold', ...notes]; let size = out.join('\n').length; let cut = 0;
  const reserve = `truncated: ${lines.length} more rows not shown`.length + 1;
  for (const line of lines.slice(0, limit)) {
    if (size + line.length + 1 > HARNESS_MESSAGE_LIMIT - reserve) { cut++; continue; }
    out.push(line); size += line.length + 1;
  }
  cut += Math.max(0, lines.length - limit);
  if (cut) out.push(`truncated: ${cut} more rows not shown`);
  return out.join('\n');
};
