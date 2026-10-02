import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, FORGOTTEN } from '../src/memory/claims';
import { episodeIndex } from '../src/channels/episodes';

const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const AT = '2026-10-03T00:00:00Z';
const run = <T>(name: string, fn: (sql: SqlStorage, tx: <R>(work: () => R) => R) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));

describe('forgetting a topic whose claim is already gone', () => {
  it('redacts the topic from retained episodes and backs the barrier', async () => {
    await run('forget-topic-redact', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'Posterbot standup moved to 09:10 UTC', 1);
      episodes.add('tg-2', 'owner', 'unrelated lunch plan', 2);
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-3', undefined, undefined, true);
      const texts = sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map((r) => r.text);
      expect(texts.join(' ')).not.toMatch(/posterbot/i);
      expect(texts).toContain('unrelated lunch plan');
      expect(texts[0]).toContain(FORGOTTEN);
      expect(store.barriers().length).toBeGreaterThan(0);
    });
  });
  it('ignores a topic shorter than three characters', async () => {
    await run('forget-topic-short', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'go to the gym at 7', 1);
      applyClaimOps(store, ops({ forget_topic: 'go' }), AT, 'owner, tg-3', undefined, undefined, true);
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').one().text).toBe('go to the gym at 7');
    });
  });
});
