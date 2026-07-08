import { ROSTER, type HookPayload, type SanitiseResult } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  egressAllowlistHook,
  HookHaltError,
  HOOK_REGISTRY,
  registerHook,
  runHooks,
  scribeSanitisePostLlmCallHook,
  scribeSanitisePostToolUseHook,
  type HookRuntimeContext,
} from '../src/hooks/registry';

type TestContext = {
  calls: string[];
};

const postPromptPayload: HookPayload = {
  event: 'PostPromptBuild',
  prompt: 'base',
};

describe('hook registry', () => {
  const validCanaries = ['1111111111111111', '2222222222222222', '3333333333333333'];

  function runtimeCtx(
    overrides: Partial<HookRuntimeContext> = {},
  ): HookRuntimeContext {
    return {
      authenticatedUserId: 'user-1',
      trigger: 'user_message',
      canaryTokens: validCanaries,
      now: () => 1_700_000_000_000,
      rateLimitCheck: () => true,
      hasApproval: () => true,
      sanitise: ({ text }) =>
        ({
          ok: true,
          output: text,
          redactions: [],
        }) satisfies SanitiseResult,
      medicalGate: () => true,
      ...overrides,
    };
  }

  it('runs matching hooks in ascending priority order and returns the replaced payload', async () => {
    const first = registerHook<TestContext>({
      name: 'second_registered_first',
      event: 'PostPromptBuild',
      priority: 200,
      async handle(payload, ctx) {
        if (payload.event !== 'PostPromptBuild') {
          throw new Error('unexpected hook payload');
        }
        ctx.calls.push('priority-200');
        return { ok: true, payload: { ...payload, prompt: `${payload.prompt} b` } };
      },
    });
    const registry = registerHook<TestContext>(
      {
        name: 'first_registered_second',
        event: 'PostPromptBuild',
        priority: 100,
        async handle(payload, ctx) {
          if (payload.event !== 'PostPromptBuild') {
            throw new Error('unexpected hook payload');
          }
          ctx.calls.push('priority-100');
          return { ok: true, payload: { ...payload, prompt: `${payload.prompt} a` } };
        },
      },
      first,
    );

    const ctx = { calls: [] };

    await expect(runHooks('PostPromptBuild', postPromptPayload, ctx, { registry })).resolves.toEqual(
      {
        event: 'PostPromptBuild',
        prompt: 'base a b',
      },
    );
    expect(ctx.calls).toEqual(['priority-100', 'priority-200']);
  });

  it('breaks same-priority ties by hook name for deterministic traversal', async () => {
    const registry = registerHook<TestContext>(
      {
        name: 'a_same_priority',
        event: 'PostPromptBuild',
        priority: 100,
        async handle(payload, ctx) {
          ctx.calls.push('a');
          return { ok: true, payload };
        },
      },
      registerHook<TestContext>({
        name: 'z_same_priority',
        event: 'PostPromptBuild',
        priority: 100,
        async handle(payload, ctx) {
          ctx.calls.push('z');
          return { ok: true, payload };
        },
      }),
    );
    const ctx = { calls: [] };

    await expect(runHooks('PostPromptBuild', postPromptPayload, ctx, { registry })).resolves.toEqual(
      postPromptPayload,
    );
    expect(ctx.calls).toEqual(['a', 'z']);
  });

  it('accepts every contract lifecycle payload when no hooks are registered', async () => {
    const payloads: HookPayload[] = [
      { event: 'OnInvocationStart', trace_id: 'trace-1' },
      { event: 'PrePromptBuild' },
      { event: 'PostPromptBuild', prompt: 'prompt' },
      { event: 'PreLLMCall', messages: [], model: ROSTER.fallback },
      { event: 'PostLLMCall', response: 'ok', tokens_in: 0, tokens_out: 0 },
      { event: 'PreToolUse', tool: 'get_crs', args: {} },
      { event: 'PostToolUse', tool: 'get_crs', result: {}, latency_ms: 0 },
      { event: 'OnError', error: 'failed', code: 'transient' },
      { event: 'OnInvocationEnd', outcome: 'success' },
    ];

    await Promise.all(
      payloads.map((payload) => runHooks(payload.event, payload, {}, { registry: [] })),
    );
  });

  it('ignores in-place payload mutation unless a hook returns a replacement payload', async () => {
    const registry = registerHook<TestContext>(
      {
        name: 'observer_after_mutation',
        event: 'PostPromptBuild',
        priority: 200,
        async handle(payload, ctx) {
          if (payload.event !== 'PostPromptBuild') {
            throw new Error('unexpected hook payload');
          }
          ctx.calls.push(payload.prompt);
          return { ok: true };
        },
      },
      registerHook<TestContext>({
        name: 'in_place_mutator',
        event: 'PostPromptBuild',
        priority: 100,
        async handle(payload) {
          if (payload.event !== 'PostPromptBuild') {
            throw new Error('unexpected hook payload');
          }
          payload.prompt = 'mutated without replacement';
          return { ok: true };
        },
      }),
    );
    const ctx = { calls: [] };

    await expect(runHooks('PostPromptBuild', postPromptPayload, ctx, { registry })).resolves.toEqual(
      postPromptPayload,
    );
    expect(ctx.calls).toEqual(['base']);
  });

  it('exports the explicit Sprint-0 hook registry in lifecycle priority order', () => {
    expect(HOOK_REGISTRY.map((hook) => [hook.event, hook.name, hook.priority])).toEqual([
      ['OnInvocationStart', 'jwt_validate', 100],
      ['OnInvocationStart', 'rate_limit_check', 200],
      ['OnInvocationStart', 'session_reset', 400],
      ['PreToolUse', 'acl_check', 100],
      ['PreToolUse', 'tool_arg_zod_validate', 200],
      ['PreToolUse', 'autonomy_gate_check', 300],
      ['PreToolUse', 'egress_allowlist_check', 500],
      ['PostToolUse', 'scribe_sanitise', 100],
      ['PostLLMCall', 'canary_leak_check', 100],
      ['PostLLMCall', 'scribe_sanitise', 100],
      ['PostLLMCall', 'medical_gate', 200],
    ]);
  });

  it('denies invocation start before session reset when auth is missing', async () => {
    await expect(
      runHooks(
        'OnInvocationStart',
        { event: 'OnInvocationStart', trace_id: 'trace-auth' },
        runtimeCtx({ authenticatedUserId: null }),
      ),
    ).rejects.toMatchObject({
      hook: 'jwt_validate',
      code: 'auth_failed',
    });
  });

  it('resets the session from trigger canaries after auth and rate limit pass', async () => {
    const ctx = runtimeCtx({ trigger: 'brief' });

    await expect(
      runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-reset' }, ctx),
    ).resolves.toEqual({ event: 'OnInvocationStart', trace_id: 'trace-reset' });

    expect(ctx.session).toMatchObject({
      trigger: 'brief',
      tool_permissions: [
        'get_crs',
        'get_health',
        'query_calendar',
        'get_communication',
        'get_tasks',
        'get_master_metrics',
        'get_context',
        'read_memory',
        'search_episodes',
        'search_connector',
        'propose_action',
        'send_message',
      ],
      canary_tokens: validCanaries,
      iteration_count: 0,
      cost_spent: 0,
      active_sandbox: null,
    });
  });

  it('denies PreToolUse when the tool is outside the reset session ACL', async () => {
    const ctx = runtimeCtx({ trigger: 'brief' });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-acl' }, ctx);

    await expect(
      runHooks('PreToolUse', { event: 'PreToolUse', tool: 'execute_action', args: {} }, ctx),
    ).rejects.toMatchObject({
      hook: 'acl_check',
      code: 'forbidden',
    });
  });

  it('validates PreToolUse args against the contract-owned tool schema', async () => {
    const ctx = runtimeCtx();
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-args' }, ctx);

    await expect(
      runHooks(
        'PreToolUse',
        { event: 'PreToolUse', tool: 'get_crs', args: { range_days: 91 } },
        ctx,
      ),
    ).rejects.toMatchObject({
      hook: 'tool_arg_zod_validate',
      code: 'invalid_args',
    });
  });

  it('requires approval for privileged actions even when the ACL and arg schema allow the tool', async () => {
    const ctx = runtimeCtx({ hasApproval: () => false });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-approval' }, ctx);

    await expect(
      runHooks(
        'PreToolUse',
        {
          event: 'PreToolUse',
          tool: 'send_message',
          args: {
            channel: 'telegram',
            user_id: 'user-1',
            content: 'hello',
            idempotency_key: 'a'.repeat(64),
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      hook: 'autonomy_gate_check',
      code: 'forbidden',
    });
  });

  it('blocks external-tainted privileged actions even when approval is present', async () => {
    const ctx = runtimeCtx({ toolArgSourceTaint: 'external' });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-taint' }, ctx);

    await expect(
      runHooks(
        'PreToolUse',
        {
          event: 'PreToolUse',
          tool: 'send_message',
          args: {
            channel: 'telegram',
            user_id: 'user-1',
            content: 'hello',
            idempotency_key: 'b'.repeat(64),
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      hook: 'autonomy_gate_check',
      code: 'forbidden',
    });
  });

  it('fails closed when an ACL-granted tool has no contract arg schema yet', async () => {
    const ctx = runtimeCtx({ trigger: 'brief' });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-schema' }, ctx);

    await expect(
      runHooks(
        'PreToolUse',
        { event: 'PreToolUse', tool: 'search_connector', args: { query: 'mail' } },
        ctx,
      ),
    ).rejects.toMatchObject({
      hook: 'tool_arg_zod_validate',
      code: 'invalid_args',
    });
  });

  it('blocks local and metadata hosts at the egress allowlist hook', async () => {
    await expect(
      runHooks(
        'PreToolUse',
        {
          event: 'PreToolUse',
          tool: 'web_search',
          args: { url: 'http://169.254.169.254/latest/meta-data' },
        },
        runtimeCtx(),
        { registry: [egressAllowlistHook] },
      ),
    ).rejects.toMatchObject({
      hook: 'egress_allowlist_check',
      code: 'forbidden',
    });
  });

  it('blocks IPv6 localhost and IPv4-mapped loopback at the egress allowlist hook', async () => {
    for (const url of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/']) {
      await expect(
        runHooks(
          'PreToolUse',
          {
            event: 'PreToolUse',
            tool: 'web_search',
            args: { url },
          },
          runtimeCtx(),
          { registry: [egressAllowlistHook] },
        ),
      ).rejects.toMatchObject({
        hook: 'egress_allowlist_check',
        code: 'forbidden',
      });
    }
  });

  it('routes PostToolUse text through the injected Scribe sanitiser and replaces safe output', async () => {
    await expect(
      runHooks(
        'PostToolUse',
        {
          event: 'PostToolUse',
          tool: 'read_document',
          result: 'email user@example.com',
          latency_ms: 5,
        },
        runtimeCtx({
          sanitise: () => ({
            ok: true,
            output: 'email [redacted]',
            redactions: [{ kind: 'email', count: 1 }],
          }),
        }),
        { registry: [scribeSanitisePostToolUseHook] },
      ),
    ).resolves.toEqual({
      event: 'PostToolUse',
      tool: 'read_document',
      result: 'email [redacted]',
      latency_ms: 5,
    });
  });

  it('recursively rewrites structured PostToolUse text through the injected Scribe sanitiser', async () => {
    await expect(
      runHooks(
        'PostToolUse',
        {
          event: 'PostToolUse',
          tool: 'read_document',
          result: { title: 'Report', body: ['email user@example.com'] },
          latency_ms: 5,
        },
        runtimeCtx({
          sanitise: ({ text }) => ({
            ok: true,
            output: text.replace('user@example.com', '[redacted]'),
            redactions: text.includes('user@example.com') ? [{ kind: 'email', count: 1 }] : [],
          }),
        }),
        { registry: [scribeSanitisePostToolUseHook] },
      ),
    ).resolves.toEqual({
      event: 'PostToolUse',
      tool: 'read_document',
      result: { title: 'Report', body: ['email [redacted]'] },
      latency_ms: 5,
    });
  });

  it('halts PostToolUse when the Scribe sanitiser rejects tool output', async () => {
    await expect(
      runHooks(
        'PostToolUse',
        {
          event: 'PostToolUse',
          tool: 'read_document',
          result: 'health_value: blocked',
          latency_ms: 5,
        },
        runtimeCtx({
          sanitise: () => ({ ok: false, reason: 'health_value_leak' }),
        }),
        { registry: [scribeSanitisePostToolUseHook] },
      ),
    ).rejects.toMatchObject({
      hook: 'scribe_sanitise',
      code: 'forbidden',
    });
  });

  it('halts PostLLMCall before delivery when a session canary leaks', async () => {
    const ctx = runtimeCtx();
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-canary' }, ctx);

    await expect(
      runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response: `leaked ${validCanaries[0]}`,
          tokens_in: 1,
          tokens_out: 1,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      hook: 'canary_leak_check',
      code: 'forbidden',
    });
  });

  it('recursively rewrites structured PostLLMCall text through the injected Scribe sanitiser', async () => {
    await expect(
      runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response: { message: { content: ['email user@example.com'] } },
          tokens_in: 1,
          tokens_out: 1,
        },
        runtimeCtx({
          sanitise: ({ text }) => ({
            ok: true,
            output: text.replace('user@example.com', '[redacted]'),
            redactions: text.includes('user@example.com') ? [{ kind: 'email', count: 1 }] : [],
          }),
        }),
        { registry: [scribeSanitisePostLlmCallHook] },
      ),
    ).resolves.toEqual({
      event: 'PostLLMCall',
      response: { message: { content: ['email [redacted]'] } },
      tokens_in: 1,
      tokens_out: 1,
    });
  });

  it('halts PostLLMCall when the Scribe sanitiser rejects generated text', async () => {
    await expect(
      runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response: { message: 'health_value: blocked' },
          tokens_in: 1,
          tokens_out: 1,
        },
        runtimeCtx({
          sanitise: () => ({ ok: false, reason: 'health_value_leak' }),
        }),
        { registry: [scribeSanitisePostLlmCallHook] },
      ),
    ).rejects.toMatchObject({
      hook: 'scribe_sanitise',
      code: 'forbidden',
    });
  });

  it('halts PostLLMCall when the medical gate rejects generated text', async () => {
    const ctx = runtimeCtx({
      medicalGate: () => ({ ok: false, reason: 'unsafe medical directive', code: 'forbidden' }),
    });
    await runHooks('OnInvocationStart', { event: 'OnInvocationStart', trace_id: 'trace-medical' }, ctx);

    await expect(
      runHooks(
        'PostLLMCall',
        {
          event: 'PostLLMCall',
          response: 'medical instruction',
          tokens_in: 1,
          tokens_out: 1,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      hook: 'medical_gate',
      code: 'forbidden',
    });
  });

  it('halts with a typed error and records OnError without leaking the hook reason to client text', async () => {
    const registry = registerHook<TestContext>({
      name: 'acl_check',
      event: 'PreToolUse',
      priority: 100,
      async handle() {
        return { ok: false, halt: true, reason: 'tool outside trigger ACL', code: 'forbidden' };
      },
    });

    await expect(
      runHooks(
        'PreToolUse',
        { event: 'PreToolUse', tool: 'execute_action', args: {} },
        { calls: [] },
        { registry },
      ),
    ).rejects.toMatchObject({
      name: 'HookHaltError',
      hook: 'acl_check',
      reason: 'tool outside trigger ACL',
      code: 'forbidden',
      clientMessage: 'hook halted',
      onErrorPayload: {
        event: 'OnError',
        error: 'hook halted',
        code: 'forbidden',
      },
    });
  });

  it('treats a slow hook timeout as a halt instead of skipping the hook', async () => {
    const registry = registerHook<TestContext>({
      name: 'jwt_validate',
      event: 'OnInvocationStart',
      priority: 100,
      timeout_ms: 1,
      async handle() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    });

    await expect(
      runHooks(
        'OnInvocationStart',
        { event: 'OnInvocationStart', trace_id: 'trace-timeout' },
        { calls: [] },
        { registry },
      ),
    ).rejects.toMatchObject({
      name: 'HookHaltError',
      hook: 'jwt_validate',
      reason: 'hook timed out',
      code: 'transient',
    });
  });

  it('does not commit late top-level context mutations from a timed-out hook', async () => {
    const ctx: TestContext & { late?: boolean } = { calls: [] };
    const registry = registerHook<typeof ctx>({
      name: 'slow_mutator',
      event: 'OnInvocationStart',
      priority: 100,
      timeout_ms: 1,
      async handle(_payload, hookCtx) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        hookCtx.late = true;
        return { ok: true };
      },
    });

    await expect(
      runHooks(
        'OnInvocationStart',
        { event: 'OnInvocationStart', trace_id: 'trace-late-mutation' },
        ctx,
        { registry },
      ),
    ).rejects.toMatchObject({
      hook: 'slow_mutator',
      code: 'transient',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.late).toBeUndefined();
  });

  it('does not commit late nested session mutations from a timed-out hook', async () => {
    const ctx = runtimeCtx();
    await runHooks(
      'OnInvocationStart',
      { event: 'OnInvocationStart', trace_id: 'trace-nested-timeout' },
      ctx,
    );

    const registry = registerHook<HookRuntimeContext>({
      name: 'slow_session_mutator',
      event: 'PreToolUse',
      priority: 100,
      timeout_ms: 1,
      async handle(_payload, hookCtx) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        hookCtx.session?.tool_permissions.push('execute_code');
        return { ok: true };
      },
    });

    await expect(
      runHooks(
        'PreToolUse',
        { event: 'PreToolUse', tool: 'get_crs', args: {} },
        ctx,
        { registry },
      ),
    ).rejects.toMatchObject({
      hook: 'slow_session_mutator',
      code: 'transient',
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.session?.tool_permissions).not.toContain('execute_code');
  });

  it('converts thrown hook errors into typed transient halts', async () => {
    const registry = registerHook<TestContext>({
      name: 'throwing_hook',
      event: 'OnInvocationStart',
      priority: 100,
      async handle() {
        throw new Error('provider exploded');
      },
    });

    await expect(
      runHooks(
        'OnInvocationStart',
        { event: 'OnInvocationStart', trace_id: 'trace-throw' },
        { calls: [] },
        { registry },
      ),
    ).rejects.toMatchObject({
      name: 'HookHaltError',
      hook: 'throwing_hook',
      reason: 'hook threw',
      code: 'transient',
    });
  });

  it('exposes HookHaltError as a typed runtime error', () => {
    const error = new HookHaltError('medical_gate', 'unsafe output', 'forbidden');

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'HookHaltError',
      hook: 'medical_gate',
      reason: 'unsafe output',
      code: 'forbidden',
      clientMessage: 'hook halted',
      onErrorPayload: {
        event: 'OnError',
        error: 'hook halted',
        code: 'forbidden',
      },
    });
  });
});
