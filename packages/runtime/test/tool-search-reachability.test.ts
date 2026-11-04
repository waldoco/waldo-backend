import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, OPENAI_GPT_6_1_SOL_MODEL, TOOL_PERMISSIONS, triggerTypeSchema, type ModelName, type ToolName } from '@waldo/contracts';
import { loopCheckBackText, LOOP_CHECK_BACK_TOOLS } from '../src/channels/check-back';
import type { Loop } from '../src/channels/loops';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { claimStore, type ClaimStore } from '../src/memory/claims';
import { ownerTyped } from './helpers/owner-typed';

// With tool search on, a deferred tool reaches the model by name alone: OpenAI shows each namespace's description and loads
// its functions when the model searches, and Anthropic's search tool matches a deferred tool's own name and description.
// So when the harness tells the model to call a tool (page a stored output, read a recalled message, close a due loop),
// the request that says so must offer that tool: loaded up front, or deferred where a search finds it by that name.
const time = async <T,>(_hop: string, work: () => Promise<T>) => work();
const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const handler = (name: ToolName, result: () => object) => ({ name, description: `The ${name} tool.`, schema: z.object({}).passthrough(), trigger_allowlist: allowlist(name), autonomy_gated: false, handle: async () => result() });

type WireTool = Readonly<{ type?: string; name?: string; description?: string; tools?: readonly WireTool[]; defer_loading?: boolean }>;
const reachable = {
  openai: (tools: readonly WireTool[], name: string) =>
    tools.some((tool) => tool.type === 'function' && tool.name === name && tool.defer_loading !== true)
    || (tools.some((tool) => tool.type === 'tool_search') && tools.some((tool) => tool.type === 'namespace' && tool.description?.includes(name) === true && tool.tools?.some((member) => member.name === name) === true)),
  anthropic: (tools: readonly WireTool[], name: string) =>
    tools.some((tool) => tool.name === name && (tool.defer_loading !== true || tools.some((search) => search.name === 'tool_search_tool_bm25'))),
};

type Wire = Readonly<{ provider: keyof typeof reachable; model: ModelName; bodies: Record<string, unknown>[]; gateway: LLMGatewayAdapter; said: (body: Record<string, unknown>) => string }>;
// Each provider's real adapter with a recording client: the bodies are what the provider would be sent. The model calls
// the scripted tool once, on the first round that offers tools, and then answers.
const wire = (provider: keyof typeof reachable, call?: Readonly<{ name: ToolName; args: object }>): Wire => {
  const bodies: Record<string, unknown>[] = [];
  let called = call === undefined;
  const next = (body: Record<string, unknown>) => {
    bodies.push(body);
    const calls = !called && body.tools !== undefined;
    if (calls) called = true;
    return calls;
  };
  if (provider === 'openai') {
    const client = { responses: { create: async (body: Record<string, unknown>) => {
      const output = next(body) ? [{ type: 'function_call', id: 'fc_1', call_id: 'c1', name: call!.name, arguments: JSON.stringify(call!.args) }] : [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }];
      return { id: `r${bodies.length}`, status: 'completed', output, output_text: output[0]!.type === 'message' ? 'Done.' : '', usage: { input_tokens: 1, output_tokens: 1 } };
    } } } as unknown as OpenAIResponsesClient;
    return { provider, model: OPENAI_GPT_6_1_SOL_MODEL, bodies, gateway: new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }), said: (body) => JSON.stringify(body.input) };
  }
  const client = { messages: { create: async (body: Record<string, unknown>) => {
    const calls = next(body);
    const content = calls ? [{ type: 'tool_use', id: 'c1', name: call!.name, input: call!.args }] : [{ type: 'text', text: 'Done.' }];
    return { id: 'msg', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, stop_reason: calls ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  } } } as never;
  return { provider, model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, bodies, gateway: new AnthropicMessagesAdapter({ apiKey: 'synthetic-key-0123456789', client }), said: (body) => JSON.stringify(body.messages) };
};

const responder = (at: Wire, tools: readonly ReturnType<typeof handler>[], memory?: ClaimStore) => {
  const args: Parameters<typeof createOwnerResponder> = [{ openaiApiKey: 'synthetic-key-0123456789', anthropicApiKey: 'synthetic-key-0123456789', toolSearch: true }];
  if (memory) args[2] = memory;
  args[4] = { timezone: 'UTC', now: () => new Date(Date.UTC(2030, 10, 4, 9)) };
  args[5] = tools as never; args[6] = at.model; args[7] = true; args[10] = at.gateway; args[15] = at.model;
  return createOwnerResponder(...args);
};

// The request whose text carries the harness's instruction, and its wire tools.
const naming = (at: Wire, words: string) => {
  const body = at.bodies.find((sent) => sent.tools !== undefined && at.said(sent).includes(words));
  expect(body, `a ${at.provider} request carried "${words}"`).toBeDefined();
  return body!.tools as WireTool[];
};

describe.each(['openai', 'anthropic'] as const)('with tool search on, %s can call the tool the harness names', (provider) => {
  it('read_tool_output, on the round after a result too large to show', async () => {
    const at = wire(provider, { name: 'read_thread', args: { thread_id: 't1' } });
    const long = handler('read_thread', () => ({ ok: true, data: { body: 'Synthetic thread line. '.repeat(1_000) }, source_taint: 'external' }));
    await responder(at, [long]).respond(ownerTyped({ traceId: `stored-${provider}`, conversationRef: `stored-${provider}`, surface: 'app', text: 'what did the long thread say?', memoryWrites: false }), time);
    expect(reachable[provider](naming(at, 'read_tool_output'), 'read_tool_output')).toBe(true);
  });

  it('close_loop, on a loop check-back', async () => {
    const at = wire(provider);
    const loop: Loop = { id: 'loop-1', title: 'Find the venue hours', due: '2030-11-04T09:00', status: 'open', created_at: 0, closed_at: null };
    const tools = [handler('get_context', () => ({ ok: true, data: { now: 'synthetic' }, source_taint: null })), handler('close_loop', () => ({ ok: true, data: { closed: true }, source_taint: null }))];
    await responder(at, tools).prompt(`loop-${provider}`, `loop-${provider}`, loopCheckBackText([loop]), time, 'app', LOOP_CHECK_BACK_TOOLS);
    expect(reachable[provider](naming(at, 'with close_loop'), 'close_loop')).toBe(true);
  });

  it('search_episodes, on a turn whose recall points at past messages', async () => {
    const at = wire(provider);
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`reachable-recall-${provider}`)), async (_instance, state) => {
      const memory = claimStore(state.storage.sql);
      memory.add({ kind: 'fact', text: 'The gym locker code is on the blue card', source: 'stated', evidence: '"locker on the blue card"', origin: 'owner', source_ref: 'owner, tg-1' }, '2030-11-01T09:00:00.000Z');
      const search = handler('search_episodes', () => ({ ok: true, data: { hits: [] }, source_taint: 'external' }));
      await responder(at, [search], memory).respond(ownerTyped({ traceId: `recall-${provider}`, conversationRef: `recall-${provider}`, surface: 'app', text: 'where is my gym locker code?', memoryWrites: false }), time);
    });
    expect(reachable[provider](naming(at, 'with search_episodes by its ref'), 'search_episodes')).toBe(true);
  });
});
