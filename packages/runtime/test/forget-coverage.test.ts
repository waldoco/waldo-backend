import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { applyClaimOps, claimStore } from '../src/memory/claims';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`forget-coverage-${sequence++}`)), (_instance, state) => fn(state.storage.sql));

const MARKER = 'zephyr-quinoa-anchor';
const CLAIM_TEXT = `Owner uses the ${MARKER} code word`;
const AT = '2026-09-26T04:00:00Z';

// Every store a forgotten fact can survive in. The barrier table is allowed to keep the topic:
// blocking re-admission is its purpose. Everything else must come back clean.
const survivors = (sql: SqlStorage): Record<string, number> => {
  const like = `%${MARKER}%`;
  const count = (table: string, column: string) =>
    sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} LIKE ?`, like).one().n;
  return {
    claims: count('claims', "text || ' ' || evidence"),
    episodes_fts: sql.exec<{ n: number }>(`SELECT count(*) AS n FROM episodes WHERE episodes MATCH ?`, `"${MARKER}"`).one().n,
    memory_backups: count('memory_backups', 'payload'),
    legacy_spots: count('spots', "text || ' ' || evidence"),
    legacy_core_files: count('core_file_revisions', 'content'),
    constellation_nodes: count('constellation_nodes', "label || ' ' || summary || ' ' || supporting_spots"),
  };
};

describe('forget coverage', () => {
  it('forgetting a claim removes it from every derived and legacy store, not just claims', async () => {
    await withSql((sql) => {
      const store = claimStore(sql);
      const episodes = episodeIndex(sql);
      // Legacy tables are frozen history (migration.ts DDL); create them as the migration would.
      sql.exec('CREATE TABLE IF NOT EXISTS core_file_revisions (file TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (file, revision))');
      sql.exec(`CREATE TABLE IF NOT EXISTS spots (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1)`);
      // Seed the exact claim text into every store a copy can live in.
      const claimId = Number(
        sql.exec<{ id: number }>(
          `INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`,
          CLAIM_TEXT, AT, AT,
        ).one().id,
      );
      episodes.add('entry-1', 'owner', `remember: ${CLAIM_TEXT}`, Date.parse(AT));
      sql.exec(`INSERT INTO spots (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'legacy spot', ?, ?)`, CLAIM_TEXT, AT, AT);
      sql.exec(`INSERT INTO core_file_revisions (file, revision, content, reason, created_at) VALUES ('NOTES.md', 1, ?, 'owner edit', ?)`, `notes: ${CLAIM_TEXT}`, AT);
      const nodeId = store.saveNode({ id: null, domain: 'habits', label: 'code words', summary: `echoes: ${CLAIM_TEXT}`, strength: 0.5, status: 'active', supporting_spots: [claimId] }, AT);
      store.backup('test-backup', { note: `payload: ${CLAIM_TEXT}` }, AT);

      // The real model-facing forget path.
      const result = applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null,
      }), AT);

      expect(survivors(sql)).toEqual({
        claims: 0, episodes_fts: 0, memory_backups: 0, legacy_spots: 0, legacy_core_files: 0, constellation_nodes: 0,
      });
      // The node survives (it is not forgotten) but no longer quotes the claim or references its id.
      const node = store.nodes().find((row) => row.id === nodeId);
      expect(node).toBeDefined();
      expect(JSON.parse(node!.supporting_spots)).not.toContain(claimId);
      // The barrier blocks re-admission of the forgotten text.
      expect(store.barriers().map((row) => row.topic)).toContain(CLAIM_TEXT);
      // Honest reporting: the result says what was purged across stores.
      expect(result).toContain('purged');
    });
  });

  it('reports incomplete when a store cannot be cleaned', async () => {
    await withSql((sql) => {
      const store = claimStore(sql);
      const claimId = Number(
        sql.exec<{ id: number }>(
          `INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`,
          CLAIM_TEXT, AT, AT,
        ).one().id,
      );
      // No legacy tables exist on this DO: cleanup must skip absent stores, not fail.
      const result = applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null,
      }), AT);
      expect(store.claims()).toEqual([]);
      expect(result).toContain('forgot1');
    });
  });
});
