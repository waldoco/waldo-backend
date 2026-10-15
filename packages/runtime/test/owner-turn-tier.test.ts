import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL, type LLMRequest } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { ConversationStore } from '../src/channels/conversation-store';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import type { LLMGatewayAdapter, LLMGatewayResult } from '../src/llm/provider';
import { liveTurnTier, type TurnTierDecider, type TurnTierInput, type TurnTierRoute } from '../src/llm/turn-tier';
import { claimStore, type ClaimStore } from '../src/memory/claims';
import { localTrustedBriefScheduleInput } from '../src/run-loop/adapters';
import { ownerTyped } from './helpers/owner-typed';

// The live router reaches the Decisions API through the SDK client's generic post; this stands in for that client.
const decisions = vi.hoisted(() => ({ posts: [] as Array<{ path: string; body: unknown }>, answer: undefined as unknown }));
vi.mock('openai', () => ({ default: class { post = async (path: string, options: { body: unknown }) => { decisions.posts.push({ path, body: options.body }); return decisions.answer; }; } }));

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const scope = (runId: string): RunEffectScope => ({ runId, attempt: `${runId}-attempt`, deadline: Date.now() + 60_000, signal: new AbortController().signal, admit: () => undefined, commit: work => work() });
const SIMPLE: TurnTierRoute = { tier: 'simple', reason: 'simple', confidence: 0.95, inputTokens: 80 };
const COMPLEX: TurnTierRoute = { tier: 'complex', reason: 'complex', confidence: 0.9 };
const toolCall = (name: string, args: unknown, extra: readonly Record<string, unknown>[] = [], callId = `${name}-1`): LLMGatewayResult => ({ ok: true, data: { model: OPENAI_GPT_6_1_SOL_MODEL, text: '', tool_calls: [{ call_id: callId, name, arguments: JSON.stringify(args) }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1,
  output_items: [...extra, { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: JSON.stringify(args) }] } });
const reasoning = (id: string) => ({ type: 'reasoning', id, encrypted_content: `sealed-${id}` });
const browsePage = { name: 'browse_page' as const, description: 'Read a public web page.', schema: z.object({ url: z.string() }), trigger_allowlist: ['user_message' as const], autonomy_gated: false,
  handle: async () => ({ ok: true as const, data: { text: 'Venue page.' }, source_taint: 'external' as const }) };
const itemTypes = (request: LLMRequest) => (request.tool_turns ?? []).map(turn => [turn.call.call_id, (turn.prior_items ?? []).map(item => item.type === 'reasoning' ? `reasoning:${String(item.id)}` : String(item.type))]);

// A responder whose gateway records every request and plays the scripted answers in order, then answers 'Done.'; the
// injected router answers from its own script and records what it was asked.
const responder = ({ routes, script = [], store, memory, tools }: { routes: readonly TurnTierRoute[]; script?: LLMGatewayResult[]; store?: ConversationStore; memory?: ClaimStore; tools?: Parameters<typeof createOwnerResponder>[5] }) => {
  const requests: LLMRequest[] = [];
  const asked: TurnTierInput[] = [];
  const logs: TurnLogEntry[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    requests.push(request);
    const next = script.shift();
    if (next?.ok) return { ok: true, data: { ...next.data, model: request.model } };
    const text = request.response_format?.name === 'reaction' ? '{"reaction":"👌"}' : 'Done.';
    return { ok: true, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  } };
  const turnTier: TurnTierDecider = async (input) => { asked.push(input); return routes[Math.min(asked.length - 1, routes.length - 1)]!; };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[1] = store; args[2] = memory; args[3] = entry => logs.push(entry); args[5] = tools; args[10] = gateway; args[18] = ['👌']; args[21] = { turnTier: () => turnTier };
  return { requests, asked, logs, owner: createOwnerResponder(...args), routed: () => requests.map(request => [request.model, request.reasoning_effort]) };
};
const SOL_MEDIUM = [OPENAI_GPT_6_1_SOL_MODEL, 'medium'];
const LUNA_LOW = [OPENAI_GPT_6_LUNA_MODEL, 'low'];

it('runs every reply call of a turn the router judges simple on Luna at low effort, deciding once', async () => {
  const { owner, routed, asked, requests } = responder({ routes: [SIMPLE, COMPLEX], script: [toolCall('get_context', {}, [reasoning('rs_a')], 'ctx-1'), toolCall('get_context', {}, [reasoning('rs_b')], 'ctx-2')] });
  await owner.respond(ownerTyped({ traceId: 'tier-simple-1', conversationRef: 'app-1', surface: 'app', text: 'what time is it?', memoryWrites: false }), time);
  expect(routed()).toEqual([LUNA_LOW, LUNA_LOW, LUNA_LOW]);
  expect(asked).toHaveLength(1);
  expect(itemTypes(requests[2]!)).toEqual([['ctx-1', ['reasoning:rs_a', 'function_call']], ['ctx-2', ['reasoning:rs_b', 'function_call']]]);
});

it('keeps a turn the router judges complex on Sol at medium effort', async () => {
  const { owner, routed } = responder({ routes: [COMPLEX], script: [toolCall('get_context', {})] });
  await owner.respond(ownerTyped({ traceId: 'tier-complex-1', conversationRef: 'app-1', surface: 'app', text: 'compare three hotels near the venue', memoryWrites: false }), time);
  expect(routed()).toEqual([SOL_MEDIUM, SOL_MEDIUM]);
});

it('decides each owner turn afresh', async () => {
  const { owner, routed, asked } = responder({ routes: [SIMPLE, COMPLEX] });
  await owner.respond(ownerTyped({ traceId: 'tier-fresh-1', conversationRef: 'app-1', surface: 'app', text: 'thanks', memoryWrites: false }), time);
  await owner.respond(ownerTyped({ traceId: 'tier-fresh-2', conversationRef: 'app-1', surface: 'app', text: 'now plan my week around the offsite', memoryWrites: false }), time);
  expect(routed()).toEqual([LUNA_LOW, SOL_MEDIUM]);
  expect(asked).toHaveLength(2);
});

// Production turns carry their run's scope and run in a responder rebuilt for it, which must keep the router.
it('routes a simple turn in its own run scope to Luna', async () => {
  const { owner, routed } = responder({ routes: [SIMPLE] });
  await owner.respond(ownerTyped({ traceId: 'tier-scoped-1', conversationRef: 'app-1', surface: 'app', text: 'hello', memoryWrites: false, runScope: scope('tier-run') }), time);
  expect(routed()).toEqual([LUNA_LOW]);
});

it('keeps a delegated subagent of a Luna turn on Sol, and moves the turn itself to Sol after it delegates', async () => {
  const { owner, requests } = responder({ routes: [SIMPLE], script: [toolCall('delegate_task', { task: 'Find the venue address and report it.' })] });
  await owner.respond(ownerTyped({ traceId: 'tier-delegate-1', conversationRef: 'app-1', surface: 'app', text: 'where is the venue?', memoryWrites: false }), time);
  expect(requests.map(request => [request.model, request.tools?.some(tool => tool.name === 'delegate_task') ?? false])).toEqual([
    [OPENAI_GPT_6_LUNA_MODEL, true], [OPENAI_GPT_6_1_SOL_MODEL, false], [OPENAI_GPT_6_1_SOL_MODEL, true],
  ]);
});

it('moves a Luna turn to Sol after it browses, replaying every call without Luna reasoning or item ids, and keeps Sol to the end', async () => {
  const { owner, routed, requests, logs } = responder({ routes: [SIMPLE], tools: [browsePage as never], script: [
    toolCall('browse_page', { url: 'https://example.com/venue' }, [reasoning('rs_luna'), { type: 'message', id: 'msg_luna', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Checking the venue page.', annotations: [] }] }], 'browse-1'),
    toolCall('get_context', {}, [reasoning('rs_sol')], 'ctx-1'),
  ] });
  await owner.respond(ownerTyped({ traceId: 'tier-escalate-1', conversationRef: 'app-1', surface: 'app', text: 'is the venue open late?', memoryWrites: false }), time);
  expect(routed()).toEqual([LUNA_LOW, SOL_MEDIUM, SOL_MEDIUM]);
  expect(itemTypes(requests[1]!)).toEqual([['browse-1', ['message', 'function_call']]]);
  expect(itemTypes(requests[2]!)).toEqual([['browse-1', ['message', 'function_call']], ['ctx-1', ['reasoning:rs_sol', 'function_call']]]);
  expect(requests[1]!.tool_turns![0]!.prior_items).toEqual([
    { type: 'message', role: 'assistant', content: 'Checking the venue page.' },
    { type: 'function_call', call_id: 'browse-1', name: 'browse_page', arguments: JSON.stringify({ url: 'https://example.com/venue' }) },
  ]);
  expect(requests[2]!.tool_turns![1]!.prior_items!.at(-1)).toMatchObject({ id: 'fc-ctx-1' });
  expect(requests[2]!.tool_turns!.map(turn => [turn.call.name, turn.output.length > 0])).toEqual([['browse_page', true], ['get_context', true]]);
  const hops = logs.filter(entry => entry.hop === 'turn_tier');
  expect(hops.map(entry => [entry.code, entry.detail])).toEqual([
    ['simple', 'tier=simple reason=simple confidence=0.95'],
    ['escalated', `from=${OPENAI_GPT_6_LUNA_MODEL} to=${OPENAI_GPT_6_1_SOL_MODEL} tool=browse_page`],
  ]);
  expect(hops[1]!.text).toBeUndefined();
});

it('moves a Luna turn to Sol after a hosted web search', async () => {
  const { owner, routed, requests } = responder({ routes: [SIMPLE], script: [toolCall('get_context', {}, [reasoning('rs_luna'), { type: 'web_search_call', id: 'ws_1', status: 'completed' }], 'ctx-1')] });
  await owner.respond(ownerTyped({ traceId: 'tier-escalate-2', conversationRef: 'app-1', surface: 'app', text: 'any rain tonight?', memoryWrites: false }), time);
  expect(routed()).toEqual([LUNA_LOW, SOL_MEDIUM]);
  expect(itemTypes(requests[1]!)).toEqual([['ctx-1', ['function_call']]]);
});

it('never escalates a turn the router already kept on Sol', async () => {
  const { owner, routed, logs } = responder({ routes: [COMPLEX], tools: [browsePage as never], script: [toolCall('browse_page', { url: 'https://example.com/venue' }, [reasoning('rs_sol')], 'browse-1')] });
  await owner.respond(ownerTyped({ traceId: 'tier-escalate-3', conversationRef: 'app-1', surface: 'app', text: 'compare the venues', memoryWrites: false }), time);
  expect(routed()).toEqual([SOL_MEDIUM, SOL_MEDIUM]);
  expect(logs.filter(entry => entry.hop === 'turn_tier').map(entry => entry.code)).toEqual(['complex']);
});

it('never asks the router about a reminder, a scheduled job or a reaction, which stay on the auxiliary model', async () => {
  const { owner, routed, asked } = responder({ routes: [COMPLEX] });
  await owner.remind('tier-reminder-1', 'app-1', 'call Sam', time, 'app');
  await owner.prompt('tier-job-1', 'app-1', 'Write the morning card from these facts: two meetings.', time, 'app');
  await owner.chooseReaction(ownerTyped({ traceId: 'tier-reaction-1', conversationRef: 'app-1', surface: 'app', text: 'thanks' }));
  expect(asked).toEqual([]);
  expect(routed()).toEqual([LUNA_LOW, LUNA_LOW, LUNA_LOW]);
});

it('keeps Sol when the router itself throws', async () => {
  const requests: LLMRequest[] = [];
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[10] = { complete: async ({ request }) => { requests.push(request); return { ok: true, data: { model: request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } }; } };
  args[21] = { turnTier: () => async () => { throw new Error('router down'); } };
  await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'tier-throw-1', conversationRef: 'app-1', surface: 'app', text: 'hi', memoryWrites: false }), time);
  expect(requests.map(request => request.model)).toEqual([OPENAI_GPT_6_1_SOL_MODEL]);
});

it('logs one content-free turn_tier hop whose input tokens bill at the router price', async () => {
  const { owner, logs } = responder({ routes: [SIMPLE] });
  await owner.respond(ownerTyped({ traceId: 'tier-log-1', conversationRef: 'app-1', surface: 'app', text: 'good morning Waldo', memoryWrites: false }), time);
  const hops = logs.filter(entry => entry.hop === 'turn_tier');
  expect(hops).toHaveLength(1);
  expect(hops[0]).toMatchObject({ trace: 'tier-log-1', ok: true, code: 'simple', detail: 'tier=simple reason=simple confidence=0.95', usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 80, output: 0, cached: 0 } });
  expect(hops[0]!.text).toBeUndefined();
  expect(JSON.stringify(hops[0])).not.toContain('good morning');
});

it('shows the router the previous exchange, without an earlier message that carries a held topic', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('turn-tier-held')), async (_instance, state) => {
    const store = canonicalOwnerConversationStore(state.storage, { invocation: localTrustedBriefScheduleInput().admission as never, assertCurrent: async () => undefined });
    const memory = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const { owner, asked } = responder({ routes: [SIMPLE], store, memory });
    await owner.respond(ownerTyped({ traceId: 'tier-held-1', conversationRef: 'owner', surface: 'app', text: 'plan coffee with Sam on Friday', memoryWrites: false, runScope: scope('held-run-1') }), time);
    await owner.respond(ownerTyped({ traceId: 'tier-held-2', conversationRef: 'owner', surface: 'app', text: 'same coffee plan for Saturday', memoryWrites: false, runScope: scope('held-run-2') }), time);
    expect(asked[1]).toEqual({ current: 'same coffee plan for Saturday', previousOwner: 'plan coffee with Sam on Friday', previousReply: 'Done.' });
    memory.beginTopicCoverage('coffee', new Date().toISOString());
    await owner.respond(ownerTyped({ traceId: 'tier-held-3', conversationRef: 'owner', surface: 'app', text: 'and Sunday?', memoryWrites: false, runScope: scope('held-run-3') }), time);
    expect(asked[2]).toEqual({ current: 'and Sunday?', previousReply: 'Done.' });
    expect(JSON.stringify(asked.slice(2))).not.toContain('coffee');
  });
});

it('the deployed router asks the Decisions API once per owner turn, through the real sanitiser, and never for a reminder', async () => {
  decisions.posts.length = 0;
  decisions.answer = { answers: [{ type: 'choice', name: 'tier', choice: 'simple', confidence: 0.92, probabilities: [{ value: 'simple', probability: 0.92 }, { value: 'complex', probability: 0.06 }, { value: 'other', probability: 0.02 }] }], usage: { input_tokens: 64 } };
  const requests: LLMRequest[] = [];
  const args: Parameters<typeof createOwnerResponder> = ['fixture-key'];
  args[10] = { complete: async ({ request }) => { requests.push(request); return { ok: true, data: { model: request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } }; } };
  args[21] = { turnTier: liveTurnTier('fixture-key') };
  const hops: TurnLogEntry[] = [];
  args[3] = entry => hops.push(entry);
  const owner = createOwnerResponder(...args);
  await owner.respond(ownerTyped({ traceId: 'tier-live-1', conversationRef: 'app-1', surface: 'app', text: 'what is on my calendar tomorrow?', memoryWrites: false }), time);
  await owner.remind('tier-live-2', 'app-1', 'call Sam', time, 'app');
  expect(hops.filter(hop => hop.hop === 'turn_tier').map(hop => hop.detail)).toEqual(['tier=simple reason=simple confidence=0.92']);
  expect(decisions.posts.map(post => post.path)).toEqual(['/decisions']);
  expect((decisions.posts[0]!.body as { input: string }).input).toContain('what is on my calendar tomorrow?');
  expect(requests.map(request => request.model)).toEqual([OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_LUNA_MODEL]);
});
