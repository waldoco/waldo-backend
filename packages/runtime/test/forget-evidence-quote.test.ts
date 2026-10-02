import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, FORGOTTEN } from '../src/memory/claims';
import { episodeIndex } from '../src/channels/episodes';

const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const AT = '2026-10-03T00:00:00Z';
const run = <T>(name: string, fn: (sql: SqlStorage, tx: <R>(work: () => R) => R) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => fn(state.storage.sql, (work) => state.storage.transactionSync(work)));

describe('forgetting a claim also redacts the owner words it was grounded on', () => {
  it('redacts the quoted evidence span from retained episodes, not only the claim text', async () => {
    await run('forget-evidence-quote', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      // The claim text is a paraphrase; the owner's own words are what retained history actually holds.
      store.add({ kind: 'fact', text: 'Owner keeps a code word, plum', source: 'stated', evidence: 'owner, tg-1: "my zebra code word is plum"', origin: 'owner' }, AT);
      episodes.add('tg-1', 'owner', 'My Zebra Code Word Is Plum, remember it', 1);
      episodes.add('tg-2', 'owner', 'unrelated lunch plan', 2);
      const id = store.claims()[0]!.id;
      applyClaimOps(store, ops({ forget_claims: [id] }), AT, 'owner, tg-3', undefined, { owner: 'forget my code word' });
      const texts = sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map((r) => r.text);
      expect(texts.join(' ')).not.toMatch(/zebra code word/i);
      expect(texts[0]).toContain(FORGOTTEN);
      expect(texts).toContain('unrelated lunch plan');
    });
  });
  it('ignores a short or unquoted evidence string such as a bare citation', async () => {
    await run('forget-evidence-short', (sql, tx) => {
      const store = claimStore(sql, tx);
      const episodes = episodeIndex(sql);
      store.add({ kind: 'fact', text: 'Owner likes tea', source: 'stated', evidence: 'owner agreed', origin: 'owner' }, AT);
      episodes.add('tg-1', 'owner', 'the owner agreed to lunch', 1);
      const id = store.claims()[0]!.id;
      applyClaimOps(store, ops({ forget_claims: [id] }), AT, 'owner, tg-3', undefined, { owner: 'forget that I like tea' });
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').toArray()[0]!.text).toBe('the owner agreed to lunch');
    });
  });
});
