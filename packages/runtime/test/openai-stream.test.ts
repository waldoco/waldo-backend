import { describe, expect, it } from 'vitest';
import { OPENAI_GPT_6_LUNA_MODEL, OPENAI_PROVIDER, type LLMRequest } from '@waldo/contracts';
import { OpenAIResponsesAdapter, type OpenAIResponsesClient } from '../src/llm/openai';
import type { LLMGatewayRequest } from '../src/llm/provider';
import type { ReplyDeltaSink } from '../src/conversation/reply-stream';

// The Responses API streaming path: only a message the model labels its final answer, and only when it is the
// response's first message, reaches the reply stream. The parsed result is the one the non-streaming call returns.

const request = (stream?: ReplyDeltaSink): LLMGatewayRequest => {
  const body: LLMRequest = { model: OPENAI_GPT_6_LUNA_MODEL, system: 'Be concise.', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 32, temperature: 0 };
  return {
    request: body,
    route: { trigger: 'user_message', primary: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none' }, fallback: [], floor: 'template' },
    step: { provider: OPENAI_PROVIDER, model: OPENAI_GPT_6_LUNA_MODEL, cache: 'none' },
    context: 'full_context', fallback_step: 'configured_model', headers: { 'cf-aig-collect-log-payload': 'false' },
    ...(stream ? { stream } : {}),
  };
};

type Item = Record<string, unknown>;
const message = (text: string, phase?: string): Item => ({ type: 'message', id: `msg-${text.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }], ...(phase === undefined ? {} : { phase }) });
const call = (name: string): Item => ({ type: 'function_call', id: 'fc-1', call_id: 'call-1', name, arguments: '{}', status: 'completed' });
const completed = (output: readonly Item[]) => ({ id: 'resp-1', status: 'completed', output, output_text: output.flatMap((item) => item.type === 'message' ? (item.content as { text: string }[]).map((part) => part.text) : []).join(''), usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } });

// The events a streamed response emits for these output items: each item is added, a message's text arrives in pieces,
// and the response completes with every item.
const events = (output: readonly Item[], pieces = 3): unknown[] => [
  { type: 'response.created', response: { id: 'resp-1', status: 'in_progress', output: [] } },
  ...output.flatMap((item, index) => {
    const added = { type: 'response.output_item.added', output_index: index, item: item.type === 'message' ? { ...item, content: [], status: 'in_progress' } : item };
    if (item.type !== 'message') return [added];
    const text = (item.content as { text: string }[])[0]!.text;
    const size = Math.ceil(text.length / pieces);
    const deltas = Array.from({ length: pieces }, (_, i) => text.slice(i * size, (i + 1) * size)).filter(Boolean)
      .map((delta) => ({ type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta }));
    return [added, ...deltas];
  }),
  { type: 'response.completed', response: completed(output) },
];

const streamingClient = (script: (body: Record<string, unknown>) => unknown[] | Error) => {
  const bodies: Record<string, unknown>[] = [];
  const client = { responses: { create: async (body: Record<string, unknown>) => {
    bodies.push(body);
    const scripted = script(body);
    if (body.stream !== true) return scripted instanceof Error ? Promise.reject(scripted) : (scripted.at(-1) as { response: unknown }).response;
    return { async *[Symbol.asyncIterator]() { if (scripted instanceof Error) throw scripted; for (const event of scripted) yield event; } };
  } } } as unknown as OpenAIResponsesClient;
  return { client, bodies };
};
const recorder = () => {
  const seen: string[] = [];
  return { seen, sink: { delta: (text: string) => seen.push(text), retract: () => seen.push('<retract>') } satisfies ReplyDeltaSink };
};

describe('OpenAI streaming', () => {
  it('streams a final-answer message and returns what the same response returns unstreamed', async () => {
    const output = [{ type: 'reasoning', id: 'rs-1', summary: [] }, message('Hello there, owner.', 'final_answer')];
    const { client, bodies } = streamingClient(() => events(output));
    const { seen, sink } = recorder();
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client });
    const streamed = await adapter.complete(request(sink));
    const plain = await adapter.complete(request());
    expect(seen.join('')).toBe('Hello there, owner.');
    expect(bodies[0]!.stream).toBe(true);
    expect(bodies[1]).not.toHaveProperty('stream');
    expect(streamed.ok && plain.ok).toBe(true);
    if (!streamed.ok || !plain.ok) return;
    expect({ ...streamed.data, latency_ms: 0 }).toEqual({ ...plain.data, latency_ms: 0 });
  });

  it.each([
    ['commentary', [message('Checking your calendar.', 'commentary'), call('get_context')]],
    ['an unlabelled message', [message('Hello there.')]],
    ['a final answer after another message', [message('First, ', 'commentary'), message('the answer.', 'final_answer')]],
  ])('does not stream %s', async (_name, output) => {
    const { client } = streamingClient(() => events(output));
    const { seen, sink } = recorder();
    const result = await new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }).complete(request(sink));
    expect(result.ok).toBe(true);
    expect(seen.filter((text) => text !== '<retract>')).toEqual([]);
  });

  it('takes back a final answer the response follows with a tool call', async () => {
    const { client } = streamingClient(() => events([message('Here is the plan.', 'final_answer'), call('get_context')]));
    const { seen, sink } = recorder();
    const result = await new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }).complete(request(sink));
    expect(seen.at(-1)).toBe('<retract>');
    expect(result.ok && result.data.tool_calls?.map((tool) => tool.name)).toEqual(['get_context']);
  });

  it('fails a stream that breaks or reports failure as transient, keeping the attempt plan the retry owner', async () => {
    for (const script of [() => new Error('socket hang up'), () => [{ type: 'response.created', response: {} }, { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: 'server_error' } } }], () => [{ type: 'error', code: 'server_error', message: 'boom' }]]) {
      const { client } = streamingClient(script);
      const result = await new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }).complete(request(recorder().sink));
      expect(result).toMatchObject({ ok: false, code: 'transient' });
    }
  });

  it('marks a streamed response cut off at its limit as truncated, as unstreamed', async () => {
    const output = [message('A long answer that', 'final_answer')];
    const cut = events(output).slice(0, -1).concat({ type: 'response.incomplete', response: { ...completed(output), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
    const { client } = streamingClient(() => cut);
    const result = await new OpenAIResponsesAdapter({ apiKey: 'synthetic-key-0123456789', client }).complete(request(recorder().sink));
    expect(result.ok && result.data).toMatchObject({ text: 'A long answer that', truncated: true });
  });
});
