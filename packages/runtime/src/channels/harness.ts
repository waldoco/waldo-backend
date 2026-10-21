import type { TurnLogEntry } from './telegram-listener';
import { localIso } from './reminders';
import type { CostLedger } from '../llm/cost-ledger';
import { modelCost } from '../llm/pricing';

type Sql = Pick<SqlStorage, 'exec'>;

export const FIRE_TARGETS = ['card:brief', 'card:midday', 'card:close', 'fetch', 'briefs', 'nightly'] as const;
export type FireTarget = (typeof FIRE_TARGETS)[number];

export type HarnessCommand =
  | Readonly<{ kind: 'fire'; target: FireTarget | null }>
  | Readonly<{ kind: 'trace'; filter: string | null }>
  | Readonly<{ kind: 'e2e' }>
  | Readonly<{ kind: 'console' }>
  | Readonly<{ kind: 'usage' }>
  | Readonly<{ kind: 'langfuse' }>
  | Readonly<{ kind: 'heldrows'; table: string | null; from: number | 'invalid' | null }>;

export const parseHarnessCommand = (text: string | undefined): HarnessCommand | null => {
  const [command, arg] = (text ?? '').trim().split(/\s+/, 2);
  if (command === '/fire') {
    const target = FIRE_TARGETS.find((name) => name === arg || name === `card:${arg}`) ?? null;
    return { kind: 'fire', target };
  }
  if (command === '/trace') return { kind: 'trace', filter: arg ?? null };
  if (command === '/e2e') return { kind: 'e2e' };
  if (command === '/console') return { kind: 'console' };
  if (command === '/usage') return { kind: 'usage' };
  if (command === '/langfuse') return { kind: 'langfuse' };
  if (command === '/heldrows') {
    const from = (text ?? '').trim().split(/\s+/)[2];
    return { kind: 'heldrows', table: arg ?? null, from: from === undefined ? null : /^-?\d{1,15}$/.test(from) ? Number(from) : 'invalid' };
  }
  return null;
};

// Each E2E step names the log hops that prove it ran. A 'request' step happens inside one chat turn's
// trace; a 'job' step comes from a scheduled or background run and never shares a trace with a chat turn.
export const E2E_STEPS: readonly Readonly<{ step: string; hops: readonly string[]; scope: 'request' | 'job' }>[] = [
  { step: 'Chat reply', hops: ['llm_reply'], scope: 'request' },
  { step: 'Memory update', hops: ['memory'], scope: 'request' },
  { step: 'Memory migration', hops: ['memory_backup', 'memory_migration'], scope: 'job' },
  { step: 'Reminder fired', hops: ['reminder'], scope: 'job' },
  { step: 'Day plan', hops: ['day_plan'], scope: 'job' },
  { step: 'Brief / midday / close card', hops: ['day_card'], scope: 'job' },
  { step: 'Fetch update card', hops: ['update_card'], scope: 'job' },
  { step: 'Pre-event brief', hops: ['brief_sweep'], scope: 'job' },
  { step: 'Nightly memory', hops: ['nightly_memory'], scope: 'job' },
  { step: 'Constellation promotion', hops: ['constellation'], scope: 'job' },
];

export type E2EStep = Readonly<{ step: string; state: 'ok' | 'failed' | 'unseen'; at: string | null; note: string | null }>;
// Logged once where the owner turn is admitted. Background work (reminders, cards, update checks) never logs it,
// so it is what separates "the last request" from a job that also calls the model.
export const OWNER_REQUEST_HOP = 'owner_request';
// The newest owner request. `at` is its admission time. `ok` and `recorded_steps` come from a durable per-request
// tally, so they stay true after the bounded trace pruned steps; `partial` means `hops` holds fewer than recorded_steps.
export type LastRequest = Readonly<{ trace: string; at: string; ok: boolean; partial: boolean; recorded_steps: number; hops: readonly Readonly<{ hop: string; ok: boolean; ms: number; note: string }>[] }>;
export type TraceRow = Readonly<{ time: string; trace: string; hop: string; ok: boolean; ms: number; note: string }>;

export const traceBook = (sql: Sql, keep = 500, ledger?: CostLedger) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS trace_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, trace TEXT NOT NULL, hop TEXT NOT NULL,
    ok INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT,
    model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, usd REAL,
    system_bytes INTEGER, request_bytes INTEGER)`);
  // Existing owner DOs carry the pre-usage shape; add the columns they miss.
  for (const column of ['model TEXT', 'input_tokens INTEGER', 'output_tokens INTEGER', 'cached_tokens INTEGER', 'usd REAL', 'system_bytes INTEGER', 'request_bytes INTEGER', 'owner TEXT']) {
    try { sql.exec(`ALTER TABLE trace_log ADD COLUMN ${column}`); } catch { /* column already exists */ }
  }
  sql.exec('CREATE TABLE IF NOT EXISTS owner_request_last (id INTEGER PRIMARY KEY CHECK (id = 1), trace TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, steps INTEGER NOT NULL)');
  return {
    record(entry: TurnLogEntry, at: number): void {
      const open = sql.exec<{ trace: string }>('SELECT trace FROM owner_request_last WHERE id = 1').toArray()[0];
      if (entry.hop === OWNER_REQUEST_HOP && open?.trace !== entry.trace) {
        sql.exec('INSERT OR REPLACE INTO owner_request_last (id, trace, at, ok, steps) VALUES (1, ?, ?, ?, 1)', entry.trace, at, entry.ok ? 1 : 0);
      } else if (open?.trace === entry.trace) {
        sql.exec('UPDATE owner_request_last SET ok = ok AND ?, steps = steps + 1 WHERE id = 1', entry.ok ? 1 : 0);
      }
      const cost = entry.usage ? modelCost(entry.usage) : null;
      sql.exec('INSERT INTO trace_log (at, trace, hop, ok, ms, note, model, input_tokens, output_tokens, cached_tokens, usd, system_bytes, request_bytes, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        at, entry.trace, entry.hop, entry.ok ? 1 : 0, Math.round(entry.ms), (entry.guard ?? entry.error ?? entry.detail ?? '').slice(0, 200),
        entry.usage?.model ?? null, entry.usage?.input ?? null, entry.usage?.output ?? null, entry.usage?.cached ?? null, cost?.total ?? null,
        entry.shape?.system_bytes ?? null, entry.shape?.request_bytes ?? null, entry.owner ?? null);
      if (ledger && entry.usage && cost) {
        const interactive = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM trace_log WHERE trace = ? AND hop = ?', entry.trace, OWNER_REQUEST_HOP).toArray()[0]!.n > 0;
        ledger.add({ kind: entry.cost_kind ?? (interactive ? 'turn' : 'background'), model: entry.usage.model, trigger: entry.hop, input: entry.usage.input, output: entry.usage.output,
          cached: entry.usage.cached, usd: cost.total, ...(entry.responsibility_id ? { responsibilityId: entry.responsibility_id } : {}) }, at);
      }
      sql.exec('DELETE FROM trace_log WHERE id <= (SELECT MAX(id) FROM trace_log) - ?', keep);
    },
    recent(timezone: string, filter: string | null, limit = 25): string {
      const rows = sql.exec<{ at: number; trace: string; hop: string; ok: number; ms: number; note: string | null }>(
        'SELECT at, trace, hop, ok, ms, note FROM trace_log WHERE ? IS NULL OR trace LIKE ? OR hop LIKE ? ORDER BY id DESC LIMIT ?',
        filter, `%${filter}%`, `%${filter}%`, limit,
      ).toArray().reverse();
      if (rows.length === 0) return 'No trace entries yet.';
      return rows.map((row) => `${localIso(row.at, timezone).slice(11, 16)} ${row.ok ? 'ok' : 'FAIL'} ${row.hop} ${row.ms}ms ${row.trace}${row.note ? ` - ${row.note}` : ''}`).join('\n');
    },
    rows(timezone: string, limit: number): readonly TraceRow[] {
      return sql.exec<{ at: number; trace: string; hop: string; ok: number; ms: number; note: string | null }>(
        'SELECT at, trace, hop, ok, ms, note FROM trace_log ORDER BY id DESC LIMIT ?', limit,
      ).toArray().reverse().map((row) => ({ time: localIso(row.at, timezone).slice(11, 16), trace: row.trace, hop: row.hop, ok: row.ok === 1, ms: row.ms, note: row.note ?? '' }));
    },
    // B9 dashboard bar: cursor page over the activity list. `before` is the epoch ms of the
    // oldest row the caller already has; `next` is the cursor for the page after this one,
    // null when the page ran out (fetched limit+1 to know).
    rowsPage(timezone: string, limit: number, before?: number): { rows: readonly TraceRow[]; next: number | null } {
      const rows = sql.exec<{ at: number; trace: string; hop: string; ok: number; ms: number; note: string | null }>(
        'SELECT at, trace, hop, ok, ms, note FROM trace_log WHERE (?1 IS NULL OR at < ?1) ORDER BY id DESC LIMIT ?2', before ?? null, limit + 1,
      ).toArray();
      const page = rows.slice(0, limit).reverse().map((row) => ({ time: localIso(row.at, timezone).slice(11, 16), trace: row.trace, hop: row.hop, ok: row.ok === 1, ms: row.ms, note: row.note ?? '' }));
      return { rows: page, next: rows.length > limit ? rows[limit - 1]!.at : null };
    },
    latest(): { at: number; hop: string; ok: boolean } | null {
      const row = sql.exec<{ at: number; hop: string; ok: number }>('SELECT at, hop, ok FROM trace_log ORDER BY at DESC, id DESC LIMIT 1').toArray()[0];
      return row ? { at: row.at, hop: row.hop, ok: row.ok === 1 } : null;
    },
    usageRows(): readonly Readonly<{ model: string; calls: number; input: number; cached: number; output: number; usd: number }>[] {
      return sql.exec<{ model: string; calls: number; input: number; cached: number; output: number; usd: number }>(
        `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output, SUM(usd) AS usd
         FROM trace_log WHERE model IS NOT NULL GROUP BY model ORDER BY usd DESC`,
      ).toArray();
    },
    usage(): string {
      const rows = sql.exec<{ model: string; calls: number; input: number; cached: number; output: number; usd: number; sys: number | null; req: number | null }>(
        `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output, SUM(usd) AS usd,
                AVG(system_bytes) AS sys, AVG(request_bytes) AS req
         FROM trace_log WHERE model IS NOT NULL GROUP BY model ORDER BY usd DESC`,
      ).toArray();
      if (rows.length === 0) return 'No model usage recorded yet.';
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
      return rows.map((row) => `${row.model}: ${row.calls} calls, ${k(row.input)} in (${row.input > 0 ? Math.round((100 * row.cached) / row.input) : 0}% cached), ${k(row.output)} out, $${row.usd.toFixed(4)}${row.req ? `, avg request ${(row.req / 1024).toFixed(1)}kB (system ${((row.sys ?? 0) / 1024).toFixed(1)}kB)` : ''}`).join('\n');
    },
    steps(timezone: string): readonly E2EStep[] {
      return E2E_STEPS.map(({ step, hops }) => {
        const row = sql.exec<{ at: number; ok: number; note: string | null }>(
          `SELECT at, ok, note FROM trace_log WHERE hop IN (${hops.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, ...hops,
        ).toArray()[0];
        if (!row) return { step, state: 'unseen', at: null, note: null };
        return { step, state: row.ok ? 'ok' : 'failed', at: localIso(row.at, timezone).slice(0, 16).replace('T', ' '), note: row.note || null };
      });
    },
    lastRequest(timezone: string): LastRequest | null {
      const head = sql.exec<{ trace: string; at: number; ok: number; steps: number }>('SELECT trace, at, ok, steps FROM owner_request_last WHERE id = 1').toArray()[0];
      if (!head) return null;
      const hops = sql.exec<{ hop: string; ok: number; ms: number; note: string | null }>('SELECT hop, ok, ms, note FROM trace_log WHERE trace = ? ORDER BY id ASC', head.trace).toArray()
        .map((row) => ({ hop: row.hop, ok: row.ok === 1, ms: row.ms, note: row.note ?? '' }));
      return { trace: head.trace, at: localIso(head.at, timezone).slice(0, 16).replace('T', ' '), ok: head.ok === 1, partial: hops.length < head.steps, recorded_steps: head.steps, hops };
    },
    checklist(timezone: string): string {
      return this.steps(timezone).map(({ step, state, at, note }) => state === 'unseen' ? `[ ] ${step}: not seen`
        : `[${state === 'ok' ? 'x' : '!'}] ${step}: ${state} at ${at}${note ? ` - ${note}` : ''}`).join('\n');
    },
  };
};
export type TraceBook = ReturnType<typeof traceBook>;
