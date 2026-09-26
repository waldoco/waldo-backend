// Idempotent DDL for the tracer's DO-local tables, applied from the DO constructor so an
// eviction-rebuild is safe. Every table is keyed by user_id for tenant scoping. The two outbox
// UNIQUE constraints are the durable exactly-once boundary: UNIQUE(idempotency_key) and an
// UNCONDITIONAL UNIQUE(run_id, kind) so an already-acked row still blocks a second insert.
export function ensureSchema(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS journal (
      run_id        TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      state         TEXT NOT NULL,
      verdict       TEXT,
      gate_reason   TEXT,
      completion_mode TEXT,
      occurrence_at INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);
  ensureColumn(sql, 'journal', 'gate_reason', 'TEXT');
  ensureColumn(sql, 'journal', 'completion_mode', 'TEXT');

  sql.exec(`
    CREATE TABLE IF NOT EXISTS run_candidates (
      run_id         TEXT PRIMARY KEY,
      candidate_json TEXT NOT NULL
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS loop_governor_runs (
      run_id          TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      loop_type       TEXT NOT NULL,
      occurrence_id   TEXT NOT NULL,
      verdict         TEXT,
      reason          TEXT,
      disposition     TEXT,
      tokens_used     INTEGER NOT NULL DEFAULT 0,
      iterations      INTEGER NOT NULL DEFAULT 0,
      subagent_spawns INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS loop_kill_flags (
      flag_key   TEXT PRIMARY KEY,
      scope      TEXT NOT NULL,
      loop_type  TEXT,
      active     INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS loop_progress (
      user_id              TEXT NOT NULL,
      loop_type            TEXT NOT NULL,
      occurrence_id        TEXT NOT NULL,
      call_count           INTEGER NOT NULL DEFAULT 0,
      unique_param_hashes  INTEGER NOT NULL DEFAULT 0,
      successes            INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL,
      PRIMARY KEY (user_id, loop_type, occurrence_id)
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS loop_progress_params (
      user_id               TEXT NOT NULL,
      loop_type             TEXT NOT NULL,
      occurrence_id         TEXT NOT NULL,
      canonical_params_hash TEXT NOT NULL,
      PRIMARY KEY (user_id, loop_type, occurrence_id, canonical_params_hash)
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS loop_observations (
      run_id                TEXT NOT NULL,
      tool_name             TEXT NOT NULL,
      canonical_params_hash TEXT NOT NULL,
      result_hash           TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      PRIMARY KEY (run_id, tool_name, canonical_params_hash, result_hash)
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
      local_date   TEXT NOT NULL,
      push_class   TEXT NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER,
      PRIMARY KEY (user_id, local_date, push_class)
    );
  `);
  migrateClassState(storage);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS event_cooldowns (
      user_id      TEXT NOT NULL,
      push_class   TEXT NOT NULL,
      event_id     TEXT NOT NULL,
      last_sent_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, push_class, event_id)
    );
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS subkind_state (
      user_id      TEXT NOT NULL,
      local_date   TEXT NOT NULL,
      push_class   TEXT NOT NULL,
      sub_kind     TEXT NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER,
      PRIMARY KEY (user_id, local_date, push_class, sub_kind)
    );
  `);
  migrateSubKindState(storage);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS exempt_telemetry (
      user_id      TEXT NOT NULL,
      push_class   TEXT NOT NULL,
      exempt_sends INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, push_class)
    );
  `);

  // Budget day uses the user's local date. Until timezone state is wired, runtime uses UTC
  // fallback and records the derived YYYY-MM-DD in this DO-local row.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_push_budget (
      user_id      TEXT NOT NULL,
      local_date   TEXT NOT NULL,
      sends_total  INTEGER NOT NULL DEFAULT 0,
      exempt_sends INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, local_date)
    );
  `);
  migrateDailyPushBudget(storage);

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

  // C4 run history, mirrored from SCHEDULE_RUNS_SCHEMA_MIGRATION (do-schema.ts) - the Scheduler
  // is shared, so every DO that hosts one carries the append-only run log.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id          TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      kind        TEXT NOT NULL,
      fired_at    INTEGER NOT NULL,
      attempt     INTEGER NOT NULL CHECK (attempt > 0),
      outcome     TEXT NOT NULL DEFAULT 'running'
        CHECK (outcome IN ('running', 'ok', 'failed', 'quarantined', 'missed')),
      error_class TEXT CHECK (error_class IN ('run', 'scheduler_handoff', 'delivery')),
      settled_at  INTEGER,
      duration_ms INTEGER,
      CHECK ((outcome = 'running') = (settled_at IS NULL))
    );
  `);
  sql.exec('CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule ON schedule_runs (schedule_id, fired_at DESC);');
}

function ensureColumn(sql: SqlStorage, table: string, column: string, ddl: string): void {
  const hasColumn = sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .some((row) => row.name === column);
  if (!hasColumn) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function migrateClassState(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(class_state)').toArray();
  if (columns.some((row) => row.name === 'local_date')) return;
  runMigration(storage, () => {
    sql.exec('DROP TABLE IF EXISTS class_state_next;');
    sql.exec(`
      CREATE TABLE class_state_next (
        user_id      TEXT NOT NULL,
        local_date   TEXT NOT NULL,
        push_class   TEXT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        last_sent_at INTEGER,
        PRIMARY KEY (user_id, local_date, push_class)
      );
    `);
    sql.exec(`
      INSERT OR IGNORE INTO class_state_next
        (user_id, local_date, push_class, count, last_sent_at)
      SELECT user_id,
             COALESCE(strftime('%Y-%m-%d', last_sent_at / 1000, 'unixepoch'), '1970-01-01'),
             push_class,
             count,
             last_sent_at
        FROM class_state;
    `);
    sql.exec('DROP TABLE class_state;');
    sql.exec('ALTER TABLE class_state_next RENAME TO class_state;');
  });
}

function migrateSubKindState(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(subkind_state)').toArray();
  if (columns.some((row) => row.name === 'local_date')) return;
  runMigration(storage, () => {
    sql.exec('DROP TABLE IF EXISTS subkind_state_next;');
    sql.exec(`
      CREATE TABLE subkind_state_next (
        user_id      TEXT NOT NULL,
        local_date   TEXT NOT NULL,
        push_class   TEXT NOT NULL,
        sub_kind     TEXT NOT NULL,
        count        INTEGER NOT NULL DEFAULT 0,
        last_sent_at INTEGER,
        PRIMARY KEY (user_id, local_date, push_class, sub_kind)
      );
    `);
    sql.exec(`
      INSERT OR IGNORE INTO subkind_state_next
        (user_id, local_date, push_class, sub_kind, count, last_sent_at)
      SELECT user_id,
             COALESCE(strftime('%Y-%m-%d', last_sent_at / 1000, 'unixepoch'), '1970-01-01'),
             push_class,
             sub_kind,
             count,
             last_sent_at
        FROM subkind_state;
    `);
    sql.exec('DROP TABLE subkind_state;');
    sql.exec('ALTER TABLE subkind_state_next RENAME TO subkind_state;');
  });
}

function migrateDailyPushBudget(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(daily_push_budget)').toArray();
  if (columns.some((row) => row.name === 'local_date')) return;
  runMigration(storage, () => {
    sql.exec('DROP TABLE IF EXISTS daily_push_budget_next;');
    sql.exec(`
      CREATE TABLE daily_push_budget_next (
        user_id      TEXT NOT NULL,
        local_date   TEXT NOT NULL,
        sends_total  INTEGER NOT NULL DEFAULT 0,
        exempt_sends INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, local_date)
      );
    `);
    sql.exec(`
      INSERT OR IGNORE INTO daily_push_budget_next
        (user_id, local_date, sends_total, exempt_sends)
      SELECT user_id, '1970-01-01', sends_total, 0
        FROM daily_push_budget;
    `);
    sql.exec('DROP TABLE daily_push_budget;');
    sql.exec('ALTER TABLE daily_push_budget_next RENAME TO daily_push_budget;');
  });
}

function runMigration(storage: DurableObjectStorage, migrate: () => void): void {
  storage.transactionSync(migrate);
}
