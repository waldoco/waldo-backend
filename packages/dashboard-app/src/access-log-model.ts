import { SignInRequired } from './model';

// Patrol's access log: which tools Waldo used and which actions you decided, from Waldo's own records. The reader keeps only
// the fields the page shows and refuses any other shape.
export const ACCESS_LOG_URL = '/console/dashboard/api/v1/access-log';

export type ToolStep = { at: string; tool: string; category: string; kind: 'read' | 'acted' | 'unknown'; ok: boolean };
export type ApprovalStep = { at: string; kind: string; decision: string; decided_at: string | null };
// A send on a connected tool that speaks as you, such as a Slack message: the tool, the workspace and channel it went to and
// how it was allowed, never what it said.
export type SendStep = { at: string; server: string; tool: string; workspace: string | null; channel: string | null; via: 'without_asking' | 'approved'; ok: boolean };
export type AccessLogRecord = {
  as_of: string; window_days: number; kept_steps: number;
  tools: { rows: ToolStep[]; next_before: number | null; oldest_at: string | null };
  approvals: { rows: ApprovalStep[]; next_before: string | null };
  sends: { rows: SendStep[]; next_before: number | null };
};
export type AccessLogCursors = { tools_before?: number; approvals_before?: string; sends_before?: number };

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const nullableStr = (v: unknown): v is string | null => v === null || str(v);
const instant = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v));
const maybeInstant = (v: unknown): v is string | null => v === null || instant(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const cursor = (v: unknown): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) > 0);
// The server's approvals cursor: "<created_at>.<ledger id>".
const approvalCursor = (v: unknown): v is string | null => v === null || (str(v) && /^[1-9][0-9]{0,15}\.[A-Za-z0-9_-]{1,128}$/.test(v));
const among = <T extends string>(options: readonly T[], v: unknown): v is T => str(v) && (options as readonly string[]).includes(v);
const list = <T>(v: unknown, row: (r: Record<string, unknown>) => T): T[] => { if (!Array.isArray(v) || !v.every(obj)) throw unsupported(); return v.map(row); };
const unsupported = () => new Error('The access log received an unsupported data shape. Nothing was assumed.');
const check = (ok: boolean) => { if (!ok) throw unsupported(); };

export function readAccessLog(value: unknown): AccessLogRecord {
  check(obj(value) && value.version === 1 && instant(value.as_of) && count(value.window_days) && count(value.kept_steps) && obj(value.tools) && obj(value.approvals));
  const v = value as Record<string, unknown>, tools = v.tools as Record<string, unknown>, approvals = v.approvals as Record<string, unknown>;
  // A Waldo that records no sends yet leaves the section out.
  const sends = v.sends === undefined ? { rows: [], next_before: null } : v.sends;
  check(obj(sends) && cursor(tools.next_before) && maybeInstant(tools.oldest_at) && approvalCursor(approvals.next_before) && cursor((sends as Record<string, unknown>).next_before));
  const sent = sends as Record<string, unknown>;
  return {
    as_of: v.as_of as string, window_days: v.window_days as number, kept_steps: v.kept_steps as number,
    tools: { next_before: tools.next_before as number | null, oldest_at: tools.oldest_at as string | null, rows: list(tools.rows, row => {
      check(instant(row.at) && str(row.tool) && str(row.category) && among(['read', 'acted', 'unknown'] as const, row.kind) && typeof row.ok === 'boolean');
      return { at: row.at as string, tool: row.tool as string, category: row.category as string, kind: row.kind as ToolStep['kind'], ok: row.ok as boolean };
    }) },
    approvals: { next_before: approvals.next_before as string | null, rows: list(approvals.rows, row => {
      check(instant(row.at) && str(row.kind) && str(row.decision) && maybeInstant(row.decided_at));
      return { at: row.at as string, kind: row.kind as string, decision: row.decision as string, decided_at: row.decided_at as string | null };
    }) },
    sends: { next_before: sent.next_before as number | null, rows: list(sent.rows, row => {
      check(instant(row.at) && str(row.server) && str(row.tool) && nullableStr(row.workspace) && nullableStr(row.channel) && among(['without_asking', 'approved'] as const, row.via) && typeof row.ok === 'boolean');
      return { at: row.at as string, server: row.server as string, tool: row.tool as string, workspace: row.workspace as string | null, channel: row.channel as string | null, via: row.via as SendStep['via'], ok: row.ok as boolean };
    }) },
  };
}

export async function fetchAccessLog(signal?: AbortSignal, cursors: AccessLogCursors = {}): Promise<AccessLogRecord> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(cursors)) if (value !== undefined) params.set(key, String(value));
  const query = params.toString();
  const response = await fetch(`${ACCESS_LOG_URL}${query ? `?${query}` : ''}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error('Couldn’t read the access log. Try again.');
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('Couldn’t read the access log. Try again.'); }
  return readAccessLog(value);
}
