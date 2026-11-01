import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  type LLMRequest,
} from '@waldo/contracts';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { CLAIM_OPS_SCHEMA, PROMOTION_SCHEMA, SOURCE_CLAIMS_SCHEMA } from '../src/memory/claims';
import { DAY_PLAN_SCHEMA } from '../src/prompt/day-cards';
import { WELCOME_SCHEMA } from '../src/onboarding/welcome';
import { reactionSchema } from '../src/channels/reactions';

// What the Messages API wants that the seam does not say: alternating roles, no sampling parameters on current
// models, tool definitions whenever tool blocks are replayed, and its own reasoning never edited, so never replayed.

function gatewayRequest(model: LLMRequest['model'] = ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, cache: 'none' | 'anthropic_native' = 'none'): LLMGatewayRequest {
  const step = { provider: ANTHROPIC_PROVIDER, model, cache };
  return {
    request: { model, system: 'Be concise.', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 32, temperature: 0.2, reasoning_effort: 'low' },
    route: { trigger: 'user_message', primary: step, fallback: [], floor: 'template' },
    step,
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: { 'cf-aig-collect-log-payload': 'false' },
  };
}

const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const reply = (content: unknown[], stop_reason = 'end_turn', extra: Record<string, unknown> = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, stop_reason, content, usage, ...extra });

const recording = (replies: unknown[]) => {
  const bodies: Array<Record<string, unknown>> = [];
  const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create: async (body: Record<string, unknown>) => { bodies.push(body); return replies[Math.min(bodies.length - 1, replies.length - 1)]; } } } as never });
  return { bodies, adapter };
};

describe('AnthropicMessagesAdapter request shape', () => {
  it('sends the system prompt, the roster model, the output cap and the effort, and no sampling parameters', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Hello.' }])]);
    await expect(adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: true, data: { text: 'Hello.' } });
    expect(bodies[0]).toMatchObject({ model: ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, system: 'Be concise.', max_tokens: 32, output_config: { effort: 'low' } });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).not.toHaveProperty('thinking');
  });

  it('sends a Sonnet request the same way: its model id, the cache breakpoint, no sampling and no thinking parameters', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Hello.' }])]);
    await expect(adapter.complete(gatewayRequest(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, 'anthropic_native'))).resolves.toMatchObject({ ok: true });
    expect(bodies[0]).toMatchObject({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, system: [{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }] });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).not.toHaveProperty('thinking');
  });

  it('marks the system prompt as a cache breakpoint on an anthropic_native step only', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Hello.' }])]);
    await adapter.complete(gatewayRequest(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, 'anthropic_native'));
    await adapter.complete(gatewayRequest());
    expect(bodies[0]!.system).toEqual([{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }]);
    expect(bodies[1]!.system).toBe('Be concise.');
  });

  it('keeps real roles and joins consecutive same-role entries into one message', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'B.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, messages: [
      { role: 'user', content: 'Show me two flights' }, { role: 'assistant', content: 'A at 9, B at 11' }, { role: 'user', content: '(context)' }, { role: 'user', content: 'that one' },
    ] } });
    expect(bodies[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Show me two flights' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'A at 9, B at 11' }] },
      { role: 'user', content: [{ type: 'text', text: '(context)' }, { type: 'text', text: 'that one' }] },
    ]);
  });

  it('attaches images and PDFs to the last user message and refuses other file types before calling', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Nice lunch.' }])]);
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, attachments: [
      { kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg', data_base64: 'AAAA' },
      { kind: 'file', mime_type: 'application/pdf', filename: 'plan.pdf', data_base64: 'BBBB' },
    ] } });
    expect(result.ok).toBe(true);
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'Say hello.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' }, title: 'plan.pdf' },
    ] }]);
    const refused = await adapter.complete({ ...base, request: { ...base.request, attachments: [{ kind: 'file', mime_type: 'application/zip', filename: 'x.zip', data_base64: 'CCCC' }] } });
    expect(refused).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(bodies).toHaveLength(1);
  });
});

describe('AnthropicMessagesAdapter tool rounds', () => {
  const tools = [{ name: 'get_context', description: 'Current time', parameters: { type: 'object', properties: {}, additionalProperties: false } }];
  const call = (n: number, name = 'get_context') => ({ call_id: `c${n}`, name, arguments: `{"n":${n}}` });

  it('declares function tools as Messages tools with their JSON schema', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'tool_use', id: 'c1', name: 'get_context', input: {} }], 'tool_use')]);
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools } });
    expect(bodies[0]!.tools).toEqual([{ name: 'get_context', description: 'Current time', input_schema: { type: 'object', properties: {}, additionalProperties: false } }]);
    expect(result).toMatchObject({ ok: true, data: { text: '', tool_calls: [{ call_id: 'c1', name: 'get_context', arguments: '{}' }] } });
  });

  it('groups a round of parallel calls into one assistant message and one tool_result message, in order', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    const first = { type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: { type: 'tool_use', id: 'c1', name: 'get_context', input: { n: 1 } } };
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_turns: [
      { call: call(1), output: 'o1', prior_items: [{ type: 'thinking', provider: ANTHROPIC_PROVIDER, block: { type: 'thinking', thinking: '', signature: 'sig' } }, first, { type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: { type: 'tool_use', id: 'c2', name: 'get_context', input: { n: 2 } } }] },
      { call: call(2), output: 'o2' },
      { call: call(3), output: 'o3', prior_items: [{ type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: { type: 'tool_use', id: 'c3', name: 'get_context', input: { n: 3 } } }] },
    ] } });
    expect(bodies[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'get_context', input: { n: 1 } }, { type: 'tool_use', id: 'c2', name: 'get_context', input: { n: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'o1' }, { type: 'tool_result', tool_use_id: 'c2', content: 'o2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c3', name: 'get_context', input: { n: 3 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c3', content: 'o3' }] },
    ]);
  });

  it('a round whose items were not kept (empty) still opens its own round, rebuilt from its call records', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_turns: [
      { call: call(1), output: 'o1', prior_items: [{ type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: { type: 'tool_use', id: 'c1', name: 'get_context', input: { n: 1 } } }] },
      { call: { call_id: 'c2', name: 'get_context', arguments: '{}' }, output: 'o2', prior_items: [] },
    ] } });
    expect(bodies[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'get_context', input: { n: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'o1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'get_context', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'o2' }] },
    ]);
  });

  it('rebuilds a round another provider ran from its call records, dropping that provider reasoning items', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_turns: [
      { call: call(1), output: 'o1', prior_items: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'c1', name: 'get_context', arguments: '{"n":1}' }] },
    ] } });
    expect(bodies[0]!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'get_context', input: { n: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'o1' }] },
    ]);
  });

  it('a call whose arguments are not JSON is replayed with an empty input', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_turns: [{ call: { call_id: 'c1', name: 'get_context', arguments: 'not json' }, output: 'o1' }] } });
    expect((bodies[0]!.messages as Array<{ content: unknown[] }>)[1]!.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'get_context', input: {} }]);
  });

  it('a final round with the tools withdrawn still defines the replayed tools, and forbids calling them', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tool_turns: [{ call: call(1), output: 'o1' }, { call: call(2, 'remember'), output: 'o2' }] } });
    expect(bodies[0]!.tools).toEqual([
      { name: 'get_context', description: 'Not offered this round.', input_schema: { type: 'object' } },
      { name: 'remember', description: 'Not offered this round.', input_schema: { type: 'object' } },
    ]);
    expect(bodies[0]!.tool_choice).toEqual({ type: 'none' });
  });

  it('returns its content blocks as provider-marked output items for the next round', async () => {
    const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'c1', name: 'get_context', input: {} }];
    const { adapter } = recording([reply(blocks, 'tool_use')]);
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools } });
    if (!result.ok) throw new Error(result.error);
    expect(result.data.output_items).toEqual(blocks.map((block) => ({ type: block.type, provider: ANTHROPIC_PROVIDER, block })));
  });
});

describe('AnthropicMessagesAdapter stop reasons', () => {
  it('a reply cut off by max_tokens with no text is oversize; with partial text it is delivered as truncated', async () => {
    const cut = recording([reply([{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens')]);
    await expect(cut.adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: false, code: 'oversize', spent: { input_tokens: 10, output_tokens: 3 } });
    const partial = recording([reply([{ type: 'text', text: 'partial answer' }], 'max_tokens')]);
    await expect(partial.adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: true, data: { text: 'partial answer', truncated: true } });
  });

  it('a refusal with no text is rejected, naming only the category', async () => {
    const { adapter } = recording([reply([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'secret explanation' } })]);
    const result = await adapter.complete(gatewayRequest());
    expect(result).toMatchObject({ ok: false, code: 'rejected', error: 'Anthropic refused the request (cyber)' });
    expect(JSON.stringify(result)).not.toContain('secret explanation');
  });

  it('counts cache writes into the prompt total and reports cache reads separately', async () => {
    const { adapter } = recording([reply([{ type: 'text', text: 'ok' }], 'end_turn', { usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 15 } })]);
    await expect(adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: true, data: { input_tokens: 50, output_tokens: 2, cache_read_input_tokens: 30, cache_write_input_tokens: 15 } });
  });

  it('reports response metadata without text', async () => {
    let metadata: unknown;
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create: async () => reply([{ type: 'text', text: 'Hello.' }]) } } as never, onResponseMetadata: (value) => { metadata = value; } });
    await adapter.complete(gatewayRequest(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL));
    expect(metadata).toEqual({ response_id: 'msg_1', model: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, input_tokens: 10, output_tokens: 3, latency_ms: expect.any(Number), stop_reason: 'end_turn' });
  });
});

describe('AnthropicMessagesAdapter tool search', () => {
  const tools = [
    { name: 'get_context', description: 'Current time', parameters: { type: 'object', properties: {} } },
    { name: 'query_availability', description: 'Free and busy time', parameters: { type: 'object', properties: { day: { type: 'string' } } }, namespace: 'calendar', defer_loading: true },
  ];
  const tool_search = { namespaces: { calendar: 'Calendar changes and free time.' } };
  const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'free time' } };
  const found = { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'query_availability' }] } };
  const use = { type: 'tool_use', id: 'c1', name: 'query_availability', input: { day: '2030-11-04' } };
  const turns = [{ call: { call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }, output: 'free', prior_items: [search, found, use].map((block) => ({ type: block.type, provider: ANTHROPIC_PROVIDER, block })) }];

  it('marks deferred tools defer_loading behind the BM25 search tool, non-strict', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(bodies[0]!.tools).toEqual([
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { name: 'get_context', description: 'Current time', input_schema: { type: 'object', properties: {} } },
      { name: 'query_availability', description: 'Free and busy time', input_schema: { type: 'object', properties: { day: { type: 'string' } } }, defer_loading: true },
    ]);
  });

  it('replays the search blocks unchanged with no tool_result for them, and drops them from a closing round', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_search, tool_turns: turns } });
    await adapter.complete({ ...base, request: { ...base.request, tool_search, tool_turns: turns } });
    expect((bodies[0]!.messages as unknown[]).slice(1)).toEqual([
      { role: 'assistant', content: [search, found, use] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'free' }] },
    ]);
    expect((bodies[1]!.messages as unknown[]).slice(1)).toEqual([
      { role: 'assistant', content: [use] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'free' }] },
    ]);
    expect(bodies[1]!.tools).toEqual([{ name: 'query_availability', description: 'Not offered this round.', input_schema: { type: 'object' } }]);
  });

  it('a search call is not returned as a tool call for the loop to run', async () => {
    const { adapter } = recording([reply([search, found, use], 'tool_use')]);
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [{ call_id: 'c1', name: 'query_availability', arguments: '{"day":"2030-11-04"}' }] } });
    if (result.ok) expect(result.data.tool_calls).toHaveLength(1);
  });

  it('continues a response that only searched, with its blocks sent back, and returns the answer after them', async () => {
    const { bodies, adapter } = recording([reply([search, found], 'pause_turn'), reply([use], 'tool_use')]);
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages).toEqual([...bodies[0]!.messages as unknown[], { role: 'assistant', content: [search, found] }]);
    expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [{ call_id: 'c1', name: 'query_availability' }], input_tokens: 20, output_tokens: 6 } });
    // The searched blocks lead the answer's, so the next round replays the whole turn.
    if (result.ok) expect(result.data.output_items!.map((item) => item.type)).toEqual(['server_tool_use', 'tool_search_tool_result', 'tool_use']);
  });

  it('stops continuing a response that keeps only searching, and fails it as an empty answer', async () => {
    const { bodies, adapter } = recording([reply([search, found], 'pause_turn')]);
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(bodies).toHaveLength(3);
    expect(result).toMatchObject({ ok: false, code: 'transient' });
  });

  it('keeps the spend of a search-only response when its continuation fails', async () => {
    let calls = 0;
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create: async () => {
      calls += 1;
      if (calls === 1) return reply([search, found], 'pause_turn');
      throw new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } }, 'synthetic', new Headers());
    } } } as never });
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: false, code: 'invalid_args', spent: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0 } });
  });

  it('reports no spend for a first call that fails', async () => {
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create: async () => {
      throw new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } }, 'synthetic', new Headers());
    } } } as never });
    const base = gatewayRequest();
    const result = await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(result).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(result).not.toHaveProperty('spent');
  });

  // Each continuation is billed, so only a response whose every block is search work, and that holds a search result,
  // is continued; anything else is answered or failed on the call that returned it.
  it.each([
    ['holds no blocks at all', reply([], 'end_turn')],
    ['called the search but holds no result', reply([search], 'pause_turn')],
    ['also answered in text', reply([search, found, { type: 'text', text: 'Free at 3.' }], 'end_turn')],
    ['stopped at the output limit', reply([search, found], 'max_tokens')],
  ])('does not continue a response that %s', async (_case, response) => {
    const { bodies, adapter } = recording([response, reply([use], 'tool_use')]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_search } });
    expect(bodies).toHaveLength(1);
  });

  it('sends a deferred tool up front when the history calls it without the search that loaded it', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Done.' }])]);
    const base = gatewayRequest();
    const deferred = (body: Record<string, unknown>) => (body.tools as Array<{ name: string; defer_loading?: boolean }>).find((tool) => tool.name === 'query_availability')!.defer_loading;
    // OpenAI ran the round: its search items cannot be replayed here, so the call is rebuilt as plain tool_use.
    const openAIRound = [{ call: turns[0]!.call, output: 'free', prior_items: [
      { type: 'tool_search_call', id: 'ts_1', execution: 'server', status: 'completed', arguments: { query: 'free time' } },
      { type: 'tool_search_output', id: 'tso_1', execution: 'server', status: 'completed', tools: [{ type: 'namespace', name: 'calendar' }] },
      { type: 'function_call', call_id: 'c1', name: 'query_availability', namespace: 'calendar', arguments: '{"day":"2030-11-04"}' },
    ] }];
    // A trimmed history kept the call but dropped the round whose search loaded it.
    const trimmed = [{ ...turns[0]!, prior_items: [{ type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: use }] }];
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_search, tool_turns: openAIRound } });
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_search, tool_turns: trimmed } });
    await adapter.complete({ ...base, request: { ...base.request, tools, tool_search, tool_turns: turns } });
    expect(deferred(bodies[0]!)).toBeUndefined();
    expect((bodies[0]!.messages as unknown[]).slice(1, 2)).toEqual([{ role: 'assistant', content: [use] }]);
    expect(deferred(bodies[1]!)).toBeUndefined();
    expect(deferred(bodies[2]!)).toBe(true);
  });
});

// Rolling breakpoints (prompt caching guide): the system block, which caches the tools rendered before it, and the last
// cacheable block of each of the last three messages, four in all as the API allows.
describe('AnthropicMessagesAdapter cache breakpoints', () => {
  const tools = [{ name: 'get_context', description: 'Current time', parameters: { type: 'object', properties: {} } }];
  const EPHEMERAL = { type: 'ephemeral' };
  const marked = (body: Record<string, unknown>) => (body.messages as Array<{ content: Array<Record<string, unknown>> }>)
    .flatMap((message, index) => message.content.flatMap((block, at) => block.cache_control ? [`${index}.${at}`] : []));
  const breakpoints = (body: Record<string, unknown>) => JSON.stringify(body).split('"cache_control"').length - 1;
  const history = [{ role: 'user' as const, content: 'one' }, { role: 'assistant' as const, content: 'two' }, { role: 'user' as const, content: 'three' }, { role: 'assistant' as const, content: 'four' }, { role: 'user' as const, content: 'five' }];

  it('marks the system block and the last block of each of the last three messages, and nothing else', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'ok' }])]);
    const base = gatewayRequest(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, 'anthropic_native');
    await adapter.complete({ ...base, request: { ...base.request, tools, messages: history } });
    expect(marked(bodies[0]!)).toEqual(['2.0', '3.0', '4.0']);
    expect((bodies[0]!.messages as Array<{ content: unknown[] }>)[4]!.content).toEqual([{ type: 'text', text: 'five', cache_control: EPHEMERAL }]);
    expect(breakpoints(bodies[0]!)).toBe(4);
    expect(bodies[0]!.tools).toEqual([{ name: 'get_context', description: 'Current time', input_schema: { type: 'object', properties: {} } }]);
  });

  it('marks every message of a shorter conversation', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'ok' }])]);
    await adapter.complete(gatewayRequest(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, 'anthropic_native'));
    expect(marked(bodies[0]!)).toEqual(['0.0']);
    expect(breakpoints(bodies[0]!)).toBe(2);
  });

  it('marks no message on a step without provider caching', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'ok' }])]);
    const base = gatewayRequest();
    await adapter.complete({ ...base, request: { ...base.request, messages: history } });
    expect(breakpoints(bodies[0]!)).toBe(0);
  });

  it('a round re-marks the message the previous round marked last, so each request reads what the one before it wrote', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'ok' }])]);
    const base = gatewayRequest(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, 'anthropic_native');
    const round = (n: number) => ({ call: { call_id: `c${n}`, name: 'get_context', arguments: '{}' }, output: `o${n}`, prior_items: [{ type: 'tool_use', provider: ANTHROPIC_PROVIDER, block: { type: 'tool_use', id: `c${n}`, name: 'get_context', input: {} } }] });
    await adapter.complete({ ...base, request: { ...base.request, tools, messages: history, tool_turns: [round(1)] } });
    await adapter.complete({ ...base, request: { ...base.request, tools, messages: history, tool_turns: [round(1), round(2)] } });
    // The first request's last marked block is the second request's first marked block, at the same position and after
    // the same content. A marker is not content: a block marked once and not again still reads from the cache.
    const unmarked = (messages: unknown) => JSON.stringify(messages).replaceAll(',"cache_control":{"type":"ephemeral"}', '');
    expect(marked(bodies[0]!).at(-1)).toBe('6.0');
    expect(marked(bodies[1]!)).toEqual(['6.0', '7.0', '8.0']);
    expect(unmarked((bodies[1]!.messages as unknown[]).slice(0, 7))).toBe(unmarked(bodies[0]!.messages));
  });

  it('marks the last block that takes a marker, never a server tool block after it, and leaves the stored item unchanged', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'ok' }])]);
    const base = gatewayRequest(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, 'anthropic_native');
    const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'time' } };
    const found = { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'get_context' }] } };
    const use = { type: 'tool_use', id: 'c1', name: 'get_context', input: {} };
    const prior = [search, found, use, search, found].map((block) => ({ type: block.type, provider: ANTHROPIC_PROVIDER, block }));
    const searchable = [{ ...tools[0]!, namespace: 'time', defer_loading: true }, { name: 'remember', description: 'Remember', parameters: { type: 'object', properties: {} } }];
    await adapter.complete({ ...base, request: { ...base.request, tools: searchable, tool_search: { namespaces: { time: 'Time.' } }, tool_turns: [{ call: { call_id: 'c1', name: 'get_context', arguments: '{}' }, output: 'now', prior_items: prior }] } });
    expect((bodies[0]!.messages as Array<{ content: unknown[] }>)[1]!.content).toEqual([search, found, { ...use, cache_control: EPHEMERAL }, search, found]);
    expect(use).not.toHaveProperty('cache_control');
    expect((bodies[0]!.tools as Array<Record<string, unknown>>).some((tool) => 'cache_control' in tool)).toBe(false);
  });
});

describe('AnthropicMessagesAdapter as the primary provider', () => {
  it('refuses a request it cannot send as unsendable, so the route can move to a provider that can', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Read it.' }])]);
    const base = gatewayRequest();
    const docx = { kind: 'file' as const, mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'notes.docx', data_base64: 'UEsDBA==' };
    await expect(adapter.complete({ ...base, request: { ...base.request, attachments: [docx] } })).resolves.toMatchObject({ ok: false, code: 'invalid_args', unsendable: true });
    expect(bodies).toHaveLength(0);
  });

  it('sends a text file as a plain-text document, its bytes read as UTF-8', async () => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: 'Read it.' }])]);
    const base = gatewayRequest();
    const text = 'name,city\nAsha,Pune — ok\n';
    const data_base64 = Buffer.from(text, 'utf8').toString('base64');
    for (const mime_type of ['text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/json', 'application/xml']) {
      await adapter.complete({ ...base, request: { ...base.request, attachments: [{ kind: 'file', mime_type, filename: 'f', data_base64 }] } });
      expect((bodies.at(-1)!.messages as Array<{ content: unknown[] }>)[0]!.content.at(-1), mime_type).toEqual({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, title: 'f' });
    }
  });

  it('fails a refusal that wrote some text before declining, so none of it reaches the owner', async () => {
    const { adapter } = recording([reply([{ type: 'text', text: 'Sure, here is' }], 'refusal', { stop_details: { type: 'refusal', category: 'general_harms', explanation: 'secret explanation' } })]);
    const result = await adapter.complete(gatewayRequest());
    expect(result).toMatchObject({ ok: false, code: 'rejected', error: 'Anthropic refused the request (general_harms)', spent: { input_tokens: 10, output_tokens: 3 } });
    expect(JSON.stringify(result)).not.toContain('Sure, here is');
  });
});

// A scripted Messages stream: the raw events in order, each after its delay, then the final message. Aborting the call's
// signal ends it the way the SDK does.
type Timed = Readonly<{ after?: number; event: Record<string, unknown> }>;
const streamingClient = (events: readonly Timed[], final: unknown) => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const client = { messages: {
    create: async () => { throw new Error('the unstreamed call ran'); },
    stream: (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
      calls.push({ body });
      const run = (async function* () {
        for (const { after = 0, event } of events) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, after);
            options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
          });
          yield event;
        }
      })();
      return { [Symbol.asyncIterator]: () => run, finalMessage: async () => { for await (const _event of run) { /* drain */ } return final; } };
    },
  } };
  return { client, calls };
};
const textStart = (index: number) => ({ event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
const textDelta = (index: number, text: string, after = 0) => ({ after, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
const sink = () => {
  const seen: string[] = [];
  return { seen, deltas: { delta: (text: string) => seen.push(text), retract: () => seen.push('<retract>') } };
};

describe('AnthropicMessagesAdapter streaming', () => {
  it('streams the answer text as it is written and returns what the unstreamed call would, with the first-token time', async () => {
    const { client, calls } = streamingClient([{ event: { type: 'message_start' } }, textStart(0), textDelta(0, 'Your day '), textDelta(0, 'is clear.')], reply([{ type: 'text', text: 'Your day is clear.' }]));
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: client as never });
    const { seen, deltas } = sink();
    const result = await adapter.complete({ ...gatewayRequest(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, 'anthropic_native'), stream: deltas });
    expect(seen).toEqual(['Your day ', 'is clear.']);
    expect(result).toMatchObject({ ok: true, data: { text: 'Your day is clear.', ttft_ms: expect.any(Number) } });
    expect(calls[0]!.body).toMatchObject({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, system: [{ type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }] });
    expect(calls[0]!.body).not.toHaveProperty('stream');
  });

  it('takes back text it streamed when the response goes on to call a tool, and streams nothing from thinking', async () => {
    const tool = { type: 'tool_use', id: 'c1', name: 'get_context', input: {} };
    const { client } = streamingClient([
      { event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } } },
      textStart(1), textDelta(1, 'Let me check.'),
      { event: { type: 'content_block_start', index: 2, content_block: tool } },
    ], reply([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Let me check.' }, tool], 'tool_use'));
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: client as never });
    const { seen, deltas } = sink();
    const result = await adapter.complete({ ...gatewayRequest(), stream: deltas });
    expect(seen).toEqual(['Let me check.', '<retract>']);
    expect(result).toMatchObject({ ok: true, data: { tool_calls: [{ call_id: 'c1', name: 'get_context' }] } });
  });

  it('streams a second text block after a break, so the shown text stays a prefix of the reply', async () => {
    const { client } = streamingClient([textStart(0), textDelta(0, 'One.'), textStart(1), textDelta(1, 'Two.')], reply([{ type: 'text', text: 'One.' }, { type: 'text', text: 'Two.' }]));
    const { seen, deltas } = sink();
    const result = await new AnthropicMessagesAdapter({ apiKey: 'test-key', client: client as never }).complete({ ...gatewayRequest(), stream: deltas });
    expect(seen.join('')).toBe('One.\nTwo.');
    expect(result).toMatchObject({ ok: true, data: { text: 'One.\nTwo.' } });
  });

  it('with a provider ahead, abandons a call that shows nothing in the first-token window, without counting against the provider', async () => {
    const { client } = streamingClient([{ event: { type: 'message_start' } }, { after: 200, ...textStart(0) }], reply([{ type: 'text', text: 'late' }]));
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: client as never, firstTokenTimeoutMs: 20 });
    const result = await adapter.complete({ ...gatewayRequest(), stream: sink().deltas, failoverAhead: true });
    expect(result).toMatchObject({ ok: false, code: 'transient', firstTokenLate: true, retry: { allowed: false } });
  });

  it('counts a thinking block as the first token, so a model that reasons first is not abandoned', async () => {
    const { client } = streamingClient([
      { after: 5, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { after: 60, ...textStart(1) }, textDelta(1, 'Thought it through.'),
    ], reply([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Thought it through.' }]));
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: client as never, firstTokenTimeoutMs: 30 });
    await expect(adapter.complete({ ...gatewayRequest(), stream: sink().deltas, failoverAhead: true })).resolves.toMatchObject({ ok: true, data: { text: 'Thought it through.' } });
  });

  it('without a provider ahead, keeps waiting past the first-token window', async () => {
    const { client } = streamingClient([{ after: 60, ...textStart(0) }, textDelta(0, 'Slow but here.')], reply([{ type: 'text', text: 'Slow but here.' }]));
    const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: client as never, firstTokenTimeoutMs: 10 });
    await expect(adapter.complete({ ...gatewayRequest(), stream: sink().deltas })).resolves.toMatchObject({ ok: true, data: { text: 'Slow but here.' } });
  });
});

describe('AnthropicMessagesAdapter structured output', () => {
  // The Messages API refuses a raw output schema with numeric, length or item-count bounds (a 400 on the whole call).
  const REFUSED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems'];
  const refusedIn = (node: unknown, path = '$'): string[] => {
    if (Array.isArray(node)) return node.flatMap((child, index) => refusedIn(child, `${path}[${index}]`));
    if (node === null || typeof node !== 'object') return [];
    const record = node as Record<string, unknown>;
    return [
      ...REFUSED.filter((key) => key in record).map((key) => `${path}.${key}`),
      ...(typeof record.minItems === 'number' && record.minItems > 1 ? [`${path}.minItems`] : []),
      ...Object.entries(record).filter(([key]) => key !== 'enum' && key !== 'const').flatMap(([key, child]) => refusedIn(child, `${path}.${key}`)),
    ];
  };
  const sentSchema = async (schema: Record<string, unknown>) => {
    const { bodies, adapter } = recording([reply([{ type: 'text', text: '{}' }])]);
    const base = gatewayRequest(ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL);
    await adapter.complete({ ...base, request: { ...base.request, response_format: { name: 'x', schema } } });
    return (bodies[0]!.output_config as { format: { schema: Record<string, unknown> } }).format.schema;
  };

  it('moves bounds the API refuses into the field description, and keeps enums, required and the object rules', async () => {
    const sent = await sentSchema({ type: 'object', additionalProperties: false, required: ['aliases', 'kind'], properties: {
      aliases: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 40 } },
      kind: { type: 'string', enum: ['a', 'b'], description: 'Which one.' },
      count: { type: 'integer', minimum: 0, maximum: 9 },
      maximum: { type: 'integer' },
    } });
    expect(sent).toEqual({ type: 'object', additionalProperties: false, required: ['aliases', 'kind'], properties: {
      aliases: { type: 'array', description: '{maxItems: 5}', items: { type: 'string', description: '{maxLength: 40}' } },
      kind: { type: 'string', enum: ['a', 'b'], description: 'Which one.' },
      count: { type: 'integer', description: '{minimum: 0, maximum: 9}' },
      maximum: { type: 'integer' },
    } });
  });

  it('sends every owner-path output schema in a shape the API accepts', async () => {
    for (const [name, schema] of Object.entries({ CLAIM_OPS_SCHEMA, SOURCE_CLAIMS_SCHEMA, PROMOTION_SCHEMA, DAY_PLAN_SCHEMA, WELCOME_SCHEMA, reaction: reactionSchema(['👍', '🙏']) })) {
      expect(refusedIn(schema as Record<string, unknown>).length > 0 || name !== 'CLAIM_OPS_SCHEMA', `${name} no longer carries a refused bound; the scan below proves nothing for it`).toBe(true);
      expect(refusedIn(await sentSchema(schema as Record<string, unknown>)), name).toEqual([]);
    }
  });
});

// The same calls through the installed SDK's own MessageStream, over a scripted SSE response: event parsing, the final
// message after the last event, and an abort while the response is open.
describe('AnthropicMessagesAdapter streaming through the SDK', () => {
  const sse = (events: ReadonlyArray<Record<string, unknown>>) => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const head = { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  const sdk = (fetch: typeof globalThis.fetch) => new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch });

  it('streams text, takes it back at the tool call, and returns the final message the SDK assembled', async () => {
    const body = sse([head,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'now.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_context', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"n":1}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]);
    const client = sdk(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const { seen, deltas } = sink();
    const result = await new AnthropicMessagesAdapter({ apiKey: 'test-key', client }).complete({ ...gatewayRequest(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL), stream: deltas });
    expect(seen).toEqual(['Checking ', 'now.', '<retract>']);
    expect(result).toMatchObject({ ok: true, data: { model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, text: 'Checking now.', tool_calls: [{ call_id: 'toolu_1', name: 'get_context', arguments: '{"n":1}' }], input_tokens: 12, output_tokens: 20, ttft_ms: expect.any(Number) } });
  });

  it('abandons an open response that writes no content block in the first-token window, as a late first token', async () => {
    const encoder = new TextEncoder();
    const client = sdk(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse([head])));
        init?.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const result = await new AnthropicMessagesAdapter({ apiKey: 'test-key', client, firstTokenTimeoutMs: 30 }).complete({ ...gatewayRequest(), stream: sink().deltas, failoverAhead: true });
    expect(result).toMatchObject({ ok: false, code: 'transient', firstTokenLate: true });
  });
});
