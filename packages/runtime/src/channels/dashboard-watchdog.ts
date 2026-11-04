import { z } from 'zod';
import { jobsKept } from '../tasks/jobs';
import { FINDING_ACTIONS, FINDING_CODES, watchdogStore, type Finding } from '../tasks/watchdog';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';

// The console's read of the progress watchdog, for an operator asking why a job failed: when it last checked, how many model
// judgments it made in the last hour, what is open now, counts by code over a day, and the newest findings with the job's own
// status and park reason. Job ids, bounded codes and times only: no title, brief, step or message text. A console read, not
// an app contract.
export const DASHBOARD_WATCHDOG_PATH = '/console/dashboard/api/v1/watchdog';
export const WATCHDOG_RECENT_LIMIT = 50;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

const at = z.iso.datetime();
const code = z.enum(FINDING_CODES as [string, ...string[]]);
const row = z.strictObject({
  job_id: z.string().max(64).nullable(), job_kind: z.string().max(32), code, action: z.enum(FINDING_ACTIONS as [string, ...string[]]),
  round: z.number().int().nonnegative().nullable(), at, cleared_at: at.nullable(),
  job_status: z.string().max(32).nullable(), park_reason: z.string().max(32).nullable(),
});
export const watchdogViewSchema = z.strictObject({
  version: z.literal(1), as_of: at, enabled: z.boolean(), last_check_at: at.nullable(), judgments_last_hour: z.number().int().nonnegative(),
  open: z.array(row), counts_24h: z.partialRecord(code, z.number().int().positive()), recent: z.array(row).max(WATCHDOG_RECENT_LIMIT),
});
export type WatchdogView = z.infer<typeof watchdogViewSchema>;

type Sql = Pick<SqlStorage, 'exec'>;
const iso = (ms: number) => new Date(ms).toISOString();

export const watchdogView = (sql: Sql, now: number, enabled: boolean): WatchdogView => {
  const store = watchdogStore(sql);
  const kept = jobsKept(sql);
  const job = (id: string | null) => id === null || !kept ? null
    : sql.exec<{ status: string; park_reason: string | null }>('SELECT status, park_reason FROM task_jobs WHERE id = ?', id).toArray()[0] ?? null;
  const shown = (finding: Finding) => {
    const state = job(finding.job_id);
    return {
      job_id: finding.job_id, job_kind: finding.job_kind, code: finding.code, action: finding.action, round: finding.seq, at: iso(finding.at),
      cleared_at: finding.cleared_at === null ? null : iso(finding.cleared_at), job_status: state?.status ?? null, park_reason: state?.park_reason ?? null,
    };
  };
  const all = store.findings();
  const counts: Record<string, number> = {};
  for (const finding of all) if (finding.at > now - DAY_MS) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  const last = store.lastCheck();
  return {
    version: 1, as_of: iso(now), enabled, last_check_at: last === null ? null : iso(last), judgments_last_hour: store.judgments(now - HOUR_MS),
    open: store.open().map(shown), counts_24h: counts, recent: all.slice(-WATCHDOG_RECENT_LIMIT).reverse().map(shown),
  };
};

// GET only, no query; counted against the console's read window (`limited`) before any read.
export const consoleWatchdog = async (input: Readonly<{ request: Request; sql: Sql; now: number; enabled: boolean; limited(): Response | null }>): Promise<Response> => {
  const reply = (body: object, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });
  if (input.request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
  if (new URL(input.request.url).search) return reply({ error: 'invalid_query' }, 400);
  const limited = input.limited();
  if (limited) return limited;
  try {
    return reply(watchdogView(input.sql, input.now, input.enabled));
  } catch {
    console.error(JSON.stringify({ hop: 'console_watchdog', ok: false, code: 'watchdog_read_failed' }));
    return reply({ error: 'watchdog_unavailable' }, 503);
  }
};
