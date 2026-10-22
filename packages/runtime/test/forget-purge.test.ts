import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, FORGOTTEN, textFingerprint } from '../src/memory/claims';
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
  it('keeps custody of what a forget must clean, cleans it at once, and wakes the job only for what remains', async () => {
    await run('forget-purge-track', async (sql, tx) => {
      const chat = fakeStore('conversation', ['the tea order'], 1);
      const { store, purge, armed } = setup(sql, tx, [chat]);
      expect(await purge.track(['tea', ' tea ', ''])).toEqual({ settled: 0, pending: 1 });
      expect(store.pendingTopics()).toEqual(['tea']);
      expect(armed).toEqual([AT + forgetPurgeDelay(1)]);
      expect(chat.copies).toEqual(['the tea order']);
    });
  });

  it('settles a text once every store reads back clean: custody and steps go, the job does not re-arm', async () => {
    await run('forget-purge-settle', async (sql, tx) => {
      const chat = fakeStore('conversation', ['the tea order', 'standup']);
      const cards = fakeStore('cards', ['tea card']);
      const { store, purge, armed, events } = setup(sql, tx, [chat, cards]);
      expect(await purge.track(['tea'])).toEqual({ settled: 1, pending: 0 });
      expect(chat.copies).toEqual(['standup']);
      expect(cards.copies).toEqual([]);
      expect(store.pendingTopics()).toEqual([]);
      expect(sql.exec('SELECT COUNT(*) AS n FROM forget_purge_steps').one().n).toBe(0);
      expect(armed).toEqual([]);
      expect(events).toEqual(['forget_settled:topics=1']);
    });
  });

  it('keeps a text held while a store still has copies, records a content-free code and backs off', async () => {
    await run('forget-purge-remaining', async (sql, tx) => {
      const chat = fakeStore('conversation', ['the tea order'], 2);
      const { store, purge, armed, advance } = setup(sql, tx, [chat]);
      expect(await purge.track(['tea'])).toEqual({ settled: 0, pending: 1 });
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
      expect(await purge.track(['tea'])).toEqual({ settled: 0, pending: 1 });
      const row = sql.exec<{ last_code: string }>('SELECT last_code FROM forget_purge_steps').one();
      expect(row.last_code).toBe('failed');
    });
  });

  it('does not settle an everywhere text while the claims table still carries it, even with every store clean', async () => {
    await run('forget-purge-sql', async (sql, tx) => {
      const { store, purge } = setup(sql, tx, [fakeStore('conversation', [])]);
      // A reminder is the owner's own record, redacted in place; a copy spelled by an escape the redaction cannot reach holds.
      sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL)');
      sql.exec('INSERT INTO reminder_notes (id, note) VALUES (?, ?)', 'r1', String.raw`buy \u0074ea`);
      expect(await purge.track(['tea'], 'everywhere')).toEqual({ settled: 0, pending: 1 });
      expect(store.pendingTopics()).toEqual(['tea']);
    });
  });

  it('a history text (a claim\'s evidence) is cleared from the stores and never deletes a claim that shares it', async () => {
    await run('forget-purge-history', async (sql, tx) => {
      const chat = fakeStore('conversation', ['owner agreed to lunch']);
      const { store, purge } = setup(sql, tx, [chat]);
      store.add({ kind: 'fact', text: 'Eats lunch at one', evidence: 'owner agreed', source: 'stated', origin: 'owner', source_ref: 'owner, tg-1' }, new Date(AT).toISOString());
      expect(await purge.track(['owner agreed'])).toEqual({ settled: 1, pending: 0 });
      expect(chat.copies).toEqual([]);
      expect(store.claims().map((claim) => claim.text)).toEqual(['Eats lunch at one']);
    });
  });

  it('a text tracked as both keeps the wider scope', async () => {
    await run('forget-purge-scope', async (sql, tx) => {
      // A store that never comes clean keeps every text in custody, so the scope can be read.
      const { purge } = setup(sql, tx, [fakeStore('conversation', [], 99)]);
      await purge.track(['tea'], 'everywhere');
      await purge.track(['tea']);
      expect(sql.exec<{ scope: string }>('SELECT scope FROM topic_purge_pending').one().scope).toBe('everywhere');
      await purge.track(['coffee']);
      await purge.track(['coffee'], 'everywhere');
      expect(sql.exec<{ scope: string }>("SELECT scope FROM topic_purge_pending WHERE topic = 'coffee'").one().scope).toBe('everywhere');
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
      const [hold] = purge.status();
      expect(hold).toEqual({ fingerprint: textFingerprint('locker code'), label: 'l········ (11)', started_at: new Date(AT).toISOString(), stores: [{ name: 'conversation', state: 'pending', attempts: 1 }] });
      expect(JSON.stringify(purge.status())).not.toContain('locker');
      expect(await purge.retry(hold!.fingerprint)).toBe(true);
      expect(armed.at(-1)).toBe(AT);
      expect(purge.status()[0]!.stores[0]!.attempts).toBe(0);
      expect(await purge.retry('fnv1a:missing')).toBe(false);
    });
  });

  it('runs a store once with every text it owes, longest first, so a shorter text cannot cut a longer one into a fragment', async () => {
    await run('forget-purge-order', async (sql, tx) => {
      const copies = ['My locker code is Bluefin 4471.'];
      // Fails its first pass, so both texts are owed at once; then redacts them in the order given, as a real store does.
      let passes = 0;
      const chat: ForgetStore = { name: 'conversation', run: (texts) => {
        if (passes++ === 0) throw new Error('store unavailable');
        copies[0] = texts.reduce((text, topic) => text.split(topic).join(FORGOTTEN), copies[0]!);
        return 0;
      } };
      const { purge, advance } = setup(sql, tx, [chat]);
      expect(await purge.track(['Bluefin'], 'everywhere')).toMatchObject({ pending: 1 });
      advance(1_000);
      expect(await purge.track(['Bluefin 4471'])).toMatchObject({ pending: 0 });
      expect(copies[0]).toBe(`My locker code is ${FORGOTTEN}.`);
    });
  });

  it('backs off from 30 seconds, doubling, to at most an hour', () => {
    expect([0, 1, 2, 3].map(forgetPurgeDelay)).toEqual([30_000, 30_000, 60_000, 120_000]);
    expect(forgetPurgeDelay(40)).toBe(60 * 60_000);
  });
});
