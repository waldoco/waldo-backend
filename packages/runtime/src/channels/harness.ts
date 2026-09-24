import type { TurnLogEntry } from './telegram-listener';
import { localIso } from './reminders';
import { modelCost } from '../llm/pricing';

type Sql = Pick<SqlStorage, 'exec'>;

export const FIRE_TARGETS = ['card:brief', 'card:midday', 'card:close', 'fetch', 'briefs', 'nightly'] as const;
export type FireTarget = (typeof FIRE_TARGETS)[number];

export type HarnessCommand =
  | Readonly<{ kind: 'fire'; target: FireTarget | null }>
  | Readonly<{ kind: 'trace'; filter: string | null }>
  | Readonly<{ kind: 'e2e' }>
  | Readonly<{ kind: 'console' }>
  | Readonly<{ kind: 'usage' }>;

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
  return null;
};

// Each E2E step names the log hops that prove it ran.
export const E2E_STEPS: readonly Readonly<{ step: string; hops: readonly string[] }>[] = [
  { step: 'Chat reply', hops: ['llm_reply'] },
  { step: 'Memory update', hops: ['memory'] },
  { step: 'Memory migration', hops: ['memory_backup', 'memory_migration'] },
  { step: 'Reminder fired', hops: ['reminder'] },
  { step: 'Day plan', hops: ['day_plan'] },
  { step: 'Brief / midday / close card', hops: ['day_card'] },
  { step: 'Fetch update card', hops: ['update_card'] },
  { step: 'Pre-event brief', hops: ['brief_sweep'] },
  { step: 'Nightly memory', hops: ['nightly_memory'] },
  { step: 'Constellation promotion', hops: ['constellation'] },
];

export type E2EStep = Readonly<{ step: string; state: 'ok' | 'failed' | 'unseen'; at: string | null; note: string | null }>;
export type TraceRow = Readonly<{ time: string; trace: string; hop: string; ok: boolean; ms: number; note: string }>;

export const traceBook = (sql: Sql, keep = 500) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS trace_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, trace TEXT NOT NULL, hop TEXT NOT NULL,
    ok INTEGER NOT NULL, ms INTEGER NOT NULL, note TEXT,
    model TEXT, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, usd REAL,
    system_bytes INTEGER, request_bytes INTEGER)`);
  // Existing owner DOs carry the pre-usage shape; add the columns they miss.
  for (const column of ['model TEXT', 'input_tokens INTEGER', 'output_tokens INTEGER', 'cached_tokens INTEGER', 'usd REAL', 'system_bytes INTEGER', 'request_bytes INTEGER']) {
    try { sql.exec(`ALTER TABLE trace_log ADD COLUMN ${column}`); } catch { /* column already exists */ }
  }
  return {
    record(entry: TurnLogEntry, at: number): void {
      const cost = entry.usage ? modelCost(entry.usage) : null;
      sql.exec('INSERT INTO trace_log (at, trace, hop, ok, ms, note, model, input_tokens, output_tokens, cached_tokens, usd, system_bytes, request_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        at, entry.trace, entry.hop, entry.ok ? 1 : 0, Math.round(entry.ms), (entry.error ?? entry.detail ?? '').slice(0, 200),
        entry.usage?.model ?? null, entry.usage?.input ?? null, entry.usage?.output ?? null, entry.usage?.cached ?? null, cost?.total ?? null,
        entry.shape?.system_bytes ?? null, entry.shape?.request_bytes ?? null);
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
    checklist(timezone: string): string {
      return this.steps(timezone).map(({ step, state, at, note }) => state === 'unseen' ? `[ ] ${step}: not seen`
        : `[${state === 'ok' ? 'x' : '!'}] ${step}: ${state} at ${at}${note ? ` - ${note}` : ''}`).join('\n');
    },
  };
};
export type TraceBook = ReturnType<typeof traceBook>;
