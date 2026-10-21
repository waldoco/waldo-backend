import Anthropic from '@anthropic-ai/sdk';
import { validModelCredential } from './credential-shape';
import { ANTHROPIC_PROVIDER, PROVIDER_OF, type LLMAttachment, type LLMRequest, type LLMToolCall, type LLMToolTurn, type ModelName } from '@waldo/contracts';
import { OUTPUT_ITEM_PROVIDER, outputItemProvider, type LLMGatewayAdapter, type LLMGatewayRequest, type LLMGatewayResult, type ProviderRetryAdvice } from './provider';
import { callTimeLeftMs, MODEL_CALL_TIMEOUT_MS } from './time-budget';

export type AnthropicMessagesClient = Pick<Anthropic, 'messages'>;

export type AnthropicAdapterOptions = Readonly<{
  apiKey?: string;
  timeoutMs?: number;
  client?: AnthropicMessagesClient;
  onResponseMetadata?: (metadata: AnthropicResponseMetadata) => void;
}>;

export type AnthropicResponseMetadata = Readonly<{
  response_id: string;
  model: ModelName;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  stop_reason: string | null;
}>;

// The second provider at the LLMGatewayAdapter seam (Messages API). Sampling parameters stay off the wire: current Claude
// models reject them. Thinking runs at the model's default and is never replayed: a replayed thinking block is bound to
// an unchanged prefix, and a turn changes its prefix when it withdraws the tools for the closing round, so the adapter
// replays only text and tool calls (the documented always-valid shape) and the next round reasons afresh.
export class AnthropicMessagesAdapter implements LLMGatewayAdapter {
  private readonly client: AnthropicMessagesClient | undefined;
  private readonly timeoutMs: number;
  private readonly missingKey: boolean;
  private readonly onResponseMetadata: ((metadata: AnthropicResponseMetadata) => void) | undefined;

  constructor(options: AnthropicAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? MODEL_CALL_TIMEOUT_MS;
    this.onResponseMetadata = options.onResponseMetadata;
    this.missingKey = options.apiKey !== undefined ? !validModelCredential(options.apiKey) : options.client === undefined;
    // The provider's attempt plan is the one retry owner; see OpenAIResponsesAdapter.
    this.client = this.missingKey ? undefined : options.client ?? new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: this.timeoutMs,
    });
  }

  async complete(input: LLMGatewayRequest): Promise<LLMGatewayResult> {
    if (PROVIDER_OF[input.request.model] !== ANTHROPIC_PROVIDER || input.step.provider !== ANTHROPIC_PROVIDER) {
      return { ok: false, code: 'invalid_args', error: 'Anthropic adapter received an unsupported route' };
    }
    if (this.missingKey || this.client === undefined) {
      return { ok: false, code: 'auth_failed', error: 'ANTHROPIC_API_KEY is unavailable' };
    }
    const messages = messagesInput(input.request);
    if (messages === null) {
      return { ok: false, code: 'invalid_args', error: 'Anthropic adapter received an attachment type it cannot send' };
    }

    input.runScope?.admit();
    const controller = new AbortController();
    const abortRun = () => controller.abort();
    input.runScope?.signal.addEventListener('abort', abortRun, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.max(0, Math.min(this.timeoutMs, callTimeLeftMs(input.runScope))));
    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create(
        {
          model: input.request.model,
          max_tokens: input.request.max_tokens,
          ...(input.request.system ? { system: systemPrompt(input.request.system, input.step.cache === 'anthropic_native') } : {}),
          messages,
          ...toolsParams(input.request),
          ...outputConfig(input.request),
        },
        { signal: controller.signal },
      );
      const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n').trim();
      const toolCalls: LLMToolCall[] = response.content.flatMap((block) => block.type === 'tool_use'
        ? [{ call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }]
        : []);
      // Anthropic's input_tokens excludes cached tokens; the seam reports the whole prompt, cache reads inside it.
      const spent = {
        input_tokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      };
      const truncated = response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded';
      if (text.length === 0 && toolCalls.length === 0) {
        if (truncated) return { ok: false, code: 'oversize', error: `Anthropic output incomplete: ${response.stop_reason}`, spent };
        // Only the policy category crosses into the trace; the explanation can quote the request.
        if (response.stop_reason === 'refusal') return { ok: false, code: 'rejected', error: `Anthropic refused the request (${response.stop_details?.category ?? 'uncategorised'})`, spent };
        return { ok: false, code: 'transient', error: 'Anthropic returned empty output', spent };
      }
      const parsed = {
        model: input.request.model,
        text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...spent,
        output_items: response.content.map((block) => ({ type: block.type, [OUTPUT_ITEM_PROVIDER]: ANTHROPIC_PROVIDER, block: block as unknown as Record<string, unknown> })),
        latency_ms: Date.now() - startedAt,
        ...(truncated ? { truncated: true } : {}),
      };
      this.onResponseMetadata?.({
        response_id: response.id,
        model: input.request.model,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        latency_ms: parsed.latency_ms,
        stop_reason: response.stop_reason,
      });
      return { ok: true, data: parsed };
    } catch (error) {
      // Only identifiers cross into the trace (status, the API's error type); the provider's message can quote the request.
      const detail = error instanceof Anthropic.APIError
        ? ` (${[error.status, error.type].filter((part) => part !== undefined && part !== null).join(' ')})`
        : '';
      const retry = error instanceof Anthropic.APIError ? retryAdvice(error.headers) : undefined;
      return { ok: false, code: anthropicErrorCode(error), error: `Anthropic request failed${detail}`, ...(retry ? { retry } : {}) };
    } finally {
      clearTimeout(timeout);
      input.runScope?.signal.removeEventListener('abort', abortRun);
    }
  }
}

function systemPrompt(system: string, cached: boolean): Anthropic.MessageCreateParams['system'] {
  return cached ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
}

const IMAGE_TYPES = new Set<Anthropic.Base64ImageSource['media_type']>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function attachmentBlock(file: LLMAttachment): Anthropic.ContentBlockParam | null {
  if (file.kind === 'image' && IMAGE_TYPES.has(file.mime_type as Anthropic.Base64ImageSource['media_type'])) {
    return { type: 'image', source: { type: 'base64', media_type: file.mime_type as Anthropic.Base64ImageSource['media_type'], data: file.data_base64 } };
  }
  if (file.kind === 'file' && file.mime_type === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data_base64 }, title: file.filename };
  }
  return null;
}

// Null when an attachment has no Messages API block; the caller refuses the request before any call.
function messagesInput(request: LLMRequest): Anthropic.MessageParam[] | null {
  const history: Array<{ role: 'user' | 'assistant'; content: Anthropic.ContentBlockParam[] }> = [];
  for (const message of request.messages) {
    const last = history[history.length - 1];
    const block: Anthropic.TextBlockParam = { type: 'text', text: message.content };
    // Roles alternate on the wire: consecutive same-role entries join one message as separate blocks.
    if (last && last.role === message.role) last.content.push(block);
    else history.push({ role: message.role, content: [block] });
  }
  const files: Anthropic.ContentBlockParam[] = [];
  for (const file of request.attachments ?? []) {
    const block = attachmentBlock(file);
    if (block === null) return null;
    files.push(block);
  }
  if (files.length > 0) {
    const lastUser = history.map((message) => message.role).lastIndexOf('user');
    if (lastUser === -1) history.push({ role: 'user', content: files });
    else history[lastUser]!.content.push(...files);
  }
  for (const round of toolRounds(request.tool_turns ?? [])) {
    // The round's own tool calls and words are replayed from the blocks the model produced; a round another provider
    // ran, or one recorded without them, is rebuilt from its call records.
    const replayed = round.prior.flatMap((item): Anthropic.ContentBlockParam[] => {
      if (outputItemProvider(item) !== ANTHROPIC_PROVIDER) return [];
      const block = item.block as Anthropic.ContentBlock | undefined;
      return block?.type === 'tool_use' || block?.type === 'text' ? [block as Anthropic.ContentBlockParam] : [];
    });
    const covered = new Set(replayed.flatMap((block) => block.type === 'tool_use' ? [block.id] : []));
    history.push({
      role: 'assistant',
      content: [
        ...replayed,
        ...round.turns.filter((turn) => !covered.has(turn.call.call_id)).map((turn): Anthropic.ToolUseBlockParam => ({ type: 'tool_use', id: turn.call.call_id, name: turn.call.name, input: toolInput(turn.call.arguments) })),
      ],
    });
    history.push({ role: 'user', content: round.turns.map((turn): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: turn.call.call_id, content: turn.output })) });
  }
  return history;
}

// A turn carrying the model's output items opens a round; the parallel calls that follow it belong to that round.
function toolRounds(turns: readonly LLMToolTurn[]): Array<{ prior: readonly Record<string, unknown>[]; turns: LLMToolTurn[] }> {
  const rounds: Array<{ prior: readonly Record<string, unknown>[]; turns: LLMToolTurn[] }> = [];
  for (const turn of turns) {
    const current = rounds[rounds.length - 1];
    if (current === undefined || turn.prior_items?.length) rounds.push({ prior: turn.prior_items ?? [], turns: [turn] });
    else current.turns.push(turn);
  }
  return rounds;
}

function toolInput(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// A request that replays tool blocks must define their tools. When the turn has withdrawn them for its closing round,
// the replayed names are declared with an empty schema and the model is told not to call them.
function toolsParams(request: LLMRequest): Pick<Anthropic.MessageCreateParams, 'tools' | 'tool_choice'> {
  if (request.tools) {
    return { tools: request.tools.map((tool): Anthropic.Tool => ({ name: tool.name, description: tool.description, input_schema: { ...tool.parameters, type: 'object' } })) };
  }
  const replayed = [...new Set((request.tool_turns ?? []).map((turn) => turn.call.name))];
  if (replayed.length === 0) return {};
  return {
    tools: replayed.map((name): Anthropic.Tool => ({ name, description: 'Not offered this round.', input_schema: { type: 'object' } })),
    tool_choice: { type: 'none' },
  };
}

function outputConfig(request: LLMRequest): Pick<Anthropic.MessageCreateParams, 'output_config'> {
  const config: Anthropic.OutputConfig = {
    ...(request.reasoning_effort ? { effort: request.reasoning_effort } : {}),
    ...(request.response_format ? { format: { type: 'json_schema', schema: request.response_format.schema } } : {}),
  };
  return Object.keys(config).length > 0 ? { output_config: config } : {};
}

// The retry headers the Anthropic SDK reads: retry-after-ms, else retry-after in seconds or as a date, and x-should-retry.
function retryAdvice(headers: Headers | undefined): ProviderRetryAdvice | undefined {
  if (!headers) return undefined;
  const millis = Number.parseFloat(headers.get('retry-after-ms') ?? '');
  const after = headers.get('retry-after');
  const seconds = Number.parseFloat(after ?? '');
  const afterMs = millis > 0 ? millis : after === null ? undefined : Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
  const flag = headers.get('x-should-retry');
  const advice = {
    ...(afterMs !== undefined && Number.isFinite(afterMs) ? { afterMs } : {}),
    ...(flag === 'true' || flag === 'false' ? { allowed: flag === 'true' } : {}),
  };
  return Object.keys(advice).length > 0 ? advice : undefined;
}

function anthropicErrorCode(error: unknown): 'auth_failed' | 'not_found' | 'rate_limited' | 'oversize' | 'invalid_args' | 'transient' {
  if (error instanceof Error && error.name === 'AbortError') return 'transient';
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 413) return 'oversize';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_args';
  // 5xx, 529 overloaded, a transport failure and an aborted call: a second try can succeed.
  return 'transient';
}
