import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_DO_PRODUCT_TABLES,
  DO_SCHEMA_METADATA_TABLE,
  DO_PRODUCT_TABLES,
  DoSchemaDriftError,
  HEY10_BASE_SCHEMA_MIGRATION,
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

  it('provisions all required product tables and schema metadata at V2', async () => {
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

    expect(result.version).toBe(2);
    expect(result.assertResult.ok).toBe(true);
    for (const table of DO_PRODUCT_TABLES) {
      expect(result.tables).toContain(table);
    }
    expect(result.tables).toContain('do_schema_migrations');

    const productTables = result.tables.filter((table) =>
      (DO_PRODUCT_TABLES as readonly string[]).includes(table),
    );
    expect(productTables).toEqual([...DO_PRODUCT_TABLES].sort());
    for (const deferred of DEFERRED_DO_PRODUCT_TABLES) {
      expect(result.tables).not.toContain(deferred);
    }
  });

  it('migrates an existing V1 database to V2 without changing a V1 row', async () => {
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

      return {
        version: getSchemaVersion(sql),
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

    expect(result.version).toBe(2);
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

  it('rolls back a failed V2-like migration with its metadata version', async () => {
    const stub = freshStub();

    const result = await runInDurableObject(stub, (_instance, state) => {
      applyDoMigration(state.storage, HEY10_BASE_SCHEMA_MIGRATION);
      const beforeVersion = getSchemaVersion(state.storage.sql);
      const badMigration: DoMigration = {
        version: 2,
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
        probeTables: listTables(state.storage.sql).filter((table) =>
          table.includes('transient_failure_probe'),
        ),
      };
    });

    expect(result).toEqual({
      beforeVersion: 1,
      afterVersion: 1,
      probeTables: [],
    });
  });
});
