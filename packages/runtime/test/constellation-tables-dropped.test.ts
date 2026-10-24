import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyClaimOps, claimStore } from '../src/memory/claims';

// The constellation is retired: opening an owner's memory drops its node and edge tables, and with them the owner text they
// held. Forgetting keeps working without them.
const AT = '2026-10-24T03:00:00Z';
const tables = (sql: SqlStorage) => sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'constellation_%'").toArray().map(row => row.name);

it('opening the store drops both constellation tables and the owner text in them, and a second open is a no-op', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('constellation-drop')), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE constellation_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, label TEXT NOT NULL, summary TEXT NOT NULL, strength REAL NOT NULL, status TEXT NOT NULL, first_seen TEXT NOT NULL, last_confirmed TEXT NOT NULL, supporting_spots TEXT NOT NULL)');
    sql.exec('CREATE TABLE constellation_edges (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, relation TEXT NOT NULL, strength REAL NOT NULL, evidence_count INTEGER NOT NULL, PRIMARY KEY (from_id, to_id, relation))');
    sql.exec("INSERT INTO constellation_nodes (domain, label, summary, strength, status, first_seen, last_confirmed, supporting_spots) VALUES ('sleep', 'Posterbot nights', 'Late Posterbot calls cut sleep', 0.7, 'active', '2026-10-01', '2026-10-02', '[1]')");
    sql.exec("INSERT INTO constellation_edges (from_id, to_id, relation, strength, evidence_count) VALUES (1, 1, 'worsens', 0.5, 2)");
    expect(tables(sql).sort()).toEqual(['constellation_edges', 'constellation_nodes']);

    claimStore(sql, work => state.storage.transactionSync(work));
    expect(tables(sql)).toEqual([]);
    claimStore(sql, work => state.storage.transactionSync(work));
    expect(tables(sql)).toEqual([]);
  });
});

it('an owner\'s forget removes the claim and settles with the constellation tables gone', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('constellation-drop-forget')), (_instance, state) => {
    const sql = state.storage.sql;
    const store = claimStore(sql, work => state.storage.transactionSync(work));
    store.add({ kind: 'fact', text: 'Posterbot standup is at nine', source: 'stated', evidence: 'Posterbot standup is at nine', origin: 'owner', source_ref: 'owner, tg-1' }, AT);
    const purged: { ids: readonly number[]; topics: readonly string[] }[] = [];
    applyClaimOps(store, JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [1], forget_topic: 'Posterbot' }), AT, 'owner, tg-2',
      (_texts, ids, topics = []) => { purged.push({ ids, topics }); }, { owner: 'please forget Posterbot' }, true);
    expect(tables(sql)).toEqual([]);
    expect(purged).toHaveLength(1);
    store.settle(purged[0]!.ids, purged[0]!.topics);
    expect(store.pendingTopics()).toEqual([]);
    expect(store.allClaims().filter(claim => claim.text.includes('Posterbot'))).toEqual([]);
    expect(store.recall('Posterbot')).toEqual([]);
  });
});
