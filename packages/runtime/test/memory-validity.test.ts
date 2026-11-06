import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, CLAIM_OPS_SCHEMA, RETIRE_RULES, withoutBringUpLess } from '../src/memory/claims';
import { recallForTurn } from '../src/memory/turn-recall';
import { memoryHandlers } from '../src/tools/live/memory';
import { outsideView } from '../src/memory/outside-view';

let sequence = 0;
const withStore = <T>(fn: (store: ReturnType<typeof claimStore>, sql: SqlStorage) => T | Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`validity-${sequence++}`)), (_instance, state) => fn(claimStore(state.storage.sql, work => state.storage.transactionSync(work)), state.storage.sql));
const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], retire: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, ...partial });
const T1 = '2026-09-01T09:00:00.000Z', T2 = '2026-10-12T21:00:00.000Z';
const owned = (text: string, ref = 'owner, chat-1') => ({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: ref });
const ids = (store: ReturnType<typeof claimStore>) => Object.fromEntries(store.allClaims().map(claim => [claim.text, claim]));

describe('valid_from', () => {
  it('is written when a claim is created, by add and by a correction\'s replacement', () => withStore(store => {
    store.add(owned('Lives in Leeds'), T1);
    const old = store.claims()[0]!;
    expect(old.valid_from).toBe(T1);
    expect(store.correct(old.id, { ...owned('Lives in Pune') }, T2)).toBe(true);
    const all = ids(store);
    expect(all['Lives in Pune']).toMatchObject({ valid_from: T2, supersedes_id: old.id, status: 'active' });
    expect(all['Lives in Leeds']).toMatchObject({ valid_from: T1, valid_to: T2, status: 'superseded' });
  }));
});

describe('the nightly retires a contradicted claim', () => {
  const day = 'Owner: I left Acme in October, I work at Globex now.';
  const grounding = { owner: day };
  const retire = (over: Record<string, unknown> = {}) => ops({ retire: [{ id: 1, replaced_by_text: 'Works at Globex', evidence: 'I left Acme in October', ...over }], add: [{ kind: 'fact', text: 'Works at Globex', source: 'stated', evidence: 'I work at Globex now', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }] });
  const seed = (store: ReturnType<typeof claimStore>) => store.add(owned('Works at Acme'), T1);

  it('ends the old claim with valid_to, links its replacement, and deletes nothing', () => withStore(store => {
    seed(store);
    applyClaimOps(store, retire(), T2, 'owner, day', undefined, grounding, false, undefined, false, true);
    const all = ids(store);
    expect(all['Works at Acme']).toMatchObject({ status: 'superseded', valid_to: T2 });
    expect(all['Works at Globex']).toMatchObject({ status: 'active', supersedes_id: all['Works at Acme']!.id });
    expect(store.claims().map(claim => claim.text)).toEqual(['Works at Globex']);
  }));

  it('retires with no replacement when nothing replaces it', () => withStore(store => {
    seed(store);
    applyClaimOps(store, ops({ retire: [{ id: 1, replaced_by_text: null, evidence: 'I left Acme in October' }] }), T2, 'owner, day', undefined, grounding, false, undefined, false, true);
    expect(ids(store)['Works at Acme']).toMatchObject({ status: 'superseded', valid_to: T2 });
    expect(store.claims()).toEqual([]);
  }));

  it('does nothing when the switch is off, the quote is not the owner\'s, or the pass has no owner words', () => withStore(store => {
    seed(store);
    applyClaimOps(store, retire(), T2, 'owner, day', undefined, grounding, false, undefined, false, false);
    expect(store.claims().map(claim => claim.text)).toContain('Works at Acme');
    applyClaimOps(store, retire({ evidence: 'a quote the owner never said' }), T2, 'owner, day', undefined, grounding, false, undefined, false, true);
    expect(ids(store)['Works at Acme']!.status).toBe('active');
    applyClaimOps(store, retire(), T2, 'outside content', undefined, { shared: 'Mail: Alice left Acme in October, I left Acme in October', outside: true } as never, false, undefined, false, true);
    expect(ids(store)['Works at Acme']!.status).toBe('active');
  }));

  it('does not retire a claim that is not live, and leaves a claim the model also corrected to the correction', () => withStore(store => {
    seed(store);
    store.setStatus(1, 'dismissed');
    applyClaimOps(store, ops({ retire: [{ id: 1, replaced_by_text: null, evidence: 'I left Acme in October' }, { id: 999, replaced_by_text: null, evidence: 'I left Acme in October' }] }), T2, 'owner, day', undefined, grounding, false, undefined, false, true);
    expect(ids(store)['Works at Acme']!.status).toBe('dismissed');
  }));

  it('never links an untrusted or agent claim as the replacement of an owner claim, so forgetting it leaves the owner\'s row alone', () => withStore(store => {
    seed(store);
    store.add({ ...owned('Works at Globex'), origin: 'untrusted', source: 'inferred', evidence: 'a shared page' }, T1);
    applyClaimOps(store, ops({ retire: [{ id: 1, replaced_by_text: 'Works at Globex', evidence: 'I left Acme in October' }] }), T2, 'owner, day', undefined, grounding, false, undefined, false, true);
    const all = ids(store);
    expect(all['Works at Acme']).toMatchObject({ status: 'superseded', valid_to: T2 });
    expect(all['Works at Globex']!.supersedes_id).toBeNull();
    store.purge([all['Works at Globex']!.id], T2);
    expect(ids(store)['Works at Acme']).toMatchObject({ status: 'superseded' });
    expect(store.lineage([all['Works at Globex']!.id])).toEqual([all['Works at Globex']!.id]);
  }));

  it('the store itself refuses the link unless the replacement is the owner\'s', () => withStore(store => {
    seed(store);
    store.add({ ...owned('Works at Globex'), origin: 'agent', source: 'inferred' }, T1);
    store.retire(1, T2, 2);
    expect(ids(store)['Works at Globex']!.supersedes_id).toBeNull();
  }));

  it('is offered to the model as a schema field and as rules that keep the old claim as history', () => {
    expect(CLAIM_OPS_SCHEMA.required).toContain('retire');
    expect(RETIRE_RULES.join(' ')).toMatch(/never what only a mail/);
  });
});

describe('what used to be true', () => {
  const held = () => false;
  const seedHistory = (store: ReturnType<typeof claimStore>) => {
    store.add(owned('Lives in Leeds'), T1);
    store.correct(store.claims()[0]!.id, owned('Lives in Pune'), T2);
  };

  it('recall adds a dated line marked no longer true only when asked for, and holds still withhold it', () => withStore(async store => {
    seedHistory(store);
    const asked = { claims: store, question: 'where did I live in Leeds before', room: 4000, holds: held };
    expect((await recallForTurn(asked)).text).not.toContain('Leeds');
    const text = (await recallForTurn({ ...asked, replaced: true })).text;
    expect(text).toContain('NO LONGER TRUE');
    expect(text).toContain('held until 2026-10-12');
    expect(text).toContain('since 2026-09-01');
    expect(text).toContain('Leeds');
    expect((await recallForTurn({ ...asked, replaced: true, holds: (...values) => values.some(value => typeof value === 'string' && value.includes('Leeds')) })).text).not.toContain('Leeds');
  }));

  it('never comes back from an outside-content view when the earlier claim was health', () => withStore(store => {
    store.add({ ...owned('Resting heart rate 51 bpm'), kind: 'health' }, T1);
    store.retire(1, T2);
    expect(store.recallReplaced('resting heart rate')).toHaveLength(1);
    expect(outsideView(store).recallReplaced('resting heart rate')).toEqual([]);
    expect(outsideView(store).replacedClaims(5)).toEqual([]);
  }));

  it('read_memory returns the replaced facts, with their dates, only when the model asks and the deployment offers it', () => withStore(async (store, sql) => {
    seedHistory(store);
    const read = async (validity: boolean, args: object) => {
      const tool = memoryHandlers({ sql, store, conversationRef: 'app:main', hideHistory: async () => undefined, ...(validity ? { validity } : {}) }).find(handler => handler.name === 'read_memory')!;
      const result = await tool.handle({ limit: 10, ...args } as never, {} as never) as { ok: boolean; data: { claims: { text: string; valid_to: string | null }[] } };
      return result.data.claims;
    };
    expect((await read(true, { query: 'leeds' })).map(claim => claim.text)).toEqual([]);
    expect((await read(true, { query: 'leeds', include_replaced: true })).map(claim => [claim.text, claim.valid_to])).toEqual([['Lives in Leeds', T2]]);
    expect((await read(true, { include_replaced: true })).map(claim => claim.text).sort()).toEqual(['Lives in Leeds', 'Lives in Pune']);
    expect((await read(false, { query: 'leeds', include_replaced: true })).map(claim => claim.text)).toEqual([]);
    expect(Object.keys((await read(false, { query: 'pune' }))[0]!)).not.toContain('valid_to');
    expect(Object.keys((await read(true, { query: 'pune' }))[0]!)).toEqual(expect.arrayContaining(['valid_from', 'valid_to']));
  }));
});

describe('replaced rows nothing points to are forget leftovers', () => {
  it('a replaced row whose newer version is gone is never shown as history, while a retired claim with no successor still is', () => withStore((store, sql) => {
    store.add(owned('Lives in Leeds'), T1);
    store.correct(1, owned('Lives in Pune'), T2);
    store.add(owned('Plays squash on Fridays'), T1);
    store.retire(3, T2);
    expect(store.recallReplaced('leeds')).toHaveLength(1);
    sql.exec('DELETE FROM claims WHERE id = 2');
    expect(store.recallReplaced('leeds')).toEqual([]);
    expect(store.replacedClaims(5).map(claim => claim.text)).toEqual(['Plays squash on Fridays']);
    expect(store.recallReplaced('squash').map(claim => claim.text)).toEqual(['Plays squash on Fridays']);
  }));
});

describe('forgetting a topic forgets the versions its claims replaced', () => {
  it('a topic purge that deletes the newer claim takes the retired earlier one too, so nothing resurfaces', () => withStore(store => {
    store.add(owned('Works at Acme'), T1);
    store.add(owned('Works at Globex'), T1);
    store.retire(1, T2, 2);
    expect(store.recallReplaced('acme')).toHaveLength(1);
    store.purge([], '2026-10-13T00:00:00.000Z', ['Globex']);
    expect(store.allClaims()).toEqual([]);
    expect(store.recallReplaced('acme')).toEqual([]);
    expect(store.replacedClaims(5)).toEqual([]);
  }));
});

describe('a turn that speaks unprompted', () => {
  it('is not told what used to be true about a note the owner asked Waldo to bring up less', () => withStore(store => {
    store.add(owned('Works at Acme'), T1);
    store.add(owned('Plays squash on Fridays'), T1);
    store.bringUpLess(1, T1, true);
    store.retire(1, T2);
    store.retire(2, T2);
    expect(store.recallReplaced('acme')).toHaveLength(1);
    expect(withoutBringUpLess(store).recallReplaced('acme')).toEqual([]);
    expect(withoutBringUpLess(store).recallReplaced('squash')).toHaveLength(1);
    expect(withoutBringUpLess(store).replacedClaims(5).map(claim => claim.text)).toEqual(['Plays squash on Fridays']);
  }));
});

describe('forgetting a claim forgets the versions it replaced', () => {
  const history = (store: ReturnType<typeof claimStore>) => {
    store.add(owned('Allergic to cobalt'), T1);
    store.correct(store.claims()[0]!.id, owned('Allergic to cobalt-11 resin'), T2);
    return ids(store)['Allergic to cobalt-11 resin']!;
  };
  it('a purge of the claim takes the earlier versions with it', () => withStore(store => {
    const now = history(store);
    expect(store.recallReplaced('cobalt')).toHaveLength(1);
    store.purge([now.id], '2026-10-13T00:00:00.000Z');
    expect(store.recallReplaced('cobalt')).toEqual([]);
    expect(store.claims()).toEqual([]);
  }));
  it('the forget tool, which deletes before it purges, takes them too', () => withStore(async (store, sql) => {
    const now = history(store);
    const tool = memoryHandlers({ sql, store, conversationRef: 'app:main', hideHistory: async () => undefined }).find(handler => handler.name === 'forget_memory')!;
    const turn = { ownerId: 'o', conversationRef: 'app:main', current: { message_ref: 'm1', text: 'forget my allergy' }, recent: [] };
    const result = await tool.handle({ claim_ids: [now.id], scope_note: 'the allergy' } as never, { memoryTurn: turn, authenticatedUserId: 'o' } as never) as { ok: boolean; data?: { removed_ids: number[] } };
    expect(result.ok).toBe(true);
    expect(result.data!.removed_ids).toEqual([1, now.id]);
    expect(store.allClaims().filter(claim => claim.text.includes('cobalt'))).toEqual([]);
    expect(store.recallReplaced('cobalt')).toEqual([]);
  }));
});
