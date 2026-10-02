import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, FORGOTTEN, MEMORY_INSTRUCTION } from '../src/memory/claims';
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
  it('ignores a writer-invented topic that is not in the owner words of the turn', async () => {
    await run('forget-topic-invented', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'Posterbot standup moved to 09:10 UTC', 1);
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-3', undefined, { owner: 'please forget my lunch order' });
      const texts = sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map((r) => r.text);
      expect(texts.join(' ')).toMatch(/posterbot/i);
      expect(store.barriers().length).toBe(0);
    });
  });
  it('still forgets a topic the owner named, in any casing', async () => {
    await run('forget-topic-named', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'Posterbot standup moved to 09:10 UTC', 1);
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-3', undefined, { owner: 'Forget POSTERBOT please' });
      const texts = sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map((r) => r.text);
      expect(texts.join(' ')).not.toMatch(/posterbot/i);
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

describe('forgetting by the exact identifier the owner named', () => {
  it('tells the writer to keep an owner-named literal as forget_topic', () => {
    expect(MEMORY_INSTRUCTION).toContain('when the owner names an exact code, id or phrase to forget, forget_topic is that text exactly as the owner wrote it');
  });
  it('a literal marker topic cleans the request and the assistant reply that repeated it', async () => {
    await run('forget-topic-literal', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'Remember workshop note DLD-20261002-M3 is Friday', 1);
      episodes.add('tg-1-reply', 'waldo', 'Saved: workshop note DLD-20261002-M3 is Friday.', 2);
      episodes.add('tg-2', 'owner', 'unrelated lunch plan', 3);
      applyClaimOps(store, ops({ forget_topic: 'DLD-20261002-M3' }), AT, 'owner, tg-3', undefined, { owner: 'forget everything about DLD-20261002-M3' });
      const texts = sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map((r) => r.text);
      expect(texts.join(' ')).not.toContain('DLD-20261002-M3');
      expect(texts).toContain('unrelated lunch plan');

describe('the forget outcome counts the episodes it redacted', () => {
  it('reports how many retained episode rows a topic forget cleaned', async () => {
    await run('forget-topic-count', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'Posterbot standup moved', 1);
      episodes.add('tg-1-reply', 'waldo', 'Noted: Posterbot standup moved.', 2);
      episodes.add('tg-2', 'owner', 'unrelated lunch plan', 3);
      let episodesRedacted: number | undefined;
      applyClaimOps(store, ops({ forget_topic: 'Posterbot' }), AT, 'owner, tg-3', undefined, { owner: 'forget Posterbot' }, true, (outcome) => { episodesRedacted = outcome.episodesRedacted; });
      expect(episodesRedacted).toBe(2);
    });
  });
});

