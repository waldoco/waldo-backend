import { expect, it } from 'vitest';
import { sendMessageArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type LLMResponse } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { ownerTyped } from './helpers/owner-typed';

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const call = (n: number) => ({ call_id: `m${n}`, name: 'send_message', arguments: JSON.stringify({ channel: 'telegram', content: `Note ${n}.`, idempotency_key: String(n).repeat(64).slice(0, 64) }) });

// The provider's prompt cache matches on an unchanged prefix, so a system prompt that moves mid-turn bills every later call in full.
it('every model call of one owner turn sends the same system prompt while the wall clock moves on', async () => {
  let minute = 0;
  const clock = { timezone: 'Asia/Kolkata', now: () => new Date(Date.UTC(2026, 9, 15, 1, 23 + minute, 30)) };
  const send = {
    name: 'send_message' as const, description: 'Queue a message.', schema: sendMessageArgsSchema, autonomy_gated: true,
    trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('send_message')),
    handle: async () => ({ ok: true as const, data: { queued: true }, source_taint: null }),
  };
  const systems: string[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    if (!request.tools?.length) return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
    systems.push(request.system ?? '');
    minute += 2;
    const round = systems.length;
    const data: LLMResponse = round < 3
      ? { model: request.model, text: '', tool_calls: [call(round)], output_items: [{ type: 'function_call', id: `fc_${round}`, ...call(round) }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }
      : { model: request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 };
    return { ok: true, data };
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[4] = clock; args[5] = [send as never]; args[10] = gateway;
  const responder = createOwnerResponder(...args);
  await responder.respond(ownerTyped({ traceId: 'stable-prefix-1', conversationRef: 'telegram-1', surface: 'telegram', text: 'send two notes', memoryWrites: false }), time);

  expect(systems).toHaveLength(3);
  expect(systems[0]).toContain('at 06:53');
  expect(new Set(systems).size).toBe(1);

  // The next turn reads the clock again.
  systems.length = 0;
  await responder.respond(ownerTyped({ traceId: 'stable-prefix-2', conversationRef: 'telegram-1', surface: 'telegram', text: 'send two more', memoryWrites: false }), time);
  expect(systems[0]).toContain('at 06:59');
});
