import OpenAI from 'openai';
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
    this.missingKey = options.client === undefined && (options.apiKey?.trim().length ?? 0) === 0;
    this.client = options.client ?? (this.missingKey ? undefined : new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: this.timeoutMs,
    }));
  }

  async complete(input: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
    if (PROVIDER_OF[input.request.model] !== OPENAI_PROVIDER || input.step.provider !== OPENAI_PROVIDER) {
      return { ok: false, code: 'invalid_args', error: 'OpenAI adapter received an unsupported route' };
    }
    if (this.missingKey || this.client === undefined) {
      return { ok: false, code: 'auth_failed', error: 'OPENAI_API_KEY is unavailable' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.client.responses.create(
        {
          model: input.request.model,
          instructions: input.request.system,
          input: input.request.messages.map((message) => `${message.role}: ${message.content}`).join('\n'),
          max_output_tokens: input.request.max_tokens,
          reasoning: { effort: 'low', summary: 'auto' },
          ...(input.request.response_format ? { text: { format: { type: 'json_schema' as const, name: input.request.response_format.name, schema: input.request.response_format.schema, strict: true } } } : {}),
        },
        { signal: controller.signal },
      );
      if (response.status === 'incomplete') {
        return { ok: false, code: 'oversize', error: `OpenAI output incomplete: ${response.incomplete_details?.reason ?? 'unknown'}` };
      }
      const text = responseText(response).trim();
      const parsed = {
        model: input.request.model,
        text,
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        cache_read_input_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        latency_ms: Date.now() - startedAt,
      };
      if (text.length === 0) {
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
    } catch (error) {
      return { ok: false, code: openAIErrorCode(error), error: 'OpenAI request failed' };
    } finally {
      clearTimeout(timeout);
    }
  }
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