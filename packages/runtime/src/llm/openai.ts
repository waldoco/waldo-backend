import OpenAI from 'openai';
import { validModelCredential } from './credential-shape';
import {
  OPENAI_PROVIDER,
  OPENAI_REASONING,
  PROVIDER_OF,
  type LLMTool,
  type ModelName,
} from '@waldo/contracts';
import { fromOpenAIStrictArguments, openAIStrictParameters } from './strict-schema';
import { outputItemProvider, type LLMGatewayAdapter, type LLMGatewayRequest, type LLMGatewayResult, type ProviderRetryAdvice } from './provider';
import type { ReplyDeltaSink } from '../conversation/reply-stream';
import { callTimeLeftMs, MODEL_CALL_TIMEOUT_MS } from './time-budget';

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
    this.timeoutMs = options.timeoutMs ?? MODEL_CALL_TIMEOUT_MS;
    this.onResponseMetadata = options.onResponseMetadata;
    this.missingKey = options.apiKey !== undefined ? !validModelCredential(options.apiKey) : options.client === undefined;
    // The provider's attempt plan is the one retry owner. An SDK retry is invisible to the trace, the circuit breaker and
    // the spend meter, and its backoff sleep outlasts both the turn's deadline and a stop.
    this.client = this.missingKey ? undefined : options.client ?? new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: this.timeoutMs,
    });
  }

  async complete(input: LLMGatewayRequest): Promise<LLMGatewayResult> {
    if (PROVIDER_OF[input.request.model] !== OPENAI_PROVIDER || input.step.provider !== OPENAI_PROVIDER) {
      return { ok: false, code: 'invalid_args', error: 'OpenAI adapter received an unsupported route' };
    }
    // Refused, never mapped to a nearby effort: a mapped effort would silently change how much the model reasons.
    const reasoning = OPENAI_REASONING[input.request.model];
    const effort = input.request.reasoning_effort ?? reasoning?.effort;
    if (reasoning === undefined || effort === undefined || !reasoning.accepts.includes(effort)) {
      return { ok: false, code: 'invalid_args', error: 'OpenAI adapter received a reasoning effort the model does not accept' };
    }
    if (this.missingKey || this.client === undefined) {
      return { ok: false, code: 'auth_failed', error: 'OPENAI_API_KEY is unavailable' };
    }

    input.runScope?.admit();
    const controller = new AbortController();
    const abortRun = () => controller.abort();
    input.runScope?.signal.addEventListener('abort', abortRun, { once: true });
    // The request's own limit, cut to what is left of the turn.
    const timeout = setTimeout(() => controller.abort(), Math.max(0, Math.min(this.timeoutMs, callTimeLeftMs(input.runScope))));
    const startedAt = Date.now();
    // Declared outside the try: a search-only response was billed even when its continuation then fails.
    const searched: OpenAI.Responses.ResponseOutputItem[] = [];
    const searchSpent = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    try {
      const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
          model: input.request.model,
          instructions: input.request.system,
          input: responsesInput(input.request),
          max_output_tokens: input.request.max_tokens,
          store: false,
          reasoning: { effort, summary: 'auto' },
          ...(input.request.cache_key ? { prompt_cache_key: input.request.cache_key } : {}),
          ...(input.request.tools || input.request.web_search ? { tools: [
            ...functionTools(input.request),
            ...(input.request.web_search ? [hostedWebSearch(input.request.web_search)] : []),
          ] } : {}),
          ...(input.request.response_format ? { text: { format: { type: 'json_schema' as const, name: input.request.response_format.name, schema: input.request.response_format.schema, strict: true } } } : {}),
      };
      const client = this.client;
      const send = (params: OpenAI.Responses.ResponseCreateParamsNonStreaming) => input.stream
        ? streamedResponse(client, params, controller.signal, input.stream)
        : client.responses.create(params, { signal: controller.signal });
      let response = await send(body);
      // A response that only searched for tools has not answered yet: it is continued with its search items, as a round
      // after a search replays them, and the items lead the answer's own so later rounds replay the whole search.
      for (let continuation = 0; continuation < SEARCH_CONTINUATIONS && onlySearched(response); continuation += 1) {
        searched.push(...response.output);
        searchSpent.input_tokens += response.usage?.input_tokens ?? 0;
        searchSpent.output_tokens += response.usage?.output_tokens ?? 0;
        searchSpent.cache_read_input_tokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;
        const asked = typeof body.input === 'string' ? [{ role: 'user' as const, content: body.input }] : body.input ?? [];
        response = await send({ ...body, input: [...asked, ...searched as unknown as OpenAI.Responses.ResponseInputItem[]] });
      }
      const text = withCitedLinks(responseText(response).trim(), response);
      const strictSent = strictParametersByTool(input.request);
      const toolCalls = response.output.flatMap((item) => item.type === 'function_call' ? [{ call_id: item.call_id, name: item.name, arguments: strictSent.has(item.name) ? fromOpenAIStrictArguments(item.arguments, strictSent.get(item.name)!) : item.arguments }] : []);
      const incomplete = response.status === 'incomplete';
      const spent = {
        input_tokens: searchSpent.input_tokens + (response.usage?.input_tokens ?? 0),
        output_tokens: searchSpent.output_tokens + (response.usage?.output_tokens ?? 0),
        cache_read_input_tokens: searchSpent.cache_read_input_tokens + (response.usage?.input_tokens_details?.cached_tokens ?? 0),
      };
      if (incomplete && text.length === 0 && toolCalls.length === 0) {
        return { ok: false, code: 'oversize', error: `OpenAI output incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`, spent };
      }
      // A reply that is only reasoning (no text, no tool call) is a transient model miss: the provider asks once more,
      // and the tokens it cost still count.
      if (text.length === 0 && toolCalls.length === 0) {
        return { ok: false, code: 'transient', error: 'OpenAI returned empty output', spent };
      }
      const parsed = {
        model: input.request.model,
        text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...spent,
        output_items: [...searched, ...response.output].map((item) => item as unknown as Record<string, unknown>),
        latency_ms: Date.now() - startedAt,
        ...(incomplete ? { truncated: true } : {}),
      };
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
      // Only identifiers cross into the trace (status, provider error code, offending parameter name); the provider's message can quote the request.
      const detail = error instanceof OpenAI.APIError
        ? ` (${[error.status, error.code, error.param].filter((part) => part !== undefined && part !== null && part !== '').join(' ')})`
        : '';
      const retry = error instanceof OpenAI.APIError ? retryAdvice(error.headers) : undefined;
      return { ok: false, code: openAIErrorCode(error), error: `OpenAI request failed${detail}`, ...(retry ? { retry } : {}), ...(searched.length > 0 ? { spent: searchSpent } : {}) };
    } finally {
      clearTimeout(timeout);
      input.runScope?.signal.removeEventListener('abort', abortRun);
    }
  }
}

// One create, streamed. The response's first message streams to the reply only when the model labels it its final answer
// (the Responses API `phase`; the installed SDK does not type it yet): commentary, reasoning and an unlabelled message never
// do. A tool call after it takes it back. The terminal event carries the same Response the unstreamed call returns, so
// everything after this reads one shape.
async function streamedResponse(client: OpenAIResponsesClient, body: OpenAI.Responses.ResponseCreateParamsNonStreaming, signal: AbortSignal, sink: ReplyDeltaSink): Promise<OpenAI.Responses.Response> {
  const events = await client.responses.create({ ...body, stream: true }, { signal });
  let messages = 0, streaming: number | null = null, streamed = false;
  for await (const event of events) {
    if (event.type === 'response.output_item.added') {
      if (event.item.type === 'message') {
        messages += 1;
        streaming = messages === 1 && (event.item as { phase?: unknown }).phase === 'final_answer' ? event.output_index : null;
      } else if (event.item.type === 'function_call' && streamed) {
        streamed = false;
        sink.retract();
      }
    } else if (event.type === 'response.output_text.delta' && event.output_index === streaming) {
      streamed = true;
      sink.delta(event.delta);
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      return event.response;
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(`OpenAI stream ${event.type}`);
    }
  }
  throw new Error('OpenAI stream ended without a result');
}

// Without tool search every function goes up front, non-strict, as it always has. With it (the tool search guide,
// Responses API): core functions go up front with strict schemas where they fit the documented subset, each deferred
// function goes into its namespace with defer_loading, and the hosted tool_search tool loads a namespace when the model
// asks. Loaded tools are injected at the end of the context, so the cached prefix holds.
function functionTools(request: LLMGatewayRequest['request']): OpenAI.Responses.Tool[] {
  const tools = request.tools ?? [];
  if (!request.tool_search) return tools.map((tool) => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
  const strictFunction = (tool: LLMTool, deferred: boolean) => {
    const strict = openAIStrictParameters(tool.parameters);
    return { type: 'function', name: tool.name, description: tool.description, parameters: strict ?? tool.parameters, strict: strict !== null, ...(deferred ? { defer_loading: true } : {}) };
  };
  const namespaces = new Map<string, unknown[]>();
  const core: unknown[] = [];
  const called = calledWithoutLoading(request);
  for (const tool of tools) {
    if (tool.defer_loading && tool.namespace && request.tool_search.namespaces[tool.namespace] && !called.has(tool.name)) {
      const members = namespaces.get(tool.namespace) ?? [];
      members.push(strictFunction(tool, true));
      namespaces.set(tool.namespace, members);
    } else core.push(strictFunction(tool, false));
  }
  // The installed SDK has no types for namespaces, defer_loading or tool_search; the API takes them as documented.
  return [
    ...core,
    ...[...namespaces].map(([name, members]) => ({ type: 'namespace', name, description: request.tool_search!.namespaces[name], tools: members })),
    ...(namespaces.size ? [{ type: 'tool_search' }] : []),
  ] as unknown as OpenAI.Responses.Tool[];
}

// Each continuation is a billed call; past this many a response that keeps only searching fails as an empty one does, and
// the provider's attempt plan decides what follows.
const SEARCH_CONTINUATIONS = 2;
const onlySearched = (response: OpenAI.Responses.Response): boolean => response.status !== 'incomplete'
  && response.output.some((item) => (item.type as string) === 'tool_search_output')
  && response.output.every((item) => ['tool_search_call', 'tool_search_output', 'reasoning'].includes(item.type as string));

// A deferred function the replayed history calls without the search output that loaded it goes up front: a round
// another provider ran is rebuilt from its call record with no namespace, and a trimmed history can drop the round whose
// search loaded it. Only then does the list change; a turn on this provider alone replays its searches.
function calledWithoutLoading(request: LLMGatewayRequest['request']): Set<string> {
  const loaded = new Set<string>();
  const called = new Set<string>();
  const rebuilt = new Set<string>();
  const replayed = new Set<string>();
  for (const turn of request.tool_turns ?? []) {
    for (const item of (turn.prior_items ?? []).filter((prior) => outputItemProvider(prior) === OPENAI_PROVIDER)) {
      if (item.type === 'function_call' && typeof item.call_id === 'string') replayed.add(item.call_id);
      if (item.type !== 'tool_search_output' || !Array.isArray(item.tools)) continue;
      for (const found of item.tools as Array<{ type?: unknown; name?: unknown }>) {
        if (typeof found.name !== 'string') continue;
        if (found.type === 'namespace') for (const tool of request.tools ?? []) { if (tool.namespace === found.name) loaded.add(tool.name); }
        else loaded.add(found.name);
      }
    }
    called.add(turn.call.name);
    if (!replayed.has(turn.call.call_id)) rebuilt.add(turn.call.name);
  }
  return new Set([...called].filter((name) => rebuilt.has(name) || !loaded.has(name)));
}

// The original parameters of each function sent strict, so a call's strict nulls can be turned back into absent fields.
function strictParametersByTool(request: LLMGatewayRequest['request']): Map<string, Record<string, unknown>> {
  if (!request.tool_search) return new Map();
  return new Map((request.tools ?? []).flatMap((tool) => openAIStrictParameters(tool.parameters) ? [[tool.name, tool.parameters] as const] : []));
}

// A request that declares no tool search (the turn's closing round, which offers no tools, or a resend without the search
// a model refused) cannot carry tool-search state: the namespaces it loaded are not declared, so the search items are left
// out and a loaded call is replayed as a plain function call.
function replayable(item: Record<string, unknown>, searchDeclared: boolean): Record<string, unknown>[] {
  if (searchDeclared) return [item];
  if (item.type === 'tool_search_call' || item.type === 'tool_search_output') return [];
  if (item.type === 'function_call' && 'namespace' in item) { const { namespace: _namespace, ...call } = item; return [call]; }
  return [item];
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
      // a call is replayed from its record only when no earlier item carries its call_id. A round another provider ran
      // left items this API cannot read, so only OpenAI's own are replayed and that round is rebuilt from its records.
      const replayed = new Set<string>();
      return (request.tool_turns ?? []).flatMap((turn): OpenAI.Responses.ResponseInputItem[] => {
        const prior = (turn.prior_items ?? []).filter((item) => outputItemProvider(item) === OPENAI_PROVIDER).flatMap((item) => replayable(item, request.tools !== undefined && request.tool_search !== undefined)) as unknown as OpenAI.Responses.ResponseInputItem[];
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

// The installed SDK types only the legacy web_search_preview tool; OpenAI's web search guide names web_search for new
// Responses integrations, with the same approximate user_location.
function hostedWebSearch(search: NonNullable<LLMGatewayRequest['request']['web_search']>): OpenAI.Responses.Tool {
  return { type: 'web_search', user_location: { type: 'approximate', ...search } } as unknown as OpenAI.Responses.Tool;
}

// OpenAI requires web results shown to people to carry visible, clickable citations. The model usually links its
// sources inline; a cited source the text does not link is listed after it, so every citation reaches the owner.
function withCitedLinks(text: string, response: OpenAI.Responses.Response): string {
  const missing = new Map<string, string>();
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text') continue;
      for (const annotation of part.annotations ?? []) {
        if (annotation.type === 'url_citation' && !text.includes(annotation.url)) missing.set(annotation.url, annotation.title.replace(/\s+/g, ' ').trim());
      }
    }
  }
  if (missing.size === 0) return text;
  return `${text}\n\nSources:\n${[...missing].map(([url, title]) => `- ${title ? `${title}: ` : ''}${url}`).join('\n')}`;
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

// The retry headers the OpenAI SDK reads: retry-after-ms, else retry-after in seconds or as a date, and x-should-retry.
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