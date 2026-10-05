// Owner-only diagnostic: the shape of the stored rows that can hold a forget, never their content.
// Each row is described by lengths, JSON validity and depth, escape and NUL counts, and whether a
// pending topic (named t1, t2 by order, never by text) appears as a raw substring, a JSON value or a JSON key.
export const HELD_ROW_TABLES: Readonly<Record<string, readonly string[]>> = {
  update_cards: ['changes', 'text'], day_plan: ['reason'], standing_orders: ['scope', 'escalation'],
  core_file_revisions: ['content'], memory_backups: ['payload'], spots: ['text', 'evidence'],
  run_candidates: ['candidate_json'], held_candidates: ['candidate_json'], outbox: ['payload'], schedule: ['payload_json'],
  claims: ['text', 'evidence', 'aliases', 'source_ref'], thread_topic_index: ['topic'], memory_blocks: ['content', 'decision_log'],
  memory_inbox: ['claim', 'content'], patrol_log: ['summary'], goals: ['description', 'baseline', 'target', 'progress'],
};

type Sql = Pick<SqlStorage, 'exec'>;

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

export const heldRowShapes = (sql: Sql, table: string, topics: readonly string[], limit: number): string => {
  const columns = HELD_ROW_TABLES[table];
  if (!columns) return `Usage: /heldrows <${Object.keys(HELD_ROW_TABLES).join(' | ')}>`;
  if (!sql.exec('SELECT 1 FROM sqlite_master WHERE name = ?', table).toArray().length) return `${table}: no such table`;
  const present = columns.filter(column => sql.exec('SELECT name FROM pragma_table_info(?) WHERE name = ?', table, column).toArray().length);
  const rows = sql.exec<Record<string, SqlStorageValue>>(`SELECT rowid AS rid, ${present.join(', ')} FROM ${table} ORDER BY rowid`).toArray();
  const lowered = topics.map(topic => topic.toLowerCase());
  const lines: string[] = [];
  let flagged = 0;
  for (const row of rows) {
    const parts: string[] = []; let interesting = false;
    for (const column of present) {
      const value = row[column];
      if (typeof value !== 'string') continue;
      const escapes = escapeCounts(value); const nul = value.split('\0').length - 1;
      const shape = jsonShape(value); const low = value.toLowerCase();
      const hits = lowered.map((topic, index) => `t${index + 1}[raw=${low.includes(topic) ? 1 : 0} val=${shape.values.some(v => v.toLowerCase().includes(topic)) ? 1 : 0} key=${shape.keys.some(k => k.toLowerCase().includes(topic)) ? 1 : 0}]`);
      const escaped = escapes.u + escapes.bad_u + escapes.quote_slash + escapes.ctl + escapes.other;
      if (escaped || nul || shape.json === 'bad' || shape.json === 'unreadable' || hits.some(hit => hit.includes('=1'))) interesting = true;
      parts.push(`${column} len=${value.length} json=${shape.json} depth=${shape.depth} esc[u=${escapes.u} bad_u=${escapes.bad_u} q=${escapes.quote_slash} ctl=${escapes.ctl} other=${escapes.other}] nul=${nul} ${hits.join(' ')}`.trim());
    }
    if (!interesting) continue;
    flagged++;
    if (lines.length < limit) lines.push(`#${String(row.rid)} ${parts.join(' | ')}`);
  }
  return [`${table}: ${rows.length} rows, ${flagged} flagged (escape, NUL, bad JSON or topic hit), topics pending: ${topics.length}`, ...lines].join('\n');
};
