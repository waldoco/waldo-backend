import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_PROVIDER,
} from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { MODEL_UNREACHABLE_REPLY } from '../src/llm/owner-routes';
import { InMemoryCircuitBreaker, type LLMGatewayAdapter } from '../src/llm/provider';
import { getContextHandler } from '../src/tools/live/get-context';
import { faultInjectedProviders, type ProviderEvent } from './helpers/fault-injection';
import { ownerTyped } from './helpers/owner-typed';

// The owner path under injected provider faults: both real adapters, the real provider loop, the real tool loop. What
// the owner gets back, which models were asked, and that no tool ran twice or ran on a malformed call.

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const answered: ProviderEvent = { text: 'Here is your day.' };

const owner = (gateway: LLMGatewayAdapter, options: Readonly<{ floorReply?: boolean; health?: InMemoryCircuitBreaker; log?: (entry: TurnLogEntry) => void }> = {}) => {
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic', floorReply: options.floorReply ?? true, ...(options.health ? { health: options.health } : {}) }];
  args[3] = options.log ?? (() => undefined);
  args[5] = [getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-10-20T08:20:00Z') })];
  args[10] = gateway;
  args[18] = ['👌'];
  return createOwnerResponder(...args);
};
let turns = 0;
const ask = (responder: ReturnType<typeof owner>, text = 'what is on today') =>
  responder.respond(ownerTyped({ traceId: `fault-${turns += 1}`, conversationRef: 'telegram-1', surface: 'telegram', text, memoryWrites: false }), time);

describe('an owner turn while the primary is failing', () => {
  it.each<[string, ProviderEvent]>([
    ['a 5xx storm', { fault: 'server_error', status: 503 }],
    ['an overloaded provider (529)', { fault: 'server_error', status: 529 }],
    ['requests that never answer', { fault: 'timeout' }],
    ['empty replies', { fault: 'empty' }],
  ])('is answered by Opus during %s, after one resend of the primary', async (_name, fault) => {
    const { gateway, models } = faultInjectedProviders({ [OPENAI_PROVIDER]: [fault], [ANTHROPIC_PROVIDER]: [answered] }, { timeoutMs: 5 });
    await expect(ask(owner(gateway))).resolves.toBe('Here is your day.');
    expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]);
  });

  it('is answered by Opus during a 429 storm without sitting out the provider\'s retry-after', async () => {
    const { gateway, models } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ fault: 'rate_limited', retryAfterS: 30 }], [ANTHROPIC_PROVIDER]: [answered] });
    const started = Date.now();
    await expect(ask(owner(gateway))).resolves.toBe('Here is your day.');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]);
  });

  it('a 429 storm across turns opens the shared breaker, and later turns stop asking OpenAI', async () => {
    const { gateway, calls } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ fault: 'rate_limited' }], [ANTHROPIC_PROVIDER]: [answered] });
    const health = new InMemoryCircuitBreaker();
    const breakers: string[] = [];
    const log = (entry: TurnLogEntry) => { if (entry.hop === 'provider_breaker') breakers.push(entry.detail ?? ''); };
    for (let turn = 0; turn < 4; turn += 1) await expect(ask(owner(gateway, { health, log }))).resolves.toBe('Here is your day.');
    expect(calls.filter((call) => call.provider === OPENAI_PROVIDER)).toHaveLength(3);
    expect(calls.filter((call) => call.provider === ANTHROPIC_PROVIDER)).toHaveLength(4);
    expect(breakers).toEqual([OPENAI_PROVIDER]);
  });
});

describe('an owner turn when every provider is failing', () => {
  it('reads the floor line when the floor is on', async () => {
    const { gateway, models } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ fault: 'server_error' }], [ANTHROPIC_PROVIDER]: [{ fault: 'rate_limited' }] });
    await expect(ask(owner(gateway))).resolves.toBe(MODEL_UNREACHABLE_REPLY);
    expect(models()).toEqual([OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_SOL_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]);
  });

  it('fails to the channel, as before, when the floor is off', async () => {
    const { gateway } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ fault: 'timeout' }], [ANTHROPIC_PROVIDER]: [{ fault: 'server_error', status: 502 }] }, { timeoutMs: 5 });
    await expect(ask(owner(gateway, { floorReply: false }))).rejects.toThrow(/live model failed/);
  });
});

describe('malformed tool calls', () => {
  const ran = (log: TurnLogEntry[]) => log.filter((entry) => entry.hop === 'tool_get_context' && entry.ok);

  it('a call whose arguments are not JSON runs nothing; the model hears why and the turn still answers', async () => {
    const { gateway, calls } = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ tool: 'get_context', args: '{"topic": "day"' }, answered] });
    const log: TurnLogEntry[] = [];
    await expect(ask(owner(gateway, { log: (entry) => log.push(entry) }))).resolves.toBe('Here is your day.');
    expect(ran(log)).toHaveLength(0);
    expect(calls.map((call) => call.provider)).toEqual([OPENAI_PROVIDER, OPENAI_PROVIDER]);
  });

  it.each([OPENAI_PROVIDER, ANTHROPIC_PROVIDER] as const)('a call to a tool that does not exist runs nothing (%s answering)', async (provider) => {
    const script: ProviderEvent[] = [{ tool: 'transfer_funds', args: '{"amount":100}' }, answered];
    const { gateway, calls } = faultInjectedProviders(provider === OPENAI_PROVIDER ? { [OPENAI_PROVIDER]: script } : { [OPENAI_PROVIDER]: [{ fault: 'server_error' }], [ANTHROPIC_PROVIDER]: script });
    const log: TurnLogEntry[] = [];
    await expect(ask(owner(gateway, { log: (entry) => log.push(entry) }))).resolves.toBe('Here is your day.');
    expect(log.filter((entry) => entry.hop.startsWith('tool_') && entry.ok)).toHaveLength(0);
    expect(calls.filter((call) => call.provider === provider).length).toBeGreaterThanOrEqual(2);
  });
});

describe('a side job while the primary is failing', () => {
  it('reaches Haiku after Luna, and fails to its caller when Haiku is down too', async () => {
    const down = faultInjectedProviders({ [OPENAI_PROVIDER]: [{ fault: 'server_error' }], [ANTHROPIC_PROVIDER]: [{ fault: 'server_error' }] });
    await expect(owner(down.gateway).chooseReaction(ownerTyped({ traceId: 'fault-reaction-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'thanks' }))).rejects.toThrow(/live model failed/);
    expect(down.models()).toEqual([OPENAI_GPT_6_LUNA_MODEL, OPENAI_GPT_6_LUNA_MODEL, ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]);
  });
});
