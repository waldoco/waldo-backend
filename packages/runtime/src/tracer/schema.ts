// Idempotent DDL for the tracer's DO-local tables, applied from the DO constructor so an
// eviction-rebuild is safe. Every table is keyed by user_id for tenant scoping. The two outbox
// UNIQUE constraints are the durable exactly-once boundary: UNIQUE(idempotency_key) and an
// UNCONDITIONAL UNIQUE(run_id, kind) so an already-acked row still blocks a second insert.
export function ensureSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS journal (
      run_id        TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      state         TEXT NOT NULL,
      verdict       TEXT,
      occurrence_at INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  // status/attempts/next_retry_at/acked_at/last_error carry the durable delivery state
  // (outboxRowSchema): the send attempt is marked BEFORE the sink is reached and the ack is
  // recorded after it, so a crash between the two resumes as an in-doubt row instead of
  // guessing whether the send happened.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      outbox_id       TEXT PRIMARY KEY,
      run_id          TEXT NOT NULL,
      kind            TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_retry_at   INTEGER,
      acked_at        INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      UNIQUE(idempotency_key),
      UNIQUE(run_id, kind)
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS class_state (
      user_id      TEXT NOT NULL,
      push_class   TEXT NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER,
      PRIMARY KEY (user_id, push_class)
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS exempt_telemetry (
      user_id      TEXT NOT NULL,
      push_class   TEXT NOT NULL,
      exempt_sends INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, push_class)
    );
  `);

  // fetch_alert never reads or writes sends_total; the row exists for Phase-D reconciliation.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_push_budget (
      user_id     TEXT PRIMARY KEY,
      sends_total INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Freeze store for 'hold' verdicts (heldCandidateSchema shape, one frozen candidate per
  // event). The DeliveryGate runtime owns all reads and writes; the tracer path never
  // touches it.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS held_candidates (
      user_id        TEXT NOT NULL,
      event_id       TEXT NOT NULL,
      push_class     TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      hold_until     INTEGER NOT NULL,
      expires_at     INTEGER,
      PRIMARY KEY (user_id, event_id)
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS schedule (
      id                 TEXT PRIMARY KEY,
      kind               TEXT NOT NULL,
      occurrence_at      INTEGER NOT NULL,
      due_at             INTEGER NOT NULL,
      recurrence_json    TEXT,
      payload_json       TEXT NOT NULL DEFAULT '{}',
      status             TEXT NOT NULL,
      attempts           INTEGER NOT NULL DEFAULT 0,
      last_fired_at      INTEGER,
      quarantined_until  INTEGER,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
  `);
}
