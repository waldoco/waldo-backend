// Owner-declared source limit. "Use only the text I pasted" is a hard boundary the owner sets, so it
// lives as typed state in the owner's Durable Object, not as prose the model must remember.
// This module is the store and the pure decision. Wiring it into the dispatcher and the owner turn
// (deny read-class tools while set, add promptLine() to the prompt, register set_source_scope) is a
// separate reviewed step in files owned by the owner-turn lane.
// Only an untainted owner message can change the value. Retrieved content, scheduled or event
// triggers cannot set or clear it. It never expires and /stop does not clear it; the prompt line
// shows it every turn so the model clears it when the owner starts a different task.
import type { ToolName } from '@waldo/contracts';
export type SourceScope = 'none' | 'pasted_only';
const SCOPES: readonly SourceScope[] = ['none', 'pasted_only'];
// Every tool name is classified, so adding a tool fails the build until someone decides.
// deny  = brings in material from outside the text the owner pasted (mail, calendar, files, web,
//         stored memory/context/notes/tasks/health, earlier tool output, browsing, MCP).
// allow = does not read owner or outside content: clock/date (get_context), the owner's own
//         reminder/standing-order lists (needed to act on what the owner asks), tool/skill catalog
//         metadata, and writers/proposals that read nothing back.
// delegate_task is allow here because the guard must be applied to the child's handlers too (see wiring).
export const SOURCE_SCOPE_CLASS: Readonly<Record<ToolName, 'deny' | 'allow'>> = {
  get_crs: 'deny', get_health: 'deny', query_calendar: 'deny', get_communication: 'deny', search_communication: 'deny',
  read_thread: 'deny', get_tasks: 'deny', get_master_metrics: 'deny', get_context: 'allow', query_availability: 'deny',
  remember: 'allow', forget_memory: 'allow',
  read_owner_context: 'deny', read_memory: 'deny', update_memory: 'allow', search_episodes: 'deny', propose_action: 'allow',
  execute_action: 'allow', send_message: 'allow', web_search: 'deny', read_document: 'deny', list_artifacts: 'deny',
  read_artifact: 'deny', call_mcp_tool: 'deny', read_mcp_tool: 'deny', read_drive: 'deny', write_task: 'allow', update_task: 'allow',
  draft_document: 'allow', create_artifact: 'allow', revise_artifact: 'allow', export_artifact: 'allow', draft_email: 'allow',
  send_email: 'allow', search_connector: 'deny', propose_schedule: 'allow', write_sheet_cell: 'allow', execute_code: 'allow',
  create_thread: 'allow', delete_message: 'allow', restore_message: 'allow', archive_thread: 'allow', update_thread_topics: 'allow',
  search_tools: 'allow', set_reminder: 'allow', list_reminders: 'allow', cancel_reminder: 'allow', propose_calendar_change: 'allow',
  open_loop: 'allow', close_loop: 'allow', track_responsibility: 'allow', update_todo: 'allow', list_responsibilities: 'allow', close_responsibility: 'allow', set_proactivity: 'allow', set_schedule_preference: 'allow', read_tool_output: 'deny', connect_service: 'allow',
  browse_page: 'deny', browse_act: 'deny', delegate_task: 'allow', log_meal: 'allow', log_workout: 'allow', list_health_logs: 'deny',
  set_standing_order: 'allow', list_standing_orders: 'allow', cancel_standing_order: 'allow', workspace_list: 'deny',
  workspace_read: 'deny', workspace_search: 'deny', workspace_write: 'allow', workspace_render: 'allow', skills_list: 'allow', skills_install: 'allow',
  skills_disable: 'allow', skills_load: 'allow',
};
export const EXTERNAL_READ_TOOLS = (Object.keys(SOURCE_SCOPE_CLASS) as ToolName[]).filter(name => SOURCE_SCOPE_CLASS[name] === 'deny');
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
      ? 'Owner source limit is on: use only text the owner pasted in this chat. Do not read mail, calendar, files, the web, stored memory, notes or tasks, or earlier tool output. Clear it with set_source_scope none only when the owner says so or starts a different task.'
      : null;
  }
}

// Wrap handlers so a denied read-class tool returns a typed denial while the limit is on. The store is
// checked at call time, so a limit set mid-turn applies at once. Apply it to the handler array before
// delegate_task is attached; child agents filter that same array, so they inherit the denial.
export const guardExternalReads = <H extends { name: string; handle: (...args: never[]) => Promise<unknown> }>(store: SourceScopeStore, handlers: readonly H[]): H[] =>
  handlers.map((handler) => DENIED.has(handler.name)
    ? { ...handler, async handle(...args: never[]) {
      return store.denies(handler.name)
        ? { ok: false, code: 'forbidden', error: 'The owner limited this task to text they pasted. Ask the owner before reading anything else.' }
        : handler.handle(...args);
    } } as H
    : handler);
