import { TOOL_RECORDS } from '../tools/records';
import { META_TOOLS } from '../tools/loader';
import { APP_APPROVAL_STATE } from './approvals';
import { SOURCE_LABEL } from './dashboard-memory';
import type { projectMemoryGraph } from './memory-graph';

// The Vault: what Waldo keeps, what it can reach and what it did, for the owner who proved an email code in the last two
// hours. The step-up gate refuses the read before this module runs (STEP_UP_ROUTES). Every field here is picked by name
// from the owner's own records: no token, secret reference, server path, message body, mail subject or health value, and no
// csrf. Changes go through the existing action paths that `revoke` names; the memory actions through memory-controls.
export const DASHBOARD_VAULT_PATH = '/console/dashboard/api/v1/vault';
export const VAULT_LOG_WINDOW_DAYS = 30;
// trace_log keeps the newest 500 steps of every kind (harness traceBook), so the log can run out before 30 days do.
export const VAULT_TRACE_KEPT = 500;
const PAGE = 50, MEMORY_PER_GROUP = 50, DAY_MS = 86_400_000;
export const VAULT_TOKEN_NOTE = 'Tokens are stored encrypted (Supabase Vault). Waldo\'s model never sees them.';

export type VaultQuery = Readonly<{ toolsBefore?: number; approvalsBefore?: number }>;
// Paging cursors only: neither selects an owner, a table or a filter.
export function readVaultQuery(params: URLSearchParams): VaultQuery | null {
  const query: { toolsBefore?: number; approvalsBefore?: number } = {};
  for (const key of new Set(params.keys())) {
    const field = key === 'tools_before' ? 'toolsBefore' : key === 'approvals_before' ? 'approvalsBefore' : null;
    const raw = params.getAll(key);
    if (!field || raw.length !== 1 || !/^[1-9][0-9]{0,15}$/.test(raw[0]!) || !Number.isSafeInteger(Number(raw[0]))) return null;
    query[field] = Number(raw[0]);
  }
  return query;
}

type Sql = Pick<SqlStorage, 'exec'>;
const iso = (at: number) => new Date(at).toISOString();
const tables = (sql: Sql) => new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('trace_log','ledger')").toArray().map(row => row.name));

// A trace hop is `tool_<name>` with the name the model asked for, so only names in the tool registry are shown; anything
// else is "other". The registry's namespace is the category, and a tool whose receipt can back a done-claim is one that acts.
const toolRow = (hop: string) => {
  const name = hop.slice(5);
  if (Object.hasOwn(TOOL_RECORDS, name)) {
    const record = TOOL_RECORDS[name as keyof typeof TOOL_RECORDS];
    return { tool: name, category: record.brain, kind: record.claim === null ? 'read' as const : 'acted' as const };
  }
  if (META_TOOLS.has(name)) return { tool: name, category: 'catalog', kind: 'read' as const };
  return { tool: 'other', category: 'other', kind: 'unknown' as const };
};
const APPROVAL_KINDS = new Set(['calendar_change', 'email_send', 'message_send', 'mcp_call', 'tainted_action', 'browser_submit', 'google_task_change']);

export function readVaultAccessLog(sql: Sql, now: number, query: VaultQuery) {
  const since = now - VAULT_LOG_WINDOW_DAYS * DAY_MS, present = tables(sql);
  const tools = present.has('trace_log') ? sql.exec<{ id: number; at: number; hop: string; ok: number }>(
    "SELECT id, at, hop, ok FROM trace_log WHERE hop LIKE 'tool\\_%' ESCAPE '\\' AND hop <> 'tool_eligibility' AND at >= ? AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3",
    since, query.toolsBefore ?? null, PAGE + 1).toArray() : [];
  const oldest = present.has('trace_log') ? sql.exec<{ at: number | null }>('SELECT MIN(at) AS at FROM trace_log').toArray()[0]?.at ?? null : null;
  const approvals = present.has('ledger') ? sql.exec<{ row: number; kind: string; status: string; created_at: number; decided_at: number | null }>(
    'SELECT rowid AS row, kind, status, created_at, decided_at FROM ledger WHERE created_at >= ? AND (?2 IS NULL OR rowid < ?2) ORDER BY rowid DESC LIMIT ?3',
    since, query.approvalsBefore ?? null, PAGE + 1).toArray() : [];
  return {
    window_days: VAULT_LOG_WINDOW_DAYS, kept_steps: VAULT_TRACE_KEPT,
    tools: {
      rows: tools.slice(0, PAGE).map(row => ({ at: iso(row.at), ...toolRow(row.hop), ok: row.ok === 1 })),
      next_before: tools.length > PAGE ? tools[PAGE - 1]!.id : null,
      oldest_at: oldest === null ? null : iso(Math.max(oldest, since)),
    },
    approvals: {
      rows: approvals.slice(0, PAGE).map(row => ({
        at: iso(row.created_at), kind: APPROVAL_KINDS.has(row.kind) ? row.kind : 'other',
        decision: Object.hasOwn(APP_APPROVAL_STATE, row.status) ? APP_APPROVAL_STATE[row.status as keyof typeof APP_APPROVAL_STATE] : 'other',
        decided_at: typeof row.decided_at === 'number' ? iso(row.decided_at) : null,
      })),
      next_before: approvals.length > PAGE ? approvals[PAGE - 1]!.row : null,
    },
  };
}
export type VaultAccessLog = ReturnType<typeof readVaultAccessLog>;

type Memory = ReturnType<typeof projectMemoryGraph>;
type GoogleGrant = Readonly<{ id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }>;
type McpServer = Readonly<{ id: string; name: string; host: string; status: string; scopes: readonly string[]; tools: number; runs_without_asking: number; connected_at: number }>;
export type VaultHealth = Readonly<{
  consents: readonly Readonly<{ source: string; purpose: string; status: string; granted_at: string | null; withdrawn_at: string | null }>[];
  sources: readonly Readonly<{ source: string; newest_upload_at: string }>[];
}>;

const memorySection = (memory: Memory) => {
  const groups = new Map<string, { id: string; text: string; source_label: string; origin: string; recorded_at: string | null }[]>();
  const add = (kind: string, item: { id: string; text: string; source_label: string; origin: string; recorded_at: string | null }) => groups.set(kind, [...groups.get(kind) ?? [], item]);
  for (const claim of memory.claims) add(claim.kind || 'other', { id: claim.id, text: claim.text, source_label: SOURCE_LABEL[claim.source] ?? 'Source unverified', origin: claim.origin, recorded_at: claim.recorded_at ? claim.recorded_at.slice(0, 10) : null });
  for (const node of memory.nodes) add('interpretation', { id: node.id, text: node.label, source_label: 'Waldo\'s pattern from your Spots', origin: 'agent', recorded_at: node.recorded_active_at ? node.recorded_active_at.slice(0, 10) : null });
  return {
    state: memory.state,
    groups: [...groups].map(([kind, items]) => ({ kind, total: items.length, items: items.slice(0, MEMORY_PER_GROUP) })),
  };
};

export function projectVault(input: Readonly<{
  now: number; memory: Memory; google: readonly GoogleGrant[]; mcp: readonly McpServer[];
  telegram: Readonly<{ linked: boolean; unlinkAvailable: boolean }>; imessage?: Readonly<{ linked: boolean }>; whatsapp?: Readonly<{ linked: boolean }>;
  health: VaultHealth | null; accessLog: VaultAccessLog;
}>) {
  const newest = new Map(input.health?.sources.map(row => [row.source, row.newest_upload_at]) ?? []);
  return {
    version: 1 as const, state: 'available' as const, as_of: iso(input.now),
    memory: memorySection(input.memory),
    connections: {
      token_note: VAULT_TOKEN_NOTE,
      // Neither the account list nor the connection row Waldo reads records when a grant was made or last used.
      google: input.google.map(grant => ({
        account_id: grant.id, email: grant.email,
        grants: [grant.calendar ? 'calendar' : null, grant.mail ? 'gmail' : null, grant.tasks ? 'tasks' : null].filter((value): value is string => value !== null),
        status: grant.error ? 'needs_reconnect' as const : 'active' as const,
        // A local: account keeps its refresh token in this owner's storage because no Vault proxy was configured when it connected.
        token_storage: grant.id.startsWith('local:') ? 'waldo_server' as const : 'supabase_vault' as const,
        connected_at: null, last_used_at: null,
        revoke: { view: 'connections', action: 'google.disconnect' },
      })),
      mcp: input.mcp.map(server => ({
        id: server.id, name: server.name, host: server.host, status: server.status, scopes: [...server.scopes], tools: server.tools, runs_without_asking: server.runs_without_asking,
        connected_at: Number.isFinite(server.connected_at) ? iso(server.connected_at) : null, last_used_at: null,
        revoke: { view: 'connections', action: 'mcp.disconnect' },
      })),
      // A channel the directory did not answer for stays out rather than reading as unlinked.
      channels: [
        { channel: 'telegram', state: input.telegram.linked ? 'linked' : 'unlinked', revoke: input.telegram.linked && input.telegram.unlinkAvailable ? { view: 'connections', action: 'telegram.unlink' } : null },
        ...(input.imessage ? [{ channel: 'imessage', state: input.imessage.linked ? 'linked' : 'unlinked', revoke: input.imessage.linked ? { view: 'imessage', action: 'imessage.unlink' } : null }] : []),
        ...(input.whatsapp ? [{ channel: 'whatsapp', state: input.whatsapp.linked ? 'linked' : 'unlinked', revoke: input.whatsapp.linked ? { view: 'connections', action: 'whatsapp.unlink' } : null }] : []),
      ],
      // Sharing is withdrawn in the app; the console has no health action.
      health: input.health === null ? { state: 'unavailable' as const } : {
        state: 'available' as const, manage: 'app' as const,
        rows: input.health.consents.map(row => ({ source: row.source, purpose: row.purpose, status: row.status, granted_at: row.granted_at, withdrawn_at: row.withdrawn_at, newest_upload_at: newest.get(row.source) ?? null })),
      },
    },
    access_log: input.accessLog,
  };
}
