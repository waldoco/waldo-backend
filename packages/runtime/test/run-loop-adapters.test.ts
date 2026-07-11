import { describe, expect, it } from 'vitest';
import { isLocalRunLoopEnvironment, resolveRunLoopAdapters } from '../src/run-loop/adapters';

const gatewayEnv = {
  WALDO_ENV: 'staging',
  RUN_LOOP_PROVIDER_MODE: 'gateway',
  RUN_LOOP_PROVIDER_LIVE: '1',
  CLOUDFLARE_ACCOUNT_ID: 'account-123',
  AI_GATEWAY_ID: 'waldo-staging',
  AI_GATEWAY_API_TOKEN: { get: async () => 'cf-token-123' },
} as const;

describe('resolveRunLoopAdapters', () => {
  it('fails closed when the runtime environment is not declared', () => {
    expect(() => resolveRunLoopAdapters({})).toThrow(/WALDO_ENV/);
  });

  it('defaults to fake adapters only in test and local environments', () => {
    const adapters = resolveRunLoopAdapters({
      WALDO_ENV: 'test',
      RUN_LOOP_LOCAL_INGRESS_TOKEN: 'test-run-loop-local-token-000000000000',
    });

    expect(adapters.providerMode).toBe('fake');
  });

  it('allows local ingress only in test and local environments', () => {
    expect(isLocalRunLoopEnvironment('test')).toBe(true);
    expect(isLocalRunLoopEnvironment('local')).toBe(true);
    expect(isLocalRunLoopEnvironment('staging')).toBe(false);
    expect(isLocalRunLoopEnvironment('production')).toBe(false);
  });

  it('rejects fake adapters in staging and production environments', () => {
    expect(() =>
      resolveRunLoopAdapters({
        WALDO_ENV: 'staging',
        RUN_LOOP_PROVIDER_MODE: 'fake',
      }),
    ).toThrow(/fake run-loop adapters are only allowed in test or local/);

    expect(() =>
      resolveRunLoopAdapters({
        WALDO_ENV: 'production',
        RUN_LOOP_PROVIDER_MODE: 'fake',
      }),
    ).toThrow(/fake run-loop adapters are only allowed in test or local/);
  });

  it('requires explicit staging live opt-in before constructing a gateway adapter', () => {
    expect(() =>
      resolveRunLoopAdapters({
        WALDO_ENV: 'staging',
        RUN_LOOP_PROVIDER_MODE: 'gateway',
        CLOUDFLARE_ACCOUNT_ID: 'account-123',
        AI_GATEWAY_ID: 'waldo-staging',
        AI_GATEWAY_API_TOKEN: { get: async () => 'cf-token-123' },
      }),
    ).toThrow(/RUN_LOOP_PROVIDER_LIVE=1/);
  });

  it('constructs gateway mode only with a Secrets Store binding and a fail-closed spend reader', async () => {
    const adapters = resolveRunLoopAdapters(gatewayEnv);

    expect(adapters.providerMode).toBe('gateway');
    await expect(adapters.spendReader?.read()).resolves.toEqual({
      ok: false,
      code: 'transient',
      error: 'spend_state_unavailable',
    });
  });

  it.each([
    resolveRunLoopAdapters({ WALDO_ENV: 'test' }),
    resolveRunLoopAdapters(gatewayEnv),
  ])('uses the production Scribe and medical gate in every provider mode', async (adapters) => {
    const input = {
      payload: { hrv: 41 },
      destination: 'internal_context' as const,
      canary_tokens: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'],
      source_taint: null,
    };

    await expect(Promise.resolve(adapters.safety.sanitise?.(input))).resolves.toMatchObject({
      ok: false,
      check: 'health_value',
      reason: 'health_value_leak',
    });
    await expect(
      Promise.resolve(adapters.safety.medicalGate?.('You may have hypertension.')),
    ).resolves.toEqual({
      ok: false,
      reason: 'medical_claim',
    });
  });

  it('rejects a plaintext gateway token instead of a secret binding', () => {
    expect(() =>
      resolveRunLoopAdapters({
        ...gatewayEnv,
        AI_GATEWAY_API_TOKEN: 'cf-token-123',
      } as never),
    ).toThrow(/secret binding/);
  });
});
