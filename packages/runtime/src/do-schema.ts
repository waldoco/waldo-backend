export const DO_SCHEMA_METADATA_TABLE = 'do_schema_migrations' as const;
export const DO_SCHEMA_VERSION = 2;

export const DO_PRODUCT_TABLES = [
  'memory_blocks',
  'memory_inbox',
  'episodes',
  'patrol_log',
  'interventions',
  'adjustments',
  'skills',
  'sheet_commits',
  'thread_topic_index',
  'drafts',
  'goals',
] as const;

export const DEFERRED_DO_PRODUCT_TABLES = [
  'runs',
  'outbox',
  'schedules',
  'schedule',
  'daily_push_budget',
  'memory_edges',
  'commitments',
  'handoff_state',
] as const;

export type DoProductTable = (typeof DO_PRODUCT_TABLES)[number];

export type DoSchemaDifference =
  | { kind: 'missing_table'; table: DoProductTable }
  | { kind: 'missing_column'; table: DoProductTable; column: string };

export type DoSchemaAssertResult = {
  ok: true;
  version: number;
  productTables: readonly DoProductTable[];
};

export type DoMigration = {
  version: number;
  name: string;
  up: readonly string[];
  down: readonly string[];
};

export class DoSchemaDriftError extends Error {
  constructor(readonly differences: readonly DoSchemaDifference[]) {
    super('DO SQLite schema drift detected');
    this.name = 'DoSchemaDriftError';
  }
}

export const HEY10_BASE_SCHEMA_MIGRATION: DoMigration = {
  version: 1,
  name: 'hey10-base-context-schema',
  up: [
    `
      CREATE TABLE IF NOT EXISTS memory_blocks (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL,
        hall_type          TEXT NOT NULL CHECK (hall_type IN ('facts', 'events', 'discoveries', 'preferences', 'advice')),
        content            TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2048),
        pattern_id         TEXT,
        rejection_count    INTEGER NOT NULL DEFAULT 0 CHECK (rejection_count >= 0),
        decision_log       TEXT NOT NULL DEFAULT '[]',
        rolled_back_from   TEXT,
        confidence         REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        last_confirmed_at  TEXT,
        created_at         TEXT NOT NULL,
        valid_from         TEXT NOT NULL,
        valid_to           TEXT,
        superseded_by      TEXT,
        source_trust       TEXT NOT NULL CHECK (source_trust IN ('system_of_record', 'user_stated', 'memory_committed', 'memory_provisional', 'inferred')),
        source_ref         TEXT,
        CHECK (valid_to IS NULL OR valid_to >= valid_from),
        CHECK (superseded_by IS NULL OR valid_to IS NOT NULL)
      );
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS memory_blocks_one_active_pattern
        ON memory_blocks(user_id, pattern_id)
       WHERE pattern_id IS NOT NULL AND valid_to IS NULL;
    `,
    `
      CREATE INDEX IF NOT EXISTS memory_blocks_recall_idx
        ON memory_blocks(user_id, hall_type, valid_to, last_confirmed_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS memory_inbox (
        id                   TEXT PRIMARY KEY,
        user_id              TEXT NOT NULL,
        operation            TEXT NOT NULL CHECK (operation IN ('ADD', 'UPDATE', 'DELETE')),
        hall                 TEXT NOT NULL CHECK (hall IN ('facts', 'events', 'discoveries', 'preferences', 'advice')),
        claim                TEXT NOT NULL,
        conditions_json      TEXT NOT NULL DEFAULT '[]',
        content              TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2048),
        proposed_pattern_id  TEXT NOT NULL,
        observed_at          TEXT NOT NULL,
        source_trust         TEXT NOT NULL CHECK (source_trust IN ('system_of_record', 'user_stated', 'memory_committed', 'memory_provisional', 'inferred')),
        source_ref           TEXT,
        conflict_class       TEXT CHECK (conflict_class IN ('event_state_change', 'user_correction', 'evidence_contradiction', 'memory_conflict')),
        rationale            TEXT NOT NULL,
        source               TEXT NOT NULL,
        source_taint         TEXT CHECK (source_taint IS NULL OR source_taint = 'external'),
        rejected             INTEGER NOT NULL DEFAULT 0 CHECK (rejected IN (0, 1)),
        rejection_reason     TEXT,
        needs_confirmation   INTEGER NOT NULL DEFAULT 0 CHECK (needs_confirmation IN (0, 1)),
        created_at           TEXT NOT NULL,
        CHECK ((rejected = 1 AND rejection_reason IS NOT NULL) OR (rejected = 0 AND rejection_reason IS NULL))
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS memory_inbox_user_open_idx
        ON memory_inbox(user_id, rejected, needs_confirmation, observed_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS episodes (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        occurred_at   TEXT NOT NULL,
        summary       TEXT NOT NULL,
        source        TEXT NOT NULL,
        source_ref    TEXT,
        created_at    TEXT NOT NULL
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS episodes_recall_idx
        ON episodes(user_id, occurred_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS patrol_log (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        observed_at   TEXT NOT NULL,
        entry_type    TEXT NOT NULL,
        summary       TEXT NOT NULL,
        source_ref    TEXT,
        created_at    TEXT NOT NULL
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS patrol_log_user_observed_idx
        ON patrol_log(user_id, observed_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS interventions (
        id                              TEXT PRIMARY KEY,
        user_id                         TEXT NOT NULL,
        trigger_form                    TEXT NOT NULL,
        trigger_load                    TEXT NOT NULL,
        complex_task_evidence_json      TEXT NOT NULL DEFAULT '{}',
        task_resumed_within_2h          INTEGER CHECK (task_resumed_within_2h IN (0, 1)),
        proposed_at                     TEXT NOT NULL,
        executed_at                     TEXT,
        outcome                         TEXT,
        source_ref                      TEXT
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS interventions_user_proposed_idx
        ON interventions(user_id, proposed_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS adjustments (
        id                         TEXT PRIMARY KEY,
        user_id                    TEXT NOT NULL,
        subtype                    TEXT NOT NULL,
        status                     TEXT NOT NULL,
        reasoning                  TEXT NOT NULL,
        applied                    INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
        reverted                   INTEGER NOT NULL DEFAULT 0 CHECK (reverted IN (0, 1)),
        revert_blocked_reason      TEXT,
        third_party_observed_at    TEXT,
        source_ref                 TEXT,
        idempotency_key            TEXT,
        created_at                 TEXT NOT NULL
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS adjustments_user_created_idx
        ON adjustments(user_id, created_at);
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS adjustments_idempotency_idx
        ON adjustments(user_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL;
    `,
    `
      CREATE TABLE IF NOT EXISTS skills (
        name                 TEXT PRIMARY KEY,
        version              INTEGER NOT NULL CHECK (version > 0),
        provenance           TEXT NOT NULL CHECK (provenance IN ('system', 'connector', 'user', 'agent_authored')),
        identity_locked      INTEGER NOT NULL CHECK (identity_locked IN (0, 1)),
        provisional          INTEGER NOT NULL CHECK (provisional IN (0, 1)),
        trigger_types_json   TEXT NOT NULL DEFAULT '[]',
        trigger_condition    TEXT NOT NULL,
        required_tools_json  TEXT NOT NULL DEFAULT '[]',
        required_connectors_json TEXT NOT NULL DEFAULT '[]',
        effectiveness        REAL NOT NULL CHECK (effectiveness >= 0 AND effectiveness <= 1),
        invocations          INTEGER NOT NULL DEFAULT 0 CHECK (invocations >= 0),
        last_used            TEXT,
        body_markdown        TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        created_by           TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'archived')),
        pinned               INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        last_curated_at      TEXT,
        archived_at          TEXT
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS skills_loader_idx
        ON skills(status, provenance, effectiveness);
    `,
    `
      CREATE TABLE IF NOT EXISTS sheet_commits (
        commit_hash       TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,
        provider          TEXT NOT NULL CHECK (provider IN ('google_sheets', 'excel_graph')),
        sheet_id          TEXT NOT NULL,
        target_ref        TEXT NOT NULL,
        operation         TEXT NOT NULL CHECK (operation IN ('write_cell', 'append_row')),
        previous_value_json TEXT,
        created_at        INTEGER NOT NULL,
        expires_at        INTEGER NOT NULL,
        undone_at         INTEGER
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS sheet_commits_user_expires_idx
        ON sheet_commits(user_id, expires_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS thread_topic_index (
        user_id               TEXT NOT NULL,
        topic                 TEXT NOT NULL,
        thread_id             TEXT NOT NULL,
        last_user_message_at  TEXT NOT NULL,
        is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        updated_at            TEXT NOT NULL,
        PRIMARY KEY (user_id, topic, thread_id)
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS thread_topic_lookup_idx
        ON thread_topic_index(user_id, topic, is_active, last_user_message_at);
    `,
    `
      CREATE TABLE IF NOT EXISTS drafts (
        user_id          TEXT NOT NULL,
        draft_id         TEXT NOT NULL,
        provider         TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook_graph')),
        created_at       INTEGER NOT NULL,
        sent_at          INTEGER,
        recipient_count  INTEGER NOT NULL CHECK (recipient_count > 0),
        idempotency_key  TEXT NOT NULL,
        PRIMARY KEY (user_id, draft_id),
        UNIQUE (user_id, idempotency_key)
      );
    `,
    `
      CREATE INDEX IF NOT EXISTS drafts_user_created_idx
        ON drafts(user_id, created_at);
    `,
  ],
  down: [
    'DROP INDEX IF EXISTS drafts_user_created_idx;',
    'DROP TABLE IF EXISTS drafts;',
    'DROP INDEX IF EXISTS thread_topic_lookup_idx;',
    'DROP TABLE IF EXISTS thread_topic_index;',
    'DROP INDEX IF EXISTS sheet_commits_user_expires_idx;',
    'DROP TABLE IF EXISTS sheet_commits;',
    'DROP INDEX IF EXISTS skills_loader_idx;',
    'DROP TABLE IF EXISTS skills;',
    'DROP INDEX IF EXISTS adjustments_idempotency_idx;',
    'DROP INDEX IF EXISTS adjustments_user_created_idx;',
    'DROP TABLE IF EXISTS adjustments;',
    'DROP INDEX IF EXISTS interventions_user_proposed_idx;',
    'DROP TABLE IF EXISTS interventions;',
    'DROP INDEX IF EXISTS patrol_log_user_observed_idx;',
    'DROP TABLE IF EXISTS patrol_log;',
    'DROP INDEX IF EXISTS episodes_recall_idx;',
    'DROP TABLE IF EXISTS episodes;',
    'DROP INDEX IF EXISTS memory_inbox_user_open_idx;',
    'DROP TABLE IF EXISTS memory_inbox;',
    'DROP INDEX IF EXISTS memory_blocks_recall_idx;',
    'DROP INDEX IF EXISTS memory_blocks_one_active_pattern;',
    'DROP TABLE IF EXISTS memory_blocks;',
  ],
};

export const HEY144_GOALS_SCHEMA_MIGRATION: DoMigration = {
  version: 2,
  name: 'hey144-goals-schema',
  up: [
    `
      CREATE TABLE IF NOT EXISTS goals (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        description  TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
        baseline     TEXT CHECK (baseline IS NULL OR length(baseline) BETWEEN 1 AND 500),
        target       TEXT CHECK (target IS NULL OR length(target) BETWEEN 1 AND 500),
        progress     TEXT CHECK (progress IS NULL OR length(progress) BETWEEN 1 AND 500),
        deadline     TEXT,
        active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `,
  ],
  down: ['DROP TABLE IF EXISTS goals;'],
};

export const DO_SCHEMA_MIGRATIONS = [
  HEY10_BASE_SCHEMA_MIGRATION,
  HEY144_GOALS_SCHEMA_MIGRATION,
] as const;

const REQUIRED_COLUMNS: Readonly<Record<DoProductTable, readonly string[]>> = {
  memory_blocks: [
    'id',
    'user_id',
    'hall_type',
    'content',
    'pattern_id',
    'rejection_count',
    'decision_log',
    'rolled_back_from',
    'confidence',
    'last_confirmed_at',
    'created_at',
    'valid_from',
    'valid_to',
    'superseded_by',
    'source_trust',
    'source_ref',
  ],
  memory_inbox: [
    'id',
    'user_id',
    'operation',
    'hall',
    'claim',
    'conditions_json',
    'content',
    'proposed_pattern_id',
    'observed_at',
    'source_trust',
    'source_ref',
    'conflict_class',
    'rationale',
    'source',
    'source_taint',
    'rejected',
    'rejection_reason',
    'needs_confirmation',
    'created_at',
  ],
  episodes: ['id', 'user_id', 'occurred_at', 'summary', 'source', 'source_ref', 'created_at'],
  patrol_log: ['id', 'user_id', 'observed_at', 'entry_type', 'summary', 'source_ref', 'created_at'],
  interventions: [
    'id',
    'user_id',
    'trigger_form',
    'trigger_load',
    'complex_task_evidence_json',
    'task_resumed_within_2h',
    'proposed_at',
    'executed_at',
    'outcome',
    'source_ref',
  ],
  adjustments: [
    'id',
    'user_id',
    'subtype',
    'status',
    'reasoning',
    'applied',
    'reverted',
    'revert_blocked_reason',
    'third_party_observed_at',
    'source_ref',
    'idempotency_key',
    'created_at',
  ],
  skills: [
    'name',
    'version',
    'provenance',
    'identity_locked',
    'provisional',
    'trigger_types_json',
    'trigger_condition',
    'required_tools_json',
    'required_connectors_json',
    'effectiveness',
    'invocations',
    'last_used',
    'body_markdown',
    'created_at',
    'created_by',
    'status',
    'pinned',
    'last_curated_at',
    'archived_at',
  ],
  sheet_commits: [
    'commit_hash',
    'user_id',
    'provider',
    'sheet_id',
    'target_ref',
    'operation',
    'previous_value_json',
    'created_at',
    'expires_at',
    'undone_at',
  ],
  thread_topic_index: [
    'user_id',
    'topic',
    'thread_id',
    'last_user_message_at',
    'is_active',
    'updated_at',
  ],
  drafts: [
    'user_id',
    'draft_id',
    'provider',
    'created_at',
    'sent_at',
    'recipient_count',
    'idempotency_key',
  ],
  goals: [
    'id',
    'user_id',
    'description',
    'baseline',
    'target',
    'progress',
    'deadline',
    'active',
    'created_at',
    'updated_at',
  ],
};

export function provisionDoSchema(storage: DurableObjectStorage): DoSchemaAssertResult {
  for (const migration of DO_SCHEMA_MIGRATIONS) {
    if (getSchemaVersion(storage.sql) < migration.version) {
      applyDoMigration(storage, migration);
    }
  }
  return assertDoSchema(storage.sql);
}

export function assertDoSchema(sql: SqlStorage): DoSchemaAssertResult {
  const differences: DoSchemaDifference[] = [];
  const tables = listTables(sql);
  const tableSet = new Set(tables);

  for (const table of DO_PRODUCT_TABLES) {
    if (!tableSet.has(table)) {
      differences.push({ kind: 'missing_table', table });
      continue;
    }
    const columns = new Set(columnNames(sql, table));
    for (const column of REQUIRED_COLUMNS[table]) {
      if (!columns.has(column)) {
        differences.push({ kind: 'missing_column', table, column });
      }
    }
  }

  if (differences.length > 0) {
    throw new DoSchemaDriftError(differences);
  }

  return {
    ok: true,
    version: getSchemaVersion(sql),
    productTables: DO_PRODUCT_TABLES,
  };
}

export function getSchemaVersion(sql: SqlStorage): number {
  if (!listTables(sql).includes(DO_SCHEMA_METADATA_TABLE)) return 0;
  const row = sql
    .exec<{ version: number }>(
      `SELECT version FROM ${DO_SCHEMA_METADATA_TABLE} ORDER BY version DESC LIMIT 1`,
    )
    .toArray()[0];
  return row?.version ?? 0;
}

export function applyDoMigration(
  storage: DurableObjectStorage,
  migration: DoMigration,
  direction: 'up' | 'down' = 'up',
): void {
  const sql = storage.sql;
  const statements = direction === 'up' ? migration.up : migration.down;

  storage.transactionSync(() => {
    ensureMigrationMetadata(sql);
    for (const statement of statements) {
      sql.exec(statement);
    }
    if (direction === 'up') {
      sql.exec(
        `INSERT INTO ${DO_SCHEMA_METADATA_TABLE} (version, name, applied_at)
         VALUES (?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET name = excluded.name, applied_at = excluded.applied_at`,
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    } else {
      sql.exec(`DELETE FROM ${DO_SCHEMA_METADATA_TABLE} WHERE version = ?`, migration.version);
    }
  });
}

function ensureMigrationMetadata(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${DO_SCHEMA_METADATA_TABLE} (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
}

function listTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
}

function columnNames(sql: SqlStorage, table: DoProductTable): string[] {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map((row) => row.name);
}
