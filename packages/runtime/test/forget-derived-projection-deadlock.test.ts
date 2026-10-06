import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';

const at = '2026-10-06T12:00:00Z';
const topic = 'jasmine pearl';

// A derived update card that carries the topic holds the forget, and its documented exit is the purge. The purge used to do nothing while
// coverage was incomplete, and coverage cannot complete while a hold keeps the selector from running, so the hold could never clear.
it('a derived update card holding an incomplete forget is blanked by the purge, so the hold can clear and the selector can run', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('derived-projection-deadlock')), (_i, state) => {
    const sql = state.storage.sql;
    const store = claimStore(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?, ?, ?, ?, 1)', 1, '2026-10-05', JSON.stringify([{ kind: 'note', title: `likes ${topic} tea at six`, keep: 'unrelated card detail' }]), null);
    sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?, ?, ?, ?)', 2, '2026-10-05', JSON.stringify([{ kind: 'note', title: 'standup moved' }]), 'Standup moved to ten');
    store.beginTopicCoverage(topic, at);
    expect(store.forgetSources(topic).incomplete).toBe(true);
    const purge = store.purge([], at, [topic]);
    // Coverage is still not authorised: the purge stays not ready and removes no other store's text.
    expect(purge.ready).toBe(false);
    expect(purge.texts).toEqual([]);
    expect(store.forgetSources(topic).incomplete).toBe(false);
    const rows = sql.exec<{ id: number; changes: string; text: string | null; pushed: number }>('SELECT id, changes, text, pushed FROM update_cards ORDER BY id').toArray();
    expect(rows[0]!.changes).not.toContain(topic);
    expect(rows[0]!.changes).toContain('unrelated card detail');
    expect(rows[0]!.pushed).toBe(1);
    expect(rows[1]).toMatchObject({ text: 'Standup moved to ten', pushed: 0 });
  });
});

it('the early purge removes no claims and keeps the topic pending and incomplete', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('derived-projection-episodes')), (_i, state) => {
    const sql = state.storage.sql;
    const store = claimStore(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?, ?, ?, ?)', 1, '2026-10-05', JSON.stringify([`about ${topic}`]), null);
    store.beginTopicCoverage(topic, at);
    const before = sql.exec<{ n: number }>('SELECT count(*) AS n FROM claims').one().n;
    store.purge([], at, [topic]);
    expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM claims').one().n).toBe(before);
    expect(store.pendingTopics()).toEqual([]);
    expect(store.incompleteTopics()).toEqual([topic]);
  });
});
