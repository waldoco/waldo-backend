import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_DO_PRODUCT_TABLES,
  DO_PRODUCT_TABLES,
  DoSchemaDriftError,
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
  it('reports an empty DO SQLite database as missing the ten product tables', async () => {
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

  it('provisions exactly the ten HEY-10 product tables and schema metadata', async () => {
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

    expect(result.version).toBe(1);
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

  it('leaves schema version unchanged when a migration fails inside the transaction', async () => {
    const stub = freshStub();

    const result = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
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
