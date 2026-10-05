import { carriesTopic, hidesTopic } from './forget-guard';

// Owner-only diagnostic: the shape of stored rows that hold a forget, never their content.
// A row is listed only when the real hold predicate is true for a pending topic (named t1, t2 by order, never by text):
// guard_escape (hidesTopic), nul (a NUL beside the topic), or projection (the topic is a raw substring, JSON value or JSON key).
export const HELD_ROW_TABLES: Readonly<Record<string, readonly string[]>> = {
  update_cards: ['changes', 'text'], day_plan: ['reason'], standing_orders: ['scope', 'escalation'],
  core_file_revisions: ['content'], memory_backups: ['payload'], spots: ['text', 'evidence'],
  run_candidates: ['candidate_json'], held_candidates: ['candidate_json'], outbox: ['payload'], schedule: ['payload_json'],
  claims: ['text', 'evidence', 'aliases', 'source_ref'], thread_topic_index: ['topic'], memory_blocks: ['content', 'decision_log'],
  memory_inbox: ['claim', 'content'], patrol_log: ['summary'], goals: ['description', 'baseline', 'target', 'progress'],
};

type Sql = Pick<SqlStorage, 'exec'>;
export type HeldTopic = Readonly<{ topic: string; state: 'incomplete' | 'pending' }>;

// Telegram's documented single-message limit; output stops before it and says so.
const MESSAGE_LIMIT = 4096;

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

export const heldRowShapes = (sql: Sql, table: string, topics: readonly HeldTopic[], limit: number): string => {
  if (!Object.hasOwn(HELD_ROW_TABLES, table)) return `Usage: /heldrows <${Object.keys(HELD_ROW_TABLES).join(' | ')}>`;
  const columns = HELD_ROW_TABLES[table]!;
  if (!sql.exec('SELECT 1 FROM sqlite_master WHERE name = ?', table).toArray().length) return `${table}: no such table`;
  const present = columns.filter(column => sql.exec('SELECT name FROM pragma_table_info(?) WHERE name = ?', table, column).toArray().length);
  const header = `${table}: topics ${topics.map((topic, index) => `t${index + 1}=${topic.state}`).join(' ') || 'none pending'}`;
  if (!present.length || !topics.length) return `${header}; nothing to inspect`;
  // SQL narrows to rows that can hold (a backslash, a NUL, or a raw topic hit) so a large store is never read whole.
  const likes = topics.map(({ topic }) => `%${topic.replace(/[\\%_]/g, char => `\\${char}`)}%`);
  const where = present.map(column => `(instr(${column}, char(92)) > 0 OR instr(CAST(${column} AS BLOB), x'00') > 0${likes.map(() => ` OR ${column} LIKE ? ESCAPE '\\'`).join('')})`).join(' OR ');
  const bindings = present.flatMap(() => likes);
  const candidates = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...bindings).toArray()[0]?.n ?? 0;
  const rows = sql.exec<Record<string, SqlStorageValue>>(`SELECT rowid AS rid, ${present.join(', ')} FROM ${table} WHERE ${where} ORDER BY rowid LIMIT ?`, ...bindings, limit).toArray();
  const lines: string[] = []; let held = 0;
  for (const row of rows) {
    const parts: string[] = [];
    for (const column of present) {
      const value = row[column];
      if (typeof value !== 'string') continue;
      const escapes = escapeCounts(value); const nul = value.split('\0').length - 1; const shape = jsonShape(value); const low = value.toLowerCase();
      const holds = topics.flatMap(({ topic }, index) => {
        const lowered = topic.toLowerCase();
        const raw = low.includes(lowered); const val = shape.values.some(v => v.toLowerCase().includes(lowered)); const key = shape.keys.some(k => k.toLowerCase().includes(lowered));
        const rules = [...(hidesTopic(value, topic) ? ['guard_escape'] : []), ...(value.includes('\0') && carriesTopic(value, topic) ? ['nul'] : []), ...(raw || val || key ? ['projection'] : [])];
        return rules.length ? [`t${index + 1}[hold=${rules.join('+')} raw=${raw ? 1 : 0} val=${val ? 1 : 0} key=${key ? 1 : 0}]`] : [];
      });
      if (holds.length) parts.push(`${column} len=${value.length} json=${shape.json} depth=${shape.depth} esc[u=${escapes.u} bad_u=${escapes.bad_u} q=${escapes.quote_slash} ctl=${escapes.ctl} other=${escapes.other}] nul=${nul} ${holds.join(' ')}`);
    }
    if (parts.length) { held++; lines.push(`#${String(row.rid)} ${parts.join(' | ')}`); }
  }
  const summary = `${header}; ${held} held among ${rows.length} scanned of ${candidates} candidate rows (backslash, NUL or topic substring)${candidates > rows.length ? `, first ${limit} by rowid` : ''}`;
  const out = [summary]; let size = summary.length; let cut = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MESSAGE_LIMIT - 40) { cut++; continue; }
    out.push(line); size += line.length + 1;
  }
  if (cut) out.push(`truncated: ${cut} more held rows not shown`);
  return out.join('\n');
};
