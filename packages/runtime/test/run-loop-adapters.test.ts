import {
  GATEWAY_CONSTANT_HEADERS,
  ROSTER,
  ROUTING_TABLE,
  acceptTrustedInvocation,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  RUN_LOOP_OBSERVE_SYSTEM_PREFIX,
  RUN_LOOP_PLAN_SYSTEM_PREFIX,
  FakeRunLoopGateway,
  fakeGatewayStats,
  isLocalRunLoopEnvironment,
  localTrustedBriefScheduleInput,
  resolveRunLoopAdapters,
} from '../src/run-loop/adapters';
import type {
  LLMGatewayRequest,
  TrustedProviderEffect,
} from '../src/llm/provider';

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
    expect(adapters.contextComposer).toBeDefined();
    expect(adapters.replayArtifacts).toBeDefined();
  });

  it('supplies one fixed frozen local V2 brief fixture without caller-owned sources', async () => {
    const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'test' });
    const fixture = localTrustedBriefScheduleInput();
    const accepted = acceptTrustedInvocation(fixture.admission);
    if (
      !accepted.ok ||
      adapters.contextComposer === undefined ||
      adapters.replayArtifacts === undefined
    ) {
      throw new Error('local V2 fixture must admit and compose');
    }

    const composed = await adapters.contextComposer.compose(accepted.value, {
      snapshot_ref: fixture.snapshot_ref,
      snapshot_at: fixture.snapshot_at,
      canary_tokens: ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'],
      replay_context_ref: null,
    });

    expect(composed).toMatchObject({
      ok: true,
      evidence: { trigger: 'brief', snapshot_ref: fixture.snapshot_ref },
    });
    if (!composed.ok) throw new Error('local V2 composition failed');
    expect(composed.checkpoint.sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(composed.checkpoint)).not.toContain('local frozen staged brief content.');

    await expect(
      adapters.replayArtifacts.resolvePlan({
        iteration: 1,
        plan_ref: 'pln_11111111111111111111111111111111',
        plan_digest: '1'.repeat(64),
        snapshot_ref: fixture.snapshot_ref,
        snapshot_at: fixture.snapshot_at,
      }),
    ).resolves.toEqual([{ id: 'call-get-crs-first', name: 'get_crs', args: { range_days: 1 } }]);
    await expect(
      adapters.replayArtifacts.resolveSynthesis({
        result_ref: 'syn_11111111111111111111111111111111',
        result_digest: '1'.repeat(64),
        snapshot_ref: fixture.snapshot_ref,
        snapshot_at: fixture.snapshot_at,
      }),
    ).resolves.toBe('Derived steady-state brief ready for delivery.');
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

describe('FakeRunLoopGateway trusted effect reconciliation', () => {
  it('keeps the legacy complete method on its single-plan/synthesis behavior', async () => {
    const result = await new FakeRunLoopGateway().complete(
      gatewayRequest(
        `${RUN_LOOP_OBSERVE_SYSTEM_PREFIX}:full_context:workers_ai`,
        JSON.stringify({ prompt: 'not a trusted effect', tool_results: [{ ok: true }] }),
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { text: 'Derived steady-state brief ready for delivery.' },
    });
  });

  it('reconciles one provider effect across a fresh gateway instance without a second physical call', async () => {
    const request = gatewayRequest(`${RUN_LOOP_PLAN_SYSTEM_PREFIX}:full_context:workers_ai`, 'brief');
    const effect = trustedEffect('a', '1', request);
    const first = new FakeRunLoopGateway();

    const issued = await first.executeOrReconcile({ operation: 'issue', request, effect });
    const reconciled = await new FakeRunLoopGateway().executeOrReconcile({
      operation: 'reconcile',
      effect: { ...effect, operation: 'reconcile' },
      execution_witness: effect.execution,
    });

    expect(issued).toEqual(reconciled);
    expect(issued).toMatchObject({ ok: true });
    expect(fakeGatewayStats([effect.idempotency_key])).toEqual({
      receipts: 1,
      physical_calls: 1,
      attempts: 2,
    });
  });

  it('fails closed when a trusted effect key is reused for a different request digest', async () => {
    const request = gatewayRequest(`${RUN_LOOP_PLAN_SYSTEM_PREFIX}:full_context:workers_ai`, 'brief');
    const firstEffect = trustedEffect('b', '2', request);
    const gateway = new FakeRunLoopGateway();

    await gateway.executeOrReconcile({ operation: 'issue', request, effect: firstEffect });
    const collision = await gateway.executeOrReconcile({
      operation: 'issue',
      request,
      effect: { ...firstEffect, request_digest: '3'.repeat(64) },
    });

    expect(collision).toEqual({
      ok: false,
      code: 'invalid_args',
      error: 'trusted provider effect key reused with a different request digest',
    });
    expect(fakeGatewayStats([firstEffect.idempotency_key])).toEqual({
      receipts: 1,
      physical_calls: 1,
      attempts: 2,
    });
  });

  it('returns two deterministic governed get_crs plans before terminal synthesis for V2 prompts', async () => {
    const gateway = new FakeRunLoopGateway();
    const firstRequest = gatewayRequest(`${RUN_LOOP_PLAN_SYSTEM_PREFIX}:full_context:workers_ai`, 'brief');
    const secondRequest = gatewayRequest(
      `${RUN_LOOP_OBSERVE_SYSTEM_PREFIX}:full_context:workers_ai`,
      JSON.stringify({ prompt: 'ephemeral prompt', tool_results: [{ ok: true }] }),
    );
    const synthesisRequest = gatewayRequest(
      `${RUN_LOOP_OBSERVE_SYSTEM_PREFIX}:full_context:workers_ai`,
      JSON.stringify({
        prompt: 'ephemeral prompt',
        tool_results: [{ ok: true }, { ok: true }],
      }),
    );
    const firstPlan = await gateway.executeOrReconcile({
      operation: 'issue',
      request: firstRequest,
      effect: trustedEffect('c', '4', firstRequest),
    });
    const secondPlan = await gateway.executeOrReconcile({
      operation: 'issue',
      request: secondRequest,
      effect: trustedEffect('d', '5', secondRequest),
    });
    const synthesis = await gateway.executeOrReconcile({
      operation: 'issue',
      request: synthesisRequest,
      effect: trustedEffect('e', '6', synthesisRequest),
    });

    expect(firstPlan).toMatchObject({
      ok: true,
      data: { text: expect.stringContaining('call-get-crs-first') },
    });
    expect(secondPlan).toMatchObject({
      ok: true,
      data: { text: expect.stringContaining('call-get-crs-second') },
    });
    expect(synthesis).toMatchObject({
      ok: true,
      data: { text: 'Derived steady-state brief ready for delivery.' },
    });
  });
});

function gatewayRequest(system: string, content: string): LLMGatewayRequest {
  const route = ROUTING_TABLE.brief;
  return {
    request: {
      model: ROSTER.primary,
      system,
      messages: [{ role: 'user', content }],
      max_tokens: 256,
      temperature: 0,
    },
    route,
    step: route.primary,
    context: 'full_context',
    fallback_step: 'configured_model',
    headers: GATEWAY_CONSTANT_HEADERS,
  };
}

function trustedEffect(
  seed: string,
  digest: string,
  request: LLMGatewayRequest,
): TrustedProviderEffect {
  return {
    effect_ref: `eff_${seed.repeat(32)}`,
    idempotency_key: `idk_${seed.repeat(32)}`,
    request_digest: digest.repeat(64),
    execution: {
      step: request.step,
      context: request.context,
      fallback_step: request.fallback_step,
    },
    operation: 'issue',
  };
}
