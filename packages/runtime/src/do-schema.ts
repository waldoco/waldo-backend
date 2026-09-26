export const DO_SCHEMA_METADATA_TABLE = 'do_schema_migrations' as const;

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
  'owner_roots',
  'presence_registrations',
  'presence_sessions',
  'owner_event_state',
  'outcomes',
  'missions',
  'work_units',
  'owner_domain_events',
  'responsibility_commands',
  'responsibility_projection',
  'responsibility_projection_state',
  'planning_execution_requests',
  'planning_agent_sessions',
  'planning_execution_leases',
  'planning_provider_invocations',
  'execution_attempts',
  'execution_observations',
  'execution_reconciliations',
  'work_unit_candidate_plans',
  'work_unit_planning_commands',
  'work_unit_planning_controls',
  'work_unit_planning_projection',
  'judgment_requests',
  'judgment_decisions',
  'authority_grants',
  'judgment_commands',
  'judgment_projection',
  'judgment_projection_state',
] as const;

export const DEFERRED_DO_PRODUCT_TABLES = [
  'memory_edges',
  'commitments',
  'handoff_state',
] as const;

// These tables are provisioned by the existing RunLoop/Journal substrate, not by the
// product migration chain. Listing them prevents an implicit second schema manifest.
export const DO_RUNTIME_SUBSTRATE_TABLES = [
  'journal',
  'run_candidates',
  'loop_governor_runs',
  'loop_kill_flags',
  'loop_progress',
  'loop_progress_params',
  'loop_observations',
  'outbox',
  'class_state',
  'event_cooldowns',
  'subkind_state',
  'exempt_telemetry',
  'daily_push_budget',
  'held_candidates',
  'schedule',
  'runtime_runs',
  'runtime_invocation_v2',
  'runtime_invocation_v2_scribe_audit',
  'runtime_journal',
  'runtime_trace',
  'local_ingress_rate',
  'responsibility_ingress_rate',
  'runtime_run_scribe_audit',
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

export const RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION: DoMigration = {
  version: 3,
  name: 'responsibility-domain-v0-2',
  up: [
    `
      CREATE TABLE owner_roots (
        root_key       INTEGER PRIMARY KEY CHECK (root_key = 1),
        owner_id       TEXT NOT NULL UNIQUE,
        created_at     TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE owner_event_state (
        root_key          INTEGER PRIMARY KEY CHECK (root_key = 1),
        owner_id          TEXT NOT NULL UNIQUE,
        high_water_cursor INTEGER NOT NULL CHECK (high_water_cursor >= 0)
      );
    `,
    `
      CREATE TABLE outcomes (
        id             TEXT PRIMARY KEY,
        owner_id       TEXT NOT NULL,
        revision       INTEGER NOT NULL CHECK (revision > 0),
        user_statement TEXT NOT NULL,
        state          TEXT NOT NULL CHECK (state IN ('captured')),
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (owner_id, id)
      );
    `,
    `
      CREATE TABLE missions (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        outcome_id  TEXT NOT NULL,
        revision    INTEGER NOT NULL CHECK (revision > 0),
        brief       TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('proposed')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE (owner_id, id),
        UNIQUE (owner_id, outcome_id)
      );
    `,
    `
      CREATE TABLE work_units (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL,
        outcome_id      TEXT NOT NULL,
        mission_id      TEXT,
        position        INTEGER NOT NULL CHECK (position >= 0),
        revision        INTEGER NOT NULL CHECK (revision > 0),
        responsibility  TEXT NOT NULL,
        inputs_json              TEXT NOT NULL,
        dependency_ids_json      TEXT NOT NULL,
        expected_evidence_json   TEXT NOT NULL,
        required_capabilities_json TEXT NOT NULL,
        authority_ceiling_json   TEXT NOT NULL,
        budget_json              TEXT NOT NULL,
        isolation_json           TEXT NOT NULL,
        stop_conditions_json     TEXT NOT NULL,
        assignee                 TEXT,
        session_ids_json         TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('planned')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (owner_id, id),
        UNIQUE (owner_id, outcome_id, position)
      );
    `,
    `
      CREATE TABLE owner_domain_events (
        owner_cursor    INTEGER PRIMARY KEY CHECK (owner_cursor > 0),
        schema_version  TEXT NOT NULL,
        event_id        TEXT NOT NULL UNIQUE,
        owner_id        TEXT NOT NULL,
        aggregate_kind  TEXT NOT NULL,
        aggregate_id    TEXT NOT NULL,
        revision        INTEGER NOT NULL CHECK (revision > 0),
        event_type      TEXT NOT NULL,
        causation_id    TEXT NOT NULL,
        correlation_id  TEXT NOT NULL,
        occurred_at     TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        UNIQUE (owner_id, aggregate_kind, aggregate_id, revision)
      );
    `,
    `
      CREATE TABLE responsibility_commands (
        request_id      TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL,
        request_digest  TEXT NOT NULL,
        result_json     TEXT NOT NULL,
        recorded_at     TEXT NOT NULL,
        UNIQUE (owner_id, request_id)
      );
    `,
    `
      CREATE TABLE responsibility_projection (
        owner_cursor  INTEGER PRIMARY KEY CHECK (owner_cursor > 0),
        owner_id      TEXT NOT NULL,
        item_json     TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE responsibility_projection_state (
        owner_id             TEXT PRIMARY KEY,
        snapshot_id          TEXT NOT NULL UNIQUE,
        snapshot_base_cursor INTEGER NOT NULL CHECK (snapshot_base_cursor >= 0),
        updated_at           TEXT NOT NULL
      );
    `,
  ],
  down: [
    'DROP TABLE IF EXISTS responsibility_projection_state;',
    'DROP TABLE IF EXISTS responsibility_projection;',
    'DROP TABLE IF EXISTS responsibility_commands;',
    'DROP TABLE IF EXISTS owner_domain_events;',
    'DROP TABLE IF EXISTS work_units;',
    'DROP TABLE IF EXISTS missions;',
    'DROP TABLE IF EXISTS outcomes;',
    'DROP TABLE IF EXISTS owner_event_state;',
    'DROP TABLE IF EXISTS owner_roots;',
  ],
};

export const RESPONSIBILITY_AUTHORITY_SCHEMA_MIGRATION: DoMigration = {
  version: 4,
  name: 'responsibility-canonical-authority-v0-1',
  up: [
    'ALTER TABLE owner_roots ADD COLUMN authenticated_subject_ref TEXT;',
    `ALTER TABLE owner_roots ADD COLUMN state TEXT
      CHECK (state IS NULL OR state IN ('active', 'suspended', 'revoked'));`,
    `ALTER TABLE owner_roots ADD COLUMN owner_policy_revision INTEGER
      CHECK (owner_policy_revision IS NULL OR owner_policy_revision >= 0);`,
    `ALTER TABLE owner_roots ADD COLUMN owner_root_routing_version INTEGER
      CHECK (owner_root_routing_version IS NULL OR owner_root_routing_version > 0);`,
    'ALTER TABLE owner_roots ADD COLUMN updated_at TEXT;',
    `CREATE UNIQUE INDEX owner_roots_subject_unique
      ON owner_roots(authenticated_subject_ref)
      WHERE authenticated_subject_ref IS NOT NULL;`,
    `CREATE TABLE presence_registrations (
      presence_registration_id TEXT PRIMARY KEY,
      owner_id                  TEXT NOT NULL,
      presence_id               TEXT NOT NULL,
      state                     TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL,
      UNIQUE (owner_id, presence_id),
      FOREIGN KEY (owner_id) REFERENCES owner_roots(owner_id)
    );`,
    `CREATE TABLE presence_sessions (
      authenticated_session_id  TEXT PRIMARY KEY,
      presence_registration_id  TEXT NOT NULL,
      expires_at                TEXT NOT NULL,
      created_at                TEXT NOT NULL,
      last_seen_at              TEXT NOT NULL,
      FOREIGN KEY (presence_registration_id)
        REFERENCES presence_registrations(presence_registration_id)
    );`,
  ],
  down: [
    'DROP TABLE IF EXISTS presence_sessions;',
    'DROP TABLE IF EXISTS presence_registrations;',
    'DROP INDEX IF EXISTS owner_roots_subject_unique;',
    'ALTER TABLE owner_roots DROP COLUMN updated_at;',
    'ALTER TABLE owner_roots DROP COLUMN owner_root_routing_version;',
    'ALTER TABLE owner_roots DROP COLUMN owner_policy_revision;',
    'ALTER TABLE owner_roots DROP COLUMN state;',
    'ALTER TABLE owner_roots DROP COLUMN authenticated_subject_ref;',
  ],
};

export const RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION: DoMigration = {
  version: 5,
  name: 'responsibility-planning-harness-v0-3',
  up: [
    'ALTER TABLE work_units RENAME TO work_units_v02;',
    `CREATE TABLE work_units (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL,
      outcome_id      TEXT NOT NULL,
      mission_id      TEXT,
      position        INTEGER NOT NULL CHECK (position >= 0),
      revision        INTEGER NOT NULL CHECK (revision > 0),
      responsibility  TEXT NOT NULL,
      inputs_json              TEXT NOT NULL,
      dependency_ids_json      TEXT NOT NULL,
      expected_evidence_json   TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      authority_ceiling_json   TEXT NOT NULL,
      budget_json              TEXT NOT NULL,
      isolation_json           TEXT NOT NULL,
      stop_conditions_json     TEXT NOT NULL,
      assignee                 TEXT,
      session_ids_json         TEXT NOT NULL,
      state           TEXT NOT NULL CHECK (state IN ('planned', 'planning_authorized')),
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      UNIQUE (owner_id, id),
      UNIQUE (owner_id, outcome_id, position)
    );`,
    `INSERT INTO work_units (
      id, owner_id, outcome_id, mission_id, position, revision, responsibility,
      inputs_json, dependency_ids_json, expected_evidence_json,
      required_capabilities_json, authority_ceiling_json, budget_json,
      isolation_json, stop_conditions_json, assignee, session_ids_json, state,
      created_at, updated_at
    ) SELECT
      id, owner_id, outcome_id, mission_id, position, revision, responsibility,
      inputs_json, dependency_ids_json, expected_evidence_json,
      required_capabilities_json, authority_ceiling_json, budget_json,
      isolation_json, stop_conditions_json, assignee, session_ids_json, state,
      created_at, updated_at
    FROM work_units_v02;`,
    'DROP TABLE work_units_v02;',
    `CREATE TABLE planning_execution_requests (
      id                       TEXT PRIMARY KEY,
      owner_id                 TEXT NOT NULL,
      outcome_id               TEXT NOT NULL,
      work_unit_id             TEXT NOT NULL,
      work_unit_revision       INTEGER NOT NULL CHECK (work_unit_revision >= 2),
      request_id               TEXT NOT NULL,
      request_digest           TEXT NOT NULL,
      governed_inputs_json     TEXT NOT NULL,
      provider_ref_json        TEXT NOT NULL,
      executor_ref_json        TEXT NOT NULL,
      capability_manifest_json TEXT NOT NULL,
      authority_ceiling_json   TEXT NOT NULL,
      status                   TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'completed', 'cancelled', 'failed', 'ambiguous')
      ),
      cancellation_generation  INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      UNIQUE (owner_id, request_id),
      UNIQUE (owner_id, work_unit_id)
    );`,
    `CREATE TABLE planning_agent_sessions (
      id                       TEXT PRIMARY KEY,
      owner_id                 TEXT NOT NULL,
      outcome_id               TEXT NOT NULL,
      work_unit_id             TEXT NOT NULL,
      execution_request_id     TEXT NOT NULL UNIQUE,
      status                   TEXT NOT NULL CHECK (
        status IN ('authorized', 'running', 'completed', 'cancelled', 'failed', 'ambiguous')
      ),
      provider_ref_json        TEXT NOT NULL,
      executor_ref_json        TEXT NOT NULL,
      capability_manifest_json TEXT NOT NULL,
      cancellation_generation  INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );`,
    `CREATE TABLE planning_execution_leases (
      execution_request_id    TEXT PRIMARY KEY,
      owner_id                TEXT NOT NULL,
      holder_id               TEXT NOT NULL,
      fence                   INTEGER NOT NULL CHECK (fence > 0),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      acquired_at             TEXT NOT NULL,
      expires_at              TEXT NOT NULL
    );`,
    `CREATE TABLE planning_provider_invocations (
      execution_request_id TEXT PRIMARY KEY,
      owner_id             TEXT NOT NULL,
      invocation_key       TEXT NOT NULL,
      effect_ref           TEXT NOT NULL,
      request_digest       TEXT NOT NULL,
      execution_json       TEXT NOT NULL,
      provider_ref_json    TEXT NOT NULL,
      status               TEXT NOT NULL CHECK (
        status IN ('pending', 'completed', 'invalid_output', 'ambiguous')
      ),
      result_digest        TEXT,
      started_at           TEXT NOT NULL,
      completed_at         TEXT,
      UNIQUE (owner_id, invocation_key)
    );`,
    `CREATE TABLE work_unit_candidate_plans (
      execution_request_id TEXT PRIMARY KEY,
      owner_id             TEXT NOT NULL,
      outcome_id           TEXT NOT NULL,
      work_unit_id         TEXT NOT NULL,
      agent_session_id     TEXT NOT NULL,
      result_digest        TEXT NOT NULL,
      plan_json            TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      UNIQUE (owner_id, work_unit_id)
    );`,
    `CREATE TABLE work_unit_planning_commands (
      request_id       TEXT PRIMARY KEY,
      owner_id         TEXT NOT NULL,
      request_digest   TEXT NOT NULL,
      result_json      TEXT NOT NULL,
      recorded_at      TEXT NOT NULL,
      UNIQUE (owner_id, request_id)
    );`,
    `CREATE TABLE work_unit_planning_controls (
      request_id       TEXT PRIMARY KEY,
      owner_id         TEXT NOT NULL,
      request_digest   TEXT NOT NULL,
      result_json      TEXT NOT NULL,
      recorded_at      TEXT NOT NULL,
      UNIQUE (owner_id, request_id)
    );`,
    `CREATE TABLE work_unit_planning_projection (
      owner_cursor INTEGER PRIMARY KEY CHECK (owner_cursor > 0),
      owner_id     TEXT NOT NULL,
      item_json    TEXT NOT NULL
    );`,
  ],
  down: [
    `CREATE TEMP TABLE planning_harness_rollback_guard (
      eligible INTEGER NOT NULL CHECK (eligible = 1)
    );`,
    `INSERT INTO planning_harness_rollback_guard (eligible)
     SELECT CASE WHEN
       NOT EXISTS (SELECT 1 FROM work_units WHERE state = 'planning_authorized') AND
       NOT EXISTS (SELECT 1 FROM planning_execution_requests) AND
       NOT EXISTS (SELECT 1 FROM planning_agent_sessions) AND
       NOT EXISTS (SELECT 1 FROM planning_execution_leases) AND
       NOT EXISTS (SELECT 1 FROM planning_provider_invocations) AND
       NOT EXISTS (SELECT 1 FROM work_unit_candidate_plans) AND
       NOT EXISTS (SELECT 1 FROM work_unit_planning_commands) AND
       NOT EXISTS (SELECT 1 FROM work_unit_planning_controls) AND
       NOT EXISTS (SELECT 1 FROM work_unit_planning_projection)
     THEN 1 ELSE 0 END;`,
    'DROP TABLE planning_harness_rollback_guard;',
    'DROP TABLE IF EXISTS work_unit_planning_projection;',
    'DROP TABLE IF EXISTS work_unit_planning_controls;',
    'DROP TABLE IF EXISTS work_unit_planning_commands;',
    'DROP TABLE IF EXISTS work_unit_candidate_plans;',
    'DROP TABLE IF EXISTS planning_provider_invocations;',
    'DROP TABLE IF EXISTS planning_execution_leases;',
    'DROP TABLE IF EXISTS planning_agent_sessions;',
    'DROP TABLE IF EXISTS planning_execution_requests;',
    'ALTER TABLE work_units RENAME TO work_units_v03;',
    `CREATE TABLE work_units (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, outcome_id TEXT NOT NULL,
      mission_id TEXT, position INTEGER NOT NULL CHECK (position >= 0),
      revision INTEGER NOT NULL CHECK (revision > 0), responsibility TEXT NOT NULL,
      inputs_json TEXT NOT NULL, dependency_ids_json TEXT NOT NULL,
      expected_evidence_json TEXT NOT NULL, required_capabilities_json TEXT NOT NULL,
      authority_ceiling_json TEXT NOT NULL, budget_json TEXT NOT NULL,
      isolation_json TEXT NOT NULL, stop_conditions_json TEXT NOT NULL,
      assignee TEXT, session_ids_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('planned')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (owner_id, id), UNIQUE (owner_id, outcome_id, position)
    );`,
    `INSERT INTO work_units (
      id, owner_id, outcome_id, mission_id, position, revision, responsibility,
      inputs_json, dependency_ids_json, expected_evidence_json,
      required_capabilities_json, authority_ceiling_json, budget_json,
      isolation_json, stop_conditions_json, assignee, session_ids_json, state,
      created_at, updated_at
    ) SELECT
      id, owner_id, outcome_id, mission_id, position, revision, responsibility,
      inputs_json, dependency_ids_json, expected_evidence_json,
      required_capabilities_json, authority_ceiling_json, budget_json,
      isolation_json, stop_conditions_json, assignee, session_ids_json, state,
      created_at, updated_at
    FROM work_units_v03;`,
    'DROP TABLE work_units_v03;',
  ],
};

export const RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION: DoMigration = {
  version: 6,
  name: 'responsibility-execution-writer-v0-4',
  up: [
    'ALTER TABLE planning_execution_requests RENAME TO planning_execution_requests_v05;',
    `CREATE TABLE planning_execution_requests (
      id                       TEXT PRIMARY KEY,
      owner_id                 TEXT NOT NULL,
      outcome_id               TEXT NOT NULL,
      work_unit_id             TEXT NOT NULL,
      work_unit_revision       INTEGER NOT NULL CHECK (
        (protocol_version = '0.3' AND work_unit_revision >= 2) OR
        (protocol_version = '0.4' AND work_unit_revision > 0)
      ),
      request_id               TEXT NOT NULL,
      request_digest           TEXT NOT NULL,
      governed_inputs_json     TEXT NOT NULL,
      provider_ref_json        TEXT NOT NULL,
      executor_ref_json        TEXT NOT NULL,
      capability_manifest_json TEXT NOT NULL,
      authority_ceiling_json   TEXT NOT NULL,
      status                   TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'completed', 'cancelled', 'failed', 'ambiguous')
      ),
      cancellation_generation  INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      protocol_version         TEXT NOT NULL DEFAULT '0.3' CHECK (protocol_version IN ('0.3', '0.4')),
      outcome_ref_json         TEXT,
      work_unit_ref_json       TEXT,
      environment_ref_json     TEXT,
      context_projection_ref   TEXT,
      context_projection_digest TEXT,
      request_json             TEXT,
      cancellation_request_id  TEXT,
      cancellation_request_digest TEXT,
      cancellation_request_json TEXT,
      UNIQUE (owner_id, request_id),
      UNIQUE (owner_id, work_unit_id),
      CHECK (
        protocol_version = '0.3' OR (
          outcome_ref_json IS NOT NULL AND work_unit_ref_json IS NOT NULL AND
          environment_ref_json IS NOT NULL AND context_projection_ref IS NOT NULL AND
          context_projection_digest IS NOT NULL AND request_json IS NOT NULL AND
          ((cancellation_request_id IS NULL) = (cancellation_request_digest IS NULL)) AND
          ((cancellation_request_id IS NULL) = (cancellation_request_json IS NULL))
        )
      )
    );`,
    `INSERT INTO planning_execution_requests (
      id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
      request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
      capability_manifest_json, authority_ceiling_json, status,
      cancellation_generation, created_at, updated_at, protocol_version
    ) SELECT
      id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
      request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
      capability_manifest_json, authority_ceiling_json, status,
      cancellation_generation, created_at, updated_at, '0.3'
    FROM planning_execution_requests_v05;`,
    'DROP TABLE planning_execution_requests_v05;',
    `CREATE UNIQUE INDEX planning_execution_requests_v04_cancel_request_unique
       ON planning_execution_requests(cancellation_request_id)
       WHERE protocol_version = '0.4' AND cancellation_request_id IS NOT NULL;`,
    'ALTER TABLE planning_agent_sessions RENAME TO planning_agent_sessions_v05;',
    `CREATE TABLE planning_agent_sessions (
      id                       TEXT PRIMARY KEY,
      owner_id                 TEXT NOT NULL,
      outcome_id               TEXT NOT NULL,
      work_unit_id             TEXT NOT NULL,
      execution_request_id     TEXT NOT NULL,
      status                   TEXT NOT NULL CHECK (
        status IN (
          'authorized', 'running', 'completed', 'cancelled', 'failed', 'ambiguous',
          'starting', 'active', 'ended', 'lost', 'unknown'
        )
      ),
      provider_ref_json        TEXT NOT NULL,
      executor_ref_json        TEXT NOT NULL,
      capability_manifest_json TEXT NOT NULL,
      cancellation_generation  INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      protocol_version         TEXT NOT NULL DEFAULT '0.3' CHECK (protocol_version IN ('0.3', '0.4')),
      attempt_id               TEXT,
      environment_ref_json     TEXT,
      provider_session_ref     TEXT,
      last_observation_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_observation_sequence >= 0),
      CHECK (
        protocol_version = '0.3' OR (attempt_id IS NOT NULL AND environment_ref_json IS NOT NULL)
      )
    );`,
    `INSERT INTO planning_agent_sessions (
      id, owner_id, outcome_id, work_unit_id, execution_request_id, status,
      provider_ref_json, executor_ref_json, capability_manifest_json,
      cancellation_generation, created_at, updated_at, protocol_version
    ) SELECT
      id, owner_id, outcome_id, work_unit_id, execution_request_id, status,
      provider_ref_json, executor_ref_json, capability_manifest_json,
      cancellation_generation, created_at, updated_at, '0.3'
    FROM planning_agent_sessions_v05;`,
    'DROP TABLE planning_agent_sessions_v05;',
    `CREATE UNIQUE INDEX planning_agent_sessions_v03_request_unique
       ON planning_agent_sessions(execution_request_id) WHERE protocol_version = '0.3';`,
    `CREATE UNIQUE INDEX planning_agent_sessions_v04_attempt_unique
       ON planning_agent_sessions(attempt_id) WHERE attempt_id IS NOT NULL;`,
    'ALTER TABLE planning_execution_leases RENAME TO planning_execution_leases_v05;',
    `CREATE TABLE planning_execution_leases (
      execution_request_id    TEXT NOT NULL,
      owner_id                TEXT NOT NULL,
      holder_id               TEXT NOT NULL,
      fence                   INTEGER NOT NULL CHECK (fence > 0),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      acquired_at             TEXT NOT NULL,
      expires_at              TEXT NOT NULL,
      id                      TEXT,
      attempt_id              TEXT,
      environment_ref_json    TEXT,
      CHECK ((id IS NULL AND attempt_id IS NULL) OR (id IS NOT NULL AND attempt_id IS NOT NULL))
    );`,
    `INSERT INTO planning_execution_leases (
      execution_request_id, owner_id, holder_id, fence, cancellation_generation,
      acquired_at, expires_at
    ) SELECT
      execution_request_id, owner_id, holder_id, fence, cancellation_generation,
      acquired_at, expires_at
    FROM planning_execution_leases_v05;`,
    'DROP TABLE planning_execution_leases_v05;',
    `CREATE UNIQUE INDEX planning_execution_leases_v03_request_unique
       ON planning_execution_leases(execution_request_id) WHERE attempt_id IS NULL;`,
    `CREATE UNIQUE INDEX planning_execution_leases_v04_id_unique
       ON planning_execution_leases(id) WHERE id IS NOT NULL;`,
    `CREATE UNIQUE INDEX planning_execution_leases_v04_attempt_unique
       ON planning_execution_leases(attempt_id) WHERE attempt_id IS NOT NULL;`,
    `CREATE TABLE execution_attempts (
      id                      TEXT PRIMARY KEY,
      owner_id                TEXT NOT NULL,
      execution_request_id    TEXT NOT NULL,
      work_unit_ref_json      TEXT NOT NULL,
      attempt_number          INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
      provider_ref_json       TEXT NOT NULL,
      environment_ref_json    TEXT NOT NULL,
      lease_id                TEXT NOT NULL UNIQUE,
      fencing_generation      INTEGER NOT NULL CHECK (fencing_generation > 0),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      state                   TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'cancelling', 'cancelled', 'settling',
                  'settled', 'failed', 'indeterminate')
      ),
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL,
      UNIQUE (execution_request_id, attempt_number)
    );`,
    `CREATE TABLE execution_observations (
      id                      TEXT PRIMARY KEY,
      owner_id                TEXT NOT NULL,
      attempt_id              TEXT NOT NULL,
      lease_id                TEXT NOT NULL,
      fencing_generation      INTEGER NOT NULL CHECK (fencing_generation > 0),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      sequence                INTEGER NOT NULL CHECK (sequence > 0),
      kind                    TEXT NOT NULL CHECK (
        kind IN ('started', 'activity', 'candidate_artifact', 'candidate_evidence',
                 'ended', 'failed', 'timed_out', 'unknown')
      ),
      environment_ref_json    TEXT NOT NULL,
      payload_ref             TEXT,
      payload_digest          TEXT,
      observed_at             TEXT NOT NULL,
      received_at             TEXT NOT NULL,
      observation_json        TEXT NOT NULL,
      canonical_digest        TEXT NOT NULL,
      UNIQUE (attempt_id, sequence),
      CHECK ((payload_ref IS NULL) = (payload_digest IS NULL))
    );`,
    `CREATE TABLE execution_reconciliations (
      id                      TEXT PRIMARY KEY,
      owner_id                TEXT NOT NULL,
      attempt_id              TEXT NOT NULL,
      lease_id                TEXT NOT NULL,
      fencing_generation      INTEGER NOT NULL CHECK (fencing_generation > 0),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      state                   TEXT NOT NULL CHECK (
        state IN ('running', 'cancelled', 'settled', 'failed', 'indeterminate')
      ),
      basis_observation_ids_json TEXT NOT NULL,
      checked_at              TEXT NOT NULL,
      reconciliation_json     TEXT NOT NULL,
      canonical_digest        TEXT NOT NULL,
      UNIQUE (attempt_id, id)
    );`,
  ],
  down: [
    `CREATE TABLE execution_writer_rollback_guard (
      eligible INTEGER NOT NULL CHECK (eligible = 1)
    );`,
    `INSERT INTO execution_writer_rollback_guard (eligible)
     SELECT CASE WHEN
       NOT EXISTS (SELECT 1 FROM execution_attempts) AND
       NOT EXISTS (SELECT 1 FROM execution_observations) AND
       NOT EXISTS (SELECT 1 FROM execution_reconciliations) AND
       NOT EXISTS (SELECT 1 FROM planning_execution_requests WHERE protocol_version != '0.3') AND
       NOT EXISTS (SELECT 1 FROM planning_agent_sessions WHERE protocol_version != '0.3') AND
       NOT EXISTS (SELECT 1 FROM planning_execution_leases WHERE id IS NOT NULL OR attempt_id IS NOT NULL)
     THEN 1 ELSE 0 END;`,
    'DROP TABLE execution_writer_rollback_guard;',
    'DROP TABLE execution_reconciliations;',
    'DROP TABLE execution_observations;',
    'DROP TABLE execution_attempts;',
    'ALTER TABLE planning_execution_requests RENAME TO planning_execution_requests_v06;',
    `CREATE TABLE planning_execution_requests (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, outcome_id TEXT NOT NULL,
      work_unit_id TEXT NOT NULL, work_unit_revision INTEGER NOT NULL CHECK (work_unit_revision >= 2),
      request_id TEXT NOT NULL, request_digest TEXT NOT NULL, governed_inputs_json TEXT NOT NULL,
      provider_ref_json TEXT NOT NULL, executor_ref_json TEXT NOT NULL,
      capability_manifest_json TEXT NOT NULL, authority_ceiling_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'completed', 'cancelled', 'failed', 'ambiguous')
      ),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (owner_id, request_id), UNIQUE (owner_id, work_unit_id)
    );`,
    `INSERT INTO planning_execution_requests (
      id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
      request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
      capability_manifest_json, authority_ceiling_json, status,
      cancellation_generation, created_at, updated_at
    ) SELECT
      id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
      request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
      capability_manifest_json, authority_ceiling_json, status,
      cancellation_generation, created_at, updated_at
    FROM planning_execution_requests_v06;`,
    'DROP TABLE planning_execution_requests_v06;',
    'DROP INDEX planning_agent_sessions_v04_attempt_unique;',
    'DROP INDEX planning_agent_sessions_v03_request_unique;',
    'ALTER TABLE planning_agent_sessions RENAME TO planning_agent_sessions_v06;',
    `CREATE TABLE planning_agent_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, outcome_id TEXT NOT NULL,
      work_unit_id TEXT NOT NULL, execution_request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (
        status IN ('authorized', 'running', 'completed', 'cancelled', 'failed', 'ambiguous')
      ),
      provider_ref_json TEXT NOT NULL, executor_ref_json TEXT NOT NULL,
      capability_manifest_json TEXT NOT NULL,
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`,
    `INSERT INTO planning_agent_sessions (
      id, owner_id, outcome_id, work_unit_id, execution_request_id, status,
      provider_ref_json, executor_ref_json, capability_manifest_json,
      cancellation_generation, created_at, updated_at
    ) SELECT
      id, owner_id, outcome_id, work_unit_id, execution_request_id, status,
      provider_ref_json, executor_ref_json, capability_manifest_json,
      cancellation_generation, created_at, updated_at
    FROM planning_agent_sessions_v06;`,
    'DROP TABLE planning_agent_sessions_v06;',
    'DROP INDEX planning_execution_leases_v04_attempt_unique;',
    'DROP INDEX planning_execution_leases_v04_id_unique;',
    'DROP INDEX planning_execution_leases_v03_request_unique;',
    'ALTER TABLE planning_execution_leases RENAME TO planning_execution_leases_v06;',
    `CREATE TABLE planning_execution_leases (
      execution_request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, holder_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence > 0),
      cancellation_generation INTEGER NOT NULL CHECK (cancellation_generation >= 0),
      acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );`,
    `INSERT INTO planning_execution_leases (
      execution_request_id, owner_id, holder_id, fence, cancellation_generation,
      acquired_at, expires_at
    ) SELECT
      execution_request_id, owner_id, holder_id, fence, cancellation_generation,
      acquired_at, expires_at
    FROM planning_execution_leases_v06;`,
    'DROP TABLE planning_execution_leases_v06;',
  ],
};

export const RESPONSIBILITY_JUDGMENT_AUTHORITY_SCHEMA_MIGRATION: DoMigration = {
  version: 7,
  name: 'responsibility-judgment-authority-v0-5',
  up: [
    `ALTER TABLE presence_sessions ADD COLUMN auth_assurance TEXT NOT NULL
      DEFAULT 'legacy_unverified'
      CHECK (
        length(auth_assurance) BETWEEN 1 AND 128 AND
        substr(auth_assurance, 1, 1) GLOB '[A-Za-z0-9]' AND
        auth_assurance NOT GLOB '*[^A-Za-z0-9._:-]*'
      );`,
    `CREATE TABLE judgment_requests (
      id                       TEXT PRIMARY KEY,
      owner_id                 TEXT NOT NULL,
      revision                 INTEGER NOT NULL CHECK (revision > 0),
      subject_kind             TEXT NOT NULL CHECK (subject_kind IN ('outcome', 'work_unit')),
      subject_id               TEXT NOT NULL,
      subject_revision         INTEGER NOT NULL CHECK (subject_revision > 0),
      affected_digest          TEXT NOT NULL,
      displayed_request_digest TEXT NOT NULL,
      request_json             TEXT NOT NULL,
      admission_basis_json     TEXT NOT NULL,
      state                    TEXT NOT NULL CHECK (
        state IN ('open', 'answered', 'expired', 'withdrawn', 'superseded')
      ),
      decision_id              TEXT,
      expires_at               TEXT NOT NULL,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL,
      UNIQUE (owner_id, id),
      CHECK ((state = 'answered') = (decision_id IS NOT NULL))
    );`,
    `CREATE TABLE judgment_decisions (
      id                  TEXT PRIMARY KEY,
      owner_id            TEXT NOT NULL,
      judgment_request_id TEXT NOT NULL UNIQUE,
      revision            INTEGER NOT NULL CHECK (revision > 0),
      decision_json       TEXT NOT NULL,
      decided_at          TEXT NOT NULL,
      UNIQUE (owner_id, id)
    );`,
    `CREATE TABLE authority_grants (
      id                    TEXT PRIMARY KEY,
      owner_id              TEXT NOT NULL,
      judgment_request_id   TEXT NOT NULL UNIQUE,
      judgment_decision_id  TEXT NOT NULL UNIQUE,
      revision              INTEGER NOT NULL CHECK (revision > 0),
      grant_json            TEXT NOT NULL,
      use_limit             INTEGER NOT NULL CHECK (use_limit = 1),
      uses_consumed         INTEGER NOT NULL CHECK (uses_consumed BETWEEN 0 AND 1),
      next_use_index        INTEGER NOT NULL CHECK (next_use_index = uses_consumed + 1),
      state                 TEXT NOT NULL CHECK (
        state IN ('active', 'exhausted', 'expired', 'revoked', 'superseded')
      ),
      expires_at            TEXT NOT NULL,
      revocation_generation INTEGER NOT NULL CHECK (revocation_generation >= 0),
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      UNIQUE (owner_id, id),
      CHECK (
        (state = 'active' AND uses_consumed < use_limit) OR
        (state = 'exhausted' AND uses_consumed = use_limit) OR
        state IN ('expired', 'revoked', 'superseded')
      )
    );`,
    `CREATE TABLE judgment_commands (
      request_id     TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      result_json    TEXT NOT NULL,
      recorded_at    TEXT NOT NULL,
      UNIQUE (owner_id, request_id)
    );`,
    `CREATE TABLE judgment_projection (
      owner_cursor INTEGER PRIMARY KEY CHECK (owner_cursor > 0),
      owner_id     TEXT NOT NULL,
      item_json    TEXT NOT NULL
    );`,
    `CREATE TABLE judgment_projection_state (
      owner_id             TEXT PRIMARY KEY,
      snapshot_id          TEXT NOT NULL UNIQUE,
      snapshot_base_cursor INTEGER NOT NULL CHECK (snapshot_base_cursor >= 0),
      updated_at           TEXT NOT NULL
    );`,
  ],
  down: [
    `CREATE TABLE judgment_authority_rollback_guard (
      eligible INTEGER NOT NULL CHECK (eligible = 1)
    );`,
    `INSERT INTO judgment_authority_rollback_guard (eligible)
     SELECT CASE WHEN
       NOT EXISTS (SELECT 1 FROM judgment_requests) AND
       NOT EXISTS (SELECT 1 FROM judgment_decisions) AND
       NOT EXISTS (SELECT 1 FROM authority_grants) AND
       NOT EXISTS (SELECT 1 FROM judgment_commands) AND
       NOT EXISTS (SELECT 1 FROM judgment_projection) AND
       NOT EXISTS (SELECT 1 FROM judgment_projection_state)
     THEN 1 ELSE 0 END;`,
    'DROP TABLE judgment_authority_rollback_guard;',
    'DROP TABLE judgment_projection_state;',
    'DROP TABLE judgment_projection;',
    'DROP TABLE judgment_commands;',
    'DROP TABLE authority_grants;',
    'DROP TABLE judgment_decisions;',
    'DROP TABLE judgment_requests;',
    'ALTER TABLE presence_sessions DROP COLUMN auth_assurance;',
  ],
};

// C4 truthful run history: one append-only row per scheduled fire, written before dispatch and
// settled at completion. A row stuck in 'running' is the crashed-run evidence; 'missed' rows are
// written by the missed-run policy (C3). No free-text error column - error_class carries the
// Hermes-style split (run vs scheduler_handoff vs delivery) without leaking provider text.
export const SCHEDULE_RUNS_SCHEMA_MIGRATION: DoMigration = {
  version: 8,
  name: 'schedule-runs-v0-1',
  up: [
    `CREATE TABLE IF NOT EXISTS schedule_runs (
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
    );`,
    `CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule ON schedule_runs (schedule_id, fired_at DESC);`,
  ],
  down: ['DROP TABLE IF EXISTS schedule_runs;'],
};

export const DO_SCHEMA_MIGRATIONS = [
  HEY10_BASE_SCHEMA_MIGRATION,
  HEY144_GOALS_SCHEMA_MIGRATION,
  RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION,
  RESPONSIBILITY_AUTHORITY_SCHEMA_MIGRATION,
  RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION,
  RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION,
  RESPONSIBILITY_JUDGMENT_AUTHORITY_SCHEMA_MIGRATION,
  SCHEDULE_RUNS_SCHEMA_MIGRATION,
] as const;

export const DO_SCHEMA_VERSION = DO_SCHEMA_MIGRATIONS.at(-1)!.version;

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
  owner_roots: [
    'root_key',
    'owner_id',
    'authenticated_subject_ref',
    'state',
    'owner_policy_revision',
    'owner_root_routing_version',
    'created_at',
    'updated_at',
  ],
  presence_registrations: [
    'presence_registration_id',
    'owner_id',
    'presence_id',
    'state',
    'created_at',
    'updated_at',
  ],
  presence_sessions: [
    'authenticated_session_id',
    'presence_registration_id',
    'expires_at',
    'created_at',
    'last_seen_at',
    'auth_assurance',
  ],
  owner_event_state: ['root_key', 'owner_id', 'high_water_cursor'],
  outcomes: [
    'id',
    'owner_id',
    'revision',
    'user_statement',
    'state',
    'created_at',
    'updated_at',
  ],
  missions: [
    'id',
    'owner_id',
    'outcome_id',
    'revision',
    'brief',
    'state',
    'created_at',
    'updated_at',
  ],
  work_units: [
    'id',
    'owner_id',
    'outcome_id',
    'mission_id',
    'position',
    'revision',
    'responsibility',
    'inputs_json',
    'dependency_ids_json',
    'expected_evidence_json',
    'required_capabilities_json',
    'authority_ceiling_json',
    'budget_json',
    'isolation_json',
    'stop_conditions_json',
    'assignee',
    'session_ids_json',
    'state',
    'created_at',
    'updated_at',
  ],
  owner_domain_events: [
    'owner_cursor',
    'schema_version',
    'event_id',
    'owner_id',
    'aggregate_kind',
    'aggregate_id',
    'revision',
    'event_type',
    'causation_id',
    'correlation_id',
    'occurred_at',
    'payload_json',
  ],
  responsibility_commands: [
    'request_id',
    'owner_id',
    'request_digest',
    'result_json',
    'recorded_at',
  ],
  responsibility_projection: ['owner_cursor', 'owner_id', 'item_json'],
  responsibility_projection_state: [
    'owner_id', 'snapshot_id', 'snapshot_base_cursor', 'updated_at',
  ],
  planning_execution_requests: [
    'id', 'owner_id', 'outcome_id', 'work_unit_id', 'work_unit_revision',
    'request_id', 'request_digest', 'governed_inputs_json', 'provider_ref_json',
    'executor_ref_json', 'capability_manifest_json', 'authority_ceiling_json',
    'status', 'cancellation_generation', 'created_at', 'updated_at',
    'protocol_version', 'outcome_ref_json', 'work_unit_ref_json',
    'environment_ref_json', 'context_projection_ref', 'context_projection_digest',
    'request_json', 'cancellation_request_id', 'cancellation_request_digest',
    'cancellation_request_json',
  ],
  planning_agent_sessions: [
    'id', 'owner_id', 'outcome_id', 'work_unit_id', 'execution_request_id',
    'status', 'provider_ref_json', 'executor_ref_json', 'capability_manifest_json',
    'cancellation_generation', 'created_at', 'updated_at', 'protocol_version',
    'attempt_id', 'environment_ref_json', 'provider_session_ref',
    'last_observation_sequence',
  ],
  planning_execution_leases: [
    'execution_request_id', 'owner_id', 'holder_id', 'fence',
    'cancellation_generation', 'acquired_at', 'expires_at', 'id', 'attempt_id',
    'environment_ref_json',
  ],
  planning_provider_invocations: [
    'execution_request_id', 'owner_id', 'invocation_key', 'effect_ref',
    'request_digest', 'execution_json', 'provider_ref_json',
    'status', 'result_digest', 'started_at', 'completed_at',
  ],
  execution_attempts: [
    'id', 'owner_id', 'execution_request_id', 'work_unit_ref_json', 'attempt_number',
    'provider_ref_json', 'environment_ref_json', 'lease_id', 'fencing_generation',
    'cancellation_generation', 'state', 'created_at', 'updated_at',
  ],
  execution_observations: [
    'id', 'owner_id', 'attempt_id', 'lease_id', 'fencing_generation',
    'cancellation_generation', 'sequence', 'kind', 'environment_ref_json',
    'payload_ref', 'payload_digest', 'observed_at', 'received_at',
    'observation_json', 'canonical_digest',
  ],
  execution_reconciliations: [
    'id', 'owner_id', 'attempt_id', 'lease_id', 'fencing_generation',
    'cancellation_generation', 'state', 'basis_observation_ids_json', 'checked_at',
    'reconciliation_json', 'canonical_digest',
  ],
  work_unit_candidate_plans: [
    'execution_request_id', 'owner_id', 'outcome_id', 'work_unit_id',
    'agent_session_id', 'result_digest', 'plan_json', 'created_at',
  ],
  work_unit_planning_commands: [
    'request_id', 'owner_id', 'request_digest', 'result_json', 'recorded_at',
  ],
  work_unit_planning_controls: [
    'request_id', 'owner_id', 'request_digest', 'result_json', 'recorded_at',
  ],
  work_unit_planning_projection: ['owner_cursor', 'owner_id', 'item_json'],
  judgment_requests: [
    'id', 'owner_id', 'revision', 'subject_kind', 'subject_id', 'subject_revision',
    'affected_digest', 'displayed_request_digest', 'request_json', 'admission_basis_json',
    'state', 'decision_id', 'expires_at', 'created_at', 'updated_at',
  ],
  judgment_decisions: [
    'id', 'owner_id', 'judgment_request_id', 'revision', 'decision_json', 'decided_at',
  ],
  authority_grants: [
    'id', 'owner_id', 'judgment_request_id', 'judgment_decision_id', 'revision',
    'grant_json', 'use_limit', 'uses_consumed', 'next_use_index', 'state', 'expires_at',
    'revocation_generation', 'created_at', 'updated_at',
  ],
  judgment_commands: [
    'request_id', 'owner_id', 'request_digest', 'result_json', 'recorded_at',
  ],
  judgment_projection: ['owner_cursor', 'owner_id', 'item_json'],
  judgment_projection_state: [
    'owner_id', 'snapshot_id', 'snapshot_base_cursor', 'updated_at',
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
    for (const [index, statement] of statements.entries()) {
      try {
        sql.exec(statement);
      } catch (cause) {
        throw new Error(
          `DO migration ${migration.name} ${direction} statement ${index + 1} failed`,
          { cause },
        );
      }
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
