import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildSessionState, readMemoryResultSchema, toolNameSchema } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { toolOutputLedger } from '../src/conversation/tool-output-ledger';
import type { LLMGatewayAdapter } from '../src/llm/provider';
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
    expect(readMemoryResultSchema.safeParse((result as { data: unknown }).data).success).toBe(true);
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
    expect(readMemoryResultSchema.safeParse((result as { data: unknown }).data).success).toBe(true);
  });

  it('withholds a claim whose topic the owner asked to forget while that forget is still settling, by text or by alias', async () => {
    const result = await inDo(async sql => {
      const m = readMemory(sql);
      m.store.add({ ...gym, text: 'Posterbot standup moved to 9' }, '2026-09-30T01:00:00Z', 1);
      m.store.add({ ...gym, text: 'Standup notes go in the shared doc', aliases: ['posterbot'] }, '2026-09-30T01:00:00Z', 2);
      m.store.add({ ...gym, text: 'Standup runs short on Fridays' }, '2026-09-30T01:00:00Z', 3);
      sql.exec("INSERT INTO topic_purge_pending (fingerprint, topic, created_at) VALUES ('pending-posterbot', 'Posterbot', '2026-09-30T02:00:00Z')");
      return [await m.call({ query: 'standup' }, machine), await m.call({ query: 'Posterbot' }, ownerTurn())];
    }) as { data: { claims: { id: number }[] } }[];
    expect(result[0]!.data.claims.map(claim => claim.id)).toEqual([3]);
    expect(result[1]!.data.claims).toEqual([]);
  });

  it('a recall in a job over outside text keeps the turn external, so its ledger row is tainted; an owner job stays clean', async () => {
    const rows = await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`read-memory-${sequence++}`)), async (_instance, state) => {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add(gym, '2026-09-30T01:00:00Z', 1);
      const ledger = toolOutputLedger(state.storage);
      const outputs: string[] = [];
      const job = async (id: string, taint?: 'external') => {
        let round = 0;
        const gateway: LLMGatewayAdapter = { async complete(request) {
          round += 1;
          if (round === 2) outputs.push(request.request.tool_turns?.[0]?.output ?? '');
          return { ok: true, data: { model: request.request.model, text: round === 1 ? '' : 'SKIP', ...(round === 1 ? { tool_calls: [{ call_id: 'c1', name: 'read_memory', arguments: JSON.stringify({ query: 'gym' }) }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
        } };
        const handlers = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined });
        // The background mail follow-up's own tool list, as the owner DO names it.
        await createOwnerResponder('fixture', undefined, store, undefined, undefined, handlers, undefined, false, ledger, undefined, gateway)
          .prompt(id, 'owner', 'Check observed mail for anything the owner should follow up', async (_hop, work) => work(), 'telegram', ['get_context', 'read_memory', 'search_episodes'], undefined, undefined, undefined, taint);
      };
      await job('mail-followup', 'external');
      await job('owner-job');
      return [...(await state.storage.list<{ tool: string; taint: string | null; origin: string }>({ prefix: 'toolout:' })).values()].filter(row => row.tool === 'read_memory');
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.taint).sort()).toEqual(['external', null]);
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
