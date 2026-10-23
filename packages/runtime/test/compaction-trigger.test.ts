import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { compactionSummaryOpen, forgetMemoryArgsSchema, type AdapterResult, type LLMResponse } from '@waldo/contracts';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { ClosedRunError, type RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerResponder, type OwnerContextHost } from '../src/channels/owner-turn';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { surfaceOwnerAdmission, type SurfaceOwnerBinding } from '../src/identity/surface-owner-admission';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { COMPACTION, COMPACTION_INSTRUCTION, compactionSettings, type CompactionSettings, type CompactionSpan } from '../src/conversation/compaction';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { forgetPurge } from '../src/memory/forget-purge';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { localTrustedBriefScheduleInput } from '../src/llm/run-loop-adapters';

const SUMMARY = 'Owner instructions:\n- The owner prefers tea.';
const authority = localTrustedBriefScheduleInput().admission.verified_authority;
const PREFIX = `canonical-owner-v1:${authority.principal_ref}:${authority.tenant_ref}:`;
const question = (n: number) => `Question ${n}: ${'q'.repeat(90)}`;
const small = (settings: CompactionSettings): CompactionSettings => ({ ...settings, budgetTokens: 160, minOwnerRows: 2, minIntervalMs: 0 });

// The model: the compaction instruction gets the summary, every other call a short reply. `during` runs while a summary
// call is in flight.
const model = (during: () => unknown = () => undefined, summary = SUMMARY) => {
  const calls: LLMGatewayRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async (input): Promise<AdapterResult<LLMResponse>> => {
    calls.push(input);
    const compacting = input.request.system === COMPACTION_INSTRUCTION;
    if (compacting) await during();
    return { ok: true, data: { model: input.request.model, text: compacting ? summary : 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  return { gateway, calls, compactions: () => calls.filter(call => call.request.system === COMPACTION_INSTRUCTION) };
};
const inOwner = <T,>(name: string, work: (storage: DurableObjectStorage) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    try { return await work(state.storage); } finally { await state.storage.deleteAll(); }
  });
const storeOn = (storage: DurableObjectStorage, settings: CompactionSettings) =>
  canonicalOwnerConversationStore(storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined }, undefined, undefined, settings);
const summaries = (storage: DurableObjectStorage, owner = PREFIX) => [...storage.kv.list<{ role?: string; modelPayload: string }>({ prefix: owner })]
  .filter(([key]) => key.includes(':conv:')).map(([, row]) => row).filter(row => row.role === 'compaction');
// A run scope that can be closed from outside, as a stop, a sign-out or a newer turn closes the one a turn ran under.
const closableScope = (storage: DurableObjectStorage) => {
  let closed = false;
  const admit = () => { if (closed) throw new ClosedRunError(); };
  const scope: RunEffectScope = { runId: 'run-1', attempt: 'attempt-1', deadline: Date.now() + 600_000, signal: new AbortController().signal, admit,
    commit: work => storage.transactionSync(() => { admit(); return work(); }) };
  return { scope, close: () => { closed = true; } };
};
type Args = Parameters<typeof createOwnerResponder>;
const responderOn = (store: Args[1], gateway: LLMGatewayAdapter, options: Readonly<{ log?: (entry: TurnLogEntry) => void; scope?: RunEffectScope; tools?: Args[5]; memory?: Args[2]; integration?: Args[21] }> = {}) => {
  const args: Args = ['fixture', store];
  if (options.memory) args[2] = options.memory;
  args[3] = options.log ?? (() => undefined);
  if (options.tools) args[5] = options.tools;
  args[10] = gateway;
  if (options.scope) args[19] = options.scope;
  if (options.integration) args[21] = options.integration;
  return createOwnerResponder(...args);
};
const say = (responder: ReturnType<typeof createOwnerResponder>, n: number, text = question(n)) =>
  responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text }), (_name, work) => work());

describe('the deploy switch', () => {
  it('is on only for the exact value "on", and leaves every other setting at its default', () => {
    expect(compactionSettings({ WALDO_COMPACTION: 'on' })).toEqual({ ...COMPACTION, enabled: true });
    for (const value of [undefined, '', 'off', 'ON', 'true', '1', ' on']) expect(compactionSettings({ WALDO_COMPACTION: value }).enabled).toBe(false);
    expect(COMPACTION.enabled).toBe(false);
  });

  // Off in both hosted configs until the eval meets its bar; turning staging on is a one-line change, and off is the rollback.
  it('is off in production and in staging', () => {
    const parsed = parseJsonc(config) as { vars: Record<string, string>; env: { staging: { vars: Record<string, string> } } };
    expect(parsed.vars.WALDO_COMPACTION).toBe('off');
    expect(parsed.env.staging.vars.WALDO_COMPACTION).toBe('off');
  });
});

describe('a chain compacts under the settings its store was built with', () => {
  it('a store built with the switch on compacts, and the next turn reads the summary first, while the module default stays off', async () => {
    await inOwner('compaction-switch-on', async (storage) => {
      const fake = model();
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), fake.gateway);
      for (let n = 1; n <= 6; n += 1) await say(responder, n);
      await responder.compactIfDue!('owner');
      expect(fake.compactions()).toHaveLength(1);
      expect(summaries(storage).map(row => row.modelPayload)).toEqual([SUMMARY]);
      await say(responder, 7);
      const input = JSON.stringify(fake.calls.at(-1)!.request.messages);
      expect(input).toContain(compactionSummaryOpen(0).slice(0, 20));
      expect(input).toContain('The owner prefers tea.');
      expect(input).not.toContain(question(1));
      expect(COMPACTION.enabled).toBe(false);
    });
  });

  it('a store built with the switch off makes no compaction call and writes no row, whatever its budget', async () => {
    await inOwner('compaction-switch-off', async (storage) => {
      const fake = model();
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'off' }))), fake.gateway);
      for (let n = 1; n <= 6; n += 1) await say(responder, n);
      await responder.compactIfDue!('owner');
      expect(fake.compactions()).toHaveLength(0);
      expect(summaries(storage)).toHaveLength(0);
      expect(storage.kv.get(`${PREFIX}compaction-attempt:owner`)).toBeUndefined();
    });
  });
});

describe('a scoped turn', () => {
  it('the owner-level responder hands the hook to the scoped turn, whose store was built with compaction on', async () => {
    await inOwner('compaction-scoped', async (storage) => {
      const fake = model();
      const binding: SurfaceOwnerBinding = { ownerId: '5d1f8a20-6c3b-4e9a-b7d2-0e4f6a8c1b3d', bindingRef: 'session-a', revision: '1', physicalDoId: 'physical-do-1' };
      let chain = '';
      const contextHost: OwnerContextHost = { prepare: async (turn, scope) => {
        const context = createOwnerTurnContext(await surfaceOwnerAdmission({ scope, lookup: async () => binding, expectedPhysicalDoId: binding.physicalDoId, surface: 'app',
          subject: 'subject', occurrenceKey: turn.traceId, occurredAt: Date.now(), text: turn.text ?? '' }));
        chain = context.conversationRef;
        return context;
      } };
      const args: Args = ['fixture'];
      const hops: TurnLogEntry[] = [];
      args[3] = entry => hops.push(entry);
      args[10] = fake.gateway;
      args[21] = { contextHost, history: (context) => canonicalOwnerConversationStore(storage, context, undefined, undefined, small(compactionSettings({ WALDO_COMPACTION: 'on' }))) };
      const responder = createOwnerResponder(...args);
      for (let n = 1; n <= 6; n += 1) {
        const { scope } = closableScope(storage);
        await responder.respond(ownerTyped({ traceId: `app-${n}`, conversationRef: 'owner', surface: 'app', text: question(n), runScope: scope }), (_name, work) => work());
      }
      await responder.compactIfDue!(chain);
      expect(fake.compactions()).toHaveLength(1);
      expect(hops.filter(hop => hop.hop === 'compaction').at(-1)).toMatchObject({ ok: true, code: 'compacted' });
      expect(summaries(storage, `canonical-owner-v1:prn_${binding.ownerId.replaceAll('-', '')}:`)).toHaveLength(1);
    });
  });
});

describe('a turn whose run was closed writes no compaction row', () => {
  it('closed after its reply: the hook refuses before any attempt, model call or write', async () => {
    await inOwner('compaction-closed-after-reply', async (storage) => {
      const fake = model();
      const { scope, close } = closableScope(storage);
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), fake.gateway, { scope });
      for (let n = 1; n <= 6; n += 1) await say(responder, n);
      close();
      await expect(responder.compactIfDue!('owner')).rejects.toBeInstanceOf(ClosedRunError);
      expect(fake.compactions()).toHaveLength(0);
      expect(summaries(storage)).toHaveLength(0);
      expect(storage.kv.get(`${PREFIX}compaction-attempt:owner`)).toBeUndefined();
    });
  });

  it('closed while the summary is in flight: the attempt is counted and the summary is never written', async () => {
    await inOwner('compaction-closed-in-flight', async (storage) => {
      const { scope, close } = closableScope(storage);
      const fake = model(close);
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), fake.gateway, { scope });
      for (let n = 1; n <= 6; n += 1) await say(responder, n);
      await expect(responder.compactIfDue!('owner')).rejects.toBeInstanceOf(ClosedRunError);
      expect(fake.compactions()).toHaveLength(1);
      expect(summaries(storage)).toHaveLength(0);
      expect(typeof storage.kv.get(`${PREFIX}compaction-attempt:owner`)).toBe('number');
    });
  });
});

describe('a topic forgotten in the turn never reaches its summary', () => {
  it('rows that carry the topic are left out of the summary call; the rest of the span is summarised', async () => {
    await inOwner('compaction-held-topic', async (storage) => {
      const fake = model();
      const forget = { name: 'forget_memory', description: 'Forget a topic.', schema: forgetMemoryArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false,
        handle: async () => ({ ok: true as const, data: { forgotten: true }, source_taint: null }) };
      const gateway: LLMGatewayAdapter = { complete: async (input) => {
        const said = JSON.stringify(input.request.messages.at(-1) ?? '');
        if (said.includes('Please forget the Lotus Hall plan') && !input.request.tool_turns?.length) {
          return { ok: true, data: { model: input.request.model, text: '', tool_calls: [{ call_id: 'f1', name: 'forget_memory', arguments: JSON.stringify({ topic: 'Lotus Hall', scope_note: 'the plan' }) }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
        }
        return fake.gateway.complete(input);
      } };
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), gateway, { tools: [forget as never] });
      for (const n of [1, 2]) await say(responder, n);
      await say(responder, 3, `Question 3: book the Lotus Hall for the party. ${'q'.repeat(50)}`);
      for (const n of [4, 5]) await say(responder, n);
      await say(responder, 6, `Please forget the Lotus Hall plan. ${'q'.repeat(60)}`);
      await responder.compactIfDue!('owner');
      expect(fake.compactions()).toHaveLength(1);
      const input = JSON.stringify(fake.compactions()[0]!.request.messages);
      expect(input).not.toContain('Lotus Hall');
      expect(input).toContain(question(2));
      expect(input).toContain(question(4));
      expect(summaries(storage)).toHaveLength(1);
    });
  });

  it('a span in which every row carries the topic makes no summary call and writes no row', async () => {
    await inOwner('compaction-held-topic-whole-span', async (storage) => {
      const fake = model();
      const forget = { name: 'forget_memory', description: 'Forget a topic.', schema: forgetMemoryArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false,
        handle: async () => ({ ok: true as const, data: { forgotten: true }, source_taint: null }) };
      const gateway: LLMGatewayAdapter = { complete: async (input) => {
        if (input.request.system === COMPACTION_INSTRUCTION) return fake.gateway.complete(input);
        const said = JSON.stringify(input.request.messages.at(-1) ?? '');
        if (said.includes('Please forget the Lotus Hall plan') && !input.request.tool_turns?.length) {
          return { ok: true, data: { model: input.request.model, text: '', tool_calls: [{ call_id: 'f1', name: 'forget_memory', arguments: JSON.stringify({ topic: 'Lotus Hall', scope_note: 'the plan' }) }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
        }
        return { ok: true, data: { model: input.request.model, text: 'Noted for the Lotus Hall.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
      } };
      const hops: TurnLogEntry[] = [];
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), gateway, { tools: [forget as never], log: entry => hops.push(entry) });
      for (let n = 1; n <= 5; n += 1) await say(responder, n, `Question ${n}: the Lotus Hall party. ${'q'.repeat(70)}`);
      await say(responder, 6, `Please forget the Lotus Hall plan. ${'q'.repeat(60)}`);
      await responder.compactIfDue!('owner');
      expect(fake.compactions()).toHaveLength(0);
      expect(summaries(storage)).toHaveLength(0);
      expect(hops.filter(hop => hop.hop === 'compaction').at(-1)).toMatchObject({ ok: false, code: 'held_topic' });
    });
  });
});

const LOTUS_SUMMARY = 'Decisions:\n- The party is booked at the Lotus Hall.';
const VENUE_SUMMARY = 'Decisions:\n- The owner booked a venue for the party.';
const iso = () => new Date().toISOString();
// Six rounds whose third books the Lotus Hall; the summary span is the older rounds, so that row is in it. With `forget`,
// the sixth message asks Waldo to forget it and the model calls the forget tool, so the turn holds the topic.
const lotusChat = async (responder: ReturnType<typeof createOwnerResponder>, forget = false) => {
  for (const n of [1, 2]) await say(responder, n);
  await say(responder, 3, `Question 3: book the Lotus Hall for the party. ${'q'.repeat(50)}`);
  for (const n of [4, 5]) await say(responder, n);
  await say(responder, 6, forget ? `Please forget the Lotus Hall plan. ${'q'.repeat(60)}` : question(6));
};
const forgetTool = { name: 'forget_memory', description: 'Forget a topic.', schema: forgetMemoryArgsSchema, trigger_allowlist: ['user_message'], autonomy_gated: false,
  handle: async () => ({ ok: true as const, data: { forgotten: true }, source_taint: null }) };
const forgettingGateway = (fake: ReturnType<typeof model>): LLMGatewayAdapter => ({ complete: async (input) => {
  if (input.request.system !== COMPACTION_INSTRUCTION && JSON.stringify(input.request.messages.at(-1) ?? '').includes('Please forget the Lotus Hall plan') && !input.request.tool_turns?.length) {
    return { ok: true, data: { model: input.request.model, text: '', tool_calls: [{ call_id: 'f1', name: 'forget_memory', arguments: JSON.stringify({ topic: 'Lotus Hall', scope_note: 'the plan' }) }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  }
  return fake.gateway.complete(input);
} });
const lastCompactionHop = (hops: readonly TurnLogEntry[]) => hops.filter(hop => hop.hop === 'compaction').at(-1);

describe('the span a held topic leaves', () => {
  it('the memory flush gets the rows the summary reads, without the rows that carry the topic', async () => {
    await inOwner('compaction-flush-held-topic', async (storage) => {
      const fake = model();
      const spans: CompactionSpan[] = [];
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), forgettingGateway(fake),
        { tools: [forgetTool as never], integration: { compactionFlush: async (span) => { spans.push(span); } } });
      await lotusChat(responder, true);
      await responder.compactIfDue!('owner');
      expect(spans).toHaveLength(1);
      expect(JSON.stringify(spans[0]!.messages)).not.toContain('Lotus Hall');
      expect(spans[0]!.messages.map(message => message.content)).toEqual(fake.compactions()[0]!.request.messages.map(message => message.content));
    });
  });

  it('the summary row counts only the rows it was made from', async () => {
    await inOwner('compaction-covers-held-topic', async (storage) => {
      const fake = model();
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), forgettingGateway(fake), { tools: [forgetTool as never] });
      await lotusChat(responder, true);
      await responder.compactIfDue!('owner');
      const [row] = summaries(storage) as unknown as { covers: { rows: number } }[];
      expect(row!.covers.rows).toBe(fake.compactions()[0]!.request.messages.length);
    });
  });

  it('a summary that names a topic forgotten in the turn is not written, and the hop says so without the words', async () => {
    await inOwner('compaction-output-held-topic', async (storage) => {
      const fake = model(undefined, LOTUS_SUMMARY);
      const hops: TurnLogEntry[] = [];
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), forgettingGateway(fake), { tools: [forgetTool as never], log: entry => hops.push(entry) });
      await lotusChat(responder, true);
      await responder.compactIfDue!('owner');
      expect(fake.compactions()).toHaveLength(1);
      expect(JSON.stringify(fake.compactions()[0]!.request.messages)).not.toContain('Lotus Hall');
      expect(summaries(storage)).toHaveLength(0);
      expect(storage.kv.get(`${PREFIX}compaction-live:owner`)).toBeUndefined();
      expect(lastCompactionHop(hops)).toEqual(expect.objectContaining({ ok: false, code: 'held_topic' }));
      expect(JSON.stringify(hops.filter(hop => hop.hop === 'compaction'))).not.toContain('Lotus');
    });
  });
});

// The console's forget as the owner DO runs it: custody of the texts, then the purge job's first pass over the conversation,
// which either cleans it at once or leaves it to the job's retry.
const consoleForget = (storage: DurableObjectStorage, memory: ReturnType<typeof claimStore>, cleans: boolean) => forgetPurge({
  sql: storage.sql, store: memory, now: Date.now, arm: async () => undefined,
  stores: [{ name: 'conversation', run: async (texts) => cleans ? (await redactConversationEntries(storage, texts, FORGOTTEN)).remaining : 1 }],
});

describe('a forget that lands while the summary is being written', () => {
  type During = (storage: DurableObjectStorage, memory: ReturnType<typeof claimStore>) => unknown;
  const compactWith = (name: string, scoped: boolean, summary: string, during: During, before: During = () => undefined) => inOwner(name, async (storage) => {
    const memory = claimStore(storage.sql, (work) => storage.transactionSync(work));
    await before(storage, memory);
    const hops: TurnLogEntry[] = [];
    const fake = model(() => during(storage, memory), summary);
    const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), fake.gateway,
      { memory, log: entry => hops.push(entry), ...(scoped ? { scope: closableScope(storage).scope } : {}) });
    await lotusChat(responder);
    await responder.compactIfDue!('owner');
    // The summary call read the row as it was, so the forget landed while the call was in flight.
    expect(JSON.stringify(fake.compactions().map(call => call.request.messages))).toContain('Lotus Hall');
    return { rows: summaries(storage), hop: lastCompactionHop(hops), live: storage.kv.get(`${PREFIX}compaction-live:owner`), pending: memory.pendingTopics() };
  });
  const refused = (result: Awaited<ReturnType<typeof compactWith>>) => {
    expect(result.rows).toHaveLength(0);
    expect(result.live).toBeUndefined();
    expect(result.hop).toEqual(expect.objectContaining({ ok: false, code: 'held_topic' }));
    expect(result.hop!.detail).toBeUndefined();
  };

  it('a topic the console still holds when the summary returns: nothing is written, whether or not the summary names it', async () => {
    for (const scoped of [false, true]) for (const summary of [LOTUS_SUMMARY, VENUE_SUMMARY]) {
      const result = await compactWith(`compaction-held-in-flight-${scoped}-${summary.length}`, scoped, summary, (storage, memory) => {
        memory.barrier('Lotus Hall', iso());
        return consoleForget(storage, memory, false).track(['Lotus Hall'], 'history');
      });
      expect(result.pending).toEqual(['Lotus Hall']);
      refused(result);
    }
  });

  it('a spot forgotten from the console in flight: the owner words it quoted hold the rows that carry them', async () => {
    const result = await compactWith('compaction-spot-forget-in-flight', true, VENUE_SUMMARY, (storage, memory) => {
      const purged = memory.purge([memory.claims()[0]!.id], iso());
      return consoleForget(storage, memory, false).track(purged.texts);
    }, (_storage, memory) => memory.add({ kind: 'fact', text: 'The party venue is booked', source: 'stated', evidence: '"book the Lotus Hall for the party"', origin: 'owner', source_ref: 'owner, app-3' }, iso()));
    expect(result.pending).toContain('book the Lotus Hall for the party');
    refused(result);
  });

  it('a forget whose cleaning finished in flight, and the stored rows redacted in flight: nothing is written', async () => {
    const cleaned: During = (storage, memory) => { memory.barrier('Lotus Hall', iso()); return consoleForget(storage, memory, true).track(['Lotus Hall'], 'history'); };
    const redacted: During = (storage) => redactConversationEntries(storage, ['Lotus Hall'], FORGOTTEN);
    for (const scoped of [false, true]) for (const [label, during] of [['cleaned', cleaned], ['redacted', redacted]] as const) {
      const result = await compactWith(`compaction-${label}-in-flight-${scoped}`, scoped, LOTUS_SUMMARY, during);
      // Nothing is held any more: only the rows the summary was made from show the forget.
      expect(result.pending).toEqual([]);
      refused(result);
    }
  });

  it('a row the store scrubbed when it saved it still reads as the summary read it', async () => {
    await inOwner('compaction-scrubbed-source', async (storage) => {
      const fake = model();
      const responder = responderOn(storeOn(storage, small(compactionSettings({ WALDO_COMPACTION: 'on' }))), fake.gateway, { scope: closableScope(storage).scope });
      for (let n = 1; n <= 6; n += 1) await say(responder, n, n === 3 ? `Question 3: I signed in at https://example.invalid/cb?code=abc123 ${'q'.repeat(40)}` : question(n));
      await responder.compactIfDue!('owner');
      expect(JSON.stringify(fake.compactions()[0]!.request.messages)).toContain('?code=abc123');
      expect(summaries(storage).map(row => row.modelPayload)).toEqual([SUMMARY]);
    });
  });

  it('a forget of a topic the span does not carry leaves the summary to be written', async () => {
    const result = await compactWith('compaction-other-forget-in-flight', true, LOTUS_SUMMARY, (storage, memory) => {
      memory.barrier('Bluefin', iso());
      return consoleForget(storage, memory, false).track(['Bluefin'], 'history');
    });
    expect(result.pending).toEqual(['Bluefin']);
    expect(result.rows.map(row => row.modelPayload)).toEqual([LOTUS_SUMMARY]);
    expect(result.hop).toEqual(expect.objectContaining({ ok: true, code: 'compacted' }));
  });
});
