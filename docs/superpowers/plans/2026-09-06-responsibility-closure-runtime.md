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
- Read: `packages/runtime/do-migration-reservations.json`
- Read: `packages/runtime/src/do-schema.ts`
- Modify after re-pin: `packages/runtime/do-migration-reservations.json`
- Modify after re-pin: `packages/runtime/src/do-schema.ts`
- Test: `packages/runtime/test/do-schema.test.ts` or the existing migration test file that owns executable lineage on landed main

- [ ] Confirm PR #133 is merged and record landed `main` SHA/tree in #116.
- [ ] Confirm `responsibility-closure-v0-6` and its HTTP route manifest resolve from `@waldo/contracts` on landed main.
- [ ] Confirm current highest reserved migration version and append exactly one collision-free closure-runtime migration.
- [ ] Write the RED migration test first: a fresh owner DO schema must not yet contain the v0.6 closure tables; then update the expectation so it fails because the new migration is missing.
- [ ] Run the focused migration test and observe the expected RED.
- [ ] Add the minimal additive schema required for:
  - `acceptance_checks`;
  - `closure_evidence`;
  - `closure_verifications`;
  - `closure_acceptances`;
  - `closure_commands`;
  - closure projection state/items only if the existing projection schema cannot safely namespace v0.6 records.
- [ ] Add owner/revision/request uniqueness and parameterizable lookup indexes. Do not add denormalized content fields that are not required by the v0.6 contract/runtime rereads.
- [ ] Run the focused migration test and observe GREEN.
- [ ] Run the DO migration lineage guard.

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
- Modify only if needed for typed conflict mapping: `packages/runtime/src/responsibility/errors.ts`
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

The concrete function names may be shortened only if the ownership remains unmistakable and no second writer is created.

- [ ] RED: test exact current WorkUnit declaration creates one active AcceptanceCheck bound to canonical Outcome/WorkUnit revision and server-computed digest.
- [ ] Observe RED because the method does not exist.
- [ ] GREEN: implement exact target reread and minimal persistence/event append; derive owner/subject from current rows, never request data.
- [ ] RED: stale `expectedRevision` rejects before writing rows/events.
- [ ] GREEN: add stale-revision guard.
- [ ] RED: cross-owner target and nonexistent target both fail closed without distinguishing private existence to the public layer.
- [ ] GREEN: add owner-scoped rereads.
- [ ] RED: active-set reread is sorted, complete, owner/subject exact, and digest recomputes deterministically.
- [ ] GREEN: implement exact active-set envelope construction using v0.6 canonicalizers.
- [ ] RED: duplicate active criterion/method for the same exact subject does not create ambiguous active checks; changed/conflicting declaration fails according to command identity handled by Coordinator in Task 5.
- [ ] Refactor only after all focused tests stay green.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-closure-outcome
```

**Commit:** `feat(runtime): own acceptance checks in outcome module`

---

## Task 3: EvidenceVerifier as sole Evidence/Verification writer

**Files:**
- Create: `packages/runtime/src/coordinator/evidence-verifier.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify only if the canonical observation reread needs a narrow existing seam: the current execution/effect observation owner module, not a duplicate observation store
- Test: `packages/runtime/test/evidence-verifier.test.ts`

**Desired trusted boundary:**

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

The final return type must be strict enough that runtime, not the public caller/model, selects verifier identity/policy and validates every field through v0.6 schemas.

- [ ] RED: admitting a canonical execution/provider/effect/person observation derives producer provenance from trusted source state and persists bounded Evidence only.
- [ ] Observe RED.
- [ ] GREEN: implement owner-scoped observation reread + `EvidenceV06` persistence and event append.
- [ ] RED: stale/missing/cross-owner observation produces no Evidence row/event.
- [ ] GREEN: fail closed.
- [ ] RED: same canonical observation cannot be counted twice in a current accepted binding; duplicate command identity itself is handled by Coordinator.
- [ ] GREEN: enforce observation uniqueness at persistence and envelope construction.
- [ ] RED: current Evidence-set envelope is strictly ordered, contains only `admitted` current records for the exact check, and recomputes `evidenceSetDigest`/envelope digest.
- [ ] GREEN: implement envelope reread/canonicalization.
- [ ] RED: verifier identity equal to any Evidence producer cannot persist `passed`.
- [ ] GREEN: enforce `closureVerifierIndependenceRuleV06` before persistence.
- [ ] RED: unavailable/unsupported verifier produces `indeterminate`, never `passed`.
- [ ] GREEN: implement availability mapping.
- [ ] RED: verifier method/version must match the exact active AcceptanceCheck.
- [ ] GREEN: bind method/version from server-owned check state.
- [ ] RED/GREEN: cover successful passed, explicit failed, and indeterminate paths with the injected hermetic verifier.

**Verification commands:**

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

The module MUST independently validate the full binding with `createVerifiedAcceptanceBindingVerifierV06` before persisting an `accepted` record. For `release`, construct only the released shape and never reuse the accepted path.

- [ ] RED: `accept` succeeds only with exactly one current `passed`, available, independent Verification for every active AcceptanceCheck.
- [ ] Observe RED.
- [ ] GREEN: implement complete binding validation and persistence.
- [ ] RED: zero/partial/duplicate Verification coverage fails.
- [ ] GREEN: enforce one-to-one check coverage.
- [ ] RED: stale check revision/digest, stale Evidence set, changed Evidence-set digest, failed/indeterminate/stale Verification, or verifier/producer identity collision all fail.
- [ ] GREEN: rely on same-transaction rereads plus contract binding verifier; do not duplicate contract logic inconsistently.
- [ ] RED: actor other than exact authenticated owner fails.
- [ ] GREEN: actor is server-constructed from canonical authority; module asserts `actor.id === ownerId`.
- [ ] RED: `release` requires reasonRef, records `released`, and never exposes active-check/evidence summaries as verified Acceptance.
- [ ] GREEN: implement separate release persistence/event type.
- [ ] RED: Acceptance persistence does not mutate Outcome state or #85 OpenLoop/ReEntry state.
- [ ] GREEN: keep module ownership bounded.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- acceptance-module
```

**Commit:** `feat(runtime): record explicit owner acceptance and release`

---

## Task 5: Coordinator sequencing, idempotency, and transaction rollback

**Files:**
- Modify: `packages/runtime/src/coordinator/waldo-coordinator.ts`
- Modify if shared helper earns its keep: `packages/runtime/src/coordinator/owner-event-log.ts`
- Test: `packages/runtime/test/responsibility-closure-coordinator.test.ts`

**Coordinator methods to add:**

```ts
declareAcceptanceCheckV06(request, canonicalAuthority)
admitEvidenceV06(request, canonicalAuthority)
requestVerificationV06(request, canonicalAuthority)
recordAcceptanceV06(request, canonicalAuthority)
readClosureProjectionV06(query, canonicalAuthority)
```

- [ ] RED: each command rejects presence-registration mismatch/cross-owner authority before mutation.
- [ ] GREEN: reuse existing canonical authority admission and owner routing.
- [ ] RED: first command persists `requestId`, canonical request material/digest, exact result bytes, domain rows, event, and projection atomically.
- [ ] GREEN: add `closure_commands` transaction helper behind Coordinator.
- [ ] RED: exact retry returns byte-identical result and unchanged row/event/high-water counts.
- [ ] GREEN: return persisted result without calling writers.
- [ ] RED: same requestId with changed canonical material rejects and leaves state unchanged.
- [ ] GREEN: compare canonical digest/material before any writer call.
- [ ] RED: induced exception after row write but before event/projection rolls the whole command back.
- [ ] GREEN: keep all writers inside one `storage.transactionSync`/existing transaction pattern.
- [ ] RED: Acceptance rereads active checks, current Evidence envelopes, and current Verification records in the same transaction immediately before persistence.
- [ ] GREEN: sequence authoritative rereads explicitly.
- [ ] RED: no provider/model/public request field can populate owner, actor, provenance, verifier, policy, IDs, clocks, digests, or Verification state.
- [ ] GREEN: construct all server-owned material in Coordinator/writer boundaries only.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-closure-coordinator
```

**Commit:** `feat(runtime): sequence closure commands in coordinator`

---

## Task 6: v0.6 closure events and projection rebuild

**Files:**
- Modify: `packages/runtime/src/coordinator/projection-publisher.ts`
- Modify only if exported aliases are required: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/closure-projection-publisher.test.ts`
- Regression test: `packages/runtime/test/judgment-authority-coordinator.test.ts`

- [ ] RED: publishing a valid v0.6 `acceptance_check.declared` event creates one closure projection item at the owner cursor.
- [ ] GREEN: teach existing publisher to recognize and validate the closure namespace without weakening v0.5 Judgment checks.
- [ ] RED/GREEN: add `evidence.admitted`/`evidence.invalidated`, `verification.recorded`, `acceptance.recorded`, and `release.recorded` mappings.
- [ ] RED: wrong schema version, aggregate/event mismatch, malformed payload, owner mismatch, revision mismatch, or record digest mismatch fails closed.
- [ ] GREEN: validate every event against canonical persisted record material.
- [ ] RED: rebuild from owner events reproduces ordered closure items and high-water state after projection rows are deleted.
- [ ] GREEN: implement bounded v0.6 replay.
- [ ] RED: closure projection query enforces snapshot/cursor ordering, 256-item cap, page digest, and 262,144-byte page limit.
- [ ] GREEN: implement page builder using contract schemas/canonical digest.
- [ ] RED: existing Judgment projection tests remain unchanged and green.
- [ ] GREEN/refactor: extract only shared replay mechanics that genuinely reduce duplication without changing public behavior.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- closure-projection-publisher
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- judgment-authority-coordinator
```

**Commit:** `feat(runtime): project responsibility closure events`

---

## Task 7: Public responsibility v0.6 HTTP ingress

**Files:**
- Modify: `packages/runtime/src/responsibility/worker-adapter.ts`
- Modify only if generic problem mapping needs a v0.6 conflict code: `packages/runtime/src/responsibility/errors.ts`
- Test: `packages/runtime/test/responsibility-worker-adapter.test.ts` or the landed adapter test file that currently owns public responsibility route conformance

- [ ] RED: all five `responsibilityClosureHttpRouteManifestV06` routes are recognized only with the exact method/path/media type.
- [ ] GREEN: add route matching/imports without changing v0.1-v0.5 behavior.
- [ ] RED: strict schemas reject extra/caller-smuggled owner/actor/provenance/verifier/policy/digest/result fields.
- [ ] GREEN: parse v0.6 request schemas before Coordinator invocation.
- [ ] RED: missing/invalid auth, owner routing mismatch, revoked/stale presence, oversized body, or malformed JSON returns the existing generic public problem shape and performs no write.
- [ ] GREEN: reuse existing auth/authority/budget/error seams; do not hand-roll another auth path.
- [ ] RED: valid commands call the corresponding Coordinator method and return the exact v0.6 result media type.
- [ ] GREEN: wire the thin route handlers.
- [ ] RED: GET closure projection is owner-scoped, cursor bounded, and content-free beyond the contract projection.
- [ ] GREEN: wire read path.

**Verification commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-worker-adapter
```

**Commit:** `feat(runtime): expose responsibility closure v0.6 ingress`

---

## Task 8: Adversarial integration, replay, and security proof

**Files:**
- Test: `packages/runtime/test/responsibility-closure-e2e.test.ts`
- Test/support only if existing repo convention requires: `packages/runtime/test/helpers/*`
- No production changes unless a failing test identifies an in-scope defect.

**Golden flow:** authenticated owner captures an Outcome/WorkUnit → declares AcceptanceCheck → admits trusted observation as Evidence → requests independent Verification → receives `passed` → explicitly accepts → reads closure projection → deletes/rebuilds projection in hermetic DO → obtains identical canonical closure items. No provider/model step can directly create Acceptance.

- [ ] RED/GREEN: golden flow.
- [ ] RED/GREEN: hostile provider observation claiming `done` without admitted Evidence cannot close.
- [ ] RED/GREEN: one LLM/verifier assertion with producer/verifier identity collision cannot produce passed Acceptance.
- [ ] RED/GREEN: Evidence becomes stale or AcceptanceCheck revision changes between Verification and Acceptance; Acceptance fails.
- [ ] RED/GREEN: duplicate commands under concurrent/replayed delivery produce one canonical row/event/result.
- [ ] RED/GREEN: induced exception at each writer boundary leaves no partial command/result/event/projection state.
- [ ] RED/GREEN: cross-owner IDs never disclose or mutate another owner's records.
- [ ] Verify tests contain no credentials, raw health, transcript, prompt, artifact bytes, or production identifiers.

**Focused verification:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- responsibility-closure-e2e
```

**Commit:** `test(runtime): prove responsibility closure invariants`

---

## Task 9: Full verification wall and review

- [ ] Run contract tests to ensure released contract compatibility.
- [ ] Run runtime tests and typecheck.
- [ ] Run Supabase integration regression even though #84 does not add a Supabase migration.
- [ ] Run migration guards and generated-artifact guards.
- [ ] Run the full pinned verification wall.
- [ ] Run `git diff --check`.
- [ ] Run repo `/check-contract` equivalent review against v0.6 schemas and HTTP manifest.
- [ ] Run adversarial `/break-feature` or QA-breaker pass.
- [ ] Run mandatory Security/authority/privacy review because this changes owner authority/product truth and DO writes.
- [ ] Run independent Standards and Spec reviews.
- [ ] Classify every failed test as in-branch, introduced, pre-existing, or genuinely flaky before changing anything.
- [ ] Record exact SHA/tree and passed/failed/skipped/unavailable/not-run evidence separately on #84 and #116.

**Full commands:**

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck
npx -y pnpm@10.34.4 verify
git diff --check
```

Do not describe local/fake proof as staging, deployment, adapter conformance, cross-surface acceptance, or production proof.

**Final commit only if verification/review causes source changes:** `fix(runtime): harden responsibility closure invariants`

---

## Task 10: Handoff and PR boundary

- [ ] Update #84 with exact implementation evidence, residual risks, and proof classification.
- [ ] Post `SESSION HANDOFF` to #116 before opening a PR or ending the lane.
- [ ] Open the #84 runtime PR only after the exact verification wall and reviews pass.
- [ ] PR body must distinguish: `architecture_specified`, `contract_defined`, `module_implemented`, `adapter_conformance_passed`, `cross_surface_acceptance_passed`, `operational_proof_passed`.
- [ ] Runtime PR merge requires the repository's normal explicit human boundary; deployment is not included.
- [ ] Keep #85 blocked until #84 runtime is landed and exact release evidence is pinned.

## Rollback

Before any deployment, rollback is `git revert` of the additive #84 runtime commits and migration reservation/source. No hosted Durable Object migration is authorized by this plan.

If a future staging migration is separately authorized, prove disposable/staging rollback before production. Never auto-run a production migration.