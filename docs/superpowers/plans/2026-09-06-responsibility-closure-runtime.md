# Responsibility Closure Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the v0.6 responsibility-closure runtime so Waldo can declare exact success checks, admit bounded Evidence, independently Verify it, and record explicit owner Acceptance or Release without allowing provider/model completion to close work.

**Architecture:** Extend the existing owner Durable Object and `WaldoCoordinator`. `OutcomeModule` remains the sole Outcome/WorkUnit writer and owns AcceptanceCheck; a new `EvidenceVerifier` owns Evidence/Verification; a new `AcceptanceModule` owns Acceptance/release; the existing projection publisher is deepened for v0.6 closure projection; the responsibility worker adapter remains thin authenticated ingress. No new backend, task store, memory store, or execution engine is introduced.

**Tech Stack:** TypeScript, Cloudflare Durable Objects SQLite, Vitest with `cloudflare:test`, Zod contracts from `@waldo/contracts`, existing OwnerEventLog/Coordinator/worker adapter infrastructure, pnpm 10.34.4.

**Spec:** `docs/superpowers/specs/2026-09-06-responsibility-closure-runtime-design.md`

## Global Constraints

- [ ] Do not start production-code edits until PR #133 is explicitly merged at reviewed head `5e6ed074c9ae49ba95ff13c107997aa6b84010ff` or a replacement head is independently reviewed.
- [ ] After merge, re-pin `origin/main` and verify the v0.6 contract files are present on the landed tree.
- [ ] Re-read `packages/runtime/do-migration-reservations.json`; allocate the next migration only by `rebase_then_append`. Current main ends at v7, but do not pre-reserve v8.
- [ ] Post a new runtime `SESSION START` on #116 with exact landed base SHA, branch/worktree, migration allocation, file ownership, acceptance, falsifier, verification, and rollback.
- [ ] TDD is mandatory: every production behavior starts with a failing test that is observed failing for the intended reason.
- [ ] Keep one definitive writer per aggregate: OutcomeModule → AcceptanceCheck; EvidenceVerifier → Evidence/Verification; AcceptanceModule → Acceptance/release; ProjectionPublisher → rebuildable closure projection.
- [ ] Coordinator authenticates/authorizes/rereads/sequences only; worker adapter parses/routes only.
- [ ] Explicit authenticated owner is the only Acceptance/release actor in #84. No delegated Acceptance.
- [ ] No real verifier/provider network I/O, credentials, health data, transcript/prompt content, arbitrary Evidence bodies, adapter activation, staging, deployment, or production mutation.
- [ ] Provider/executor/model/channel `done` remains an observation and can never imply Verification, Acceptance, Outcome completion, OpenLoop closure, or Release.
- [ ] Preserve every released v0.1-v0.5 contract byte and all existing Judgment behavior.

---

## Task 1: Landed-contract preflight and migration allocation

**Files:**
- Read: `packages/contracts/src/protocol/responsibility-closure-v0-6.ts`
- Read: `packages/contracts/src/protocol/responsibility-closure-http-v0-6.ts`
- Read: `packages/contracts/src/index.ts`
- Read: `packages/runtime/DO-MIGRATIONS.md`
- Modify after re-pin: `packages/runtime/do-migration-reservations.json`
- Modify after re-pin: `packages/runtime/src/do-schema.ts`
- Test: `packages/runtime/test/do-schema.test.ts`
- Guard: `scripts/guards/guard-do-migration-lineage.mjs`

- [ ] Confirm PR #133 is merged and record landed `main` SHA/tree in #116.
- [ ] Confirm `responsibility-closure-v0-6` and its HTTP route manifest resolve from `@waldo/contracts` on landed main.
- [ ] Confirm current highest reserved migration version and append exactly one collision-free closure-runtime migration.
- [ ] RED: add a `do-schema.test.ts` assertion that a freshly initialized owner DO exposes the new closure tables and current migration version; run it and observe failure because the migration is absent.
- [ ] GREEN: add the minimal additive schema required for `acceptance_checks`, `closure_evidence`, `closure_verifications`, `closure_acceptances`, `closure_commands`, and closure projection state/items only if the existing projection schema cannot safely namespace v0.6 records.
- [ ] Add owner/revision/request uniqueness and parameterized lookup indexes. Do not add denormalized content fields not required by the v0.6 contract/runtime rereads.
- [ ] Run the focused migration test and observe GREEN.
- [ ] Run the DO migration lineage guard and keep the reservation/source chain identical.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- do-schema
node scripts/guards/guard-do-migration-lineage.mjs
```

**Commit:** `feat(runtime): add responsibility closure schema`

---

## Task 2: AcceptanceCheck ownership in OutcomeModule

**Files:**
- Modify: `packages/runtime/src/coordinator/outcome-module.ts`
- Modify only for typed conflict mapping: `packages/runtime/src/responsibility/errors.ts`
- Test: `packages/runtime/test/responsibility-closure-outcome.test.ts`

**Desired interface:**

```ts
OutcomeModule.declareAcceptanceCheckInCurrentTransaction(input: {
  ownerId: string;
  target: ClosureTargetSelectorV06;
  criterion: AcceptanceCriterionRefV06;
  verificationMethod: AcceptanceVerificationMethodV06;
  requestId: string;
  correlationId: string;
  at: string;
}): AcceptanceCheckV06

OutcomeModule.readActiveAcceptanceCheckSetInCurrentTransaction(input: {
  ownerId: string;
  outcomeId: string;
  expectedOutcomeRevision: number;
  sha256Hex: ClosureSha256HexV06;
}): ActiveAcceptanceCheckSetV06
```

- [ ] RED: exact current WorkUnit declaration creates one active AcceptanceCheck bound to canonical Outcome/WorkUnit revision and server-computed digest; observe failure because the method is absent.
- [ ] GREEN: implement exact target reread and minimal persistence/event append; derive owner/subject from current rows, never request data.
- [ ] RED/GREEN: stale `expectedRevision` rejects before rows/events are written.
- [ ] RED/GREEN: cross-owner and nonexistent targets fail closed; public mapping must not disclose private existence.
- [ ] RED/GREEN: active-set reread is strictly sorted, complete, owner/subject exact, and its digest recomputes deterministically with v0.6 canonicalizers.
- [ ] RED/GREEN: duplicate/conflicting active criteria cannot create an ambiguous active success definition.
- [ ] Refactor only after focused tests remain green.

**Verification command:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-closure-outcome
```

**Commit:** `feat(runtime): own acceptance checks in outcome module`

---

## Task 3: EvidenceVerifier as sole Evidence/Verification writer

**Files:**
- Create: `packages/runtime/src/coordinator/evidence-verifier.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify only through the existing canonical observation owner seam discovered on landed main; do not create a duplicate observation store.
- Test: `packages/runtime/test/evidence-verifier.test.ts`

**Trusted verifier boundary:**

```ts
export type ClosureVerifier = (input: {
  ownerId: string;
  acceptanceCheck: AcceptanceCheckV06;
  evidence: CurrentEvidenceSetEnvelopeV06;
}) => Promise<Readonly<{
  state: 'passed' | 'failed' | 'indeterminate';
  verifierId: string;
  verifierVersion: string;
  availability: 'available' | 'unavailable' | 'unsupported';
  independentFromProducer: boolean;
  disclosure: { ref: string; digest: `sha256:${string}` };
  findings: { ref: string; digest: `sha256:${string}` } | null;
}>>;
```

- [ ] RED: admitting a canonical execution/provider/effect/person observation derives producer provenance from trusted source state and persists bounded Evidence only; observe failure because `EvidenceVerifier` is absent.
- [ ] GREEN: implement owner-scoped observation reread plus `EvidenceV06` persistence/event append.
- [ ] RED/GREEN: stale, missing, or cross-owner observation produces no Evidence row/event.
- [ ] RED/GREEN: one canonical observation cannot be counted twice in a current accepted binding.
- [ ] RED/GREEN: current Evidence-set envelope is strictly ordered, contains only `admitted` current records for the exact check, and recomputes `evidenceSetDigest` plus envelope digest.
- [ ] RED/GREEN: verifier identity equal to any Evidence producer cannot persist `passed`.
- [ ] RED/GREEN: unavailable/unsupported verifier produces `indeterminate`, never `passed`.
- [ ] RED/GREEN: verifier method/version must match the exact current AcceptanceCheck.
- [ ] RED/GREEN: cover passed, failed, and indeterminate paths with the injected hermetic verifier.

**Verification command:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- evidence-verifier
```

**Commit:** `feat(runtime): persist evidence and independent verification`

---

## Task 4: AcceptanceModule as explicit-owner-only writer

**Files:**
- Create: `packages/runtime/src/coordinator/acceptance-module.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/acceptance-module.test.ts`

**Desired interface:**

```ts
AcceptanceModule.recordInCurrentTransaction(input: {
  ownerId: string;
  outcomeId: string;
  expectedOutcomeRevision: number;
  request: AcceptanceRecordRequestV06;
  activeChecks: ActiveAcceptanceCheckSetV06;
  evidenceSets: readonly CurrentEvidenceSetEnvelopeV06[];
  verifications: readonly VerificationV06[];
  at: string;
}): AcceptanceV06
```

- [ ] RED: `accept` succeeds only with exactly one current `passed`, available, independent Verification for every active AcceptanceCheck; observe failure because the module is absent.
- [ ] GREEN: construct and validate the complete binding with `createVerifiedAcceptanceBindingVerifierV06`, then persist.
- [ ] RED/GREEN: zero, partial, or duplicate Verification coverage fails.
- [ ] RED/GREEN: stale check revision/digest, stale Evidence set, changed Evidence-set digest, failed/indeterminate/stale Verification, or verifier/producer identity collision fails.
- [ ] RED/GREEN: actor other than the exact authenticated owner fails; actor is server-constructed.
- [ ] RED/GREEN: `release` requires `reasonRef`, records `released`, and never claims verified Acceptance.
- [ ] RED/GREEN: Acceptance persistence does not mutate Outcome state or #85 OpenLoop/ReEntry state.

**Verification command:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- acceptance-module
```

**Commit:** `feat(runtime): record explicit owner acceptance and release`

---

## Task 5: Coordinator sequencing, idempotency, and rollback

**Files:**
- Modify: `packages/runtime/src/coordinator/waldo-coordinator.ts`
- Modify only if shared journal behavior is truly needed: `packages/runtime/src/coordinator/owner-event-log.ts`
- Test: `packages/runtime/test/responsibility-closure-coordinator.test.ts`

**Coordinator methods:**

```ts
declareAcceptanceCheckV06(request, canonicalAuthority)
admitEvidenceV06(request, canonicalAuthority)
requestVerificationV06(request, canonicalAuthority)
recordAcceptanceV06(request, canonicalAuthority)
readClosureProjectionV06(query, canonicalAuthority)
```

- [ ] RED/GREEN: each command rejects presence-registration mismatch/cross-owner authority before mutation using existing canonical authority admission.
- [ ] RED/GREEN: first command persists `requestId`, canonical request material/digest, exact result bytes, domain rows, event, and projection atomically.
- [ ] RED/GREEN: exact retry returns byte-identical result and unchanged row/event/high-water counts.
- [ ] RED/GREEN: same requestId with changed canonical material rejects and leaves state unchanged.
- [ ] RED/GREEN: induced exception after a row write but before event/projection rolls back the whole command.
- [ ] RED/GREEN: Acceptance rereads active checks, current Evidence envelopes, and current Verification records in the same transaction immediately before persistence.
- [ ] RED/GREEN: no provider/model/public request field can populate owner, actor, provenance, verifier, policy, IDs, clocks, digests, or Verification state.

**Verification command:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-closure-coordinator
```

**Commit:** `feat(runtime): sequence closure commands in coordinator`

---

## Task 6: v0.6 closure events and projection rebuild

**Files:**
- Modify: `packages/runtime/src/coordinator/projection-publisher.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/closure-projection-publisher.test.ts`
- Regression: `packages/runtime/test/judgment-authority-coordinator.test.ts`

- [ ] RED/GREEN: valid v0.6 `acceptance_check.declared` event creates one closure projection item at owner cursor.
- [ ] RED/GREEN: support `evidence.admitted`, `evidence.invalidated`, `verification.recorded`, `acceptance.recorded`, and `release.recorded` without weakening v0.5 Judgment checks.
- [ ] RED/GREEN: wrong schema version, aggregate/event mismatch, malformed payload, owner/revision mismatch, or record-digest mismatch fails closed.
- [ ] RED/GREEN: deleting rebuildable closure projection rows then replaying owner events reproduces identical ordered closure items and high-water state.
- [ ] RED/GREEN: closure projection query enforces snapshot/cursor ordering, 256-item cap, page digest, and 262,144-byte page limit.
- [ ] RED/GREEN: existing Judgment projection tests stay unchanged and green.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- closure-projection-publisher
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- judgment-authority-coordinator
```

**Commit:** `feat(runtime): project responsibility closure events`

---

## Task 7: Public v0.6 responsibility ingress

**Files:**
- Modify: `packages/runtime/src/responsibility/worker-adapter.ts`
- Modify: `packages/runtime/src/responsibility/ingress-signature.ts`
- Modify only for typed generic problem mapping: `packages/runtime/src/responsibility/errors.ts`
- Test: `packages/runtime/test/responsibility-worker-adapter.test.ts`
- Public DO regression: `packages/runtime/test/responsibility-public-do.test.ts`

- [ ] RED/GREEN: extend `ResponsibilityIngressOperation` with bounded closure command/projection operations and preserve canonical ingress-signature behavior.
- [ ] RED/GREEN: all five `responsibilityClosureHttpRouteManifestV06` routes are recognized only with the exact method/path/media type.
- [ ] RED/GREEN: strict schemas reject extra/caller-smuggled owner, actor, provenance, verifier, policy, digest, and result fields.
- [ ] RED/GREEN: missing/invalid auth, owner mismatch, revoked/stale presence, oversized body, or malformed JSON returns existing generic public problems and performs no write.
- [ ] RED/GREEN: valid commands call the corresponding Coordinator method and return exact v0.6 result media type.
- [ ] RED/GREEN: GET closure projection is owner-scoped and cursor bounded.
- [ ] Run the existing public DO regression path to prove the new routes do not weaken prior public responsibility ingress.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-worker-adapter
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-public-do
```

**Commit:** `feat(runtime): expose responsibility closure v0.6 ingress`

---

## Task 8: Adversarial integration and replay proof

**Files:**
- Create: `packages/runtime/test/responsibility-closure-e2e.test.ts`

**Golden flow:** authenticated owner captures Outcome/WorkUnit → declares AcceptanceCheck → admits trusted observation as Evidence → requests independent Verification → gets `passed` → explicitly accepts → reads closure projection → rebuilds projection in hermetic DO → obtains identical canonical closure items. No provider/model step can directly create Acceptance.

- [ ] RED/GREEN: golden flow.
- [ ] RED/GREEN: hostile provider observation claiming `done` without admitted Evidence cannot close.
- [ ] RED/GREEN: verifier/producer identity collision cannot yield accepted closure.
- [ ] RED/GREEN: Evidence becomes stale or AcceptanceCheck changes between Verification and Acceptance; Acceptance fails.
- [ ] RED/GREEN: replayed commands produce one canonical row/event/result.
- [ ] RED/GREEN: induced exceptions at writer boundaries leave no partial command/result/event/projection state.
- [ ] RED/GREEN: cross-owner IDs never disclose or mutate another owner's records.
- [ ] Verify fixtures contain no credentials, health values, prompts/transcripts, artifact bytes, or production identifiers.

**Verification command:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-closure-e2e
```

**Commit:** `test(runtime): prove responsibility closure invariants`

---

## Task 9: Full verification wall and review

- [ ] Run contract tests for released compatibility.
- [ ] Run runtime tests and typecheck.
- [ ] Run Supabase responsibility integration regression even though #84 adds no Supabase migration.
- [ ] Run migration and generated-artifact guards.
- [ ] Run the full pinned verification wall and `git diff --check`.
- [ ] Run repo contract review against v0.6 schemas/HTTP manifest.
- [ ] Run adversarial QA-breaker.
- [ ] Run mandatory Security/authority/privacy review because this changes owner product truth and DO writes.
- [ ] Run independent Standards and Spec reviews.
- [ ] Classify every failure as in-branch, introduced, pre-existing, or genuinely flaky before changing code.
- [ ] Record exact SHA/tree and passed/failed/skipped/unavailable/not-run evidence separately on #84 and #116.

**Full commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck
npx -y pnpm@10.34.4 verify
git diff --check
```

Do not describe local/hermetic proof as staging, deployment, adapter conformance, cross-surface acceptance, or production proof.

**Conditional hardening commit:** `fix(runtime): harden responsibility closure invariants`

---

## Task 10: Handoff and PR boundary

- [ ] Update #84 with exact implementation evidence, residual risks, and proof classification.
- [ ] Post `SESSION HANDOFF` to #116 before opening a PR or ending the lane.
- [ ] Open the #84 runtime PR only after the exact verification wall and reviews pass.
- [ ] PR body must distinguish `architecture_specified`, `contract_defined`, `module_implemented`, `adapter_conformance_passed`, `cross_surface_acceptance_passed`, and `operational_proof_passed`.
- [ ] Runtime PR merge remains a separate human boundary; deployment is not included.
- [ ] Keep #85 blocked until #84 runtime is landed and exact release evidence is pinned.

## Rollback

Before any deployment, rollback is `git revert` of the additive #84 runtime commits and migration reservation/source. No hosted Durable Object migration is authorized by this plan.

If a future staging migration is separately authorized, prove disposable/staging rollback before production. Never auto-run a production migration.