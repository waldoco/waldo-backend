import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';

const at = '2026-10-06T12:00:00Z';
const topic = 'jasmine pearl';

// The hold record is what /heldrows prints per topic. A count of 1 for a store that holds many rows hides how big the backlog is.
it('a projection hold reports how many rows hold the forget, not just that one does', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('held-count')), (_i, state) => {
    const sql = state.storage.sql;
    const store = claimStore(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
    for (const n of [1, 2, 3]) sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?, ?, ?, ?)', n, '2026-10-05', JSON.stringify([{ kind: 'note', title: `likes ${topic} tea, card ${n}` }]), null);
    sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?, ?, ?, ?)', 4, '2026-10-05', JSON.stringify([{ kind: 'note', title: 'standup moved' }]), null);
    store.beginTopicCoverage(topic, at);
    expect(store.forgetSources(topic).heldBy).toEqual([{ table: 'update_cards', rule: 'projection', rows: 3 }]);
  });
});
