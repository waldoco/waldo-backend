import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';

const owner = (name: string) => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
const base = { kind: 'preference', source: 'stated', evidence: 'synthetic owner turn', origin: 'owner', source_ref: 'owner, alias-fixture' };
const AT = '2026-10-02T00:00:00Z';

describe('write-time claim aliases', () => {
  it('an alias is found by recall when the question shares no word with the claim text', async () => {
    await runInDurableObject(owner('alias-recall'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ ...base, text: 'Sleeps at eleven thirty', aliases: ['bedtime', 'lights out'] }, AT);
      store.add({ ...base, text: 'Takes the metro to work', aliases: ['commute'] }, AT);
      expect(store.recall('When is my bedtime?').map((c) => c.text)).toEqual(['Sleeps at eleven thirty']);
      expect(store.recall('What time is lights out').map((c) => c.text)).toEqual(['Sleeps at eleven thirty']);
      expect(store.recall('How is my commute?').map((c) => c.text)).toEqual(['Takes the metro to work']);
    });
  });

  it('aliases are bounded and cleaned: at most 5, 3 to 40 characters, letters digits spaces and hyphens only, no duplicates', async () => {
    await runInDurableObject(owner('alias-bounds'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ ...base, text: 'Fact one', aliases: ['alpha', 'ALPHA', 'be', 'x'.repeat(41), 'bad"quote', 'NEAR(a b)', 'one-two', 'three', 'four', 'five', 'six', 'seven'] }, AT);
      const row = state.storage.sql.exec<{ aliases: string | null }>('SELECT aliases FROM claims').one();
      expect(row.aliases!.split(' / ')).toEqual(['alpha', 'one-two', 'three', 'four', 'five']);
    });
  });

  it('a claim with no aliases behaves as before', async () => {
    await runInDurableObject(owner('alias-none'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ ...base, text: 'Likes green tea' }, AT);
      expect(store.recall('green tea').map((c) => c.text)).toEqual(['Likes green tea']);
      expect(state.storage.sql.exec<{ aliases: string | null }>('SELECT aliases FROM claims').one().aliases).toBeNull();
    });
  });

  it('an old FTS table without the aliases column is rebuilt in place with its rows still searchable', async () => {
    await runInDurableObject(owner('alias-migrate'), (_i, state) => {
      const sql = state.storage.sql;
      claimStore(sql, (work) => state.storage.transactionSync(work)).add({ ...base, text: 'Runs on Sundays' }, AT);
      for (const t of ['insert', 'delete', 'update']) sql.exec(`DROP TRIGGER claim_recall_${t}`);
      sql.exec('DROP TABLE claim_recall'); sql.exec('DROP TABLE claim_recall_ready');
      sql.exec("CREATE VIRTUAL TABLE claim_recall USING fts5(text, content='claims', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2')");
      const store = claimStore(sql, (work) => state.storage.transactionSync(work));
      store.add({ ...base, text: 'Eats lunch at one', aliases: ['midday meal'] }, AT);
      expect(store.recall('Sundays').map((c) => c.text)).toEqual(['Runs on Sundays']);
      expect(store.recall('midday meal').map((c) => c.text)).toEqual(['Eats lunch at one']);
    });
  });

  it('a corrected claim keeps its new aliases and the superseded claim stops matching them', async () => {
    await runInDurableObject(owner('alias-correct'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ ...base, text: 'Gym at six', aliases: ['workout'] }, AT);
      const old = store.claims()[0]!.id;
      expect(store.correct(old, { ...base, text: 'Gym at seven', aliases: ['workout'] }, AT)).toBe(true);
      expect(store.recall('workout').map((c) => c.text)).toEqual(['Gym at seven']);
    });
  });

  it('purging a claim removes its aliases from the index, and a surviving claim that quotes the forgotten text in its aliases is redacted', async () => {
    await runInDurableObject(owner('alias-purge'), (_i, state) => {
      const sql = state.storage.sql;
      const store = claimStore(sql, (work) => state.storage.transactionSync(work));
      store.add({ ...base, text: 'Takes medication zebracillin daily', aliases: ['pills'] }, AT);
      store.add({ ...base, text: 'Likes quiet mornings', aliases: ['takes medication zebracillin daily'] }, AT);
      const target = store.claims().find((c) => c.text.includes('zebracillin'))!.id;
      const purge = store.purge([target], AT);
      expect(purge.ready).toBe(true);
      store.settle([target]);
      expect(store.recall('pills')).toEqual([]);
      expect(store.recall('zebracillin')).toEqual([]);
      expect(sql.exec<{ aliases: string }>("SELECT aliases FROM claims WHERE text = 'Likes quiet mornings'").one().aliases).toBe('[forgotten]');
      expect(sql.exec("SELECT count(*) AS n FROM claims WHERE aliases LIKE '%zebracillin%' OR text LIKE '%zebracillin%'").one()).toEqual({ n: 0 });
    });
  });
});

describe('aliases through the claim admission gate', () => {
  const AT2 = '2026-10-01T00:00:00.000Z';
  const SAID = 'I usually go to bed around eleven thirty';
  const ops = (add: unknown[], forgetTopic: string | null = null) => JSON.stringify({ add, seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: forgetTopic });
  it('model-written aliases are stored cleaned and make the claim findable by a synonym', async () => {
    const { applyClaimOps, turnMemoryPrompt } = await import('../src/memory/claims');
    await runInDurableObject(owner('alias-admit'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      applyClaimOps(store, ops([{ kind: 'routine', text: 'Goes to bed around 11:30pm', source: 'stated', evidence: `owner, tg-1: "${SAID}"`, touches_forgotten: false, aliases: ['bedtime', 'lights out', 'bad"quote', 'be'] }]), AT2, 'owner agreed', undefined, { owner: SAID });
      expect(state.storage.sql.exec<{ aliases: string }>('SELECT aliases FROM claims').one().aliases).toBe('bedtime / lights out');
      // Recall by question moved out of the turn prompt into the read_memory tool; the store still finds the claim by its alias.
      expect(store.recall('bedtime', 8).map((claim) => claim.text)).toEqual(['Goes to bed around 11:30pm']);
      expect(turnMemoryPrompt(store, 'what is my bedtime?')).not.toContain('lights out');
    });
  });
  it('a claim that touches a forgotten topic is held with its aliases, and an alias equal to a forgotten topic is dropped', async () => {
    const { applyClaimOps } = await import('../src/memory/claims');
    await runInDurableObject(owner('alias-admit-forget'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.barrier('zebracillin', AT2);
      applyClaimOps(store, ops([
        { kind: 'routine', text: 'Goes to bed around 11:30pm', source: 'stated', evidence: `owner, tg-1: "${SAID}"`, touches_forgotten: false, aliases: ['zebracillin', 'bedtime'] },
        { kind: 'fact', text: 'Held claim', source: 'stated', evidence: `owner, tg-1: "${SAID}"`, touches_forgotten: true, aliases: ['should-not-appear'] },
      ]), AT2, 'owner agreed', undefined, { owner: SAID });
      expect(state.storage.sql.exec<{ text: string; aliases: string }>('SELECT text, aliases FROM claims').toArray()).toEqual([{ text: 'Goes to bed around 11:30pm', aliases: 'bedtime' }]);
    });
  });
  it('aliases the writer flags as touching a forgotten topic are dropped while the claim itself is kept', async () => {
    const { applyClaimOps } = await import('../src/memory/claims');
    await runInDurableObject(owner('alias-touch-forgotten'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      applyClaimOps(store, ops([{ kind: 'routine', text: 'Goes to bed around 11:30pm', source: 'stated', evidence: `owner, tg-1: "${SAID}"`, touches_forgotten: false, aliases_touch_forgotten: true, aliases: ['bedtime after zebracillin'] }]), AT2, 'owner agreed', undefined, { owner: SAID });
      expect(state.storage.sql.exec<{ text: string; aliases: string | null }>('SELECT text, aliases FROM claims').toArray()).toEqual([{ text: 'Goes to bed around 11:30pm', aliases: null }]);
    });
  });
  it('an alias that equals a forgotten topic in other casing or spacing is dropped', async () => {
    const { applyClaimOps } = await import('../src/memory/claims');
    await runInDurableObject(owner('alias-case'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.barrier('zebracillin', AT2);
      applyClaimOps(store, ops([{ kind: 'routine', text: 'Goes to bed around 11:30pm', source: 'stated', evidence: `owner, tg-1: "${SAID}"`, touches_forgotten: false, aliases: ['ZEBRACILLIN', ' Zebracillin ', 'zebra  cillin', 'bedtime'] }]), AT2, 'owner agreed', undefined, { owner: SAID });
      expect(state.storage.sql.exec<{ aliases: string }>('SELECT aliases FROM claims').one().aliases).toBe('zebra cillin / bedtime');
    });
  });

  it('drops aliases that match a capitalised barrier topic', async () => {
    const { applyClaimOps } = await import('../src/memory/claims');
    await runInDurableObject(owner('alias-capital-barrier'), (_i, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.barrier('Zebracillin', AT2);
      applyClaimOps(store, ops([{ kind: 'routine', text: 'Goes to bed around 11:30pm', source: 'stated', evidence: `owner, tg-1: "${SAID}"`, touches_forgotten: false, aliases: ['zebracillin', 'Zebra  Cillin', 'bedtime'] }]), AT2, 'owner agreed', undefined, { owner: SAID });
      expect(state.storage.sql.exec<{ aliases: string }>('SELECT aliases FROM claims').one().aliases).toBe('zebra cillin / bedtime');
    });
  });
});
