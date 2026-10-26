import { fetchControls, submitControl, type ActionResult, type ControlAction } from './controls-model';
import { SignInRequired, StepUpRequired, isStepUpRefusal } from './model';

// The Vault read. The Worker answers step_up_required, with nothing else, until this browser proves an email code from the
// last two hours. The reader keeps only the fields the page shows and refuses any other shape.
export const VAULT_URL = '/console/dashboard/api/v1/vault';

export type RevokeTarget = { view: 'connections' | 'imessage'; action: 'google.disconnect' | 'mcp.disconnect' | 'telegram.unlink' | 'whatsapp.unlink' | 'imessage.unlink' };
export type MemoryItem = { id: string; text: string; source_label: string; recorded_at: string | null };
export type ToolStep = { at: string; tool: string; category: string; kind: 'read' | 'acted' | 'unknown'; ok: boolean };
export type ApprovalStep = { at: string; kind: string; decision: string; decided_at: string | null };
export type HealthRow = { source: string; purpose: string; status: string; granted_at: string | null; withdrawn_at: string | null; newest_upload_at: string | null };
export type VaultRecord = {
  as_of: string;
  memory: { state: 'available' | 'partial' | 'unavailable'; groups: { kind: string; total: number; items: MemoryItem[] }[] };
  connections: {
    token_note: string;
    google: { account_id: string; email: string; grants: ('calendar' | 'gmail' | 'tasks')[]; status: 'active' | 'needs_reconnect'; token_storage: 'supabase_vault' | 'waldo_server'; connected_at: string | null; last_used_at: string | null; revoke: RevokeTarget }[];
    mcp: { id: string; name: string; host: string; status: string; scopes: string[]; tools: number; runs_without_asking: number; connected_at: string | null; last_used_at: string | null; revoke: RevokeTarget }[];
    channels: { channel: 'telegram' | 'imessage' | 'whatsapp'; state: 'linked' | 'unlinked'; revoke: RevokeTarget | null }[];
    health: { state: 'unavailable' } | { state: 'available'; manage: 'app'; rows: HealthRow[] };
  };
  access_log: { window_days: number; kept_steps: number; tools: { rows: ToolStep[]; next_before: number | null; oldest_at: string | null }; approvals: { rows: ApprovalStep[]; next_before: string | null } };
};
export type VaultCursors = { tools_before?: number; approvals_before?: string };

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const instant = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v));
const maybeInstant = (v: unknown): v is string | null => v === null || instant(v);
const maybeDay = (v: unknown): v is string | null => v === null || (str(v) && /^\d{4}-\d{2}-\d{2}$/.test(v));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const cursor = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) > 0);
// The server's approvals cursor: "<created_at>.<ledger id>".
const approvalCursor = (v: unknown): v is string | null => v === null || (str(v) && /^[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{1,128}$/.test(v));
const among = <T extends string>(options: readonly T[], v: unknown): v is T => str(v) && (options as readonly string[]).includes(v);
const list = <T>(v: unknown, row: (r: Record<string, unknown>) => T): T[] => { if (!Array.isArray(v) || !v.every(obj)) throw unsupported(); return v.map(row); };
const unsupported = () => new Error('The Vault received an unsupported data shape. Nothing was assumed.');
const REVOKES: readonly string[] = ['connections:google.disconnect', 'connections:mcp.disconnect', 'connections:telegram.unlink', 'connections:whatsapp.unlink', 'imessage:imessage.unlink'];
const revoke = (v: unknown): RevokeTarget => {
  if (!obj(v) || !str(v.view) || !str(v.action) || !REVOKES.includes(`${v.view}:${v.action}`)) throw unsupported();
  return { view: v.view as RevokeTarget['view'], action: v.action as RevokeTarget['action'] };
};
const check = (ok: boolean) => { if (!ok) throw unsupported(); };

export function readVault(value: unknown): VaultRecord {
  check(obj(value) && value.version === 1 && value.state === 'available' && instant(value.as_of) && obj(value.memory) && obj(value.connections) && obj(value.access_log));
  const v = value as Record<string, Record<string, unknown>>, memory = v.memory!, connections = v.connections!, log = v.access_log!;
  check(among(['available', 'partial', 'unavailable'] as const, memory.state) && str(connections.token_note) && obj(log.tools) && obj(log.approvals) && count(log.window_days) && count(log.kept_steps));
  const health = connections.health as Record<string, unknown>;
  check(obj(health) && (health.state === 'unavailable' || (health.state === 'available' && health.manage === 'app')));
  const tools = log.tools as Record<string, unknown>, approvals = log.approvals as Record<string, unknown>;
  check(cursor(tools.next_before) && maybeInstant(tools.oldest_at) && approvalCursor(approvals.next_before));
  return {
    as_of: (value as Record<string, unknown>).as_of as string,
    memory: { state: memory.state as VaultRecord['memory']['state'], groups: list(memory.groups, group => {
      check(str(group.kind) && count(group.total));
      return { kind: group.kind as string, total: group.total as number, items: list(group.items, item => { check(str(item.id) && str(item.text) && str(item.source_label) && maybeDay(item.recorded_at)); return { id: item.id as string, text: item.text as string, source_label: item.source_label as string, recorded_at: item.recorded_at as string | null }; }) };
    }) },
    connections: {
      token_note: connections.token_note as string,
      google: list(connections.google, row => {
        check(str(row.account_id) && str(row.email) && Array.isArray(row.grants) && row.grants.every(g => among(['calendar', 'gmail', 'tasks'] as const, g)) && among(['active', 'needs_reconnect'] as const, row.status) && among(['supabase_vault', 'waldo_server'] as const, row.token_storage) && maybeInstant(row.connected_at) && maybeInstant(row.last_used_at));
        return { account_id: row.account_id as string, email: row.email as string, grants: row.grants as VaultRecord['connections']['google'][number]['grants'], status: row.status as 'active' | 'needs_reconnect', token_storage: row.token_storage as 'supabase_vault' | 'waldo_server', connected_at: row.connected_at as string | null, last_used_at: row.last_used_at as string | null, revoke: revoke(row.revoke) };
      }),
      mcp: list(connections.mcp, row => {
        check(str(row.id) && str(row.name) && str(row.host) && str(row.status) && Array.isArray(row.scopes) && row.scopes.every(str) && count(row.tools) && count(row.runs_without_asking) && maybeInstant(row.connected_at) && maybeInstant(row.last_used_at));
        return { id: row.id as string, name: row.name as string, host: row.host as string, status: row.status as string, scopes: row.scopes as string[], tools: row.tools as number, runs_without_asking: row.runs_without_asking as number, connected_at: row.connected_at as string | null, last_used_at: row.last_used_at as string | null, revoke: revoke(row.revoke) };
      }),
      channels: list(connections.channels, row => {
        check(among(['telegram', 'imessage', 'whatsapp'] as const, row.channel) && among(['linked', 'unlinked'] as const, row.state));
        return { channel: row.channel as 'telegram' | 'imessage' | 'whatsapp', state: row.state as 'linked' | 'unlinked', revoke: row.revoke === null ? null : revoke(row.revoke) };
      }),
      health: health.state === 'unavailable' ? { state: 'unavailable' } : { state: 'available', manage: 'app', rows: list(health.rows, row => {
        check(str(row.source) && str(row.purpose) && str(row.status) && maybeInstant(row.granted_at) && maybeInstant(row.withdrawn_at) && maybeInstant(row.newest_upload_at));
        return { source: row.source as string, purpose: row.purpose as string, status: row.status as string, granted_at: row.granted_at as string | null, withdrawn_at: row.withdrawn_at as string | null, newest_upload_at: row.newest_upload_at as string | null };
      }) },
    },
    access_log: {
      window_days: log.window_days as number, kept_steps: log.kept_steps as number,
      tools: { next_before: tools.next_before as number | null, oldest_at: tools.oldest_at as string | null, rows: list(tools.rows, row => {
        check(instant(row.at) && str(row.tool) && str(row.category) && among(['read', 'acted', 'unknown'] as const, row.kind) && typeof row.ok === 'boolean');
        return { at: row.at as string, tool: row.tool as string, category: row.category as string, kind: row.kind as ToolStep['kind'], ok: row.ok as boolean };
      }) },
      approvals: { next_before: approvals.next_before as string | null, rows: list(approvals.rows, row => {
        check(instant(row.at) && str(row.kind) && str(row.decision) && maybeInstant(row.decided_at));
        return { at: row.at as string, kind: row.kind as string, decision: row.decision as string, decided_at: row.decided_at as string | null };
      }) },
    },
  };
}

export async function fetchVault(signal?: AbortSignal, cursors: VaultCursors = {}): Promise<VaultRecord> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(cursors)) if (value !== undefined) params.set(key, String(value));
  const query = params.toString();
  const response = await fetch(`${VAULT_URL}${query ? `?${query}` : ''}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal });
  if (response.status === 401) throw new SignInRequired();
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('The Vault could not load right now. Try again.'); }
  if (isStepUpRefusal(response.status, value)) throw new StepUpRequired();
  if (!response.ok) throw new Error('The Vault could not load right now. Try again.');
  return readVault(value);
}

// A revoke is the console's own disconnect: a fresh read of the view that offers it, then the action path with that read's
// csrf and revision. The server re-checks that this owner holds the target.
export async function revokeConnection(target: RevokeTarget, id: string, requestId: string): Promise<ActionResult> {
  const record = await fetchControls(target.view);
  return submitControl(record, target.action as ControlAction, target.view === 'imessage' ? {} : { id }, requestId);
}
