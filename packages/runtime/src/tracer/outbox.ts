import type { OutboxIntent, OutboxRow } from '@waldo/contracts';
import { outboxStatusSchema } from '@waldo/contracts';
import type { Deps } from '../seams/deps';

// Fixed in-doubt retry delay. Backoff and exhaustion policy belong to the DeliveryGate
// runtime; the tracer only needs a durable "retry due" stamp for the resume proof.
const RETRY_DELAY_MS = 60_000;

type OutboxSqlRow = {
  outbox_id: string;
  run_id: string;
  kind: string;
  idempotency_key: string;
  payload: string;
  status: string;
  attempts: number;
  next_retry_at: number | null;
  acked_at: number | null;
  last_error: string | null;
  created_at: number;
};

// Status parses at the read seam so corrupt durable state fails loudly instead of silently
// re-sending — the same discipline as the journal's state parse.
function toRow(r: OutboxSqlRow): OutboxRow {
  return {
    run_id: r.run_id,
    kind: r.kind as 'fetch_alert',
    idempotency_key: r.idempotency_key,
    payload: r.payload,
    status: outboxStatusSchema.parse(r.status),
    attempts: r.attempts,
    next_retry_at: r.next_retry_at,
    acked_at: r.acked_at,
    last_error: r.last_error,
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

  insert(intent: OutboxIntent): void {
    this.sql.exec(
      `INSERT INTO outbox
         (outbox_id, run_id, kind, idempotency_key, payload,
          status, attempts, next_retry_at, acked_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)`,
      this.deps.newOutboxId(),
      intent.run_id,
      intent.kind,
      intent.idempotency_key,
      intent.payload,
      intent.created_at,
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

  // Durably marks the send attempt BEFORE the physical send: attempts counts every time the
  // sink is about to be reached, and next_retry_at stamps when a resume should re-drive the
  // in-doubt row. Committing this first is what lets a post-send/pre-ack crash resume
  // without guessing whether the send happened.
  markSendAttempt(runId: string, kind: 'fetch_alert', now: number): void {
    this.sql.exec(
      `UPDATE outbox
          SET status = 'sent_unacked', attempts = attempts + 1, next_retry_at = ?
        WHERE run_id = ? AND kind = ?`,
      now + RETRY_DELAY_MS,
      runId,
      kind,
    );
  }

  // last_error survives the ack as an audit of the prior failed attempt.
  markAcked(runId: string, kind: 'fetch_alert', now: number): void {
    this.sql.exec(
      `UPDATE outbox
          SET status = 'acked', acked_at = ?, next_retry_at = NULL
        WHERE run_id = ? AND kind = ?`,
      now,
      runId,
      kind,
    );
  }

  recordSendError(runId: string, kind: 'fetch_alert', message: string): void {
    this.sql.exec(
      'UPDATE outbox SET last_error = ? WHERE run_id = ? AND kind = ?',
      message,
      runId,
      kind,
    );
  }
}
