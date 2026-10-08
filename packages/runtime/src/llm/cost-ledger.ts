type Sql = Pick<SqlStorage, 'exec'>;

export const COST_KINDS = ['turn', 'background', 'worker', 'heartbeat', 'eval'] as const;
export type CostKind = (typeof COST_KINDS)[number];

export type CostEntry = Readonly<{
  kind: CostKind;
  model: string;
  trigger: string;
  input: number;
  output: number;
  cached: number;
  usd: number;
  responsibilityId?: string;
}>;

export type KindSpend = Readonly<{ kind: CostKind; calls: number; usd: number }>;

export const LOW_EFFORT_FRACTION = 0.8;

export type SpendPosture = Readonly<{
  effort: 'normal' | 'low';
  background: 'run' | 'skip';
  batchProactive: boolean;
  ceilingReached: boolean;
}>;

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

// Schema for the owner DO migration that is still to be written. costLedger never creates it.
export const COST_LEDGER_DDL = [`CREATE TABLE cost_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${COST_KINDS.map((kind) => `'${kind}'`).join(',')})),
    responsibility_id TEXT, trigger TEXT NOT NULL, model TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, usd REAL NOT NULL)`,
  'CREATE INDEX cost_ledger_day ON cost_ledger (day)'] as const;

export type CostLedger = ReturnType<typeof costLedger>;

export const costLedger = (sql: Sql) => {
  return {
    add(entry: CostEntry, at: number): void {
      sql.exec('INSERT INTO cost_ledger (day, kind, responsibility_id, trigger, model, input, output, cached, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        utcDay(at), entry.kind, entry.responsibilityId ?? null, entry.trigger, entry.model, entry.input, entry.output, entry.cached, entry.usd);
    },
    monthByKind(at: number): readonly KindSpend[] {
      return sql.exec<KindSpend>(
        'SELECT kind, COUNT(*) AS calls, SUM(usd) AS usd FROM cost_ledger WHERE day LIKE ? GROUP BY kind ORDER BY usd DESC',
        `${utcDay(at).slice(0, 7)}-%`,
      ).toArray();
    },
    monthTotal(at: number): number {
      return sql.exec<{ usd: number | null }>('SELECT SUM(usd) AS usd FROM cost_ledger WHERE day LIKE ?', `${utcDay(at).slice(0, 7)}-%`).toArray()[0]?.usd ?? 0;
    },
    byResponsibility(at: number): readonly Readonly<{ responsibilityId: string; usd: number }>[] {
      return sql.exec<{ responsibilityId: string; usd: number }>(
        'SELECT responsibility_id AS responsibilityId, SUM(usd) AS usd FROM cost_ledger WHERE day LIKE ? AND responsibility_id IS NOT NULL GROUP BY responsibility_id ORDER BY usd DESC',
        `${utcDay(at).slice(0, 7)}-%`,
      ).toArray();
    },
  };
};

// Interactive turns are never limited by the ceiling; only background, heartbeat and worker work is.
export const spendPosture = (spentUsd: number, ceilingUsd: number | null): SpendPosture => {
  if (ceilingUsd === null || ceilingUsd <= 0) return { effort: 'normal', background: 'run', batchProactive: false, ceilingReached: false };
  const reached = spentUsd >= ceilingUsd;
  const nearing = spentUsd >= ceilingUsd * LOW_EFFORT_FRACTION;
  return { effort: nearing ? 'low' : 'normal', background: reached ? 'skip' : 'run', batchProactive: nearing, ceilingReached: reached };
};

export const parseCeilingUsd = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const costNotice = (spentUsd: number, ceilingUsd: number): string =>
  `I've used $${spentUsd.toFixed(2)} of your $${ceilingUsd.toFixed(2)} monthly ceiling, so I've paused background work. Chats still work.`;
