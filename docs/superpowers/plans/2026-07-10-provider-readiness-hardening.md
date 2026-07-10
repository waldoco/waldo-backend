# Provider Readiness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HEY-143 provider readiness fail closed before any uncontrolled gateway request while preserving hermetic adapter tests.

**Architecture:** The Cloudflare adapter owns secret resolution, fixed-host transport, response validation, and request privacy headers. The run loop owns pre-call sanitisation and spend preflight. Gateway mode has no spend ledger yet, so its resolver returns an unavailable control and stops before egress.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, Vitest, local contracts, Cloudflare AI Gateway REST API.

## Global Constraints

- No live calls, credentials, channels, or Cloudflare configuration changes.
- Secrets are asynchronous binding capabilities, never strings in source or normal environment variables.
- The only permitted provider URL is Cloudflare's HTTPS REST API origin.
- Prompt, response, credential, and channel payload bodies remain out of durable evidence.
- Missing spend state or sanitisation failure must produce zero gateway fetches.
- Keep the branch uncommitted unless the user explicitly requests a commit.

---

### Task 1: Harden Cloudflare gateway transport [completed]

**Files:**
- Modify: `packages/runtime/src/llm/gateway.ts`
- Modify: `packages/runtime/test/llm-gateway.test.ts`

**Interfaces:**
- Produces: `GatewaySecretBinding = { get(): Promise<string | null> }`
- Produces: `CloudflareAIGatewayAdapterOptions.credential`
- Produces: metadata-only headers and an allowlisted, timeout-bound request path.

- [ ] **Step 1: Write failing adapter tests**

```ts
it('pins payload logging even when a request forges the header', async () => {
  const result = await adapter.complete({ ...request(), headers: { 'cf-aig-collect-log-payload': 'true' } as never });
  expect(new Headers(calls[0]?.init.headers).get('cf-aig-collect-log-payload')).toBe('false');
  expect(result.ok).toBe(true);
});

it('returns auth_failed without fetch when the secret binding is unavailable', async () => {
  const result = await unavailableSecretAdapter.complete(request());
  expect(result).toEqual({ ok: false, code: 'auth_failed', error: 'gateway_credential_unavailable' });
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the adapter tests and confirm RED**

Run: `pnpm --filter @waldo/runtime test -- test/llm-gateway.test.ts`

Expected: failures because the constructor still accepts `apiToken` and headers copy the forged value.

- [ ] **Step 3: Implement the minimal transport boundary**

```ts
export type GatewaySecretBinding = { get(): Promise<string | null> };

async function credentialValue(binding: GatewaySecretBinding): Promise<string | null> {
  try {
    const value = await binding.get();
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}
```

Resolve the binding before `fetch`, pin `GATEWAY_CONSTANT_HEADERS`, use
`cf-aig-skip-cache: true` for `cache: 'none'`, require a returned model string, and cancel
non-OK bodies without recording them. Use a local fixed-origin transport with an abort timeout.

- [ ] **Step 4: Run the adapter tests and confirm GREEN**

Run: `pnpm --filter @waldo/runtime test -- test/llm-gateway.test.ts`

Expected: all adapter tests pass.

### Task 2: Enforce sanitisation and spend before RunLoop provider calls [completed]

**Files:**
- Modify: `packages/runtime/src/llm/provider.ts`
- Modify: `packages/runtime/src/run-loop/adapters.ts`
- Modify: `packages/runtime/src/run-loop/do.ts`
- Modify: `packages/runtime/test/llm-provider.test.ts`
- Modify: `packages/runtime/test/run-loop-adapters.test.ts`
- Modify: `packages/runtime/test/run-loop.test.ts`

**Interfaces:**
- Produces: `RunLoopSpendReader` returning `AdapterResult<RouteSpendState>`.
- Produces: a sanitised LLM request or a `hook_halt` result before `gateway.complete`.
- Produces: gateway resolver control failure when no HEY-99 spend reader exists.
- Extends: the existing test-only override with an optional `providerMode` and `spendReader`.

- [ ] **Step 1: Write failing preflight tests**

```ts
it('does not call the gateway when pre-LLM sanitisation rejects request text', async () => {
  const result = await provider.complete(input, runtimeCtx({ sanitise: () => ({ ok: false, reason: 'untrusted_instruction' }) }));
  expect(result).toMatchObject({ ok: false, reason: 'hook_halt' });
  expect(gateway.requests).toEqual([]);
});

it('fails gateway-mode preflight before network egress when spend state is unavailable', async () => {
  const adapters = resolveRunLoopAdapters(gatewayEnv);
  await expect(adapters.spendReader?.read()).resolves.toMatchObject({ ok: false, code: 'transient' });
});

it('does not call the run-loop gateway when its gateway-mode spend reader is unavailable', async () => {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as CrashableRunLoopInstance).__runLoopSetTestOverrides({
      providerMode: 'gateway',
    });
  });
  await runDurableObjectAlarm(stub);
  expect(gateway.requests).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm --filter @waldo/runtime test -- test/llm-provider.test.ts test/run-loop-adapters.test.ts`

Expected: sanitisation is currently post-response only and no spend reader exists.

- [ ] **Step 3: Implement sanitisation and fail-closed spend control**

```ts
export type RunLoopSpendReader = {
  read(): Promise<AdapterResult<RouteSpendState>>;
};

function unavailableSpendReader(): RunLoopSpendReader {
  return { read: async () => ({ ok: false, code: 'transient', error: 'spend_state_unavailable' }) };
}
```

Sanitise system and message text before the pre-LLM hook and gateway call. In `RunLoopDO`, read
spend immediately before each LLM call when `providerMode === 'gateway'`; on failure, fail the
run with a stable non-private reason and do not invoke `RuntimeLLMProvider`.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `pnpm --filter @waldo/runtime test -- test/llm-provider.test.ts test/run-loop-adapters.test.ts test/run-loop.test.ts`

Expected: all selected tests pass and the unavailable reader proves zero provider calls.

### Task 3: Replace token env shape and close local ingress [completed]

**Files:**
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/src/run-loop/adapters.ts`
- Modify: `packages/runtime/src/run-loop/do.ts`
- Modify: `packages/runtime/test/run-loop-adapters.test.ts`
- Modify: `packages/runtime/test/run-loop.test.ts`
- Modify: `packages/runtime/README.md`

**Interfaces:**
- Produces: `AI_GATEWAY_API_TOKEN?: GatewaySecretBinding` rather than `AI_GATEWAY_TOKEN?: string`.
- Produces: a local ingress deny response when `WALDO_ENV` is not `local` or `test`.

- [ ] **Step 1: Write failing configuration and ingress tests**

```ts
it('rejects a string token where gateway mode requires a secret binding', () => {
  expect(() => resolveRunLoopAdapters({ ...gatewayEnv, AI_GATEWAY_API_TOKEN: 'token' } as never)).toThrow(/secret binding/);
});

it('does not allow local ingress outside local and test', () => {
  expect(isLocalRunLoopEnvironment('staging')).toBe(false);
  expect(isLocalRunLoopEnvironment('production')).toBe(false);
});
```

- [ ] **Step 2: Run the configuration and ingress tests and confirm RED**

Run: `pnpm --filter @waldo/runtime test -- test/run-loop-adapters.test.ts test/run-loop.test.ts`

Expected: gateway mode still accepts a string and local ingress has no environment check.

- [ ] **Step 3: Implement binding validation and ingress guard**

```ts
function isGatewaySecretBinding(value: unknown): value is GatewaySecretBinding {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function';
}
```

Make `WALDO_ENV` the first local-ingress gate and return `404` for non-local environments.
Export the pure environment predicate so the test pool can prove the branch without provisioning a
staging Secrets Store binding. Document the external Secrets Store binding prerequisite without
declaring an actual store ID.

- [ ] **Step 4: Run the configuration and ingress tests and confirm GREEN**

Run: `pnpm --filter @waldo/runtime test -- test/run-loop-adapters.test.ts test/run-loop.test.ts`

Expected: all selected tests pass.

### Task 4: Contract, guard, and merge-wall verification [completed]

**Files:**
- Modify when needed: `scripts/guards/guard-fake-callbacks.mjs`
- Modify when needed: `scripts/guards/guards-selftest.mjs`
- Modify: `packages/runtime/README.md`

- [ ] **Step 1: Add a guard only if the invariant cannot be held by a typed test**

The guard must target a narrow runtime file and reject permissive production provider wiring. Do
not scan fixtures, documentation, or local/test fakes.

- [ ] **Step 2: Run the focused red/green tests and typecheck**

Run: `pnpm --filter @waldo/runtime typecheck && pnpm --filter @waldo/runtime test`

Expected: typecheck passes and all runtime tests pass.

- [ ] **Step 3: Run the complete verification wall**

Run: `npx -y pnpm@10.34.4 verify && git diff --check`

Expected: contracts, runtime, guards, and whitespace checks pass.

- [ ] **Step 4: Record remaining blockers**

Document that a Cloudflare Secrets Store binding and the HEY-99 spend reader are external
prerequisites; do not claim staging dogfood or live-provider readiness.
