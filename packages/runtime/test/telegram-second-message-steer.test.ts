import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { triggerTypeSchema, TOOL_PERMISSIONS, type LLMResponse, type LLMToolCall, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { ownerTyped } from './helpers/owner-typed';

// Characterises the one surface with a steer path today (Telegram, internal only): what a second owner message does to the
// running turn, depending on when it lands. These tests pin current behaviour, not the target design
// (docs/proposals/WALDO_SECOND_MESSAGE_DESIGN_2026-10-31.md). The owner DO side (owner-do.ts drainInbox) closes a run that
// throws as execution_uncertain, sends the uncertain-outcome notice, and returns the unheard steer to the FIFO as its own turn;
// owner-do-ingress-isolation.test.ts covers that half.
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const call = (n: number, name: string, args: object): LLMToolCall => ({ call_id: `m${n}`, name, arguments: JSON.stringify(args) });
const handlers = [{ name: 'get_context' as const, description: 'Owner context.', schema: z.object({ topic: z.string() }), trigger_allowlist: allowlist('get_context'), autonomy_gated: false,
  handle: async () => ({ ok: true as const, data: {}, source_taint: null }) }];
const STEER = { text: 'also, is it raining in Pune?', foreignRanges: [] };

// A model that calls one tool in its first round and answers in its second; `during` runs inside the first model call.
const scripted = (messages: string[], during: () => void = () => undefined): LLMGatewayAdapter => ({ complete: async ({ request }) => {
  if (!request.tools?.length) return { ok: true, data: { model: request.model, text: 'ok', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 } };
  messages.push(String(request.messages.at(-1)?.content ?? ''));
  if (messages.length === 1) during();
  const toolCalls = messages.length === 1 ? [call(1, 'get_context', { topic: 'week' })] : undefined;
  const data: LLMResponse = toolCalls
    ? { model: request.model, text: '', tool_calls: toolCalls, output_items: toolCalls.map((item) => ({ type: 'function_call', id: `fc_${item.call_id}`, ...item })), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 }
    : { model: request.model, text: 'Here are three Goa flights.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1 };
  return { ok: true, data };
} });

it('B landing while A waits on the model is folded into A\'s next round: one answer for both, and B never gets its own turn', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('telegram-second-steer-model')), async () => {
    const messages: string[] = [];
    let responder: ReturnType<typeof createOwnerResponder> | undefined;
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[5] = handlers as never; args[10] = scripted(messages, () => expect(responder!.control.steerTarget('run', 5, STEER)).toBe(true));
    responder = createOwnerResponder(...args);
    responder.control.bindTarget('run');
    const reply = await responder.respond(ownerTyped({ traceId: 'telegram-second-steer-model', conversationRef: 'steer', surface: 'telegram', text: 'find me three flights to Goa for Friday' }), time);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('[While you were working, the owner added: "also, is it raining in Pune?". Take it into account in this answer.]');
    expect(reply).toContain('Here are three Goa flights.');
    expect(responder.control.absorbed(5)).toBe(true);
  });
});

it('B landing while A\'s round is still building its context closes A outright: the run throws and A gets no answer', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('telegram-second-steer-context')), async () => {
    const messages: string[] = [];
    let responder: ReturnType<typeof createOwnerResponder> | undefined, steered = false;
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[5] = handlers as never; args[10] = scripted(messages);
    // Standing orders are read while the first round assembles its context, after the round noted the steer revision.
    args[13] = () => { if (!steered) { steered = true; expect(responder!.control.steerTarget('run', 5, STEER)).toBe(true); } return ''; };
    responder = createOwnerResponder(...args);
    responder.control.bindTarget('run');
    await expect(responder.respond(ownerTyped({ traceId: 'telegram-second-steer-context', conversationRef: 'steer', surface: 'telegram', text: 'find me three flights to Goa for Friday' }), time))
      .rejects.toBeInstanceOf(ClosedRunError);
    expect(messages).toHaveLength(0);
    expect(responder.control.absorbed(5)).toBe(false);
  });
});
