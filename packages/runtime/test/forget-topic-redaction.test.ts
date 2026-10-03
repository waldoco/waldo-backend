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
    });
  });
});

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

describe('forgetting a claim reaches the turn it came from', () => {
  const claim = (extra: Record<string, unknown>) => ({ kind: 'preference', text: 'Workshop starts at nine', source: 'owner', evidence: 'owner, tg-1', ...extra });
  it('redacts the owner message and Waldo reply of the source turn whole, and nothing else', async () => {
    await run('forget-source-turn', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'I like the workshop early, nine sharp', 1);
      episodes.add('tg-1-reply', 'waldo', 'Saved: mornings at 09:00 for the workshop.', 2);
      episodes.add('tg-2', 'owner', 'unrelated lunch plan', 3);
      episodes.add('tg-4', 'owner', 'does the workshop still start at 09:00?', 4);
      store.add({ ...claim({ origin: 'owner', source_ref: 'owner, tg-1' }) } as never, AT);
      const id = store.claims()[0]!.id;
      let outcome: { sourceTurns?: readonly string[]; sourceTurnEpisodesRedacted?: number } | undefined;
      applyClaimOps(store, ops({ forget_claims: [id] }), AT, 'owner, tg-5', undefined, { owner: 'forget the workshop time' }, true, (o) => { outcome = o; });
      const rows = sql.exec<{ entry_id: string; text: string }>('SELECT entry_id, text FROM episodes ORDER BY rowid').toArray();
      expect(rows.find((r) => r.entry_id === 'tg-1')!.text).toBe(FORGOTTEN);
      expect(rows.find((r) => r.entry_id === 'tg-1-reply')!.text).toBe(FORGOTTEN);
      expect(rows.find((r) => r.entry_id === 'tg-2')!.text).toBe('unrelated lunch plan');
      expect(rows.find((r) => r.entry_id === 'tg-4')!.text).toContain('09:00');
      expect(outcome?.sourceTurns).toEqual(['tg-1']);
      expect(outcome?.sourceTurnEpisodesRedacted).toBe(2);
    });
  });
  it('does not follow a claim that is not owner-origin, or a claim the forget did not name', async () => {
    await run('forget-source-turn-gate', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', 'agent-origin turn text', 1);
      episodes.add('tg-2', 'owner', 'other owner turn text', 2);
      store.add({ ...claim({ source_ref: 'owner, tg-1' }) } as never, AT);
      store.add({ ...claim({ text: 'Second claim', origin: 'owner', source_ref: 'owner, tg-2' }) } as never, AT);
      const first = store.claims().find((c) => c.text === 'Workshop starts at nine')!.id;
      applyClaimOps(store, ops({ forget_claims: [first] }), AT, 'owner, tg-5', undefined, { owner: 'forget the workshop time' }, true);
      const texts = sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map((r) => r.text);
      expect(texts).toEqual(['agent-origin turn text', 'other owner turn text']);
    });
  });
});

