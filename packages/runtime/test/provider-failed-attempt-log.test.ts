import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
  ANTHROPIC_PROVIDER,
  OPENAI_GPT_6_1_TERRA_MODEL,
  buildSessionState,
  type LLMResponse,
  type ModelName,
} from '@waldo/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter } from '../src/llm/anthropic';
import { ownerRoutePolicy } from '../src/llm/owner-routes';
import { RuntimeLLMProvider, type LLMGatewayAdapter, type LLMGatewayRequest } from '../src/llm/provider';
import type { HookRuntimeContext } from '../src/hooks/registry';
import { sanitise } from '../src/scribe/sanitiser';

const canaryTokens = ['1111111111111111', '2222222222222222', '3333333333333333'];
const ctx = (): HookRuntimeContext => ({
  authenticatedUserId: 'user-1', trigger: 'user_message', canaryTokens,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: canaryTokens, started_at: 1_700_000_000_000 }),
  sourceTaint: null, toolArgSourceTaint: null, sanitise,
});
const answer = (model: ModelName): LLMResponse => ({ model, text: 'Hello.', input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, latency_ms: 11 });
const SECRET_PROMPT = 'my resting heart rate is 48 and the key is sk-ant-leak';
const request = (primary: ModelName) => ({
  trigger: 'user_message' as const,
  policy: ownerRoutePolicy(primary, primary, { openaiApiKey: 'fixture-openai', anthropicApiKey: 'fixture-anthropic' }),
  renderRequest: () => ({ system: 'Be concise.', messages: [{ role: 'user' as const, content: SECRET_PROMPT }], max_tokens: 64, temperature: 0.3 }),
});

// The Anthropic side is the real adapter over a client that fails the way the API does; the OpenAI side answers.
const gatewayWith = (anthropic: () => unknown): LLMGatewayAdapter => {
  const adapter = new AnthropicMessagesAdapter({ apiKey: 'test-key', client: { messages: { create: async () => anthropic() } } as never });
  return { complete: async (call: LLMGatewayRequest) => call.step.provider === ANTHROPIC_PROVIDER ? adapter.complete(call) : { ok: true as const, data: answer(call.request.model) } };
};
const apiError = (status: number, type: string) => () => { throw Anthropic.APIError.generate(status, { type: 'error', error: { type, message: SECRET_PROMPT } }, undefined, new Headers({ authorization: 'Bearer sk-ant-leak' })); };
const failedLines = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map(([line]) => String(line)).filter((line: string) => line.includes('provider_attempt_failed')).map((line: string) => JSON.parse(line) as Record<string, unknown>);

afterEach(() => vi.restoreAllMocks());

describe('a failed provider attempt is logged with its reason', () => {
  it('a 401 authentication_error from Anthropic logs one line with status, type, latency and that a fallback follows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await new RuntimeLLMProvider({ gateway: gatewayWith(apiError(401, 'authentication_error')) }).complete(request(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL), ctx());
    expect(result.ok).toBe(true);
    const lines = failedLines(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ hop: 'provider_attempt_failed', ok: false, provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, code: 'auth_failed', status: 401, error_type: 'authentication_error', fallback_follows: true });
    expect(lines[0]!.latency_ms).toEqual(expect.any(Number));
  });

  it('the line never carries the prompt, the key, a header or the provider\'s message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await new RuntimeLLMProvider({ gateway: gatewayWith(apiError(401, 'authentication_error')) }).complete(request(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL), ctx());
    const text = warn.mock.calls.map(([line]) => String(line)).join('\n');
    for (const secret of ['heart rate', 'sk-ant', 'Bearer', 'authorization', 'Be concise']) expect(text).not.toContain(secret);
  });

  it('a connection failure with no HTTP status logs the error class, so the reason is never blank', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = () => { throw new Anthropic.APIConnectionError({ message: 'connect ECONNREFUSED 10.0.0.1:443' }); };
    await new RuntimeLLMProvider({ gateway: gatewayWith(refused) }).complete(request(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL), ctx());
    // A transient failure is tried once more on the same model, and each failed attempt has its own line.
    const lines = failedLines(warn);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line).toMatchObject({ provider: ANTHROPIC_PROVIDER, code: 'transient' });
      expect(line).not.toHaveProperty('status');
      expect(String(line.detail)).toContain('APIConnectionError');
    }
    expect(lines.at(-1)).toMatchObject({ fallback_follows: true });
    expect(JSON.stringify(lines)).not.toContain('10.0.0.1');
  });

  it('a call that succeeds logs nothing new', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway: LLMGatewayAdapter = { complete: async call => ({ ok: true, data: answer(call.request.model) }) };
    const result = await new RuntimeLLMProvider({ gateway }).complete(request(OPENAI_GPT_6_1_TERRA_MODEL), ctx());
    expect(result.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failure with nothing left to fall back to says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway: LLMGatewayAdapter = { complete: async () => ({ ok: false, code: 'auth_failed', error: 'OpenAI request failed (401 invalid_api_key)' }) };
    const result = await new RuntimeLLMProvider({ gateway }).complete(request(OPENAI_GPT_6_1_TERRA_MODEL), ctx());
    expect(result.ok).toBe(false);
    const lines = failedLines(warn);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toMatchObject({ fallback_follows: false });
  });
});
