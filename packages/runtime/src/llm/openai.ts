import OpenAI from 'openai';
import { validModelCredential } from './credential-shape';
import {
  OPENAI_PROVIDER,
  PROVIDER_OF,
  type ModelName,
  type AdapterResult,
  type LLMResponse,
} from '@waldo/contracts';
import type { LLMGatewayAdapter, LLMGatewayRequest } from './provider';

export type OpenAIResponsesClient = Pick<OpenAI, 'responses'>;

export type OpenAIAdapterOptions = Readonly<{
  apiKey?: string;
  timeoutMs?: number;
  client?: OpenAIResponsesClient;
  onResponseMetadata?: (metadata: OpenAIResponseMetadata) => void;
}>;

export type OpenAIResponseMetadata = Readonly<{
  response_id: string;
  model: ModelName;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  reasoning?: string;
}>;

export class OpenAIResponsesAdapter implements LLMGatewayAdapter {
  private readonly client: OpenAIResponsesClient | undefined;
  private readonly timeoutMs: number;
  private readonly missingKey: boolean;
  private readonly onResponseMetadata: ((metadata: OpenAIResponseMetadata) => void) | undefined;

  constructor(options: OpenAIAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onResponseMetadata = options.onResponseMetadata;
    this.missingKey = options.apiKey !== undefined ? !validModelCredential(options.apiKey) : options.client === undefined;
    this.client = this.missingKey ? undefined : options.client ?? new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 2,
      timeout: this.timeoutMs,
    });
  }

  async complete(input: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
    if (PROVIDER_OF[input.request.model] !== OPENAI_PROVIDER || input.step.provider !== OPENAI_PROVIDER) {
      return { ok: false, code: 'invalid_args', error: 'OpenAI adapter received an unsupported route' };
    }
    if (this.missingKey || this.client === undefined) {
      return { ok: false, code: 'auth_failed', error: 'OPENAI_API_KEY is unavailable' };
    }

    input.runScope?.admit();
    const controller = new AbortController();
    const abortRun = () => controller.abort();
    input.runScope?.signal.addEventListener('abort', abortRun, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      // A reply that is only reasoning (no text, no tool call) is a transient model miss, not a finished turn: ask once more before failing.
      // Tokens spent on a discarded attempt are still spent: they ride into the final totals.
      let spentInput = 0;
      let spentOutput = 0;
      let spentCached = 0;
      for (let attempt = 0; ; attempt++) {
        const response = await this.client.responses.create(
          {
            model: input.request.model,
            instructions: input.request.system,
            input: responsesInput(input.request),
            max_output_tokens: input.request.max_tokens,
            store: false,
            reasoning: { effort: 'low', summary: 'auto' },
            ...(input.request.cache_key ? { prompt_cache_key: input.request.cache_key } : {}),
            ...(input.request.tools ? { tools: input.request.tools.map((tool) => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {}),
            ...(input.request.response_format ? { text: { format: { type: 'json_schema' as const, name: input.request.response_format.name, schema: input.request.response_format.schema, strict: true } } } : {}),
          },
          { signal: controller.signal },
        );
        const text = responseText(response).trim();
        const toolCalls = response.output.flatMap((item) => item.type === 'function_call' ? [{ call_id: item.call_id, name: item.name, arguments: item.arguments }] : []);
        const incomplete = response.status === 'incomplete';
        if (incomplete && text.length === 0 && toolCalls.length === 0) {
          return { ok: false, code: 'oversize', error: `OpenAI output incomplete: ${response.incomplete_details?.reason ?? 'unknown'}` };
        }
        const parsed = {
          model: input.request.model,
          text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          input_tokens: spentInput + (response.usage?.input_tokens ?? 0),
          output_tokens: spentOutput + (response.usage?.output_tokens ?? 0),
          cache_read_input_tokens: spentCached + (response.usage?.input_tokens_details?.cached_tokens ?? 0),
          output_items: response.output.map((item) => item as unknown as Record<string, unknown>),
          latency_ms: Date.now() - startedAt,
          ...(incomplete ? { truncated: true } : {}),
        };
        if (text.length === 0 && toolCalls.length === 0) {
          if (attempt === 0) {
            spentInput = parsed.input_tokens;
            spentOutput = parsed.output_tokens;
            spentCached = parsed.cache_read_input_tokens;
            continue;
          }
          return { ok: false, code: 'invalid_args', error: 'OpenAI returned empty output' };
        }
        this.onResponseMetadata?.({
          response_id: response.id,
          model: input.request.model,
          input_tokens: parsed.input_tokens,
          output_tokens: parsed.output_tokens,
          latency_ms: parsed.latency_ms,
          ...(reasoningSummary(response) ? { reasoning: reasoningSummary(response) } : {}),
        });
        return { ok: true, data: parsed };
      }
    } catch (error) {
      // Only identifiers cross into the trace (status, provider error code, offending parameter name); the provider's message can quote the request.
      const detail = error instanceof OpenAI.APIError
        ? ` (${[error.status, error.code, error.param].filter((part) => part !== undefined && part !== null && part !== '').join(' ')})`
        : '';
      return { ok: false, code: openAIErrorCode(error), error: `OpenAI request failed${detail}` };
    } finally {
      clearTimeout(timeout);
      input.runScope?.signal.removeEventListener('abort', abortRun);
    }
  }
}

function responsesInput(request: LLMGatewayRequest['request']): OpenAI.Responses.ResponseCreateParams['input'] {
  // Real roles: a flattened "user: ..." blob hid who said what, so "that one" could not resolve (PR 1 item 3).
  const turns = request.messages.map((message) => ({ role: message.role, content: message.content }));
  // One plain user message stays a plain string (single-shot callers such as selectors and writers parse it as text).
  if (!request.attachments && !request.tool_turns) return turns.length === 1 && turns[0]!.role === 'user' ? turns[0]!.content : turns;
  const lastUser = turns.map((turn) => turn.role).lastIndexOf('user');
  const files = (request.attachments ?? []).map((file): OpenAI.Responses.ResponseInputContent => {
    const data = `data:${file.mime_type};base64,${file.data_base64}`;
    return file.kind === 'image'
      ? { type: 'input_image', image_url: data, detail: 'auto' }
      : { type: 'input_file', filename: file.filename, file_data: data };
  });
  return [
    ...turns.map((turn, index): OpenAI.Responses.ResponseInputItem => index === lastUser && files.length
      ? { role: 'user', content: [{ type: 'input_text', text: turn.content }, ...files] }
      : { role: turn.role, content: turn.content }),
    ...(lastUser === -1 && files.length ? [{ role: 'user' as const, content: files }] : []),
    ...(() => {
      // The model's own output items ride on the first call of a round and already hold every parallel call in it;
      // a call is replayed from its record only when no earlier item carries its call_id.
      const replayed = new Set<string>();
      return (request.tool_turns ?? []).flatMap((turn): OpenAI.Responses.ResponseInputItem[] => {
        const prior = (turn.prior_items ?? []) as unknown as OpenAI.Responses.ResponseInputItem[];
        for (const item of prior) {
          const record = item as { type?: string; call_id?: string };
          if (record.type === 'function_call' && record.call_id) replayed.add(record.call_id);
        }
        const included = replayed.has(turn.call.call_id);
        replayed.add(turn.call.call_id);
        return [
          ...prior,
          ...(included ? [] : [{ type: 'function_call' as const, call_id: turn.call.call_id, name: turn.call.name, arguments: turn.call.arguments }]),
          { type: 'function_call_output' as const, call_id: turn.call.call_id, output: turn.output },
        ];
      });
    })(),
  ];
}

function reasoningSummary(response: OpenAI.Responses.Response): string {
  return response.output
    .flatMap((item) => item.type === 'reasoning' ? item.summary.map((part) => part.text) : [])
    .join('\n\n');
}

function responseText(response: OpenAI.Responses.Response): string {
  if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return response.output_text;
  }
  return response.output
    .flatMap((item) => {
      if (item.type !== 'message') return [];
      return item.content.flatMap((part) => part.type === 'output_text' ? [part.text] : []);
    })
    .join('\n');
}

function openAIErrorCode(error: unknown): 'auth_failed' | 'not_found' | 'rate_limited' | 'oversize' | 'invalid_args' | 'transient' {
  if (error instanceof Error && error.name === 'AbortError') return 'transient';
  const status = error instanceof OpenAI.APIError ? error.status : undefined;
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 413) return 'oversize';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_args';
  return 'transient';
}