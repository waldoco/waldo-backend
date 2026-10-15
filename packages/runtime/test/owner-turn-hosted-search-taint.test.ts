import { expect, it } from 'vitest';
import { sendMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type LLMResponse } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { ownerTyped } from './helpers/owner-typed';

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const call = { call_id: 'm1', name: 'send_message', arguments: JSON.stringify({ channel: 'telegram', content: 'Booked it.', idempotency_key: 'e'.repeat(64) }) };
const SEARCH = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'quiet hotels near the venue' } };

// One owner turn whose first response asks to send a message, with or without a hosted web search in the same response.
const turn = async (searched: boolean) => {
  let sent = 0;
  const send = {
    name: 'send_message' as const, description: 'Queue a message.', schema: sendMessageArgsSchema, autonomy_gated: true,
    trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('send_message')),
    handle: async () => { sent += 1; return { ok: true as const, data: { queued: true }, source_taint: null }; },
  };
  let calls = 0;
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    calls += 1;
    const data: LLMResponse = calls === 1
      ? { model: request.model, text: '', tool_calls: [call], output_items: [...(searched ? [SEARCH] : []), { type: 'function_call', id: 'fc_1', ...call }], input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }
      : { model: request.model, text: 'Done.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 };
    return { ok: true, data };
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[5] = [send as never]; args[10] = gateway;
  await createOwnerResponder(...args).respond(ownerTyped({ traceId: `search-taint-${searched}`, conversationRef: 'telegram-1', surface: 'telegram', text: 'book the quieter hotel and tell Sam', memoryWrites: false }), time);
  return sent;
};

it('a privileged call in the same response as a hosted web search is refused by the turn taint gate', async () => {
  expect(await turn(false)).toBe(1);
  expect(await turn(true)).toBe(0);
});
