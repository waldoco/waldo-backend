import { TOOL_RECORDS } from '../tools/records';
import { META_TOOLS } from '../tools/loader';
import { approvalKindV1Schema } from '../../../contracts/src/app/parts';
import { APP_APPROVAL_STATE } from './approvals';
import { TRACE_KEPT } from './harness';

// Patrol's access log: which tools Waldo used and which actions the owner decided, from Waldo's own records, for the
// signed-in owner. Every field is picked by name: no step note, trace id, message body, mail subject, approval summary or
// payload, health value or csrf.
export const DASHBOARD_ACCESS_LOG_PATH = '/console/dashboard/api/v1/access-log';
export const ACCESS_LOG_WINDOW_DAYS = 30;
const PAGE = 50, DAY_MS = 86_400_000;

type ApprovalCursor = Readonly<{ at: number; id: string }>;
export type AccessLogQuery = Readonly<{ toolsBefore?: number; approvalsBefore?: ApprovalCursor }>;
const POSITIVE = /^[1-9][0-9]{0,15}$/;
const position = (raw: string) => POSITIVE.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
// Paging cursors only: neither selects an owner, a table or a filter. tools_before is a trace row id; approvals_before is
// "<created_at>.<ledger id>", the last approval of the previous page.
export function readAccessLogQuery(params: URLSearchParams): AccessLogQuery | null {
  const query: { toolsBefore?: number; approvalsBefore?: ApprovalCursor } = {};
  for (const key of new Set(params.keys())) {
    const raw = params.getAll(key);
    if (raw.length !== 1) return null;
    if (key === 'tools_before') {
      const at = position(raw[0]!);
      if (at === null) return null;
      query.toolsBefore = at;
    } else if (key === 'approvals_before') {
      const [at, id, ...rest] = raw[0]!.split('.');
      const time = position(at ?? '');
      if (time === null || rest.length || !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
      query.approvalsBefore = { at: time, id };
    } else return null;
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
// The ledger also holds rows Waldo records as done without asking (desk.record, such as a Gmail draft): only the kinds an
// owner decides are read.
const APPROVAL_KINDS = approvalKindV1Schema.options;

export function readAccessLog(sql: Sql, now: number, query: AccessLogQuery) {
  const since = now - ACCESS_LOG_WINDOW_DAYS * DAY_MS, present = tables(sql);
  const tools = present.has('trace_log') ? sql.exec<{ id: number; at: number; hop: string; ok: number }>(
    "SELECT id, at, hop, ok FROM trace_log WHERE hop LIKE 'tool\\_%' ESCAPE '\\' AND hop <> 'tool_eligibility' AND at >= ? AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3",
    since, query.toolsBefore ?? null, PAGE + 1).toArray() : [];
  const oldest = present.has('trace_log') ? sql.exec<{ at: number | null }>('SELECT MIN(at) AS at FROM trace_log').toArray()[0]?.at ?? null : null;
  const before = query.approvalsBefore;
  const approvals = present.has('ledger') ? sql.exec<{ id: string; kind: string; status: string; created_at: number; decided_at: number | null }>(
    `SELECT id, kind, status, created_at, decided_at FROM ledger WHERE kind IN (${APPROVAL_KINDS.map(() => '?').join(', ')}) AND created_at >= ?
     AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...APPROVAL_KINDS, since, before?.at ?? null, before?.at ?? null, before?.at ?? null, before?.id ?? null, PAGE + 1).toArray() : [];
  return {
    version: 1 as const, as_of: iso(now),
    // trace_log keeps only its newest steps, so the tool list can run out before 30 days do.
    window_days: ACCESS_LOG_WINDOW_DAYS, kept_steps: TRACE_KEPT,
    tools: {
      rows: tools.slice(0, PAGE).map(row => ({ at: iso(row.at), ...toolRow(row.hop), ok: row.ok === 1 })),
      next_before: tools.length > PAGE ? tools[PAGE - 1]!.id : null,
      oldest_at: oldest === null ? null : iso(Math.max(oldest, since)),
    },
    approvals: {
      rows: approvals.slice(0, PAGE).map(row => ({
        at: iso(row.created_at), kind: row.kind,
        decision: Object.hasOwn(APP_APPROVAL_STATE, row.status) ? APP_APPROVAL_STATE[row.status as keyof typeof APP_APPROVAL_STATE] : 'other',
        decided_at: typeof row.decided_at === 'number' ? iso(row.decided_at) : null,
      })),
      next_before: approvals.length > PAGE ? `${approvals[PAGE - 1]!.created_at}.${approvals[PAGE - 1]!.id}` : null,
    },
  };
}
