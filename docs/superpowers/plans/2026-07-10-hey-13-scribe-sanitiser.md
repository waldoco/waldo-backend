# HEY-13 Scribe Sanitiser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Install one structured, destination-aware Scribe sanitiser before every current
content-bearing persistence and egress seam and prove nested, encoded, numeric, restart, and mutation
resistance.

**Architecture:** The contract package owns the ordered policy vocabulary and strict persistence
shapes. A single pure runtime Module implements recursive sanitisation. Hooks, provider, dispatcher,
RunLoop, trace/replay, and delivery owners are thin callers of that interface.

**Tech Stack:** TypeScript 5.9.3, Zod 4.4.3, Vitest 4.1.9, Cloudflare Workers pool 0.16.20,
fast-check 4.8.0, StrykerJS 9.6.1, pnpm 10.34.4.

## Global Constraints

- Run the five Scribe checks in this exact order: canary/secret, health, PII, instruction,
  destination field/size policy.
- Use one production `sanitise()` implementation. Do not create per-surface sanitizers.
- Raw and numeric derived health are forbidden in generic prompt, DO SQLite, memory, R2, trace,
  replay, outbox, and channel destinations.
- Nonnumeric health context requires the strict ADR-0081 destination view and explicit eligibility.
- Redaction/denial evidence contains counts and enum reasons only, never values.
- Medical claims are checked by the separate existing medical-gate hook after Scribe.
- Fake remains the default provider and sink. Never silently fall back from real to fake.
- Do not touch Supabase, migrations, RLS, issuer/mint/session, public Brief/OpenAPI/generated clients,
  app/native code, async delivery, Spots, or Chat.
- Do not enable live providers, use credentials, deploy, merge, or perform production cloud effects.
- Every behavior change uses one red test, one minimal green implementation, and refactoring only
  while green.

---

### Task 1: Canonical structured sanitiser and health-view contracts

**Files:**
- Modify: `packages/contracts/src/memory/sanitise.ts`
- Modify: `packages/contracts/src/memory/sanitise.test.ts`
- Modify: `packages/contracts/src/health/crs.ts`
- Modify: `packages/contracts/src/health/crs.test.ts`

**Interfaces:**
- Produces: `SanitiseInput`, structured `SanitiseResult`, `SanitiseFailureReason`, destination
  structural policies, and `DerivedHealthDestinationView`.
- Consumes: `CanaryTokens`, `SourceTaint`, `FormZone`, and `CrsPillar`.

- [x] **Step 1: Write the failing strict-union test**

```ts
expect(sanitiseResultSchema.safeParse({
  ok: true,
  payload: { summary: '[email]' },
  source_taint: 'external',
  redactions: [{ kind: 'email', count: 1 }],
}).success).toBe(true);
expect(sanitiseResultSchema.safeParse({
  ok: false,
  check: 'health_value',
  reason: 'health_value_leak',
  payload: 'HRV 58 ms',
}).success).toBe(false);
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `npx -y pnpm@10.34.4 --filter @waldo/contracts test -- src/memory/sanitise.test.ts`
Expected: FAIL because structured payload/input/destination policy exports do not exist.

- [x] **Step 3: Implement the contract types and supersede old health actions**

```ts
export const sanitiseInputSchema = z.strictObject({
  payload: z.json(),
  destination: sanitiseDestinationSchema,
  canary_tokens: canaryTokensSchema,
  source_taint: sourceTaintSchema,
});

export const sanitiseResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    payload: z.json(),
    source_taint: sourceTaintSchema,
    redactions: z.array(redactionSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    check: sanitiseCheckSchema,
    reason: sanitiseFailureReasonSchema,
  }),
]);
```

Set raw and numeric-derived health actions to `reject` for every current generic destination. Add
`r2_summary` and `outbox` to the single destination enum and structural policy table.

- [x] **Step 4: Add and test the strict nonnumeric ADR-0081 view**

```ts
export const derivedHealthDestinationViewSchema = z.strictObject({
  authority: z.literal('backend'),
  algorithm_version: z.literal('form.safte-fast.v1'),
  form_zone: formZoneSchema,
  trend: z.enum(['improving', 'steady', 'declining', 'insufficient']),
  freshness: z.enum(['fresh', 'stale']),
  missing_components: z.array(crsPillarSchema),
  confidence_band: z.enum(['high', 'medium', 'low']),
  provenance_refs: z.array(opaqueHealthProvenanceRefSchema).max(4),
  destination_eligibility: z.array(derivedHealthDestinationEligibilitySchema).min(1),
});
```

Run the two focused contract tests. Expected: PASS.

- [x] **Step 5: Commit the contract slice**

```bash
git add packages/contracts/src/memory/sanitise.ts packages/contracts/src/memory/sanitise.test.ts \
  packages/contracts/src/health/crs.ts packages/contracts/src/health/crs.test.ts
git commit -m "feat: define structured scribe contract"
```

### Task 2: Pure Scribe and medical-claim Modules

**Files:**
- Create: `packages/runtime/src/scribe/sanitiser.ts`
- Create: `packages/runtime/src/scribe/medical-gate.ts`
- Create: `packages/runtime/test/scribe-sanitiser.test.ts`
- Create: `packages/runtime/test/medical-gate.test.ts`
- Modify: `packages/runtime/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 `SanitiseInput` and policy exports.
- Produces: `sanitise(input): SanitiseResult` and `evaluateMedicalClaim(text)`.

- [x] **Step 1: Add the failing tracer test through the public Module**

```ts
expect(sanitise({
  payload: { metric: 'hrv', measurement: 58, unit: 'ms' },
  destination: 'internal_context',
  canary_tokens: CANARIES,
  source_taint: null,
})).toEqual({ ok: false, check: 'health_value', reason: 'health_value_leak' });
```

- [x] **Step 2: Run and confirm RED**

Run: `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/scribe-sanitiser.test.ts`
Expected: FAIL because the Module does not exist.

- [x] **Step 3: Implement the minimal ordered pipeline**

```ts
export function sanitise(raw: SanitiseInput): SanitiseResult {
  const input = sanitiseInputSchema.safeParse(raw);
  if (!input.success) return deny('size_cap', 'invalid_payload');
  const prepared = prepareJson(input.data.payload);
  if (!prepared.ok) return deny('size_cap', 'invalid_payload');
  if (containsCanaryOrSecret(prepared.value, input.data.canary_tokens)) {
    return deny('canary_token', prepared.reason);
  }
  if (containsForbiddenHealth(prepared.value, input.data.destination)) {
    return deny('health_value', 'health_value_leak');
  }
  const pii = redactPii(prepared.value);
  const instructions = inspectInstructions(pii.payload);
  if (!instructions.ok) return instructions;
  return applyDestinationPolicy({ ...input.data, payload: instructions.payload }, pii.redactions);
}
```

Keep helpers private. Scan keys and values in one recursive walk; use a `WeakSet` for cycles and
bounded decode views for JSON escapes, percent encoding, Base64, and Base64URL.

- [x] **Step 4: Add one hostile behavior at a time**

For each of nested records, arrays, benign-key siblings, aliases/camelCase, unit suffixes, quoted
values, BP ratios, CSV, intervening words, each encoding, secret formats, PII redaction, one-pattern
redaction, two-pattern denial, structured caps, safe numbers, and eligible derived views:

1. add one test;
2. run it and observe RED;
3. write minimal implementation;
4. rerun and observe GREEN.

- [x] **Step 5: Add medical golden tests and implementation**

```ts
expect(evaluateMedicalClaim('Based on your data, you are at risk for heart disease.')).toEqual({
  ok: false,
  reason: 'medical_claim',
});
expect(evaluateMedicalClaim('Your recovery pattern suggests taking it easy today.')).toEqual({
  ok: true,
});
```

Run both focused test files. Expected: PASS.

- [x] **Step 6: Install exact aged test dependencies**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime add -D -E fast-check@4.8.0 \
  @stryker-mutator/core@9.6.1 @stryker-mutator/vitest-runner@9.6.1
```

Run `pnpm install --frozen-lockfile` after the lockfile change. Expected: PASS with no new
`minimumReleaseAgeExclude` entry.

- [x] **Step 7: Commit the pure Module slice**

```bash
git add package.json packages/runtime/package.json pnpm-lock.yaml \
  packages/runtime/src/scribe packages/runtime/test/scribe-sanitiser.test.ts \
  packages/runtime/test/medical-gate.test.ts
git commit -m "feat: implement deterministic scribe sanitiser"
```

### Task 3: Tool, hook, and provider enforcement

**Files:**
- Modify: `packages/contracts/src/core/hooks.ts` and `.test.ts`
- Modify: `packages/contracts/src/tools/handler.ts` and `.test.ts`
- Modify: `packages/contracts/src/tools/schemas/reads.ts` and `.test.ts`
- Modify: `packages/contracts/src/tools/schemas/writes.ts` and `.test.ts`
- Modify: `packages/runtime/src/hooks/registry.ts`
- Modify: `packages/runtime/src/tools/dispatcher.ts`
- Modify: `packages/runtime/src/llm/provider.ts`
- Modify: `packages/runtime/test/hooks.test.ts`
- Modify: `packages/runtime/test/tool-dispatcher.test.ts`
- Modify: `packages/runtime/test/llm-provider.test.ts`

**Interfaces:**
- Consumes: production `sanitise()` and `evaluateMedicalClaim()`.
- Produces: pre-side-effect sanitized tool args, contract-required taint-preserving results, and
  terminal provider request/response/template safety.

- [x] **Step 1: Write a failing handler non-invocation test**

Create a counted `send_message` handler, dispatch nested health content, and assert the result is
`sanitise_denied` and the handler count is zero. Run the focused dispatcher test and confirm RED.

- [x] **Step 2: Add the PreTool Scribe adapter after strict arg validation**

The adapter calls the single Module with a deterministic tool-to-destination mapping and returns the
sanitized replacement payload. Add `tool_arg_sanitise: 250` between strict Zod validation at 200 and
the autonomy gate at 300. `handler.handle` receives only the replacement args.

- [x] **Step 3: Preserve result taint**

```ts
type DispatchToolResult =
  | { ok: true; call_id: string; tool: ToolName; data: unknown; source_taint: SourceTaint; card?: WaldoCard }
  | DispatchFailure;
```

Require `source_taint` on the contract-owned successful `ToolResult`: `external` for external-origin
handlers and `null` for internal handlers. Preserve it through PostTool replacement and the public
dispatcher result. Add a test that a missing stamp fails rather than being inferred.

- [x] **Step 4: Remove model-selected identities**

Delete `user_id` from `executeActionArgsSchema` and `sendMessageArgsSchema`. Add rejection tests for
the now-unknown key. Handler contexts continue to use `authenticatedUserId`.

- [x] **Step 5: Make custom hooks and provider safety non-bypassable**

Do not concatenate custom and required registries into one priority-sorted list: a later custom hook
could restore unsafe args/output after Scribe. Run custom transformations first, then the immutable
core registry as the terminal pass. At PreTool, core ACL/Zod/Scribe/autonomy/egress validates the
final custom payload; at PostTool, core Scribe sees the final custom result. For provider requests,
sanitize the final post-custom request immediately before gateway egress; for provider/template
responses, run the final custom response through core PostLLM Scribe then medical. Convert template
fallback to this same asynchronous path. Add malicious late-custom-hook, counted-handler,
counted-gateway, and unsafe-template tests.

- [x] **Step 6: Run focused tests and commit**

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test -- \
  src/core/hooks.test.ts src/tools/schemas/reads.test.ts src/tools/schemas/writes.test.ts
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- \
  test/hooks.test.ts test/tool-dispatcher.test.ts test/llm-provider.test.ts
git add packages/contracts/src/core/hooks.ts packages/contracts/src/core/hooks.test.ts \
  packages/contracts/src/tools packages/runtime/src/hooks packages/runtime/src/tools \
  packages/runtime/src/llm packages/runtime/test
git commit -m "feat: enforce scribe across provider and tools"
```

### Task 4: Strict persisted run, trace, evidence, and telemetry contracts

**Files:**
- Modify: `packages/contracts/src/runtime/run.ts` and `.test.ts`
- Modify: `packages/contracts/src/runtime/evidence.ts` and `.test.ts`
- Modify: `packages/contracts/src/testing/evidence.ts` and `.test.ts`
- Modify: `packages/contracts/src/telemetry/engagement.ts` and `.test.ts`
- Modify: `packages/runtime/src/run-loop/evidence.ts`

**Interfaces:**
- Produces: strict `RuntimeRunContext`, `RuntimeRunScratch`, `RuntimeRunFailureReason`,
  event-discriminated trace details, closed evidence metadata, and closed metric labels.

- [x] **Step 1: Add negative tests for arbitrary content**

```ts
expect(runtimeRunRecordSchema.safeParse({
  ...baseRecord,
  context_json: { measurement: 'HRV 58 ms' },
}).success).toBe(false);
expect(runtimeTraceDetailSchema.safeParse({ measurement: 'HRV 58 ms' }).success).toBe(false);
expect(evidenceRunSchema.safeParse({ ...baseEvidence, metadata: { note: 'a@b.com' } }).success).toBe(false);
expect(lowCardinalityMetricLabelSchema.safeParse({ note: 'HRV 58 ms' }).success).toBe(false);
```

Run focused contract tests and confirm RED.

- [x] **Step 2: Replace arbitrary shapes with strict schemas**

Use discriminated/strict objects, bounded arrays and strings, roster/error/tool enums, required
`source_taint`, and a finite run failure vocabulary. Trace detail selection is keyed by the event enum;
unknown events and unknown detail fields reject.

- [x] **Step 3: Update replay/eval projection**

Replace arbitrary synthesized failure text with `RuntimeRunFailureReason | 'unknown'`. Reuse the
existing HEY-111 trace/replay path; do not create another store.

- [x] **Step 4: Run focused tests and commit**

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test -- \
  src/runtime/run.test.ts src/runtime/evidence.test.ts src/testing/evidence.test.ts \
  src/telemetry/engagement.test.ts
git add packages/contracts/src/runtime packages/contracts/src/testing \
  packages/contracts/src/telemetry packages/runtime/src/run-loop/evidence.ts
git commit -m "feat: close persisted evidence shapes"
```

### Task 5: RunLoop checkpoint, trace, delivery, and restart vertical

**Files:**
- Modify: `packages/runtime/src/run-loop/adapters.ts`
- Modify: `packages/runtime/src/run-loop/do.ts`
- Modify: `packages/runtime/test/run-loop-adapters.test.ts`
- Modify: `packages/runtime/test/run-loop.test.ts`

**Interfaces:**
- Consumes: strict Task 4 run/evidence schemas and production Scribe.
- Produces: pre-transaction sanitized checkpoints, content-free trace denial, pre-outbox delivery
  sanitization, and crash/resume taint restoration.

- [x] **Step 1: Write the Workerd denial tracer**

Script hostile provider output containing `{ metric: 'hrv', measurement: 58 }`. Assert FAILED with a
typed `scribe:*` reason, zero forbidden bytes in runtime tables/proof/replay, zero outbox rows, and zero
sink calls. Run the focused test and confirm RED.

- [x] **Step 2: Replace local pass-through safety**

Wire `sanitise` and `evaluateMedicalClaim` in fake and gateway adapter sets. Gateway rate/approval/
spend/sink behavior stays fail-closed.

- [x] **Step 3: Sanitize before synchronous SQLite writes**

Parse and sanitize context/scratch outside `transactionSync`; pass only strict parsed values to
`advanceRun` and `updateRunScratch`. Validate tool calls before checkpoint. On denial, write only the
finite failure code.

- [x] **Step 4: Sanitize trace/replay and delivery**

`recordTrace` sanitizes strict detail as `audit_log`; denied detail becomes one `scribe_denied` event.
`gate()` sanitizes the delivery candidate for `outbox` and `send_message` before `gateRun()` can commit
an outbox row.

- [x] **Step 5: Persist and restore taint**

When a dispatched result is external, set scratch `source_taint: 'external'`. Rebuilt invocation
context reads it. Add crash-after-tools, eviction, resume, and privileged-follow-up denial proof.

- [x] **Step 6: Run Workerd tests and commit**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- \
  test/run-loop-adapters.test.ts test/run-loop.test.ts
git add packages/runtime/src/run-loop packages/runtime/test/run-loop-adapters.test.ts \
  packages/runtime/test/run-loop.test.ts
git commit -m "feat: guard run-loop persistence and delivery"
```

### Task 6: Property and mutation evidence

**Files:**
- Create: `packages/runtime/test/scribe-sanitiser.property.test.ts`
- Create: `packages/runtime/vitest.scribe.config.ts`
- Create: `packages/runtime/stryker.config.mjs`
- Modify: `packages/runtime/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: production `sanitise()` only.
- Produces: reproducible property lane and targeted deterministic mutation lane.

- [x] **Step 1: Add bounded recursive generators**

Generate health token aliases, separators/casing, numeric/ratio forms, nested records/arrays, CSV,
and each supported encoding. Assert insertion anywhere causes denial at prohibited destinations while
safe numbers remain allowed. Configure fast-check to print seed/path on failure.

- [x] **Step 2: Prove the property test is sensitive**

Temporarily replace one hostile token with a safe token and observe the property fail, then restore
the generator/invariant and observe PASS. Do not weaken the invariant to make it green.

- [x] **Step 3: Configure Node-only mutation against the same production Module**

```js
export default {
  mutate: ['src/scribe/sanitiser.ts'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  vitest: { configFile: 'vitest.scribe.config.ts', related: false },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/stryker/scribe.json' },
};
```

- [x] **Step 4: Run mutation and kill critical survivors**

Run: `npx -y pnpm@10.34.4 verify:mutation`
Expected: no survivor/no-coverage mutant in recursion, check ordering, health correlation, instruction
threshold, destination eligibility, or denial branches. Equivalent mutants must be documented with
source proof rather than ignored.

- [x] **Step 5: Commit the evidence lane**

```bash
git add package.json packages/runtime/package.json packages/runtime/vitest.scribe.config.ts \
  packages/runtime/stryker.config.mjs packages/runtime/test/scribe-sanitiser.property.test.ts
git commit -m "test: add scribe property and mutation proof"
```

### Task 7: Contract, adversarial, and whole-branch verification

**Files:**
- Modify as findings require: HEY-13-owned files only
- Update: `docs/foundation/HEY-13-ISA-RUN-CONTRACT.md`

**Interfaces:**
- Produces: reviewer-clean, fully verified branch evidence.

- [x] **Step 1: Run focused and full contract checks**

```bash
npx -y pnpm@10.34.4 verify:property
npx -y pnpm@10.34.4 verify:mutation
npx -y pnpm@10.34.4 verify
git diff --check
git status --short
```

- [x] **Step 2: Run privacy scans**

Scan the diff and fixtures for secrets, real personal data, raw health values, broad JSON records,
pass-through sanitizers, dynamic failure strings, and bypassing provider/tool/persistence calls.

- [x] **Step 3: Run required review skills**

Run `check-contract`, workflow-mapper, qa-breaker, security-reviewer, health-data-reviewer,
e2e-pipeline-tester, `break-feature`, `review-all`, and `run-eval`. Run CRS validation if `crs.ts`
changed. Fix every Critical/Important finding with a failing test first, then re-review.

- [x] **Step 4: Append fresh evidence and commit fixes**

Record exact command outputs, test counts, mutation result, reviewer verdicts, and residual unproved
absent surfaces in the ISA contract. Commit only after the full wall is green.

### Task 8: Phase handoff and PR preparation

**Files:**
- Create: `docs/foundation/HEY-13-PHASE-HANDOFF.md`
- Update: `docs/foundation/HEY-13-ISA-RUN-CONTRACT.md`
- Update: `.superpowers/sdd/progress.md` (ignored scratch ledger)

**Interfaces:**
- Produces: one reviewable HEY-13 PR and durable next-session state.

- [x] **Step 1: Write the phase handoff**

Include what was built, fresh evidence, what remains absent/unproved, architecture decisions, lessons,
prerequisites, and all changed files.

- [x] **Step 2: Capture reusable learning only if novel**

Run the overlap check required by `compound-learning-capture`. Update an existing home rather than
creating a duplicate lesson. Do not edit protected ADR/soul/rule files.

- [x] **Step 3: Rebase/fetch check and final verification**

Fetch current `origin/main`, inspect divergence, resolve only in the HEY-13 worktree, and rerun the
complete verification wall. Do not merge.

- [x] **Step 4: Push and open one HEY-13 PR**

The PR body must include impact surface, rollback, exact proof, missing eval/live/staging evidence,
and unresolved risks. Update Linear HEY-13 with the commit/PR and evidence. Leave status In Progress
until the PR is reviewed; do not mark Done or merge.
