import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, textFingerprint } from '../src/memory/claims';
import { forgetPurge, forgetPurgeDelay, type ForgetStore } from '../src/memory/forget-purge';

const AT = Date.parse('2026-10-22T10:00:00Z');
const run = <T>(name: string, fn: (sql: SqlStorage, tx: <R>(work: () => R) => R) => T | Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), (_i, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));

// A store holding copies of texts; each run removes what it can and reports the rest.
const fakeStore = (name: string, copies: string[], stuck = 0): ForgetStore & { copies: string[] } => {
  let left = stuck;
  return { name, copies, run: (texts) => {
    if (left > 0) { left -= 1; return 1; }
    for (const text of texts) for (let i = copies.length - 1; i >= 0; i -= 1) if (copies[i]!.includes(text)) copies.splice(i, 1);
    return 0;
  } };
};

const setup = (sql: SqlStorage, tx: <R>(work: () => R) => R, stores: readonly ForgetStore[]) => {
  const store = claimStore(sql, tx);
  const armed: number[] = [];
  const events: string[] = [];
  let clock = AT;
  const purge = forgetPurge({ sql, store, stores, now: () => clock, arm: async (at) => { armed.push(at); }, log: (event) => events.push(`${event.hop}:${event.detail}`) });
  return { store, purge, armed, events, advance: (ms: number) => { clock += ms; } };
};

describe('forget purge job', () => {
  it('keeps custody of what a forget must clean and wakes the job, cleaning nothing itself', async () => {
    await run('forget-purge-track', async (sql, tx) => {
      const chat = fakeStore('conversation', ['the tea order']);
      const { store, purge, armed } = setup(sql, tx, [chat]);
      await purge.track(['tea', ' tea ', '']);
      expect(store.pendingTopics()).toEqual(['tea']);
      expect(armed).toEqual([AT]);
      expect(chat.copies).toEqual(['the tea order']);
    });
  });

  it('settles a text once every store reads back clean: custody and steps go, the job does not re-arm', async () => {
    await run('forget-purge-settle', async (sql, tx) => {
      const chat = fakeStore('conversation', ['the tea order', 'standup']);
      const cards = fakeStore('cards', ['tea card']);
      const { store, purge, armed, events } = setup(sql, tx, [chat, cards]);
      await purge.track(['tea']);
      expect(await purge.run()).toEqual({ settled: 1, pending: 0 });
      expect(chat.copies).toEqual(['standup']);
      expect(cards.copies).toEqual([]);
      expect(store.pendingTopics()).toEqual([]);
      expect(sql.exec('SELECT COUNT(*) AS n FROM forget_purge_steps').one().n).toBe(0);
      expect(armed).toEqual([AT]);
      expect(events).toEqual(['forget_settled:topics=1']);
    });
  });

  it('keeps a text held while a store still has copies, records a content-free code and backs off', async () => {
    await run('forget-purge-remaining', async (sql, tx) => {
      const chat = fakeStore('conversation', ['the tea order'], 2);
      const { store, purge, armed, advance } = setup(sql, tx, [chat]);
      await purge.track(['tea']);
      expect(await purge.run()).toEqual({ settled: 0, pending: 1 });
      expect(armed.at(-1)).toBe(AT + forgetPurgeDelay(1));
      expect(sql.exec("SELECT attempts, last_code FROM forget_purge_steps WHERE store = 'conversation'").one()).toEqual({ attempts: 1, last_code: 'remaining' });
      advance(forgetPurgeDelay(1));
      expect(await purge.run()).toEqual({ settled: 0, pending: 1 });
      expect(armed.at(-1)).toBe(AT + forgetPurgeDelay(1) + forgetPurgeDelay(2));
      expect(await purge.run()).toEqual({ settled: 1, pending: 0 });
      expect(store.pendingTopics()).toEqual([]);
    });
  });

  it('a store that throws stays pending with the code failed, never the error text', async () => {
    await run('forget-purge-throws', async (sql, tx) => {
      const broken: ForgetStore = { name: 'imessage', run: () => { throw new Error('could not reach the tea row'); } };
      const { purge } = setup(sql, tx, [broken]);
      await purge.track(['tea']);
      expect(await purge.run()).toEqual({ settled: 0, pending: 1 });
      const row = sql.exec<{ last_code: string }>('SELECT last_code FROM forget_purge_steps').one();
      expect(row.last_code).toBe('failed');
    });
  });

  it('does not settle while the claims table still carries the text, even with every store clean', async () => {
    await run('forget-purge-sql', async (sql, tx) => {
      const { store, purge } = setup(sql, tx, [fakeStore('conversation', [])]);
      // A row the purge cannot rewrite: non-canonical JSON in a redacted store holds the forget open.
      sql.exec("CREATE TABLE IF NOT EXISTS patrol_log (id INTEGER PRIMARY KEY, summary TEXT)");
      sql.exec("INSERT INTO patrol_log (summary) VALUES ('{ \"note\": \"tea\" }')");
      await purge.track(['tea']);
      expect(await purge.run()).toEqual({ settled: 0, pending: 1 });
      expect(store.pendingTopics()).toEqual(['tea']);
    });
  });

  it('takes claims marked for removal: deletes them and holds their words until the stores are clean', async () => {
    await run('forget-purge-purging', async (sql, tx) => {
      const chat = fakeStore('conversation', ['I drink oolong every morning'], 1);
      const { store, purge } = setup(sql, tx, [chat]);
      store.add({ kind: 'preference', text: 'Drinks oolong every morning', evidence: 'oolong', source: 'stated', origin: 'owner' }, new Date(AT).toISOString());
      const id = store.claims()[0]!.id;
      sql.exec("UPDATE claims SET status = 'purging' WHERE id = ?", id);
      expect(await purge.run()).toEqual({ settled: 0, pending: 1 });
      expect(store.allClaims().map((claim) => claim.id)).not.toContain(id);
      expect(store.pendingTopics()).toEqual(['Drinks oolong every morning']);
    });
  });

  it('shows each held topic masked, with its stores, and lets the owner retry it now', async () => {
    await run('forget-purge-status', async (sql, tx) => {
      const { purge, armed } = setup(sql, tx, [fakeStore('conversation', ['x'], 5)]);
      await purge.track(['locker code']);
      await purge.run();
      const [hold] = purge.status();
      expect(hold).toEqual({ fingerprint: textFingerprint('locker code'), label: 'l········ (11)', started_at: new Date(AT).toISOString(), stores: [{ name: 'conversation', state: 'pending', attempts: 1 }] });
      expect(JSON.stringify(purge.status())).not.toContain('locker');
      expect(await purge.retry(hold!.fingerprint)).toBe(true);
      expect(armed.at(-1)).toBe(AT);
      expect(purge.status()[0]!.stores[0]!.attempts).toBe(0);
      expect(await purge.retry('fnv1a:missing')).toBe(false);
    });
  });

  it('backs off from 30 seconds, doubling, to at most an hour', () => {
    expect([0, 1, 2, 3].map(forgetPurgeDelay)).toEqual([30_000, 30_000, 60_000, 120_000]);
    expect(forgetPurgeDelay(40)).toBe(60 * 60_000);
  });
});
