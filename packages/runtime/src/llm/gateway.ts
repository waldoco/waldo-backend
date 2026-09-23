import {
  CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS,
  GATEWAY_CONSTANT_HEADERS,
  GATEWAY_STEP_HEADER,
  llmResponseSchema,
  type AdapterResult,
  type ErrorCode,
  type LLMMessage,
  type LLMResponse,
  type ModelName,
} from '@waldo/contracts';
import type {
  LLMGatewayAdapter,
  LLMGatewayRequest,
  TrustedGatewayAdapterResult,
  TrustedGatewayExecution,
} from './provider';

const CLOUDFLARE_AIG_REST_ORIGIN = 'https://api.cloudflare.com';
const DEFAULT_GATEWAY_TIMEOUT_MS = 20_000;

export type GatewaySecretBinding = {
  get(): Promise<string | null>;
};

export type CloudflareAIGatewayAdapterOptions = {
  accountId: string;
  gatewayId: string;
  credential: GatewaySecretBinding;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export class CloudflareAIGatewayAdapter implements LLMGatewayAdapter {
  private readonly accountId: string;
  private readonly gatewayId: string;
  private readonly credential: GatewaySecretBinding;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: CloudflareAIGatewayAdapterOptions) {
    this.accountId = requiredConfig(options.accountId, 'accountId');
    this.gatewayId = requiredConfig(options.gatewayId, 'gatewayId');
    this.credential = requiredCredential(options.credential);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = requiredTimeout(options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS);
  }

  async complete(request: LLMGatewayRequest): Promise<AdapterResult<LLMResponse>> {
    if (request.request.attachments) return { ok: false, error: 'gateway_attachments_unsupported', code: 'invalid_args' };
    const startedAt = this.now();
    const apiToken = await credentialValue(this.credential);
    if (apiToken === null) {
      return { ok: false, error: 'gateway_credential_unavailable', code: 'auth_failed' };
    }

    let response: Response;
    try {
      response = await this.safeFetch(apiToken, request);
    } catch {
      return { ok: false, error: 'gateway_fetch_failed', code: 'transient' };
    }

    if (!response.ok) {
      await discardResponseBody(response);
      return {
        ok: false,
        error: `gateway_http_${response.status}`,
        code: errorCodeForStatus(response.status),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'gateway_invalid_json', code: 'invalid_args' };
    }

    const normalized = normalizeChatCompletionsResponse(
      body,
      request.request.model,
      Math.max(0, this.now() - startedAt),
    );
    return normalized === null
      ? { ok: false, error: 'gateway_invalid_response', code: 'invalid_args' }
      : { ok: true, data: normalized };
  }

  async executeOrReconcile(input: TrustedGatewayExecution): Promise<TrustedGatewayAdapterResult> {
    if (input.operation === 'reconcile') {
      return {
        ok: false,
        code: 'transient',
        error: 'gateway_trusted_receipt_unavailable',
        receipt_status: 'unavailable',
      };
    }
    return this.complete(input.request);
  }

  private chatCompletionsUrl(): string {
    return `${CLOUDFLARE_AIG_REST_ORIGIN}/client/v4/accounts/${encodeURIComponent(
      this.accountId,
    )}/ai/v1/chat/completions`;
  }

  private async safeFetch(apiToken: string, request: LLMGatewayRequest): Promise<Response> {
    const url = this.chatCompletionsUrl();
    if (new URL(url).origin !== CLOUDFLARE_AIG_REST_ORIGIN) {
      throw new Error('gateway URL is outside the Cloudflare AI Gateway allowlist');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(apiToken, request),
        body: JSON.stringify(chatCompletionsBody(request)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(apiToken: string, request: LLMGatewayRequest): Headers {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${apiToken}`);
    headers.set('content-type', 'application/json');
    headers.set('cf-aig-gateway-id', this.gatewayId);
    headers.set(
      'cf-aig-collect-log-payload',
      GATEWAY_CONSTANT_HEADERS['cf-aig-collect-log-payload'],
    );
    headers.set(GATEWAY_STEP_HEADER, request.fallback_step);
    headers.set('cf-aig-skip-cache', request.step.cache === 'none' ? 'true' : 'false');
    return headers;
  }
}

function chatCompletionsBody(request: LLMGatewayRequest): Record<string, unknown> {
  return {
    model: cloudflareModelName(request.request.model),
    messages: [
      ...(request.request.system === undefined
        ? []
        : [{ role: 'system', content: request.request.system }]),
      ...request.request.messages.map(toChatMessage),
    ],
    max_tokens: request.request.max_tokens,
    temperature: request.request.temperature,
  };
}

function toChatMessage(message: LLMMessage): { role: string; content: string } {
  return { role: message.role, content: message.content };
}

function normalizeChatCompletionsResponse(
  body: unknown,
  requestedModel: ModelName,
  latencyMs: number,
): LLMResponse | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const returnedModel = record.model;
  if (
    typeof returnedModel !== 'string' ||
    !isExpectedCloudflareModelName(returnedModel, requestedModel)
  ) {
    return null;
  }

  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  if (choice === null || typeof choice !== 'object') return null;
  const message = (choice as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.length === 0) return null;

  const usage = record.usage;
  if (usage === null || typeof usage !== 'object') return null;
  const usageRecord = usage as Record<string, unknown>;
  const promptTokens = usageRecord.prompt_tokens;
  const completionTokens = usageRecord.completion_tokens;
  const details = usageRecord.prompt_tokens_details;
  const cachedTokens =
    details !== null && typeof details === 'object'
      ? (details as Record<string, unknown>).cached_tokens
      : 0;

  const parsed = llmResponseSchema.safeParse({
    model: requestedModel,
    text: content,
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cache_read_input_tokens: cachedTokens ?? 0,
    latency_ms: latencyMs,
  });
  return parsed.success ? parsed.data : null;
}

function cloudflareModelName(model: ModelName): string {
  const identity = CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[model];
  if (identity === undefined) throw new Error(`unsupported Cloudflare model: ${model}`);
  return identity.request;
}

function isExpectedCloudflareModelName(returnedModel: string, requestedModel: ModelName): boolean {
  const identity = CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[requestedModel];
  if (identity === undefined) return false;
  return returnedModel === identity.request || identity.response.includes(returnedModel);
}

function errorCodeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 413) return 'oversize';
  if (status === 429) return 'rate_limited';
  return 'transient';
}

function requiredConfig(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`CloudflareAIGatewayAdapter requires ${name}`);
  }
  return value;
}

function requiredCredential(value: GatewaySecretBinding): GatewaySecretBinding {
  if (value === null || typeof value !== 'object' || typeof value.get !== 'function') {
    throw new Error('CloudflareAIGatewayAdapter requires a secret binding');
  }
  return value;
}

function requiredTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('CloudflareAIGatewayAdapter requires a positive timeoutMs');
  }
  return value;
}

async function credentialValue(binding: GatewaySecretBinding): Promise<string | null> {
  try {
    const value = await binding.get();
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are intentionally neither parsed nor recorded.
  }
}
