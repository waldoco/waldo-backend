import { GATEWAY_CONSTANT_HEADERS, ROSTER } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { CloudflareAIGatewayAdapter } from '../src/llm/gateway';
import type { LLMGatewayRequest } from '../src/llm/provider';

function credential(value = 'cf-token-123') {
  return { get: async () => value };
}

function request(model = ROSTER.primary): LLMGatewayRequest {
  return {
    request: {
      model,
      system: 'runtime system summary',
      messages: [{ role: 'user', content: 'derived brief context only' }],
      max_tokens: 256,
      temperature: 0,
    },
    route: {
      trigger: 'brief',
      primary: { provider: 'workers_ai', model: ROSTER.primary, cache: 'none' },
      fallback: [{ provider: 'anthropic', model: ROSTER.fallback, cache: 'none' }],
      floor: 'template',
    },
    step: { provider: 'workers_ai', model, cache: 'none' },
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: GATEWAY_CONSTANT_HEADERS,
  };
}

describe('CloudflareAIGatewayAdapter', () => {
  it('sends metadata-only Cloudflare AI Gateway chat requests and normalizes usage', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const adapter = new CloudflareAIGatewayAdapter({
      accountId: 'account-123',
      gatewayId: 'waldo-staging',
      credential: credential(),
      now: (() => {
        let t = 1_000;
        return () => {
          t += 25;
          return t;
        };
      })(),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            model: ROSTER.primary,
            choices: [{ message: { content: '{"tool_calls":[]}' } }],
            usage: {
              prompt_tokens: 42,
              completion_tokens: 7,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const result = await adapter.complete(request());

    expect(result).toEqual({
      ok: true,
      data: {
        model: ROSTER.primary,
        text: '{"tool_calls":[]}',
        input_tokens: 42,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        latency_ms: 25,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/chat/completions',
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer cf-token-123');
    expect(headers.get('cf-aig-gateway-id')).toBe('waldo-staging');
    expect(headers.get('cf-aig-collect-log-payload')).toBe('false');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: ROSTER.primary,
      messages: [
        { role: 'system', content: 'runtime system summary' },
        { role: 'user', content: 'derived brief context only' },
      ],
      max_tokens: 256,
      temperature: 0,
    });
  });

  it('classifies provider HTTP errors without returning raw provider bodies', async () => {
    const adapter = new CloudflareAIGatewayAdapter({
      accountId: 'account-123',
      gatewayId: 'waldo-staging',
      credential: credential(),
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { message: 'raw prompt and provider body must not leak' },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    });

    const result = await adapter.complete(request());

    expect(result).toEqual({
      ok: false,
      code: 'rate_limited',
      error: 'gateway_http_429',
    });
    expect(JSON.stringify(result)).not.toContain('raw prompt');
    expect(JSON.stringify(result)).not.toContain('provider body');
  });

  it('pins metadata-only logging and bypasses cache for a cache-none route', async () => {
    const calls: RequestInit[] = [];
    const adapter = new CloudflareAIGatewayAdapter({
      accountId: 'account-123',
      gatewayId: 'waldo-staging',
      credential: credential(),
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(
          JSON.stringify({
            model: ROSTER.primary,
            choices: [{ message: { content: 'safe response' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        );
      },
    });

    const result = await adapter.complete({
      ...request(),
      headers: { 'cf-aig-collect-log-payload': 'true' } as never,
    });

    expect(result.ok).toBe(true);
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get('cf-aig-collect-log-payload')).toBe('false');
    expect(headers.get('cf-aig-skip-cache')).toBe('true');
  });

  it('rejects a successful response that omits the provider model', async () => {
    const adapter = new CloudflareAIGatewayAdapter({
      accountId: 'account-123',
      gatewayId: 'waldo-staging',
      credential: credential(),
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'safe response' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
    });

    await expect(adapter.complete(request())).resolves.toEqual({
      ok: false,
      code: 'invalid_args',
      error: 'gateway_invalid_response',
    });
  });

  it('does not fetch when its secret binding has no credential', async () => {
    let fetches = 0;
    const adapter = new CloudflareAIGatewayAdapter({
      accountId: 'account-123',
      gatewayId: 'waldo-staging',
      credential: { get: async () => null },
      fetch: async () => {
        fetches += 1;
        return new Response('', { status: 500 });
      },
    } as never);

    await expect(adapter.complete(request())).resolves.toEqual({
      ok: false,
      code: 'auth_failed',
      error: 'gateway_credential_unavailable',
    });
    expect(fetches).toBe(0);
  });

  it('passes an abort signal to its fixed gateway transport', async () => {
    let signal: AbortSignal | undefined;
    const adapter = new CloudflareAIGatewayAdapter({
      accountId: 'account-123',
      gatewayId: 'waldo-staging',
      credential: credential(),
      timeoutMs: 20,
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal as AbortSignal | undefined;
        return new Response(
          JSON.stringify({
            model: ROSTER.primary,
            choices: [{ message: { content: 'safe response' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        );
      },
    } as never);

    await expect(adapter.complete(request())).resolves.toMatchObject({ ok: true });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
