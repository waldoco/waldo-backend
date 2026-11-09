import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ANTHROPIC_PROVIDER, OPENAI_PROVIDER, type Provider } from '@waldo/contracts';
import { AnthropicMessagesAdapter } from '../../src/llm/anthropic';
import { OpenAIResponsesAdapter } from '../../src/llm/openai';
import { routedGateway, type LLMGatewayAdapter } from '../../src/llm/provider';

// Fault injection at the SDK seam: both real adapters run against scripted provider clients, so every fault goes through
// the same error mapping, retry advice and reply parsing a live outage would. One script per provider, one event per
// request; the last event repeats, so a scripted storm lasts as long as the test keeps calling.
export type ProviderEvent =
  | Readonly<{ text: string }>
  // `args` is the raw argument text, so a malformed call (not JSON) can be injected.
  | Readonly<{ tool: string; args: string }>
  | Readonly<{ fault: 'rate_limited'; retryAfterS?: number }>
  | Readonly<{ fault: 'server_error'; status?: 500 | 502 | 503 | 529 }>
  // The provider never answers; the adapter aborts at its timeout.
  | Readonly<{ fault: 'timeout' }>
  // A completed reply with neither text nor a tool call.
  | Readonly<{ fault: 'empty' }>;

type Create = (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
const USAGE = { input: 40, output: 6 };

const hang = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
  const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
});

const openaiReply = (event: ProviderEvent, signal: AbortSignal | undefined): Promise<unknown> => {
  if ('fault' in event) {
    if (event.fault === 'timeout') return hang(signal);
    if (event.fault === 'rate_limited') throw new OpenAI.APIError(429, { message: 'rate limited' }, 'rate limited', new Headers(event.retryAfterS === undefined ? {} : { 'retry-after': String(event.retryAfterS) }));
    if (event.fault === 'server_error') throw new OpenAI.APIError(event.status ?? 500, { message: 'server error' }, 'server error', new Headers());
    return Promise.resolve({ id: 'resp_empty', status: 'completed', output_text: '', output: [{ type: 'reasoning', summary: [] }], usage: { input_tokens: USAGE.input, output_tokens: USAGE.output } });
  }
  if ('text' in event) return Promise.resolve({ id: 'resp_text', status: 'completed', output_text: event.text, output: [{ type: 'message', content: [{ type: 'output_text', text: event.text }] }], usage: { input_tokens: USAGE.input, output_tokens: USAGE.output } });
  return Promise.resolve({ id: 'resp_tool', status: 'completed', output_text: '', output: [{ type: 'function_call', id: 'fc_1', call_id: `oa_${Math.random().toString(36).slice(2, 10)}`, name: event.tool, arguments: event.args }], usage: { input_tokens: USAGE.input, output_tokens: USAGE.output } });
};

const anthropicReply = (event: ProviderEvent, model: string, signal: AbortSignal | undefined): Promise<unknown> => {
  const message = (content: unknown[], stop_reason: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model, stop_reason, content, usage: { input_tokens: USAGE.input, output_tokens: USAGE.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  if ('fault' in event) {
    if (event.fault === 'timeout') return hang(signal);
    if (event.fault === 'rate_limited') throw Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, 'rate limited', new Headers(event.retryAfterS === undefined ? {} : { 'retry-after': String(event.retryAfterS) }));
    if (event.fault === 'server_error') throw Anthropic.APIError.generate(event.status ?? 500, { type: 'error', error: { type: 'api_error', message: 'server error' } }, 'server error', new Headers());
    return Promise.resolve(message([{ type: 'thinking', thinking: '', signature: 'sig' }], 'end_turn'));
  }
  if ('text' in event) return Promise.resolve(message([{ type: 'text', text: event.text }], 'end_turn'));
  // Messages API tool input is always an object; a malformed call here is one whose input is not what the tool asked for.
  let input: unknown;
  try { input = JSON.parse(event.args); } catch { input = { unparsed: event.args }; }
  return Promise.resolve(message([{ type: 'tool_use', id: `an_${Math.random().toString(36).slice(2, 10)}`, name: event.tool, input }], 'tool_use'));
};

export const faultInjectedProviders = (scripts: Partial<Record<Provider, readonly ProviderEvent[]>>, options: Readonly<{ timeoutMs?: number }> = {}) => {
  const calls: Array<Readonly<{ provider: Provider; model: string; event: ProviderEvent }>> = [];
  const queues = new Map<Provider, ProviderEvent[]>();
  const next = (provider: Provider): ProviderEvent => {
    const queue = queues.get(provider) ?? queues.set(provider, [...(scripts[provider] ?? [{ fault: 'server_error' }])]).get(provider)!;
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
  const scripted = (provider: Provider, reply: (event: ProviderEvent, model: string, signal: AbortSignal | undefined) => Promise<unknown>): Create => async (body, requestOptions) => {
    const event = next(provider);
    calls.push({ provider, model: String(body.model), event });
    return reply(event, String(body.model), requestOptions?.signal);
  };
  const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  const gateway: LLMGatewayAdapter = routedGateway({
    [OPENAI_PROVIDER]: new OpenAIResponsesAdapter({ apiKey: 'fixture-openai', ...timeout, client: { responses: { create: scripted(OPENAI_PROVIDER, (event, _model, signal) => openaiReply(event, signal)) } } as never }),
    [ANTHROPIC_PROVIDER]: new AnthropicMessagesAdapter({ apiKey: 'fixture-anthropic', ...timeout, client: { messages: { create: scripted(ANTHROPIC_PROVIDER, anthropicReply) } } as never }),
  });
  return { gateway, calls, models: () => calls.map((call) => call.model) };
};
