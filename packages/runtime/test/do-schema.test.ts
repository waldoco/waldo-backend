import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_DO_PRODUCT_TABLES,
  DO_SCHEMA_METADATA_TABLE,
  DO_SCHEMA_VERSION,
  DO_PRODUCT_TABLES,
  DoSchemaDriftError,
  HEY10_BASE_SCHEMA_MIGRATION,
  HEY144_GOALS_SCHEMA_MIGRATION,
  RESPONSIBILITY_AUTHORITY_SCHEMA_MIGRATION,
  RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION,
  RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION,
  RESPONSIBILITY_JUDGMENT_AUTHORITY_SCHEMA_MIGRATION,
  SCHEDULE_RUNS_SCHEMA_MIGRATION,
  RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION,
  applyDoMigration,
  assertDoSchema,
  getSchemaVersion,
  provisionDoSchema,
  type DoMigration,
} from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';

let seq = 0;
function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  seq += 1;
  const id = env.RUNTIME_DO.idFromName(`do-schema-${seq}`);
  return env.RUNTIME_DO.get(id);
}

type TableColumn = {
  table_name: string;
  column_name: string;
};

function listTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
}

function listProductColumns(sql: SqlStorage): TableColumn[] {
  return DO_PRODUCT_TABLES.flatMap((tableName) =>
    sql
      .exec<{ name: string }>(`PRAGMA table_info(${tableName})`)
      .toArray()
      .map((row) => ({ table_name: tableName, column_name: row.name })),
  );
}

function provisionThroughV5(storage: DurableObjectStorage): void {
  for (const migration of [
    HEY10_BASE_SCHEMA_MIGRATION,
    HEY144_GOALS_SCHEMA_MIGRATION,
    RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION,
    RESPONSIBILITY_AUTHORITY_SCHEMA_MIGRATION,
    RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION,
  ]) {
    applyDoMigration(storage, migration);
  }
}

function provisionThroughV6(storage: DurableObjectStorage): void {
  provisionThroughV5(storage);
  applyDoMigration(storage, RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION);
}

describe('HEY-10 DO SQLite schema root', () => {
  it('reports an empty DO SQLite database as missing required product tables', async () => {
    const stub = freshStub();

    const differences = await runInDurableObject(stub, (_instance, state) => {
      try {
        assertDoSchema(state.storage.sql);
        return [];
      } catch (error) {
        if (!(error instanceof DoSchemaDriftError)) throw error;
        return error.differences;
      }
    });

    expect(differences).toEqual(
      DO_PRODUCT_TABLES.map((table) => ({
        kind: 'missing_table',
        table,
      })),
    );
  });

  it('provisions all required product tables and schema metadata at the current version', async () => {
    const stub = freshStub();

    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      provisionDoSchema(state.storage);

      return {
        version: getSchemaVersion(state.storage.sql),
        tables: listTables(state.storage.sql),
        assertResult: assertDoSchema(state.storage.sql),
      };
    });

    expect(result.version).toBe(8);
    expect(result.version).toBe(DO_SCHEMA_VERSION);
    expect(result.assertResult.ok).toBe(true);
    for (const table of DO_PRODUCT_TABLES) {
      expect(result.tables).toContain(table);
    }
    expect(result.tables).toEqual(expect.arrayContaining([
      'judgment_requests',
      'judgment_decisions',
      'authority_grants',
      'judgment_commands',
      'judgment_projection',
      'judgment_projection_state',
    ]));
    expect(result.tables).toContain('do_schema_migrations');

    const productTables = result.tables.filter((table) =>
      (DO_PRODUCT_TABLES as readonly string[]).includes(table),
    );
    expect(productTables).toEqual([...DO_PRODUCT_TABLES].sort());
    for (const deferred of DEFERRED_DO_PRODUCT_TABLES) {
      expect(result.tables).not.toContain(deferred);
    }
  });

  it('migrates an existing V1 database to the current version without changing a V1 row', async () => {
    const stub = freshStub();

    const result = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      sql.exec(
        `INSERT INTO drafts (
          user_id,
          draft_id,
          provider,
          created_at,
          recipient_count,
          idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        'user-v1',
        'draft-v1',
        'gmail',
        1_700_000_000,
        1,
        'draft-v1-key',
      );

      provisionDoSchema(state.storage);

      let legacyRevisionOneRejected = false;
      try {
        sql.exec(
          `INSERT INTO planning_execution_requests (
            id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
            request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
            capability_manifest_json, authority_ceiling_json, status,
            cancellation_generation, created_at, updated_at, protocol_version
          ) VALUES ('execution-v03-invalid', 'owner-v03', 'outcome-v03',
            'work-unit-v03-invalid', 1, 'request-v03-invalid', 'digest-v03', '{}', '{}', '{}',
            '{}', '{}', 'pending', 0, '2026-08-14T00:00:00.000Z',
            '2026-08-14T00:00:00.000Z', '0.3')`,
        );
      } catch {
        legacyRevisionOneRejected = true;
      }

      return {
        version: getSchemaVersion(sql),
        legacyRevisionOneRejected,
        tables: listTables(sql),
        explicitGoalsIndexes: sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'goals' AND name NOT LIKE 'sqlite_autoindex%'",
          )
          .toArray()
          .map((row) => row.name),
        draft: sql
          .exec<{
            user_id: string;
            draft_id: string;
            provider: string;
            created_at: number;
            recipient_count: number;
            idempotency_key: string;
          }>(
            `SELECT user_id, draft_id, provider, created_at, recipient_count, idempotency_key
               FROM drafts
              WHERE user_id = ?`,
            'user-v1',
          )
          .one(),
      };
    });

    expect(result.version).toBe(8);
    expect(result.legacyRevisionOneRejected).toBe(true);
    expect(result.tables).toContain('goals');
    expect(result.explicitGoalsIndexes).toEqual([]);
    expect(result.draft).toEqual({
      user_id: 'user-v1',
      draft_id: 'draft-v1',
      provider: 'gmail',
      created_at: 1_700_000_000,
      recipient_count: 1,
      idempotency_key: 'draft-v1-key',
    });
  });

  it('migrates V2 to the current version without changing existing product state', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      state.storage.sql.exec(
        `INSERT INTO goals (id, user_id, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        'goal-v2', 'owner-v2', 'Preserve this row.', '2026-08-06T00:00:00Z',
        '2026-08-06T00:00:00Z',
      );
      provisionDoSchema(state.storage);
      return {
        version: getSchemaVersion(state.storage.sql),
        description: state.storage.sql.exec<{ description: string }>(
          'SELECT description FROM goals WHERE id = ?', 'goal-v2',
        ).one().description,
      };
    });
    expect(result).toEqual({ version: 8, description: 'Preserve this row.' });
  });

  it('migrates the merged V3 responsibility schema to current without changing responsibility state', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION);

      sql.exec(
        'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
        'owner-v3',
        '2026-08-06T00:00:00.000Z',
      );
      sql.exec(
        'INSERT INTO owner_event_state (root_key, owner_id, high_water_cursor) VALUES (1, ?, 1)',
        'owner-v3',
      );
      sql.exec(
        `INSERT INTO outcomes (
          id, owner_id, revision, user_statement, state, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'captured', ?, ?)`,
        'outcome-v3',
        'owner-v3',
        'Preserve this responsibility.',
        '2026-08-06T00:00:00.000Z',
        '2026-08-06T00:00:00.000Z',
      );
      sql.exec(
        `INSERT INTO owner_domain_events (
          owner_cursor, schema_version, event_id, owner_id, aggregate_kind,
          aggregate_id, revision, event_type, causation_id, correlation_id,
          occurred_at, payload_json
        ) VALUES (1, '0.2', 'event-v3', 'owner-v3', 'outcome', 'outcome-v3',
          1, 'outcome_captured', 'request-v3', 'request-v3',
          '2026-08-06T00:00:00.000Z', '{"outcomeId":"outcome-v3"}')`,
      );
      sql.exec(
        `INSERT INTO responsibility_commands (
          request_id, owner_id, request_digest, result_json, recorded_at
        ) VALUES ('request-v3', 'owner-v3', 'digest-v3', '{"ok":true}',
          '2026-08-06T00:00:00.000Z')`,
      );
      sql.exec(
        `INSERT INTO responsibility_projection (owner_cursor, owner_id, item_json)
         VALUES (1, 'owner-v3', '{"kind":"outcome"}')`,
      );
      sql.exec(
        `INSERT INTO responsibility_projection_state (
          owner_id, snapshot_id, snapshot_base_cursor, updated_at
        ) VALUES ('owner-v3', 'snapshot-v3', 1, '2026-08-06T00:00:00.000Z')`,
      );

      const before = {
        version: getSchemaVersion(sql),
        outcome: sql.exec('SELECT * FROM outcomes').toArray(),
        events: sql.exec('SELECT * FROM owner_domain_events').toArray(),
        commands: sql.exec('SELECT * FROM responsibility_commands').toArray(),
        projection: sql.exec('SELECT * FROM responsibility_projection').toArray(),
        projectionState: sql.exec('SELECT * FROM responsibility_projection_state').toArray(),
      };
      provisionDoSchema(state.storage);
      return {
        before,
        after: {
          version: getSchemaVersion(sql),
          outcome: sql.exec('SELECT * FROM outcomes').toArray(),
          events: sql.exec('SELECT * FROM owner_domain_events').toArray(),
          commands: sql.exec('SELECT * FROM responsibility_commands').toArray(),
          projection: sql.exec('SELECT * FROM responsibility_projection').toArray(),
          projectionState: sql.exec('SELECT * FROM responsibility_projection_state').toArray(),
        },
        authority: sql.exec<{
          authenticated_subject_ref: string | null;
          state: string | null;
          owner_policy_revision: number | null;
          owner_root_routing_version: number | null;
          updated_at: string | null;
        }>(
          `SELECT authenticated_subject_ref, state, owner_policy_revision,
                  owner_root_routing_version, updated_at
             FROM owner_roots WHERE root_key = 1`,
        ).one(),
        presenceCount: sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM presence_registrations',
        ).one().count,
        sessionCount: sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM presence_sessions',
        ).one().count,
      };
    });

    expect(result.before.version).toBe(3);
    expect(result.after).toEqual({ ...result.before, version: 8 });
    expect(result.authority).toEqual({
      authenticated_subject_ref: null,
      state: null,
      owner_policy_revision: null,
      owner_root_routing_version: null,
      updated_at: null,
    });
    expect(result.presenceCount).toBe(0);
    expect(result.sessionCount).toBe(0);
  });

  it('rolls back V3 metadata and all new tables when a legacy name collision is incompatible', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      state.storage.sql.exec('CREATE TABLE outcomes (id TEXT PRIMARY KEY)');
      expect(() => provisionDoSchema(state.storage)).toThrow();
      const tables = listTables(state.storage.sql);
      return {
        version: getSchemaVersion(state.storage.sql),
        v3Tables: tables.filter((table) => [
          'owner_roots', 'owner_event_state', 'outcomes', 'missions',
          'work_units', 'owner_domain_events',
          'responsibility_commands', 'responsibility_projection',
          'responsibility_projection_state',
        ].includes(table)),
      };
    });
    expect(result).toEqual({ version: 2, v3Tables: ['outcomes'] });
  });

  it('rolls back a failed V4 authority upgrade without altering the merged V3 owner root', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION);
      state.storage.sql.exec('CREATE TABLE presence_registrations (id TEXT PRIMARY KEY)');

      expect(() => provisionDoSchema(state.storage)).toThrow();
      return {
        version: getSchemaVersion(state.storage.sql),
        ownerRootColumns: state.storage.sql.exec<{ name: string }>(
          'PRAGMA table_info(owner_roots)',
        ).toArray().map((row) => row.name),
        authorityTables: listTables(state.storage.sql).filter((table) =>
          table === 'presence_registrations' || table === 'presence_sessions'),
        authorityIndexes: state.storage.sql.exec<{ name: string }>(
          `SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'owner_roots_subject_unique'`,
        ).toArray(),
      };
    });

    expect(result).toEqual({
      version: 3,
      ownerRootColumns: ['root_key', 'owner_id', 'created_at'],
      authorityTables: ['presence_registrations'],
      authorityIndexes: [],
    });
  });

  it('migrates V4 WorkUnits to the planning harness without changing captured responsibility data', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_AUTHORITY_SCHEMA_MIGRATION);
      const sql = state.storage.sql;
      sql.exec(
        'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
        'owner-v4', '2026-08-07T00:00:00.000Z',
      );
      sql.exec(
        `INSERT INTO outcomes (
          id, owner_id, revision, user_statement, state, created_at, updated_at
        ) VALUES ('outcome-v4', 'owner-v4', 1, 'Preserve me.', 'captured', ?, ?)`,
        '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z',
      );
      sql.exec(
        `INSERT INTO work_units (
          id, owner_id, outcome_id, mission_id, position, revision, responsibility,
          inputs_json, dependency_ids_json, expected_evidence_json,
          required_capabilities_json, authority_ceiling_json, budget_json,
          isolation_json, stop_conditions_json, assignee, session_ids_json,
          state, created_at, updated_at
        ) VALUES ('work-unit-v4', 'owner-v4', 'outcome-v4', NULL, 0, 1,
          'Prepare a plan.', '[]', '[]', '[]', '[]',
          '{"externalEffects":"none","acceptance":"none","closure":"none"}',
          '{"maxProviderTurns":0,"maxExternalEffects":0,"maxDurationMs":0}',
          '{"mode":"unassigned","egress":"deny_all","credentials":"none"}',
          '[]', NULL, '[]', 'planned', ?, ?)`,
        '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z',
      );

      const before = sql.exec('SELECT * FROM work_units').one();
      provisionDoSchema(state.storage);
      const after = sql.exec('SELECT * FROM work_units').one();
      sql.exec("UPDATE work_units SET state = 'planning_authorized', revision = 2");
      return {
        version: getSchemaVersion(sql),
        preserved: before,
        after,
        newState: sql.exec<{ state: string; revision: number }>(
          'SELECT state, revision FROM work_units',
        ).one(),
      };
    });

    expect(result.version).toBe(8);
    expect(result.after).toEqual(result.preserved);
    expect(result.newState).toEqual({ state: 'planning_authorized', revision: 2 });
  });

  it('rolls back a failed V5 planning upgrade without replacing the V4 WorkUnit table', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_DOMAIN_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_AUTHORITY_SCHEMA_MIGRATION);
      state.storage.sql.exec('CREATE TABLE planning_execution_requests (legacy TEXT)');
      expect(() => provisionDoSchema(state.storage)).toThrow();
      state.storage.sql.exec('PRAGMA ignore_check_constraints = ON');
      const workUnitSql = state.storage.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_units'",
      ).one().sql;
      state.storage.sql.exec('PRAGMA ignore_check_constraints = OFF');
      return {
        version: getSchemaVersion(state.storage.sql),
        workUnitSql,
        legacyColumns: state.storage.sql.exec<{ name: string }>(
          'PRAGMA table_info(planning_execution_requests)',
        ).toArray().map((row) => row.name),
        leakedV5Tables: listTables(state.storage.sql).filter((table) => [
          'planning_agent_sessions', 'planning_execution_leases',
          'planning_provider_invocations', 'work_unit_candidate_plans',
          'work_unit_planning_commands', 'work_unit_planning_controls',
          'work_unit_planning_projection',
        ].includes(table)),
      };
    });
    expect(result.version).toBe(4);
    expect(result.workUnitSql).toContain("state IN ('planned')");
    expect(result.workUnitSql).not.toContain('planning_authorized');
    expect(result.legacyColumns).toEqual(['legacy']);
    expect(result.leakedV5Tables).toEqual([]);
  });

  it('migrates V5 planning rows in place and adds only the v0.4 execution aggregate tables', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionThroughV5(state.storage);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO planning_execution_requests (
          id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
          request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
          capability_manifest_json, authority_ceiling_json, status,
          cancellation_generation, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'execution-v03', 'owner-v03', 'outcome-v03', 'work-unit-v03', 2,
        'request-v03', 'digest-v03', '{"inputs":[]}', '{"category":"provider"}',
        '{"category":"executor"}', '{"version":"v03"}', '{"externalEffects":"none"}',
        'pending', 0, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z',
      );
      const before = sql.exec('SELECT * FROM planning_execution_requests').one();

      provisionDoSchema(state.storage);

      return {
        version: getSchemaVersion(sql),
        before,
        preserved: sql.exec(
          `SELECT id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
                  request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
                  capability_manifest_json, authority_ceiling_json, status,
                  cancellation_generation, created_at, updated_at
             FROM planning_execution_requests WHERE id = 'execution-v03'`,
        ).one(),
        protocolVersion: sql.exec<{ protocol_version: string }>(
          "SELECT protocol_version FROM planning_execution_requests WHERE id = 'execution-v03'",
        ).one().protocol_version,
        executionTables: listTables(sql).filter((table) => [
          'execution_attempts', 'execution_observations', 'execution_reconciliations',
        ].includes(table)),
      };
    });

    expect(result.version).toBe(8);
    expect(result.preserved).toEqual(result.before);
    expect(result.protocolVersion).toBe('0.3');
    expect(result.executionTables).toEqual([
      'execution_attempts', 'execution_observations', 'execution_reconciliations',
    ]);
  });

  it('leaves the legacy runtime_runs substrate byte-stable across V6', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionThroughV5(state.storage);
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE runtime_runs (id TEXT PRIMARY KEY, state_json TEXT NOT NULL)');
      sql.exec(
        'INSERT INTO runtime_runs (id, state_json) VALUES (?, ?)',
        'legacy-run',
        '{"legacy":true}',
      );
      const before = {
        schema: sql.exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_runs'",
        ).one().sql,
        row: sql.exec('SELECT * FROM runtime_runs').one(),
      };
      applyDoMigration(state.storage, RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION);
      return {
        before,
        after: {
          schema: sql.exec<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_runs'",
          ).one().sql,
          row: sql.exec('SELECT * FROM runtime_runs').one(),
        },
      };
    });

    expect(result.after).toEqual(result.before);
  });

  it('rolls back a failed V6 upgrade without altering V5 planning state', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionThroughV5(state.storage);
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE execution_attempts (legacy TEXT)');
      const requestSql = sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'planning_execution_requests'",
      ).one().sql;

      expect(() => provisionDoSchema(state.storage)).toThrow();

      return {
        version: getSchemaVersion(sql),
        requestUnchanged: sql.exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'planning_execution_requests'",
        ).one().sql === requestSql,
        attemptColumns: sql.exec<{ name: string }>('PRAGMA table_info(execution_attempts)')
          .toArray().map((row) => row.name),
        leakedTables: listTables(sql).filter((table) =>
          table === 'execution_observations' || table === 'execution_reconciliations'),
      };
    });

    expect(result).toEqual({
      version: 5,
      requestUnchanged: true,
      attemptColumns: ['legacy'],
      leakedTables: [],
    });
  });

  it('downgrades V6 to exact V5 while only legacy planning rows exist', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionThroughV5(state.storage);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO planning_execution_leases (
          execution_request_id, owner_id, holder_id, fence, cancellation_generation,
          acquired_at, expires_at
        ) VALUES ('execution-v03', 'owner-v03', 'holder-v03', 1, 0, ?, ?)`,
        '2026-08-14T00:00:00.000Z', '2026-08-14T00:05:00.000Z',
      );
      const legacyLease = sql.exec('SELECT * FROM planning_execution_leases').one();
      applyDoMigration(state.storage, RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION, 'down');
      return {
        version: getSchemaVersion(sql),
        lease: sql.exec('SELECT * FROM planning_execution_leases').one(),
        leaseColumns: sql.exec<{ name: string }>('PRAGMA table_info(planning_execution_leases)')
          .toArray().map((row) => row.name),
        executionTables: listTables(sql).filter((table) => [
          'execution_attempts', 'execution_observations', 'execution_reconciliations',
        ].includes(table)),
        legacyLease,
      };
    });

    expect(result.version).toBe(5);
    expect(result.lease).toEqual(result.legacyLease);
    expect(result.leaseColumns).toEqual([
      'execution_request_id', 'owner_id', 'holder_id', 'fence',
      'cancellation_generation', 'acquired_at', 'expires_at',
    ]);
    expect(result.executionTables).toEqual([]);
  });

  it('refuses a V6 downgrade once native execution state exists and preserves that state', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionThroughV6(state.storage);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO execution_attempts (
          id, owner_id, execution_request_id, work_unit_ref_json, attempt_number,
          provider_ref_json, environment_ref_json, lease_id, fencing_generation,
          cancellation_generation, state, created_at, updated_at
        ) VALUES ('attempt-v04', 'owner-v04', 'request-v04', '{}', 1, '{}', '{}',
          'lease-v04', 1, 0, 'queued', ?, ?)`,
        '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z',
      );

      expect(() => applyDoMigration(
        state.storage,
        RESPONSIBILITY_EXECUTION_WRITER_SCHEMA_MIGRATION,
        'down',
      )).toThrow();

      return {
        version: getSchemaVersion(sql),
        attempt: sql.exec<{ id: string }>('SELECT id FROM execution_attempts').one().id,
      };
    });

    expect(result).toEqual({ version: 6, attempt: 'attempt-v04' });
  });

  it('downgrades an empty V7 judgment schema to V6', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      applyDoMigration(state.storage, SCHEDULE_RUNS_SCHEMA_MIGRATION, 'down');
      applyDoMigration(
        state.storage,
        RESPONSIBILITY_JUDGMENT_AUTHORITY_SCHEMA_MIGRATION,
        'down',
      );
      return {
        version: getSchemaVersion(state.storage.sql),
        judgmentTables: listTables(state.storage.sql).filter((table) =>
          table.startsWith('judgment_') || table === 'authority_grants'),
        sessionColumns: state.storage.sql.exec<{ name: string }>(
          'PRAGMA table_info(presence_sessions)',
        ).toArray().map((row) => row.name),
      };
    });

    expect(result.version).toBe(6);
    expect(result.judgmentTables).toEqual([]);
    expect(result.sessionColumns).not.toContain('auth_assurance');
  });

  it('marks pre-V7 sessions non-authorizing until trusted ingress refreshes assurance', async () => {
    const result = await runInDurableObject(freshStub(), (_instance, state) => {
      provisionThroughV6(state.storage);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO owner_roots (
          root_key, owner_id, created_at, authenticated_subject_ref, state,
          owner_policy_revision, owner_root_routing_version, updated_at
        ) VALUES (1, 'owner-v6', ?, 'subject-v6', 'active', 1, 2, ?)`,
        '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z',
      );
      sql.exec(
        `INSERT INTO presence_registrations (
          presence_registration_id, owner_id, presence_id, state, created_at, updated_at
        ) VALUES ('registration-v6', 'owner-v6', 'presence-v6', 'active', ?, ?)`,
        '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z',
      );
      sql.exec(
        `INSERT INTO presence_sessions (
          authenticated_session_id, presence_registration_id, expires_at,
          created_at, last_seen_at
        ) VALUES ('session-v6', 'registration-v6', ?, ?, ?)`,
        '2026-08-17T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z',
      );
      applyDoMigration(state.storage, RESPONSIBILITY_JUDGMENT_AUTHORITY_SCHEMA_MIGRATION);
      return sql.exec<{ auth_assurance: string }>(
        "SELECT auth_assurance FROM presence_sessions WHERE authenticated_session_id = 'session-v6'",
      ).one().auth_assurance;
    });

    expect(result).toBe('legacy_unverified');
  });

  it('refuses V7 downgrade for state in any judgment table and preserves the row', async () => {
    const cases = [
      {
        table: 'judgment_requests',
        insert: `INSERT INTO judgment_requests (
          id, owner_id, revision, subject_kind, subject_id, subject_revision,
          affected_digest, displayed_request_digest, request_json, admission_basis_json,
          state, decision_id, expires_at, created_at, updated_at
        ) VALUES ('request-v7', 'owner-v7', 1, 'work_unit', 'work-unit-v7', 1,
          'sha256:a', 'sha256:b', '{}', '{}', 'open', NULL, ?, ?, ?)`,
        args: ['2026-08-17T00:00:00.000Z', '2026-08-16T00:00:00.000Z',
          '2026-08-16T00:00:00.000Z'],
      },
      {
        table: 'judgment_decisions',
        insert: `INSERT INTO judgment_decisions (
          id, owner_id, judgment_request_id, revision, decision_json, decided_at
        ) VALUES ('decision-v7', 'owner-v7', 'request-v7', 1, '{}', ?)`,
        args: ['2026-08-16T00:00:00.000Z'],
      },
      {
        table: 'authority_grants',
        insert: `INSERT INTO authority_grants (
          id, owner_id, judgment_request_id, judgment_decision_id, revision, grant_json,
          use_limit, uses_consumed, next_use_index, state, expires_at,
          revocation_generation, created_at, updated_at
        ) VALUES ('grant-v7', 'owner-v7', 'request-v7', 'decision-v7', 1, '{}',
          1, 0, 1, 'active', ?, 0, ?, ?)`,
        args: ['2026-08-17T00:00:00.000Z', '2026-08-16T00:00:00.000Z',
          '2026-08-16T00:00:00.000Z'],
      },
      {
        table: 'judgment_commands',
        insert: `INSERT INTO judgment_commands (
          request_id, owner_id, request_digest, result_json, recorded_at
        ) VALUES ('command-v7', 'owner-v7', 'sha256:c', '{}', ?)`,
        args: ['2026-08-16T00:00:00.000Z'],
      },
      {
        table: 'judgment_projection',
        insert: `INSERT INTO judgment_projection (owner_cursor, owner_id, item_json)
          VALUES (1, 'owner-v7', '{}')`,
        args: [],
      },
      {
        table: 'judgment_projection_state',
        insert: `INSERT INTO judgment_projection_state (
          owner_id, snapshot_id, snapshot_base_cursor, updated_at
        ) VALUES ('owner-v7', 'snapshot-v7', 0, ?)`,
        args: ['2026-08-16T00:00:00.000Z'],
      },
    ] as const;

    for (const testCase of cases) {
      const result = await runInDurableObject(freshStub(), (_instance, state) => {
        provisionDoSchema(state.storage);
        state.storage.sql.exec(testCase.insert, ...testCase.args);
        expect(() => applyDoMigration(
          state.storage,
          RESPONSIBILITY_JUDGMENT_AUTHORITY_SCHEMA_MIGRATION,
          'down',
        )).toThrow();
        return {
          version: getSchemaVersion(state.storage.sql),
          rows: state.storage.sql.exec<{ count: number }>(
            `SELECT count(*) AS count FROM ${testCase.table}`,
          ).one().count,
        };
      });
      expect(result).toEqual({ version: 8, rows: 1 });
    }
  });

  it('stores constrained grant-use counters for a future atomic EffectIntent transaction', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO authority_grants (
          id, owner_id, judgment_request_id, judgment_decision_id, revision, grant_json,
          use_limit, uses_consumed, next_use_index, state, expires_at,
          revocation_generation, created_at, updated_at
        ) VALUES ('grant-v7', 'owner-v7', 'request-v7', 'decision-v7', 1, '{}',
          1, 0, 1, 'active', ?, 0, ?, ?)`,
        '2026-08-17T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z',
      );
      expect(() => sql.exec(
        `UPDATE authority_grants
            SET uses_consumed = 1, next_use_index = 1
          WHERE id = 'grant-v7'`,
      )).toThrow();
      return sql.exec<{
        use_limit: number;
        uses_consumed: number;
        next_use_index: number;
        state: string;
      }>(
        `SELECT use_limit, uses_consumed, next_use_index, state
           FROM authority_grants WHERE id = 'grant-v7'`,
      ).one();
    });

    expect(result).toEqual({
      use_limit: 1,
      uses_consumed: 0,
      next_use_index: 1,
      state: 'active',
    });
  });

  it('refuses an unsafe V5 downgrade after planning authorization and preserves all V5 state', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionThroughV5(state.storage);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO owner_roots (root_key, owner_id, created_at)
         VALUES (1, 'owner-v5', '2026-08-07T00:00:00.000Z')`,
      );
      sql.exec(
        `INSERT INTO outcomes (
          id, owner_id, revision, user_statement, state, created_at, updated_at
        ) VALUES ('outcome-v5', 'owner-v5', 1, 'Keep this state.', 'captured', ?, ?)`,
        '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z',
      );
      sql.exec(
        `INSERT INTO work_units (
          id, owner_id, outcome_id, mission_id, position, revision, responsibility,
          inputs_json, dependency_ids_json, expected_evidence_json,
          required_capabilities_json, authority_ceiling_json, budget_json,
          isolation_json, stop_conditions_json, assignee, session_ids_json,
          state, created_at, updated_at
        ) VALUES ('work-unit-v5', 'owner-v5', 'outcome-v5', NULL, 0, 2,
          'Preserve an authorized plan.', '[]', '[]', '[]', '[]',
          '{"externalEffects":"none","acceptance":"none","closure":"none"}',
          '{"maxProviderTurns":0,"maxExternalEffects":0,"maxDurationMs":0}',
          '{"mode":"unassigned","egress":"deny_all","credentials":"none"}',
          '[]', NULL, '[]', 'planning_authorized', ?, ?)`,
        '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z',
      );

      expect(() => applyDoMigration(
        state.storage,
        RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION,
        'down',
      )).toThrow();

      return {
        version: getSchemaVersion(sql),
        workUnit: sql.exec<{ state: string; revision: number }>(
          "SELECT state, revision FROM work_units WHERE id = 'work-unit-v5'",
        ).one(),
        planningTables: listTables(sql).filter((table) => [
          'planning_execution_requests', 'planning_agent_sessions',
          'planning_execution_leases', 'planning_provider_invocations',
          'work_unit_candidate_plans', 'work_unit_planning_commands',
          'work_unit_planning_controls',
          'work_unit_planning_projection',
        ].includes(table)),
      };
    });

    expect(result.version).toBe(5);
    expect(result.workUnit).toEqual({ state: 'planning_authorized', revision: 2 });
    expect(result.planningTables).toHaveLength(8);
  });

  it('names every WorkUnit column in both V5 migration copy directions', () => {
    const copyStatements = [
      ...RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION.up,
      ...RESPONSIBILITY_PLANNING_HARNESS_SCHEMA_MIGRATION.down,
    ].filter((statement) => statement.includes('INSERT INTO work_units'));

    expect(copyStatements).toHaveLength(2);
    for (const statement of copyStatements) {
      expect(statement).toContain('INSERT INTO work_units (');
      expect(statement).not.toMatch(/INSERT INTO work_units\s+SELECT \*/);
      expect(statement).toContain('id, owner_id, outcome_id, mission_id');
      expect(statement).toContain('created_at, updated_at');
    }
  });

  it('keeps the memory-block contract columns needed by Scribe rollback and recall', async () => {
    const stub = freshStub();

    const columns = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      return listProductColumns(state.storage.sql);
    });

    expect(columns).toEqual(
      expect.arrayContaining([
        { table_name: 'memory_blocks', column_name: 'pattern_id' },
        { table_name: 'memory_blocks', column_name: 'rejection_count' },
        { table_name: 'memory_blocks', column_name: 'decision_log' },
        { table_name: 'memory_blocks', column_name: 'rolled_back_from' },
        { table_name: 'memory_blocks', column_name: 'valid_from' },
        { table_name: 'memory_blocks', column_name: 'valid_to' },
        { table_name: 'memory_blocks', column_name: 'superseded_by' },
      ]),
    );
  });

  it('keeps the V2 goal columns required for contract-safe reads', async () => {
    const stub = freshStub();

    const columns = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      return listProductColumns(state.storage.sql).filter(({ table_name }) => table_name === 'goals');
    });

    expect(columns).toEqual([
      { table_name: 'goals', column_name: 'id' },
      { table_name: 'goals', column_name: 'user_id' },
      { table_name: 'goals', column_name: 'description' },
      { table_name: 'goals', column_name: 'baseline' },
      { table_name: 'goals', column_name: 'target' },
      { table_name: 'goals', column_name: 'progress' },
      { table_name: 'goals', column_name: 'deadline' },
      { table_name: 'goals', column_name: 'active' },
      { table_name: 'goals', column_name: 'created_at' },
      { table_name: 'goals', column_name: 'updated_at' },
    ]);
  });

  it('returns typed schema drift when a required column is missing', async () => {
    const stub = freshStub();

    const differences = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      provisionDoSchema(state.storage);
      sql.exec('ALTER TABLE drafts RENAME TO drafts_old;');
      sql.exec(`
        CREATE TABLE drafts (
          user_id          TEXT NOT NULL,
          draft_id         TEXT NOT NULL,
          provider         TEXT NOT NULL,
          created_at       INTEGER NOT NULL,
          sent_at          INTEGER,
          recipient_count  INTEGER NOT NULL,
          PRIMARY KEY (user_id, draft_id)
        );
      `);

      try {
        assertDoSchema(sql);
        return [];
      } catch (error) {
        if (!(error instanceof DoSchemaDriftError)) throw error;
        return error.differences;
      }
    });

    expect(differences).toContainEqual({
      kind: 'missing_column',
      table: 'drafts',
      column: 'idempotency_key',
    });
  });

  it('does not mint raw-health-looking columns in the base schema', async () => {
    const stub = freshStub();

    const forbiddenColumns = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      return listProductColumns(state.storage.sql).filter(({ column_name }) =>
        /(hrv|heart_rate|spo2|weight|blood_pressure|systolic|diastolic|calorie|active_energy)/i.test(
          column_name,
        ),
      );
    });

    expect(forbiddenColumns).toEqual([]);
  });

  it('rolls back a failed migration from fresh storage without retaining bootstrap metadata', async () => {
    const stub = freshStub();

    const result = await runInDurableObject(stub, (_instance, state) => {
      const beforeVersion = getSchemaVersion(state.storage.sql);
      const badMigration: DoMigration = {
        version: 1,
        name: 'intentional-fresh-failure',
        up: [
          'CREATE TABLE transient_fresh_failure_probe (id TEXT PRIMARY KEY);',
          'INSERT INTO missing_table_for_fresh_failure (id) VALUES (1);',
        ],
        down: ['DROP TABLE IF EXISTS transient_fresh_failure_probe;'],
      };

      expect(() => applyDoMigration(state.storage, badMigration)).toThrow();

      const tables = listTables(state.storage.sql);
      return {
        beforeVersion,
        afterVersion: getSchemaVersion(state.storage.sql),
        metadataPresent: tables.includes(DO_SCHEMA_METADATA_TABLE),
        probePresent: tables.includes('transient_fresh_failure_probe'),
      };
    });

    expect(result).toEqual({
      beforeVersion: 0,
      afterVersion: 0,
      metadataPresent: false,
      probePresent: false,
    });
  });

  it('rolls back a failed post-current migration without disturbing responsibility tables', async () => {
    const stub = freshStub();

    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      const beforeVersion = getSchemaVersion(state.storage.sql);
      const badMigration: DoMigration = {
        version: 9,
        name: 'intentional-failure',
        up: [
          'CREATE TABLE transient_failure_probe (id TEXT PRIMARY KEY);',
          'INSERT INTO missing_table_for_failure (id) VALUES (1);',
        ],
        down: ['DROP TABLE IF EXISTS transient_failure_probe;'],
      };

      expect(() => applyDoMigration(state.storage, badMigration)).toThrow();

      return {
        beforeVersion,
        afterVersion: getSchemaVersion(state.storage.sql),
        outcomesPresent: listTables(state.storage.sql).includes('outcomes'),
        probeTables: listTables(state.storage.sql).filter((table) =>
          table.includes('transient_failure_probe'),
        ),
      };
    });

    expect(result).toEqual({
      beforeVersion: 8,
      afterVersion: 8,
      outcomesPresent: true,
      probeTables: [],
    });
  });
});
