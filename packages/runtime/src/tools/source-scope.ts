// Owner-declared source limit. "Use only the text I pasted" is a hard boundary the owner sets, so it
// lives as typed state in the owner's Durable Object, not as prose the model must remember.
// This module is the store and the pure decision. Wiring it into the dispatcher and the owner turn
// (deny read-class tools while set, add promptLine() to the prompt, register set_source_scope) is a
// separate reviewed step in files owned by the owner-turn lane.
// Only an untainted owner message can change the value. Retrieved content, scheduled or event
// triggers cannot set or clear it. It never expires and /stop does not clear it; the prompt line
// shows it every turn so the model clears it when the owner starts a different task.
export type SourceScope = 'none' | 'pasted_only';
const SCOPES: readonly SourceScope[] = ['none', 'pasted_only'];
// Read-class tools that bring in material from outside the owner's pasted text.
export const EXTERNAL_READ_TOOLS = [
  'search_communication', 'get_communication', 'read_thread', 'read_drive', 'query_calendar',
  'web_search', 'browse_page', 'browse_act', 'workspace_read', 'workspace_list', 'read_mcp_tool', 'search_episodes',
] as const;
const DENIED = new Set<string>(EXTERNAL_READ_TOOLS);
export type ScopeContext = Readonly<{ trigger: string; toolArgSourceTaint: string | null }>;
export type ScopeResult = Readonly<{ ok: true } | { ok: false; reason: 'untrusted' | 'invalid' }>;

export class SourceScopeStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS owner_source_scope(id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL, set_at INTEGER NOT NULL)');
  }
  // A stored value this code does not know fails closed to the limit.
  current(): SourceScope {
    const row = this.sql.exec<{ scope: string }>('SELECT scope FROM owner_source_scope WHERE id = 1').toArray()[0];
    if (!row) return 'none';
    return (SCOPES as readonly string[]).includes(row.scope) ? row.scope as SourceScope : 'pasted_only';
  }
  denies(tool: string): boolean { return this.current() === 'pasted_only' && DENIED.has(tool); }
  set(scope: SourceScope, ctx: ScopeContext, now: number): ScopeResult {
    if (!(SCOPES as readonly string[]).includes(scope)) return { ok: false, reason: 'invalid' };
    if (ctx.trigger !== 'user_message' || ctx.toolArgSourceTaint !== null) return { ok: false, reason: 'untrusted' };
    this.sql.exec('INSERT INTO owner_source_scope(id, scope, set_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, set_at = excluded.set_at', scope, now);
    return { ok: true };
  }
  promptLine(): string | null {
    return this.current() === 'pasted_only'
      ? 'Owner source limit is on: use only text the owner pasted in this chat. Do not read mail, calendar, files, the web or memory. Clear it with set_source_scope none only when the owner says so or starts a different task.'
      : null;
  }
}
