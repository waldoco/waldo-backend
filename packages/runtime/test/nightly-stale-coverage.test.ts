import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { claimStore, FORGOTTEN, textFingerprint } from '../src/memory/claims';
import { createOwnerResponder } from '../src/channels/owner-turn';

const seen = vi.hoisted(() => ({ inputs: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  const input = JSON.stringify(body);
  seen.inputs.push(input);
  const output_text = input.includes('"name":"promotion"') ? '{"nodes":[],"edges":[],"promoted":[]}'
    : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null,"pin":[],"unpin":[]}';
  return { id: 'fixture', output_text, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
beforeEach(() => { seen.inputs.length = 0; });

// An older build kept a topic the owner asked to forget as "coverage incomplete" until a span selector had proved its
// sources. The selector is gone, so such a row could never clear, and it deferred every nightly pass and promotion.
it('a stale coverage-incomplete row becomes an ordinary pending forget with a barrier, and the nightly pass runs and purges it', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('nightly-stale-coverage')), async (_i, state) => {
    const sql = state.storage.sql;
    // The table as the older build left it: one unproved topic, one ordinary pending literal.
    sql.exec('CREATE TABLE topic_purge_pending (fingerprint TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at TEXT NOT NULL, coverage_incomplete INTEGER NOT NULL DEFAULT 0)');
    sql.exec('INSERT INTO topic_purge_pending (fingerprint, topic, created_at, coverage_incomplete) VALUES (?, ?, ?, 1)', textFingerprint('oolong'), 'oolong', '2026-10-07T08:00:00Z');
    sql.exec('INSERT INTO topic_purge_pending (fingerprint, topic, created_at, coverage_incomplete) VALUES (?, ?, ?, 0)', textFingerprint('matcha'), 'matcha', '2026-10-07T09:00:00Z');
    const memory = claimStore(sql, work => state.storage.transactionSync(work));
    // The forget is kept, not dropped: still pending (so still hidden from prompts), and barred from being relearned.
    expect(memory.pendingTopics()).toEqual(['oolong', 'matcha']);
    expect(memory.barriers()).toMatchObject([{ topic: FORGOTTEN, topic_hash: textFingerprint('oolong'), created_at: '2026-10-07T08:00:00Z' }]);
    // Opening the store again is a no-op.
    claimStore(sql);
    expect(memory.pendingTopics()).toEqual(['oolong', 'matcha']);
    expect(memory.barriers()).toHaveLength(1);
    memory.add({ kind: 'preference', text: 'Prefers oolong tea', source: 'stated', evidence: 'oolong tea please', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-06T08:00:00Z');

    const responder = createOwnerResponder('fixture', undefined, memory);
    const night = await responder.consolidate('nightly-1', '[2026-10-19 08:00] owner: nothing new today', { owner: 'nothing new today', shared: '', waldo: '', ownerMessages: [] });
    expect(night).toMatchObject({ done: true });
    expect(night.detail).not.toContain('deferred');
    expect(seen.inputs).toHaveLength(1);
    expect(seen.inputs[0]).not.toContain('oolong');
    // The nightly pass retries pending topics through the literal purge, so the old forget finally lands and settles.
    expect(memory.allClaims().map(claim => claim.text)).toEqual([`Prefers ${FORGOTTEN} tea`]);
    expect(memory.pendingTopics()).toEqual([]);
    memory.add({ kind: 'fact', text: 'Lives in Pune', source: 'stated', evidence: 'Pune', origin: 'owner', source_ref: 'owner, tg-2' }, '2026-10-19T08:00:00Z');
    expect(await responder.promote('promote-1')).not.toContain('deferred');
  });
});

it('a forget on a topic still purges and settles through the literal path', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('nightly-stale-coverage-forget')), (_i, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    store.add({ kind: 'preference', text: 'Prefers oolong tea', source: 'stated', evidence: '"oolong tea please"', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-19T08:00:00Z');
    const purge = store.purge([], '2026-10-19T09:00:00Z', ['oolong']);
    expect(purge.ready).toBe(true);
    expect(store.pendingTopics()).toEqual(['oolong']);
    store.settle([], ['oolong']);
    expect(store.pendingTopics()).toEqual([]);
    expect(store.allClaims().map(claim => claim.text)).toEqual([`Prefers ${FORGOTTEN} tea`]);
  });
});
