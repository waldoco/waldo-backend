import { expect, it } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_PROVIDER,
  type ErrorCode,
  type Provider,
} from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { MODEL_UNREACHABLE_REPLY, ownerModelGateway, ownerRoutePolicy } from '../src/llm/owner-routes';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { getContextHandler } from '../src/tools/live/get-context';
import { ownerTyped } from './helpers/owner-typed';

// The owner path's routes under a provider failure: the owner's turn moves to the second provider and finishes without
// running a tool twice; when every provider is down the owner reads an honest line instead of "please try again"; side
// jobs reach their small second model and never a template.

type Step = Readonly<{ tool: string; topic: string }> | Readonly<{ text: string }> | Readonly<{ fail: ErrorCode }>;
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();

// One script per provider, consumed one step per call; the last step repeats, so a provider scripted to fail stays down.
const scriptedProviders = (scripts: Partial<Record<Provider, readonly Step[]>>) => {
  const requests: LLMGatewayRequest[] = [];
  const queues = new Map<Provider, Step[]>();
  let calls = 0;
  const gateway: LLMGatewayAdapter = { complete: async (input) => {
    requests.push(input);
    const queue = queues.get(input.step.provider) ?? queues.set(input.step.provider, [...(scripts[input.step.provider] ?? [{ fail: 'transient' }])]).get(input.step.provider)!;
    const step = queue.length > 1 ? queue.shift()! : queue[0]!;
    if ('fail' in step) return { ok: false, code: step.fail, error: `${input.step.provider} is down` };
    const base = { model: input.request.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 1 };
    if ('text' in step) return { ok: true, data: { ...base, text: step.text } };
    return { ok: true, data: { ...base, text: '', tool_calls: [{ call_id: `${input.step.provider}-${calls++}`, name: step.tool, arguments: JSON.stringify({ topic: step.topic }) }] } };
  } };
  return { gateway, requests, models: () => requests.map((request) => request.request.model) };
};

const responder = (gateway: LLMGatewayAdapter, log: (entry: TurnLogEntry) => void = () => undefined, floorReply = true) => {
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', floorReply }];
  args[3] = log; args[5] = [getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-10-20T08:20:00Z') })]; args[10] = gateway; args[18] = ['👌'];
  return createOwnerResponder(...args);
};

it('an owner turn whose primary dies after round 2 of 4 is finished by the Anthropic fallback without running a tool twice', async () => {
  const { gateway, requests } = scriptedProviders({
    [OPENAI_PROVIDER]: [{ tool: 'get_context', topic: 'one' }, { tool: 'get_context', topic: 'two' }, { fail: 'transient' }],
    [ANTHROPIC_PROVIDER]: [{ tool: 'get_context', topic: 'three' }, { text: 'All four rounds done.' }],
  });
  const executed: string[] = [];
  const owner = responder(gateway, (entry) => { if (entry.hop === 'tool_get_context' && entry.ok) executed.push(entry.text?.input ?? ''); });
  const reply = await owner.respond(ownerTyped({ traceId: 'fallback-turn-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'walk me through my day in four steps', memoryWrites: false }), time);
  expect(reply).toBe('All four rounds done.');
  // Three tool rounds ran: one effect each, none repeated by the provider that took over.
  expect(executed.map((input) => JSON.parse(input).topic)).toEqual(['one', 'two', 'three']);
  const anthropicRequests = requests.filter((request) => request.step.provider === ANTHROPIC_PROVIDER);
  expect(anthropicRequests.map((request) => request.request.model)).toEqual([ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]);
  // The fallback saw the earlier rounds' calls and results, so it continued the turn instead of restarting it.
  expect(anthropicRequests[0]!.request.tool_turns?.map((turn) => JSON.parse(turn.call.arguments).topic)).toEqual(['one', 'two']);
  expect(anthropicRequests[1]!.request.tool_turns?.map((turn) => JSON.parse(turn.call.arguments).topic)).toEqual(['one', 'two', 'three']);
});

it('an owner turn tries Sol with full then reduced context, then Opus, then the floor', async () => {
  const { gateway, models } = scriptedProviders({});
  const hops: TurnLogEntry[] = [];
  const owner = responder(gateway, (entry) => { if (entry.hop === 'llm_reply') hops.push(entry); });
  const reply = await owner.respond(ownerTyped({ traceId: 'fallback-turn-2', conversationRef: 'telegram-1', surface: 'telegram', text: 'what is on today', memoryWrites: false }), time);
  expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]);
  expect(reply).toBe(MODEL_UNREACHABLE_REPLY);
  expect(hops).toHaveLength(1);
  expect(hops[0]).toMatchObject({ ok: true });
});

it('an owner turn without the floor reply fails the way it did before, once every provider has failed', async () => {
  const { gateway, models } = scriptedProviders({});
  const owner = responder(gateway, undefined, false);
  await expect(owner.respond(ownerTyped({ traceId: 'fallback-turn-3', conversationRef: 'telegram-1', surface: 'telegram', text: 'what is on today', memoryWrites: false }), time)).rejects.toThrow(/live model failed/);
  expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]);
});

it('a side job tries Luna with full then reduced context, then Haiku, and never answers from a template', async () => {
  const { gateway, models } = scriptedProviders({});
  const owner = responder(gateway);
  await expect(owner.chooseReaction(ownerTyped({ traceId: 'fallback-reaction-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'thanks' }))).rejects.toThrow(/live model failed/);
  expect(models()).toEqual([OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_LUNA_MODEL, ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]);
});

it('a side job answered by Haiku returns its answer', async () => {
  const { gateway, models } = scriptedProviders({ [ANTHROPIC_PROVIDER]: [{ text: '{"reaction":"👌"}' }] });
  const owner = responder(gateway);
  await expect(owner.chooseReaction(ownerTyped({ traceId: 'fallback-reaction-2', conversationRef: 'telegram-1', surface: 'telegram', text: 'thanks' }))).resolves.toBe('👌');
  expect(models()).toEqual([OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_LUNA_MODEL, ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]);
});

it('the owner gateway fails a step without its provider key as auth_failed, before any network call', async () => {
  const route = ownerRoutePolicy(OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, { openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic' }).routes[0]!;
  const step = route.fallback[0]!;
  const request = {
    request: { model: step.model, system: 'Be concise.', messages: [{ role: 'user' as const, content: 'hello' }], max_tokens: 32, temperature: 0.2 },
    route, step, context: 'reduced_context' as const, fallback_step: 'gateway_chain' as const, headers: { 'cf-aig-collect-log-payload': 'false' as const },
  };
  await expect(ownerModelGateway({ openaiApiKey: 'fixture-openai' }).complete(request)).resolves.toMatchObject({ ok: false, code: 'auth_failed' });
});

it('with no second-provider key deployed the route has no fallback step, so a failing turn asks only OpenAI, as before', async () => {
  const { gateway, models } = scriptedProviders({});
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai' }];
  args[5] = [getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-10-20T08:20:00Z') })]; args[10] = gateway;
  await expect(createOwnerResponder(...args).respond(ownerTyped({ traceId: 'no-key-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'what is on today', memoryWrites: false }), time)).rejects.toThrow(/live model failed/);
  expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL]);
  // A malformed key counts as no key: the adapter would refuse it without a call.
  expect(ownerRoutePolicy(OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, { openaiApiKey: 'k', anthropicApiKey: 'bad key' }).routes[0]!.fallback).toEqual([]);
});
