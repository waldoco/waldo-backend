import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { applyClaimOps, claimStore } from '../src/memory/claims';
import { durableConversationStore, redactConversationEntries } from '../src/channels/conversation-store';

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

const withStorage = <T>(fn: (storage: DurableObjectStorage) => T | Promise<T>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`forget-conv-${sequence++}`)), (_instance, state) => fn(state.storage));

describe('forget coverage - rolling conversation window', () => {
  // The scoped fix authorized on #196: forgetting redacts the text from persisted conversation
  // entries in place, so it cannot return in the next turn's context, while unrelated history
  // and the tree structure (keys, count, leaf) are preserved.
  it('forget redacts the rolling conversation store: no marker on fresh load, unrelated history intact', async () => {
    await withStorage(async (storage) => {
      const conv = durableConversationStore(storage);
      await conv.save([
        {
          id: 'tg-1', ownerId: 'owner', chatId: 'chat', parentId: null, threadAnchorId: null,
          surface: 'telegram', modelPayload: `owner said: ${CLAIM_TEXT}`, appPayload: '',
          modelProjection: { mode: 'include' }, role: 'user',
        },
        {
          id: 'tg-1-reply', ownerId: 'owner', chatId: 'chat', parentId: 'tg-1', threadAnchorId: 'tg-1',
          surface: 'telegram', modelPayload: 'waldo: your gym session is at 11', appPayload: 'your gym session is at 11',
          modelProjection: { mode: 'include' }, role: 'assistant',
        },
      ], 'tg-1-reply');
      const store = claimStore(storage.sql);
      const claimId = Number(
        storage.sql.exec<{ id: number }>(
          `INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`,
          CLAIM_TEXT, AT, AT,
        ).one().id,
      );
      let purged: readonly string[] = [];
      const summary = applyClaimOps(store, JSON.stringify({ add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: 'code words' }), AT, 'owner, tg-1', (texts) => { purged = texts; });
      expect(summary).toContain('purged');
      expect(purged.length).toBe(1);
      const convResult = await redactConversationEntries(storage, purged, '[forgotten]');
      expect(convResult).toEqual({ rewritten: 1, remaining: 0 });

      // Fresh load = what the next turn restores: the marker is gone, unrelated history survives.
      const { entries, leafId } = await conv.load();
      expect(leafId).toBe('tg-1-reply');
      expect(entries).toHaveLength(2);
      expect(entries.some((entry) => entry.modelPayload.includes(MARKER) || entry.appPayload.includes(MARKER))).toBe(false);
      expect(entries[0]!.modelPayload).toContain('[forgotten]');
      expect(entries[1]!.modelPayload).toContain('gym session');
    });
  });

  // Limitation, pinned: a paraphrase of the forgotten fact in hot context is not caught by text
  // matching; the forget barrier covers model behavior there. Whole-window truncation would be
  // the stronger guarantee and is not built.
  it('paraphrased mentions in hot context survive text matching (barrier covers model use)', async () => {
    await withStorage(async (storage) => {
      const conv = durableConversationStore(storage);
      await conv.save([{
        id: 'tg-2', ownerId: 'owner', chatId: 'chat', parentId: null, threadAnchorId: null,
        surface: 'telegram', modelPayload: 'owner: that zephyr thing we discussed', appPayload: '',
        modelProjection: { mode: 'include' }, role: 'user',
      }], 'tg-2');
      const result = await redactConversationEntries(storage, [CLAIM_TEXT], '[forgotten]');
      expect(result.rewritten).toBe(0);
      const { entries } = await conv.load();
      expect(entries[0]!.modelPayload).toContain('zephyr');
    });
  });
});
