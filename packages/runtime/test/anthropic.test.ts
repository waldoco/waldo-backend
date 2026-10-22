import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  type LLMRequest,
} from '@waldo/contracts';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import type { LLMGatewayRequest } from '../src/llm/provider';

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
    await expect(adapter.complete(gatewayRequest())).resolves.toMatchObject({ ok: true, data: { input_tokens: 50, output_tokens: 2, cache_read_input_tokens: 30 } });
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
