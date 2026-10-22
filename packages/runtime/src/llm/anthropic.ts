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
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: input.request.model,
        max_tokens: input.request.max_tokens,
        ...(input.request.system ? { system: systemPrompt(input.request.system, input.step.cache === 'anthropic_native') } : {}),
        messages,
        ...toolsParams(input.request),
        ...outputConfig(input.request),
      };
      let response = await this.client.messages.create(body, { signal: controller.signal });
      // A response that only searched for tools (the server paused its turn) has not answered yet. The tool search guide
      // continues it by sending its content back as the assistant's turn; the searched blocks lead the answer's own, so a
      // later round replays the whole turn.
      const searched: Anthropic.ContentBlock[] = [];
      const searchSpent = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
      for (let continuation = 0; continuation < SEARCH_CONTINUATIONS && onlySearched(response); continuation += 1) {
        searched.push(...response.content);
        searchSpent.input_tokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
        searchSpent.output_tokens += response.usage.output_tokens;
        searchSpent.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
        response = await this.client.messages.create({ ...body, messages: [...messages, { role: 'assistant', content: searched as Anthropic.ContentBlockParam[] }] }, { signal: controller.signal });
      }
      const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n').trim();
      const toolCalls: LLMToolCall[] = response.content.flatMap((block) => block.type === 'tool_use'
        ? [{ call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }]
        : []);
      // Anthropic's input_tokens excludes cached tokens; the seam reports the whole prompt, cache reads inside it.
      const spent = {
        input_tokens: searchSpent.input_tokens + response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
        output_tokens: searchSpent.output_tokens + response.usage.output_tokens,
        cache_read_input_tokens: searchSpent.cache_read_input_tokens + (response.usage.cache_read_input_tokens ?? 0),
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
        output_items: [...searched, ...response.content].map((block) => ({ type: block.type, [OUTPUT_ITEM_PROVIDER]: ANTHROPIC_PROVIDER, block: block as unknown as Record<string, unknown> })),
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

// Each continuation is a billed call; past this many a response that keeps only searching fails as an empty one does, and
// the provider's attempt plan decides what follows.
const SEARCH_CONTINUATIONS = 2;
const onlySearched = (response: Anthropic.Message): boolean => response.stop_reason !== 'max_tokens'
  && response.content.some((block) => (block.type as string) === 'tool_search_tool_result')
  && response.content.every((block) => ['server_tool_use', 'tool_search_tool_result', 'thinking', 'redacted_thinking'].includes(block.type as string));

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
    // With tool search on and tools offered, the search call and its result go back unchanged, as the tool search guide
    // requires; a closing round declares no deferred tools, so it leaves them out and its calls stay plain tool_use.
    const searchReplay = request.tool_search !== undefined && request.tools !== undefined;
    const replayed = round.prior.flatMap((item): Anthropic.ContentBlockParam[] => {
      if (outputItemProvider(item) !== ANTHROPIC_PROVIDER) return [];
      const block = item.block as Anthropic.ContentBlock | undefined;
      const kind = block?.type as string | undefined;
      return kind === 'tool_use' || kind === 'text' || (searchReplay && (kind === 'server_tool_use' || kind === 'tool_search_tool_result')) ? [block as Anthropic.ContentBlockParam] : [];
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

// A deferred tool the replayed history calls without the search result that loaded it goes up front: a round another
// provider ran is rebuilt as plain tool_use, and a trimmed history can drop the round whose search loaded it. Only then
// does the list change; a turn on this provider alone replays its searches.
function calledWithoutLoading(request: LLMRequest): Set<string> {
  const loaded = new Set<string>();
  const called = new Set<string>();
  const rebuilt = new Set<string>();
  for (const round of toolRounds(request.tool_turns ?? [])) {
    const blocks = round.prior.flatMap((item) => outputItemProvider(item) === ANTHROPIC_PROVIDER && item.block ? [item.block as { type?: unknown; id?: unknown; content?: { tool_references?: Array<{ tool_name?: unknown }> } }] : []);
    for (const block of blocks) {
      if (block.type !== 'tool_search_tool_result') continue;
      for (const reference of block.content?.tool_references ?? []) if (typeof reference.tool_name === 'string') loaded.add(reference.tool_name);
    }
    const replayed = new Set(blocks.flatMap((block) => block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : []));
    for (const turn of round.turns) {
      called.add(turn.call.name);
      if (!replayed.has(turn.call.call_id)) rebuilt.add(turn.call.name);
    }
  }
  return new Set([...called].filter((name) => rebuilt.has(name) || !loaded.has(name)));
}

// A request that replays tool blocks must define their tools. When the turn has withdrawn them for its closing round,
// the replayed names are declared with an empty schema and the model is told not to call them.
// With tool search on (the tool search tool guide), deferred tools carry defer_loading and stay out of the prompt until
// the BM25 search tool loads them; core tools and the search tool load up front. Schemas stay non-strict here: strict tool
// use allows at most 20 strict tools, 24 optional parameters and 16 union parameters per request, which the brain's
// tool list exceeds.
function toolsParams(request: LLMRequest): Pick<Anthropic.MessageCreateParams, 'tools' | 'tool_choice'> {
  if (request.tools) {
    const called = request.tool_search ? calledWithoutLoading(request) : new Set<string>();
    const tools = request.tools.map((tool): Anthropic.Tool => ({
      name: tool.name, description: tool.description, input_schema: { ...tool.parameters, type: 'object' },
      ...(request.tool_search && tool.defer_loading && !called.has(tool.name) ? { defer_loading: true } : {}),
    }));
    if (!request.tool_search || !request.tools.some((tool) => tool.defer_loading)) return { tools };
    // The installed SDK types the search tool and defer_loading only on the beta surface; the Messages API takes them.
    return { tools: [{ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' } as unknown as Anthropic.Tool, ...tools] };
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
