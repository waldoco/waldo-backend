import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/tracer/schema';
import type { TracerDO } from '../src/tracer/tracer-do';

let seq = 0;
function freshStub(): DurableObjectStub<TracerDO> {
  seq += 1;
  const id = env.TRACER_DO.idFromName(`schema-migration-${seq}`);
  return env.TRACER_DO.get(id);
}

describe('TracerDO schema migrations', () => {
  it('upgrades legacy budget and class-state tables without dropping counters', async () => {
    const stub = freshStub();

    const migrated = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE class_state;');
      sql.exec('DROP TABLE subkind_state;');
      sql.exec('DROP TABLE daily_push_budget;');
      sql.exec(`
        CREATE TABLE class_state (
          user_id      TEXT NOT NULL,
          push_class   TEXT NOT NULL,
          count        INTEGER NOT NULL DEFAULT 0,
          last_sent_at INTEGER,
          PRIMARY KEY (user_id, push_class)
        );
      `);
      sql.exec(`
        CREATE TABLE subkind_state (
          user_id      TEXT NOT NULL,
          push_class   TEXT NOT NULL,
          sub_kind     TEXT NOT NULL,
          count        INTEGER NOT NULL DEFAULT 0,
          last_sent_at INTEGER,
          PRIMARY KEY (user_id, push_class, sub_kind)
        );
      `);
      sql.exec(`
        CREATE TABLE daily_push_budget (
          user_id     TEXT PRIMARY KEY,
          sends_total INTEGER NOT NULL DEFAULT 0
        );
      `);
      sql.exec(
        `INSERT INTO class_state (user_id, push_class, count, last_sent_at)
         VALUES ('user-legacy', 'fetch_alert', 2, ?)`,
        Date.parse('2026-01-02T10:00:00.000Z'),
      );
      sql.exec(
        `INSERT INTO subkind_state (user_id, push_class, sub_kind, count, last_sent_at)
         VALUES ('user-legacy', 'adjustment', 'proposed', 1, ?)`,
        Date.parse('2026-01-03T11:00:00.000Z'),
      );
      sql.exec(
        "INSERT INTO daily_push_budget (user_id, sends_total) VALUES ('user-legacy', 3)",
      );

      ensureSchema(state.storage);

      const classRow = sql
        .exec<{
          user_id: string;
          local_date: string;
          push_class: string;
          count: number;
          last_sent_at: number;
        }>(
          'SELECT * FROM class_state WHERE user_id = ? AND push_class = ?',
          'user-legacy',
          'fetch_alert',
        )
        .one();
      const subKindRow = sql
        .exec<{
          user_id: string;
          local_date: string;
          push_class: string;
          sub_kind: string;
          count: number;
          last_sent_at: number;
        }>(
          `SELECT *
             FROM subkind_state
            WHERE user_id = ? AND push_class = ? AND sub_kind = ?`,
          'user-legacy',
          'adjustment',
          'proposed',
        )
        .one();
      const budgetRow = sql
        .exec<{
          user_id: string;
          local_date: string;
          sends_total: number;
          exempt_sends: number;
        }>('SELECT * FROM daily_push_budget WHERE user_id = ?', 'user-legacy')
        .one();
      return { classRow, subKindRow, budgetRow };
    });

    expect(migrated.classRow).toEqual({
      user_id: 'user-legacy',
      local_date: '2026-01-02',
      push_class: 'fetch_alert',
      count: 2,
      last_sent_at: Date.parse('2026-01-02T10:00:00.000Z'),
    });
    expect(migrated.subKindRow).toEqual({
      user_id: 'user-legacy',
      local_date: '2026-01-03',
      push_class: 'adjustment',
      sub_kind: 'proposed',
      count: 1,
      last_sent_at: Date.parse('2026-01-03T11:00:00.000Z'),
    });
    expect(migrated.budgetRow).toEqual({
      user_id: 'user-legacy',
      local_date: '1970-01-01',
      sends_total: 3,
      exempt_sends: 0,
    });
  });
});
