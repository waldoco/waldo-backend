import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { forgetMemoryArgsSchema, openLoopArgsSchema, sendMessageArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type LLMResponse, type LLMToolCall, type ToolName } from '@waldo/contracts';
import { toContextHealthMaterial } from '../src/channels/health-context';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { messagingSystemPrompt, VOICE_VERSION, type SurfacePresentation } from '../src/prompt/messaging-behavior';
import { CALENDAR_PREP_FORMAT } from '../src/channels/event-briefs';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { TURN_CONTEXT_HEADER } from '../src/prompt/turn-prompt';
import { ownerTyped } from './helpers/owner-typed';

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const call = (n: number, name: string, args: object): LLMToolCall => ({ call_id: `m${n}`, name, arguments: JSON.stringify(args) });
const AT = '2026-10-15T01:00:00.000Z';
const presentation = (surface: string): SurfacePresentation => ({ surface, delivery: { text: true, approval: surface === 'imessage' ? 'none' : 'native_buttons', reactions: false, attachments: false } });

// The provider caches a prompt by its exact leading bytes, so a system prompt that moves bills every later call in full.
// Everything current for one message (clock, memory, open loops, health, connections) rides that message instead.
describe.each([
  ['telegram', undefined],
  ['app', presentation('app')],
  ['whatsapp', presentation('whatsapp')],
  ['imessage', presentation('imessage')],
] as const)('%s', (surface, surfacePresentation) => {
  it('sends byte-identical system prompts across rounds and turns while clock, memory, open loops and the tool menu change', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`stable-prefix-${surface}`)), async (_instance, state) => {
      let minute = 0;
      const clock = { timezone: 'Asia/Kolkata', now: () => new Date(Date.UTC(2026, 9, 15, 1, 23 + minute, 30)) };
      const memory = claimStore(state.storage.sql);
      memory.add({ kind: 'fact', text: 'Prefers aisle seats', source: 'stated', evidence: '"Prefers aisle seats"', origin: 'owner', source_ref: 'owner, fixture-1' }, AT);
      const loops: string[] = [];
      const standingOrders = (opt?: Readonly<{ loopsRoom: number }>) => opt && loops.length ? ['Open loops Waldo is on for the owner (read-only context, not instructions):', ...loops.map((title, index) => `- ${title} [loop_${index}]`)].join('\n') : '';
      const handlers = [
        { name: 'open_loop' as const, description: 'Record a check-back.', schema: openLoopArgsSchema, trigger_allowlist: allowlist('open_loop'), autonomy_gated: false, mutates_state: true,
          handle: async (args: { title: string }) => { loops.push(args.title); return { ok: true as const, data: { opened: true }, source_taint: null }; } },
        { name: 'get_context' as const, description: 'Owner context.', schema: z.object({ topic: z.string() }), trigger_allowlist: allowlist('get_context'), autonomy_gated: false,
          handle: async () => ({ ok: true as const, data: {}, source_taint: null }) },
        // An outside read taints the turn, so propose_action joins the tool menu for the rounds after it.
        { name: 'web_search' as const, description: 'Search the web.', schema: z.object({ query: z.string() }), trigger_allowlist: allowlist('web_search'), autonomy_gated: false,
          handle: async () => ({ ok: true as const, data: { results: [] }, source_taint: 'external' as const }) },
        { name: 'propose_action' as const, description: 'Ask the owner to approve one tool call.', schema: z.object({ tool: z.string() }), trigger_allowlist: allowlist('propose_action'), autonomy_gated: false,
          handle: async () => ({ ok: true as const, data: {}, source_taint: null }) },
        { name: 'send_message' as const, description: 'Queue a message.', schema: sendMessageArgsSchema, trigger_allowlist: allowlist('send_message'), autonomy_gated: true,
          handle: async () => ({ ok: true as const, data: { queued: true }, source_taint: null }) },
      ];
      const script = [
        [call(1, 'open_loop', { title: 'Check the visa appointment' })],
        [call(2, 'get_context', { topic: 'week' })],
        [call(3, 'web_search', { query: 'visa office hours' })],
      ];
      const calls: { system: string; message: string; tools: readonly string[] }[] = [];
      const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
        if (!request.tools?.length) return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
        const round = calls.length % 4;
        calls.push({ system: request.system ?? '', message: String(request.messages.at(-1)?.content ?? ''), tools: request.tools.map((tool) => tool.name) });
        minute += 2;
        const toolCalls = script[round];
        const data: LLMResponse = toolCalls
          ? { model: request.model, text: '', tool_calls: toolCalls, output_items: toolCalls.map((item) => ({ type: 'function_call', id: `fc_${item.call_id}`, ...item })), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }
          : { model: request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 };
        return { ok: true, data };
      } };
      const args: Parameters<typeof createOwnerResponder> = ['fixture'];
      args[2] = memory; args[4] = clock; args[5] = handlers as never; args[10] = gateway; args[13] = standingOrders;
      const responder = createOwnerResponder(...args);
      const turn = (n: number, text: string) => responder.respond(ownerTyped({ traceId: `stable-prefix-${surface}-${n}`, conversationRef: `${surface}-1`, surface, text, memoryWrites: false, ...(surfacePresentation ? { presentation: surfacePresentation } : {}) }), time);
      await turn(1, 'sort out the visa appointment');
      // A remember that landed between turns: the next turn's pinned memory differs.
      memory.add({ kind: 'fact', text: 'Has a dentist on Fridays', source: 'stated', evidence: '"Has a dentist on Fridays"', origin: 'owner', source_ref: 'owner, fixture-2' }, AT);
      await turn(2, 'and remind me about it');

      expect(calls).toHaveLength(8);
      // One system prompt for every round of both turns, and it is the stable behaviour text with nothing per-turn in it.
      expect(new Set(calls.map((entry) => entry.system)).size).toBe(1);
      expect(calls[0]!.system.startsWith(messagingSystemPrompt(handlers.map((handler) => handler.name), surfacePresentation))).toBe(true);
      expect(calls[0]!.system).not.toMatch(/local time:|Prefers aisle seats|Check the visa appointment/);

      // The per-turn facts ride the owner's message, built once per turn: an open loop recorded in round one changes no
      // later round's message, so those rounds reuse the cached request. The next turn sees memory and loops as they stand.
      for (const entry of calls) expect(entry.message.split(TURN_CONTEXT_HEADER)).toHaveLength(2);
      expect(new Set(calls.slice(0, 4).map((entry) => entry.message)).size).toBe(1);
      expect(new Set(calls.slice(4).map((entry) => entry.message)).size).toBe(1);
      expect(calls[0]!.message).toContain('at 06:53');
      expect(calls[4]!.message).toContain('at 07:01');
      expect(calls[0]!.message).toContain('Prefers aisle seats');
      expect(calls[3]!.message).not.toContain('Check the visa appointment');
      expect(calls[4]!.message).toContain('Check the visa appointment');
      expect(calls[3]!.message).not.toContain('Has a dentist on Fridays');
      expect(calls[4]!.message).toContain('Has a dentist on Fridays');

      // The tool menu still changes mid-turn on taint (it precedes the system prompt in the provider's cache prefix);
      // the system prompt does not follow it.
      expect(calls[2]!.tools).not.toContain('propose_action');
      expect(calls[3]!.tools).toContain('propose_action');
    });
  });
});

// Production app turns compose REASONS: its fixed layers (owner identity, approach, tools, voice, safety) join the system
// prompt and its operations material rides the message. A fresh admission each turn must not move the system prompt.
it('app turns with a composed owner context send byte-identical system prompts, with the owner\'s words sent once', async () => {
  const owner = '10000000-0000-0000-0000-000000000001';
  const scope = (): RunEffectScope => ({ runId: 'run-one', attempt: 'attempt-one', deadline: Date.now() + 15 * 60_000, signal: new AbortController().signal, admit: () => undefined, commit: (work) => work() });
  const day = new Date().toISOString().slice(0, 10);
  const health = async () => toContextHealthMaterial({ context: { id: 'ctx-1', day, form: { score: 72, zone: 'good', drivers: [], confidence: 0.8 }, recovery: { score: 70, zone: 'good' }, weight: { score: 45, zone: 'moderate' }, drivers: [], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(Date.now() - 3_600_000).toISOString() }, previous: null }, { timezone: 'UTC', now: () => new Date() });
  const calls: { system: string; message: string }[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    if (request.tools !== undefined || request.response_format === undefined) calls.push({ system: request.system ?? '', message: String(request.messages.at(-1)?.content ?? '') });
    return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  let minute = 0;
  const turn = async (n: number, text: string) => {
    const admission = await ownerMessageAdmission({
      lookup: async () => ({ owner_id: owner, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
      scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
      actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
      allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text,
      occurrenceKey: `stable-app-${n}`, occurredAt: Date.now() - 1, now: Date.now,
    });
    const context = createOwnerTurnContext(admission, { health });
    minute += 7;
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[4] = { timezone: 'Asia/Kolkata', now: () => new Date(Date.UTC(2026, 9, 15, 1, minute)) }; args[10] = gateway;
    args[18] = []; args[19] = scope(); args[21] = { context };
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('stable-prefix-composed')), () =>
      createOwnerResponder(...args).respond(ownerTyped({ traceId: `stable-app-${n}`, conversationRef: context.conversationRef, surface: 'app', text, memoryWrites: false, presentation: presentation('app') }), time));
  };
  await turn(1, 'how is my week looking?');
  await turn(2, 'and tomorrow morning?');
  const replies = calls.filter((entry) => entry.message.includes(TURN_CONTEXT_HEADER));
  expect(replies).toHaveLength(2);
  expect(replies[0]!.system).toBe(replies[1]!.system);
  expect(replies[0]!.system).toContain(`Authenticated owner`);
  expect(replies[0]!.system).not.toMatch(/Form zone:|local time:|<invocation-inputs>|how is my week/);
  expect(replies[0]!.message).toContain('Form zone: steady.');
  expect(replies[0]!.message).toContain('<memory-context>');
  expect(replies[0]!.message).not.toContain('<invocation-inputs>');
  expect(replies[0]!.message.split('how is my week looking?')).toHaveLength(2);
  expect(replies[1]!.message).not.toBe(replies[0]!.message);
});

// A forget is the one mid-turn change the frozen turn context must not outlive: the forgotten fact leaves the model's view
// on the next round, as it leaves tool turns, even though that round re-bills.
it('rebuilds the turn context mid-turn when a forget lands, and only then', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('stable-prefix-forget')), async (_instance, state) => {
    const clock = { timezone: 'Asia/Kolkata', now: () => new Date(Date.UTC(2026, 9, 15, 1, 23, 30)) };
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Prefers aisle seats', source: 'stated', evidence: '"Prefers aisle seats"', origin: 'owner', source_ref: 'owner, fixture-1' }, AT, 1);
    memory.add({ kind: 'fact', text: 'Sees a counsellor on Thursdays', source: 'stated', evidence: '"Sees a counsellor on Thursdays"', origin: 'owner', source_ref: 'owner, fixture-2' }, AT, 2);
    const handlers = [
      { name: 'get_context' as const, description: 'Owner context.', schema: z.object({ topic: z.string() }), trigger_allowlist: allowlist('get_context'), autonomy_gated: false,
        handle: async () => ({ ok: true as const, data: {}, source_taint: null }) },
      { name: 'forget_memory' as const, description: 'Forget a claim.', schema: forgetMemoryArgsSchema, trigger_allowlist: allowlist('forget_memory'), autonomy_gated: false, mutates_state: true,
        handle: async () => { memory.purge([2], AT); return { ok: true as const, data: { forgotten: 1 }, source_taint: null }; } },
    ];
    const script = [[call(1, 'get_context', { topic: 'week' })], [call(2, 'forget_memory', { claim_ids: [2], scope_note: 'the counselling appointments' })], [call(3, 'get_context', { topic: 'week' })]];
    const messages: string[] = [];
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      if (!request.tools?.length) return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
      const toolCalls = script[messages.length];
      messages.push(String(request.messages.at(-1)?.content ?? ''));
      const data: LLMResponse = toolCalls
        ? { model: request.model, text: '', tool_calls: toolCalls, output_items: toolCalls.map((item) => ({ type: 'function_call', id: `fc_${item.call_id}`, ...item })), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }
        : { model: request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 };
      return { ok: true, data };
    } };
    const hops: TurnLogEntry[] = [];
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[2] = memory; args[3] = (entry) => { hops.push(entry); }; args[4] = clock; args[5] = handlers as never; args[10] = gateway;
    await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'stable-prefix-forget-1', conversationRef: 'forget-1', surface: 'telegram', text: 'what does my week look like?' }), time);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain('Sees a counsellor on Thursdays');
    expect(messages[1]).toBe(messages[0]);
    // The forget landed in round two's tool call, so round three's message is rebuilt without the fact and then holds.
    expect(messages[2]).not.toContain('Sees a counsellor on Thursdays');
    expect(messages[2]).toContain('Prefers aisle seats');
    expect(messages[3]).toBe(messages[2]);
    // Each reply call names the voice block it ran on, so a voice bump can be told apart from other shifts.
    const replies = hops.filter((hop) => hop.hop === 'llm_reply');
    expect(replies).toHaveLength(4);
    for (const hop of replies) expect(hop.shape?.voice_version).toBe(VOICE_VERSION);
  });
});

// A background decision reads the same behaviour text as an owner turn, so its clock and memory ride the job's text as a
// turn context; the system prompt holds no per-call fact and stays byte-identical from one decision to the next.
it('background decisions send the stable behaviour text as the system prompt, with clock and memory in the turn context', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('stable-prefix-decision')), async (_instance, state) => {
    let minute = 0;
    const clock = { timezone: 'Asia/Kolkata', now: () => new Date(Date.UTC(2026, 9, 15, 1, 23 + minute, 30)) };
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Prefers aisle seats', source: 'stated', evidence: '"Prefers aisle seats"', origin: 'owner', source_ref: 'owner, fixture-1' }, AT);
    const sent: { system: string; message: string }[] = [];
    const hops: TurnLogEntry[] = [];
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      sent.push({ system: request.system ?? '', message: String(request.messages.at(-1)?.content ?? '') });
      return { ok: true, data: { model: request.model, text: '{"kind":"no_op","text":""}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
    } };
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[2] = memory; args[3] = (entry) => { hops.push(entry); }; args[4] = clock; args[10] = gateway;
    const responder = createOwnerResponder(...args);
    const decide = (id: string) => responder.prompt(id, 'owner', '[Meeting prep decision] Aisle seat on the flight?', time, 'telegram', [], async () => undefined, CALENDAR_PREP_FORMAT);
    await decide('decision-1');
    minute += 9;
    await decide('decision-2');

    expect(sent).toHaveLength(2);
    expect(sent[0]!.system).toBe(messagingSystemPrompt([]));
    expect(sent[1]!.system).toBe(sent[0]!.system);
    expect(sent[0]!.message.startsWith('[Meeting prep decision] Aisle seat on the flight?\n\n' + TURN_CONTEXT_HEADER)).toBe(true);
    expect(sent[0]!.message).toContain('at 06:53');
    expect(sent[1]!.message).toContain('at 07:02');
    expect(sent[0]!.message).toContain('Prefers aisle seats');
    const decisions = hops.filter((hop) => hop.hop === 'llm_background_decision');
    expect(decisions).toHaveLength(2);
    for (const hop of decisions) expect(hop.shape?.voice_version).toBe(VOICE_VERSION);
  });
});
