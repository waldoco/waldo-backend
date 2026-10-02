import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore } from '../src/memory/claims';
import { episodeIndex } from '../src/channels/episodes';

const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const AT = '2026-10-03T00:00:00Z';
const run = <T>(name: string, fn: (sql: SqlStorage, tx: <R>(work: () => R) => R) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));

describe('a topic-only forget keeps its retry state until the caller settles it', () => {
  it('keeps the evidenced topic pending, retries it on a later turn, and clears it on settle', async () => {
    await run('forget-topic-pending', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'Posterbot standup moved to 09:10 UTC', 1);
      const calls: Array<{ texts: readonly string[]; topics: readonly string[] }> = [];
      const onPurged = (texts: readonly string[], _ids: readonly number[], topics: readonly string[] = []) => { calls.push({ texts, topics }); };
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-2', onPurged, { owner: 'forget Posterbot' });
      // The caller's KV stores did not verify clean, so it does not settle: the topic stays pending.
      expect(store.pendingTopics()).toEqual(['Posterbot']);
      // A copy survives somewhere written after the first pass; a later turn with no forget intent retries the pending topic.
      episodes.add('tg-3', 'owner', 'Posterbot again', 2);
      applyClaimOps(store, ops({}), AT, 'owner, tg-4', onPurged, { owner: 'what is for lunch' });
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').toArray().map((r) => r.text).join(' ')).not.toMatch(/posterbot/i);
      expect(calls.at(-1)?.texts).toEqual(['Posterbot']);
      // Once every store verifies, the caller settles the topic and the plaintext leaves.
      store.settle([], calls.at(-1)!.topics);
      expect(store.pendingTopics()).toEqual([]);
      const before = calls.length;
      applyClaimOps(store, ops({}), AT, 'owner, tg-5', onPurged, { owner: 'hello' });
      expect(calls.length).toBe(before);
    });
  });
  it('without a KV consumer, SQL verification settles the topic at once', async () => {
    await run('forget-topic-pending-nokv', (sql, tx) => {
      const store = claimStore(sql, tx);
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-2', undefined, { owner: 'forget Posterbot' });
      expect(store.pendingTopics()).toEqual([]);
    });
  });
  it('does not redact a topic whose pending row could not be written (custody before destruction)', async () => {
    await run('forget-topic-pending-failwrite', (rawSql, tx) => {
      const sql = new Proxy(rawSql, { get: (target, prop) => {
        if (prop === 'exec') return (query: string, ...bindings: unknown[]) => {
          if (/INSERT OR IGNORE INTO topic_purge_pending/.test(query)) throw new Error('injected sqlite failure');
          return (target.exec as (q: string, ...b: unknown[]) => unknown)(query, ...bindings);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as SqlStorage;
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(rawSql);
      episodes.add('tg-1', 'owner', 'Posterbot standup moved to 09:10 UTC', 1);
      let outcome: { purgeIncomplete: readonly string[] } | undefined;
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-2', undefined, { owner: 'forget Posterbot' }, undefined, (o) => { outcome = o; });
      // The source words are still there, the result is explicitly not complete, and nothing was settled.
      expect(rawSql.exec<{ text: string }>('SELECT text FROM episodes').toArray()[0]!.text).toMatch(/posterbot/i);
      expect(outcome?.purgeIncomplete).toContain('pending_topic(failed)');
    });
  });
});
