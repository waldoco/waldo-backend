import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { applyClaimOps, barrierPrompt, claimStore, FORGOTTEN, textFingerprint } from '../src/memory/claims';
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
      // Append-only contract: the episode row was redacted in place, never deleted.
      expect(episodes.count()).toBe(1);
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').one().text).not.toContain(MARKER);
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').one().text).toContain(FORGOTTEN);
      // Exact re-admission of the forgotten text is held by the fingerprint, even if the model
      // fails to flag touches_forgotten.
      const relearn = applyClaimOps(store, JSON.stringify({
        add: [{ kind: 'fact', text: CLAIM_TEXT, source: 'stated', evidence: 'owner said so again', touches_forgotten: false }],
        seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null,
      }), AT);
      expect(relearn).toContain('held1');
      expect(store.claims()).toEqual([]);
      // The node survives (it is not forgotten) but no longer quotes the claim or references its id.
      const node = store.nodes().find((row) => row.id === nodeId);
      expect(node).toBeDefined();
      expect(JSON.parse(node!.supporting_spots)).not.toContain(claimId);
      // The barrier blocks re-admission WITHOUT keeping the text: the topic is the marker and
      // the fingerprint is the exact-match guard. Anything else would leak the text back into
      // every model prompt (barriers ride every memory pass).
      expect(store.barriers().map((row) => row.topic)).not.toContain(CLAIM_TEXT);
      expect(store.barriers().map((row) => row.topic)).toContain(FORGOTTEN);
      expect(store.barriers().map((row) => row.topic_hash)).toContain(textFingerprint(CLAIM_TEXT.trim()));
      expect(barrierPrompt(store)).not.toContain(MARKER);
      // Honest reporting: the result says what was purged across stores.
      expect(result).toContain('purged');
    });
  });

  it("a surviving claim's own text and evidence are redacted when they quote the forgotten text", async () => {
    await withSql((sql) => {
      const store = claimStore(sql);
      const forgottenId = Number(
        sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id,
      );
      const otherId = Number(
        sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'confirmed', ?, ?, ?) RETURNING id`,
          'Owner likes morning runs', `chat: "Owner uses the ${MARKER} code word"`, AT, AT).one().id,
      );
      applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [forgottenId], forget_nodes: [], forget_topic: null,
      }), AT);
      const other = store.claims().find((claim) => claim.id === otherId)!;
      expect(other.text).toBe('Owner likes morning runs'); // unrelated claim text survives untouched
      expect(other.evidence).not.toContain(MARKER); // its quote of the forgotten text is redacted
      expect(other.evidence).toContain(FORGOTTEN);
    });
  });

  it('KV-survivor retry: a purge is not settled until the caller KV stores verify clean', async () => {
    await withSql((sql) => {
      const store = claimStore(sql);
      const claimId = Number(
        sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id,
      );
      // The chat/console path hands onPurged to applyClaimOps: SQL verifies (ready ids), the
      // caller KV redaction reports a survivor, so settle is skipped - the source must stay.
      let readyIds: readonly number[] = [];
      applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null,
      }), AT, 'owner, test', (_texts, ids) => { readyIds = ids; });
      expect(readyIds).toEqual([claimId]); // SQL clean, KV pending
      // KV survivor: caller does NOT settle. The claim and its marker survive for retry.
      expect(store.claims('purging').map((claim) => claim.id)).toEqual([claimId]);
      expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM purge_pending WHERE claim_id = ?', claimId).one().n).toBe(1);
      expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM claims WHERE id = ?', claimId).one().n).toBe(1);
      // Retry (KV now clean): purge again (idempotent on already-redacted SQL), then settle.
      const retry = applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null,
      }), AT, 'owner, retry', (_texts, ids) => { readyIds = ids; });
      expect(retry).toContain('purged');
      store.settle(readyIds);
      expect(store.claims()).toEqual([]);
      expect(store.claims('purging')).toEqual([]);
      expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM purge_pending').one().n).toBe(0);
      // Settle is idempotent and never sweeps a re-admitted active row.
      store.settle([claimId]);
    });
  });

  it('rendered console keeps a KV-survivor row visible with a Retry forget action', async () => {
    const { renderConsole } = await import('../src/channels/console');
    const { SAMPLE_CONSOLE_VIEW } = await import('./fixtures/console-sample');
    await withSql((sql) => {
      const store = claimStore(sql);
      const claimId = Number(
        sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id,
      );
      // Force the KV-survivor state: SQL verifies clean, the caller KV step never settles.
      applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null,
      }), AT, 'owner, test', () => undefined);
      expect(store.claims('purging').map((claim) => claim.id)).toEqual([claimId]);
      // The console view the owner sees: the purging row renders with a Retry action and is
      // absent from the active spots list.
      const html = renderConsole({ ...SAMPLE_CONSOLE_VIEW, spots: store.claims(), forgettingSpots: store.claims('purging') });
      expect(html).toContain('Forget in progress (1)');
      expect(html).toContain(CLAIM_TEXT);
      expect(html).toContain('Retry forget');
      expect(html).toContain(`name="id" value="${claimId}"`);
    });
  });

  it('case-variant quoting is redacted too: LIKE matches it, so redaction must as well', async () => {
    await withSql((sql) => {
      const store = claimStore(sql);
      const forgottenId = Number(
        sql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id,
      );
      // A casing variant of the forgotten text in another claim: SQLite LIKE matches it,
      // but a plain replace() would leave it intact while the source claim settles away.
      const variant = CLAIM_TEXT.toUpperCase();
      sql.exec(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', ?, ?, ?)`,
        'Owner likes morning runs', `heard "${variant}" once`, AT, AT);
      const result = applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [forgottenId], forget_nodes: [], forget_topic: null,
      }), AT);
      expect(result).toContain('purged');
      // The variant is gone AND the source settled - no half-forgotten state.
      expect(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM claims WHERE evidence LIKE ?`, `%${variant}%`).one().n).toBe(0);
      expect(sql.exec<{ evidence: string }>(`SELECT evidence FROM claims WHERE text = 'Owner likes morning runs'`).one().evidence).toContain(FORGOTTEN);
      expect(store.claims().map((claim) => claim.id)).not.toContain(forgottenId);
    });
  });

  it('legacy barrier rows with raw topic text are redacted on load and never reach the prompt', async () => {
    await withSql((sql) => {
      // Pre-migration shape: raw topic, no hash. Recreate against a fresh store so the
      // migration in claimStore() runs over it.
      sql.exec('CREATE TABLE IF NOT EXISTS forget_barriers (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, topic_hash TEXT, created_at TEXT NOT NULL)');
      sql.exec(`INSERT INTO forget_barriers (topic, topic_hash, created_at) VALUES (?, NULL, ?)`, `the ${MARKER} topic`, AT);
      const store = claimStore(sql);
      expect(sql.exec<{ topic: string }>('SELECT topic FROM forget_barriers').toArray().map((row) => row.topic)).toEqual([FORGOTTEN]);
      expect(barrierPrompt(store)).not.toContain(MARKER);
      expect(barrierPrompt(store)).toContain('a removed item');
    });
  });

  it('a model-supplied forget_topic is never stored or shown back - barrier holds marker + fingerprint only', async () => {
    await withSql((sql) => {
      const store = claimStore(sql);
      const topic = `the ${MARKER} affair`;
      const result = applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: topic,
      }), AT);
      expect(result).toContain('barrier');
      const rows = sql.exec<{ topic: string; topic_hash: string | null }>('SELECT topic, topic_hash FROM forget_barriers').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.topic).toBe(FORGOTTEN); // never the raw model-supplied words
      expect(rows[0]!.topic_hash).toBe(textFingerprint(topic));
      expect(barrierPrompt(store)).not.toContain(MARKER);
      expect(barrierPrompt(store)).toContain('a removed item');
      // and the fingerprint is what blocks re-admission of the same content
      const second = applyClaimOps(store, JSON.stringify({
        add: [{ kind: 'fact', text: topic, source: 'stated', evidence: 'owner said', touches_forgotten: false }],
        seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null,
      }), AT);
      expect(second).toContain('held1');
      expect(store.claims()).toEqual([]);
      // barrier insert is idempotent on the fingerprint - no duplicate rows
      expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM forget_barriers').toArray()[0]!.n).toBe(1);
    });
  });

  it('a failed purge preserves a durable pending intent and the source text, and a retry resumes to completion', async () => {
    await withSql((rawSql) => {
      let failEpisodes = true;
      const sql = new Proxy(rawSql, {
        get: (target, prop, receiver) => {
          if (prop !== 'exec') return Reflect.get(target, prop, receiver);
          return (query: string, ...args: unknown[]) =>
            (failEpisodes && query.startsWith('UPDATE episodes')) ? (() => { throw new Error('fts locked'); })() : target.exec(query, ...(args as never[]));
        },
      }) as SqlStorage;
      const store = claimStore(sql);
      const claimId = Number(
        rawSql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id,
      );
      episodeIndex(rawSql).add('entry-1', 'owner', `remember: ${CLAIM_TEXT}`, Date.parse(AT));
      const ops = JSON.stringify({ add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null });

      // First pass: episodes fails. The claim leaves the active set but KEEPS its text, and the
      // pending intent is durable - the receipt names the failure honestly.
      const first = applyClaimOps(store, ops, AT);
      expect(first).toContain('purge-incomplete');
      expect(first).toContain('episodes(failed)');
      expect(store.claims()).toEqual([]); // out of the active set
      const midClaim = rawSql.exec<{ status: string; text: string }>('SELECT status, text FROM claims WHERE id = ?', claimId).toArray()[0]!;
      expect(midClaim.status).toBe('purging');
      expect(midClaim.text).toContain(MARKER); // source text preserved for resume
      expect(rawSql.exec<{ n: number }>('SELECT count(*) AS n FROM purge_pending WHERE claim_id = ?', claimId).one().n).toBe(1);

      // Retry (the owner asks again, the model re-lists the same id): the 'purging' claim is
      // still forgettable, redactions are idempotent no-ops, and the purge settles completely.
      failEpisodes = false;
      const second = applyClaimOps(store, ops, AT);
      expect(second).toContain('purged');
      expect(second).not.toContain('purge-incomplete');
      expect(rawSql.exec<{ n: number }>('SELECT count(*) AS n FROM claims WHERE id = ?', claimId).one().n).toBe(0);
      expect(rawSql.exec<{ n: number }>('SELECT count(*) AS n FROM purge_pending').one().n).toBe(0);
      expect(rawSql.exec<{ n: number }>(`SELECT count(*) AS n FROM episodes WHERE episodes MATCH ?`, `"${MARKER}"`).one().n).toBe(0); // failed store now clean
    });
  });

  it('a failed store is named in the receipt and every other store is still cleaned', async () => {
    await withSql((rawSql) => {
      // Force one store to fail: UPDATEs against episodes throw. Purge must continue with the
      // rest and report the failure instead of losing it or aborting half-cleaned silently.
      const sql = new Proxy(rawSql, {
        get: (target, prop, receiver) => {
          if (prop !== 'exec') return Reflect.get(target, prop, receiver);
          return (query: string, ...args: unknown[]) =>
            query.startsWith('UPDATE episodes') ? (() => { throw new Error('fts locked'); })() : target.exec(query, ...(args as never[]));
        },
      }) as SqlStorage;
      const store = claimStore(sql);
      const claimId = Number(
        rawSql.exec<{ id: number }>(`INSERT INTO claims (kind, text, source, evidence, created_at, last_seen_at) VALUES ('fact', ?, 'stated', 'owner said so', ?, ?) RETURNING id`, CLAIM_TEXT, AT, AT).one().id,
      );
      const episodes = episodeIndex(rawSql);
      episodes.add('entry-1', 'owner', `remember: ${CLAIM_TEXT}`, Date.parse(AT));
      const result = applyClaimOps(store, JSON.stringify({
        add: [], seen: [], confirm: [], dismiss: [], forget_claims: [claimId], forget_nodes: [], forget_topic: null,
      }), AT);
      expect(result).toContain('purge-incomplete');
      expect(result).toContain('episodes(failed)');
      expect(store.claims()).toEqual([]); // claims cleanup still happened
      expect(rawSql.exec<{ n: number }>(`SELECT count(*) AS n FROM episodes WHERE episodes MATCH ?`, `"${MARKER}"`).one().n).toBe(1); // the failed store honestly still holds it
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

import { redactToolOutputLedger, toolOutputLedger } from '../src/conversation/tool-output-ledger';

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
  it('forget redacts recent tool-output summaries quoting the text, keeping keys, order and taint', async () => {
    await withStorage(async (storage) => {
      const ledger = toolOutputLedger(storage);
      await ledger.record({ tool: 'gmail_read', ok: true, at: 1, taint: 'external', summary: `mail mentions ${MARKER} twice: ${MARKER}` });
      await ledger.record({ tool: 'web_search', ok: true, at: 2, taint: 'external', summary: 'unrelated hits' });
      const touched = await redactToolOutputLedger(storage, [MARKER], FORGOTTEN);
      expect(touched).toBe(1);
      const recent = await ledger.recent();
      expect(recent).toHaveLength(2);
      expect(recent[0]!.text).not.toContain(MARKER);
      expect(recent[0]!.text).toContain(FORGOTTEN);
      expect(recent[0]!.source.source_taint).toBe('external'); // taint stamps survive redaction
      expect(recent[1]!.text).toContain('unrelated hits'); // unrelated output intact
    });
  });
});
