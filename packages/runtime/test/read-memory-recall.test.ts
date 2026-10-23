import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildSessionState, toolNameSchema } from '@waldo/contracts';
import { claimStore } from '../src/memory/claims';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';
import { dispatchTool } from '../src/tools/dispatcher';
import { sanitise } from '../src/scribe/sanitiser';

// M-5: read_memory is the one memory-read tool. It carries what read_owner_context did (topic search, provenance,
// whole-claim byte budget, availability to machine turns hosted by the owner's DO) and keeps read_memory's fences.
const OWNER = 'owner:1';
const CHAT = 'telegram-1';
let sequence = 0;
const inDo = <T>(fn: (sql: SqlStorage, transaction: <R>(work: () => R) => R) => Promise<T>) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`read-memory-${sequence++}`));
  return runInDurableObject(stub, (_instance, state) => fn(state.storage.sql, work => state.storage.transactionSync(work)));
};
const readMemory = (sql: SqlStorage, transaction?: <R>(work: () => R) => R) => {
  const store = claimStore(sql, transaction);
  const handler = memoryHandlers({ sql, store, conversationRef: CHAT, hideHistory: async () => undefined }).find(h => h.name === 'read_memory')!;
  return { store, call: (args: unknown, ctx: MemoryToolContext) => handler.handle(handler.schema.parse(args), ctx), schema: handler.schema };
};
// A machine turn (a brief, a mail follow-up job) runs on the owner's DO with no owner message, so it carries no memoryTurn.
const machine = { authenticatedUserId: OWNER, trigger: 'user_message' } as unknown as MemoryToolContext;
const ownerTurn = (conversationRef = CHAT, ownerId = OWNER) => ({
  authenticatedUserId: OWNER, trigger: 'user_message',
  memoryTurn: { ownerId, conversationRef, current: { message_ref: 'tg-1', text: 'hi' }, recent: [] },
}) as unknown as MemoryToolContext;
const gym = { kind: 'preference' as const, text: 'Usually gym 11am; evening when mornings fail', source: 'stated', evidence: 'original words', origin: 'owner', source_ref: 'owner, tg-1' };

describe('read_memory as the one recall function', () => {
  it('a machine turn on the owner DO reads topic memory with evidence, provenance and no action authority', async () => {
    const result = await inDo(async sql => {
      const m = readMemory(sql); m.store.add(gym, '2026-09-30T01:00:00Z', 1);
      return m.call({ query: 'gym' }, machine);
    });
    expect(result).toMatchObject({ ok: true, source_taint: null, data: {
      authority: 'context_only_not_action_approval', complete: true, omitted_claim_ids: [],
      claims: [{ id: 1, text: gym.text, evidence: gym.evidence, source_ref: gym.source_ref, origin: 'owner', verification_status: 'owner-grounded' }],
    } });
  });

  it('still refuses an owner turn bound to another conversation or owner', async () => {
    const results = await inDo(async sql => {
      const m = readMemory(sql); m.store.add(gym, '2026-09-30T01:00:00Z', 1);
      return [await m.call({ query: 'gym' }, ownerTurn('telegram-2')), await m.call({ query: 'gym' }, ownerTurn(CHAT, 'owner:2')), await m.call({ query: 'gym' }, ownerTurn())];
    });
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[2]).toMatchObject({ ok: true, data: { claims: [{ id: 1 }] } });
  });

  it('returns the provenance projection: no aliases or internal bookkeeping columns', async () => {
    const result = await inDo(async sql => {
      const m = readMemory(sql); m.store.add({ ...gym, aliases: ['workout'] }, '2026-09-30T01:00:00Z', 1);
      return m.call({ query: 'workout' }, ownerTurn());
    }) as { data: { claims: Record<string, unknown>[] } };
    expect(result.data.claims).toHaveLength(1);
    expect(Object.keys(result.data.claims[0]!).sort()).toEqual(['evidence', 'id', 'kind', 'last_seen_at', 'learned_at', 'origin', 'source', 'source_ref', 'supersedes_id', 'text', 'valid_from', 'verification_status']);
  });

  it('excludes forgotten, superseded, untrusted and temporally ended claims', async () => {
    const result = await inDo(async (sql, transaction) => {
      const m = readMemory(sql, transaction);
      m.store.add({ ...gym, text: 'Cedar gym forgotten' }, '2026-09-30T01:00:00Z', 1); m.store.forget(1);
      m.store.add({ ...gym, text: 'Cedar gym mornings' }, '2026-09-30T01:00:00Z', 2);
      expect(m.store.correct(2, { ...gym, text: 'Cedar gym evenings unless meeting', source_ref: 'owner, tg-2' }, '2026-09-30T02:00:00Z')).toBe(true);
      m.store.add({ ...gym, text: 'Cedar gym from a mail', origin: 'untrusted' }, '2026-09-30T01:00:00Z', 4);
      m.store.add({ ...gym, text: 'Cedar gym last winter' }, '2026-09-30T01:00:00Z', 5);
      sql.exec("UPDATE claims SET valid_to = '2026-09-30T02:00:00Z' WHERE id = 5");
      return m.call({ query: 'Cedar' }, machine);
    }) as { data: { claims: { text: string; supersedes_id: number | null }[] } };
    expect(result.data.claims).toEqual([expect.objectContaining({ text: 'Cedar gym evenings unless meeting', supersedes_id: 2 })]);
  });

  it('omits an oversized claim whole and says the read is incomplete', async () => {
    const result = await inDo(async sql => {
      const m = readMemory(sql);
      m.store.add({ ...gym, text: 'gym '.repeat(20000) }, '2026-09-30T02:00:00Z', 1);
      m.store.add(gym, '2026-09-30T01:00:00Z', 2);
      return m.call({}, machine);
    });
    expect(result).toMatchObject({ ok: true, data: { claims: [{ id: 2, text: gym.text }], omitted_claim_ids: [1], complete: false } });
  });

  it('one owner DO never reads another owner store', async () => {
    await inDo(async sql => { readMemory(sql).store.add(gym, '2026-09-30T01:00:00Z', 1); });
    const other = await inDo(async sql => readMemory(sql).call({ query: 'gym' }, machine));
    expect(other).toMatchObject({ ok: true, data: { claims: [] } });
  });

  it('the dispatcher admits read_memory with null taint, rejects read_owner_context arguments, and knows no read_owner_context tool', async () => {
    expect(toolNameSchema.safeParse('read_owner_context').success).toBe(false);
    const result = await inDo(async sql => {
      const m = readMemory(sql); m.store.add(gym, '2026-09-30T01:00:00Z', 1);
      const handlers = memoryHandlers({ sql, store: m.store, conversationRef: CHAT, hideHistory: async () => undefined });
      const context = { authenticatedUserId: OWNER, trigger: 'user_message' as const, session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'], started_at: 1 }), hasApproval: () => false, sourceTaint: null, toolArgSourceTaint: null, sanitise };
      return {
        read: await dispatchTool({ id: 'read', name: 'read_memory', args: { query: 'gym' } }, context, { handlers }),
        topic: await dispatchTool({ id: 'topic', name: 'read_memory', args: { topic: 'gym' } }, context, { handlers }),
        old: await dispatchTool({ id: 'old', name: 'read_owner_context' as never, args: { topic: 'gym' } }, context, { handlers }),
      };
    });
    expect(result.read).toMatchObject({ ok: true, source_taint: null, data: { authority: 'context_only_not_action_approval', claims: [{ id: 1 }] } });
    expect(result.topic).toMatchObject({ ok: false });
    expect(result.old).toMatchObject({ ok: false });
  });
});
