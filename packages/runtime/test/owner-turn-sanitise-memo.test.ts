import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { forgetMemoryArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type LLMRequest, type LLMResponse, type SanitiseInput, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ownerTyped } from './helpers/owner-typed';

// The owner turn scans its system prompt once and reuses the result on later rounds, but never across a forget or a turn.
const scans = vi.hoisted(() => ({ calls: [] as SanitiseInput[] }));
vi.mock('../src/scribe/sanitiser', async load => {
  const original = await load<typeof import('../src/scribe/sanitiser')>();
  return { ...original, sanitise: (input: SanitiseInput) => { scans.calls.push(input); return original.sanitise(input); } };
});

const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

const twoTurns = async (name: string, firstCall: 'get_context' | 'forget_memory') => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`sanitise-memo-${name}`)), async (_instance, state) => {
  scans.calls = [];
  const handlers = [
    { name: 'get_context' as const, description: 'Owner context.', schema: z.object({}), trigger_allowlist: allowlist('get_context'), autonomy_gated: false,
      handle: async () => ({ ok: true as const, data: {}, source_taint: null }) },
    { name: 'forget_memory' as const, description: 'Forget a topic.', schema: forgetMemoryArgsSchema, trigger_allowlist: allowlist('forget_memory'), autonomy_gated: false, mutates_state: true,
      handle: async () => ({ ok: true as const, data: { forgotten: 0 }, source_taint: null }) },
  ];
  const replies: LLMRequest[] = [];
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    const done = (data: Partial<LLMResponse>) => ({ ok: true as const, data: { model: request.model, text: '', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 1, ...data } });
    if (request.response_format) return done({ text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' });
    if (!request.tools?.length) return done({ text: 'ok' });
    replies.push(request);
    if (request.tool_turns?.length) return done({ text: 'Done.' });
    const call = { call_id: `c${replies.length}`, name: replies.length === 1 ? firstCall : 'get_context', arguments: replies.length === 1 && firstCall === 'forget_memory' ? JSON.stringify({ topic: 'zebra crossings', scope_note: 'the owner asked' }) : '{}' };
    return done({ tool_calls: [call], output_items: [{ type: 'function_call', id: `fc_${call.call_id}`, ...call }] });
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[2] = claimStore(state.storage.sql); args[5] = handlers as never; args[10] = gateway;
  const responder = createOwnerResponder(...args);
  const systemScans: number[] = [];
  for (const [turn, text] of ['plan my week', 'and the weekend?'].entries()) {
    await responder.respond(ownerTyped({ traceId: `sanitise-memo-${name}-${turn}`, conversationRef: `${name}-1`, surface: 'telegram', text, memoryWrites: true }), time);
    systemScans.push(scans.calls.filter((call) => call.destination === 'system_prompt' && call.payload === replies.at(-1)!.system).length);
  }
  return { replies, systemScans };
});

it('scans the system prompt once per turn across its rounds, and again on the next turn', async () => {
  const { replies, systemScans } = await twoTurns('plain', 'get_context');
  expect(replies).toHaveLength(4);
  expect(new Set(replies.map((request) => request.system)).size).toBe(1);
  expect(systemScans).toEqual([1, 2]);
});

it('scans the system prompt again after a forget lands mid-turn, though its text did not change', async () => {
  const { replies, systemScans } = await twoTurns('forget', 'forget_memory');
  expect(replies[1]!.tool_turns?.[0]).toMatchObject({ call: { name: 'forget_memory' }, output: expect.stringContaining('"ok":true') });
  expect(replies[1]!.system).toBe(replies[0]!.system);
  expect(systemScans).toEqual([2, 3]);
});
