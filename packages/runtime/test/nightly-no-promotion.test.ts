import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { NIGHTLY_ID, NIGHTLY_THROUGH_KEY } from '../src/channels/episodes';
import { applyClaimOps, claimStore, memoryPrompt } from '../src/memory/claims';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';
import { Scheduler } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import { productionDeps } from '../src/seams/deps';

// The nightly pass writes no constellation: no promotion call, no node, and no claim leaves 'active' for 'promoted'.
// What earlier nights promoted stays readable and forgettable.
const formats = vi.hoisted(() => [] as string[]);
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete({ request }) {
    const format = request.response_format?.name;
    if (format) formats.push(format);
    // What a promotion model would answer: a durable node on the two owner observations, promoting the recurring one.
    const text = format === 'promotion'
      ? JSON.stringify({ nodes: [{ durable: true, reason: 'recurs', id: null, domain: 'energy', label: 'Late screens', summary: 'Screens late, slow mornings', strength: 0.8, status: 'active', supporting_spots: [1, 2] }], edges: [], promoted: [1] })
      : format === 'claim_ops' ? JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null })
        : format ? '{}' : 'Noted.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

afterEach(() => { formats.length = 0; vi.restoreAllMocks(); });

const observation = (text: string) => ({ kind: 'observation', text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: 'owner, tg-1' });

it('a nightly pass makes no promotion call and logs no constellation hop; a recurring owner observation stays active, in the next night\'s input and correctable', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('nightly-no-promotion')), async (_instance, state) => {
    const realNow = Date.now;
    const now = Date.parse('2026-10-13T05:00:00Z');
    Date.now = () => now;
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add(observation('Scrolls the phone in bed past midnight'), '2026-10-10T22:00:00Z', 1);
      store.add(observation('Mornings feel slow after late screens'), '2026-10-11T08:00:00Z', 2);
      state.storage.sql.exec('UPDATE claims SET seen_count = 3 WHERE id = 1');
      const owner = new OwnerDO(state, { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture' });
      ensureSchema(state.storage);
      state.storage.kv.put('do_name', 'nightly-no-promotion'); state.storage.kv.put('telegram_subject', '7');
      state.storage.kv.put(NIGHTLY_THROUGH_KEY, now - 10_800_000);
      state.storage.sql.exec('DELETE FROM schedule');
      await new Scheduler(state.storage.sql, state.storage, productionDeps()).schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: now - 1000, dueAt: now - 1000, recurrence: null });
      state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();

      const logged = logs.mock.calls.map(call => String(call[0]));
      expect(logged.some(line => line.includes('"hop":"machine_turn"') && line.includes('nightly')), 'the nightly pass ran').toBe(true);
      expect(logged.filter(line => /"hop":"constellation(_evidence)?"/.test(line))).toEqual([]);
      expect(formats).not.toContain('promotion');
      expect(store.nodes()).toEqual([]);
      expect(store.claims('promoted')).toEqual([]);
      expect(store.claims().map(claim => claim.id).sort()).toEqual([1, 2]);
      expect(memoryPrompt(store)).toContain('Scrolls the phone in bed past midnight');
      expect(store.correct(1, { ...observation('Scrolls the phone in bed until about one'), source_ref: 'owner, tg-2' }, '2026-10-13T06:00:00Z')).toBe(true);
    } finally { Date.now = realNow; await state.storage.deleteAlarm(); }
  });
});

it('a claim and a node that earlier nights promoted stay readable through read_memory and recall, and the owner can forget both', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('promoted-stays-forgettable')), async (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    store.add(observation('Posterbot standup runs long on Mondays'), '2026-10-10T09:00:00Z', 1);
    store.setStatus(1, 'promoted');
    const node = store.saveNode({ id: null, domain: 'work rhythm', label: 'Posterbot Mondays', summary: 'Posterbot standup runs long', strength: 0.7, status: 'active', supporting_spots: [1] }, '2026-10-11T00:00:00Z');
    const read = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', hideHistory: async () => undefined }).find(handler => handler.name === 'read_memory')!;
    const turn = { authenticatedUserId: 'owner:1', trigger: 'user_message', memoryTurn: { ownerId: 'owner:1', conversationRef: 'owner', current: { message_ref: 'tg-3', text: 'standup' }, recent: [] } } as unknown as MemoryToolContext;
    expect(await read.handle(read.schema.parse({ query: 'standup' }), turn)).toMatchObject({ ok: true, data: { claims: [{ id: 1 }] } });
    expect(store.recall('standup').map(claim => claim.id)).toEqual([1]);
    expect(memoryPrompt(store)).toContain('Posterbot Mondays');

    applyClaimOps(store, JSON.stringify({ add: [], corrections: [], seen: [], confirm: [], dismiss: [], forget_claims: [1], forget_nodes: [node], forget_topic: 'Posterbot' }),
      '2026-10-13T06:00:00Z', 'owner, tg-3', undefined, { owner: 'please forget Posterbot' }, true);
    expect(store.claims('promoted')).toEqual([]);
    expect(store.recall('standup')).toEqual([]);
    expect(await read.handle(read.schema.parse({ query: 'standup' }), turn)).toMatchObject({ ok: true, data: { claims: [] } });
    expect(store.nodes().filter(row => row.status === 'active' && JSON.stringify(row).includes('Posterbot'))).toEqual([]);
    expect(memoryPrompt(store)).not.toContain('Posterbot');
  });
});
