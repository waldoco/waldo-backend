import type { OutboxRow } from '@waldo/contracts';
import type { Deps } from '../seams/deps';

type OutboxSqlRow = {
  outbox_id: string;
  run_id: string;
  kind: string;
  idempotency_key: string;
  payload: string;
  ack_recorded: number;
  created_at: number;
};

function toRow(r: OutboxSqlRow): OutboxRow {
  return {
    run_id: r.run_id,
    kind: r.kind as 'fetch_alert',
    idempotency_key: r.idempotency_key,
    payload: r.payload,
    created_at: r.created_at,
  };
}

// Outbox over DO SQLite. UNIQUE(run_id, kind) and UNIQUE(idempotency_key) enforce exactly-once
// at the durable layer: a second insert for the same (run, kind) throws even after the first row
// is acked, so the resume path must enter at GATED-or-later and never re-insert.
export class Outbox {
  constructor(
    private readonly sql: SqlStorage,
    private readonly deps: Deps,
  ) {}

  insert(row: OutboxRow): void {
    this.sql.exec(
      `INSERT INTO outbox
         (outbox_id, run_id, kind, idempotency_key, payload, ack_recorded, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      this.deps.newOutboxId(),
      row.run_id,
      row.kind,
      row.idempotency_key,
      row.payload,
      row.created_at,
    );
  }

  readRow(runId: string, kind: 'fetch_alert'): OutboxRow | null {
    const rows = this.sql
      .exec<OutboxSqlRow>('SELECT * FROM outbox WHERE run_id = ? AND kind = ?', runId, kind)
      .toArray();
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  // TOTAL rows, including an already-acked one — the exactly-once assertion counts durable rows,
  // not active rows, so a masked double-processing bug cannot pass.
  countRows(runId: string, kind: 'fetch_alert'): number {
    return this.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM outbox WHERE run_id = ? AND kind = ?',
        runId,
        kind,
      )
      .one().n;
  }

  markAcked(runId: string, kind: 'fetch_alert'): void {
    this.sql.exec(
      'UPDATE outbox SET ack_recorded = 1 WHERE run_id = ? AND kind = ?',
      runId,
      kind,
    );
  }
}
