# B1 Sole Execution Writer and #80 Convergence Handoff

## Identity

- **Date:** 2026-08-14
- **Owner / agents:** Codex primary integration agent; planner and workflow mapper; independent QA breaker, Security, Standards, and Spec reviewers
- **Repository / gate / issue:** `Pin4sf/waldo-backend` / B1 runtime writer / [#80](https://github.com/Pin4sf/waldo-backend/issues/80)
- **Base / reviewed implementation head:** `cd96cbd643dccb8450438531b27c8374ab729dd5` / `1ec812076079b362154b1b0de83c24d3efd45826`
- **Branch / worktree / PR:** `codex/80-sole-execution-writer` / `/Users/shivanshfulper/.codex/worktrees/waldo-backend-80-sole-execution-writer` / [#125](https://github.com/Pin4sf/waldo-backend/pull/125)
- **Released dependency:** #81 contracts at `df0abae1c74c24029556f47ba8b7ed49e83a40b8`, fixture tree `adff7e52da78d5523363a634eef1df8d62b3dffb`
- **Next frontier rule:** #87 remains blocked until #80 merges and its landed runtime SHA is published; #88 remains blocked on both #80 and #87

This handoff supersedes only the next-session directions in the [#81 release handoff](./2026-08-14-b1-contract-fixture-release.md). It preserves that release's contract and fixture evidence.

## What Was Built

- Deepened `PlanningExecutionModule` in place as the sole durable v0.4 writer for ExecutionRequest, Attempt, Session, Lease, executor Observation, cancellation, and reconciliation state.
- Added collision-reserved Durable Object migration v6. It generalizes the existing planning request/session/lease tables in place, adds Attempt/Observation/Reconciliation tables, preserves provider invocation as a separate ledger, leaves `runtime_runs` unchanged, and fails downgrade closed after v0.4 state exists.
- Preserved all v0.3 rows, stored result bytes, and read paths. No v0.1-v0.4 contract or fixture source changed.
- Bound admission to current canonical owner authority, Outcome and WorkUnit identity/revision/relationship/authority ceiling, and server-derived reference digests. Client or adapter values cannot self-sign canonical product binding.
- Enforced one active claim, coherent request/session/lease/attempt chronology, fence and cancellation generation matching, expiry before retry, exact observation replay, monotonic freshness, trusted receipt/check times, and restart-safe reconciliation.
- Made cancellation globally idempotent by command ID, conflict-safe across requests, current-presence authorized, and retry-history preserving. Old-generation reconciliation cannot override cancellation.
- Kept provider invocation and execution-environment operations as distinct categories and ledgers. All external I/O remains outside SQLite transactions.
- Kept execution truth separate from product truth: terminal execution can change only request/Attempt/Session state and cannot admit Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure.

## What Works (with evidence)

At exact clean implementation SHA `1ec812076079b362154b1b0de83c24d3efd45826`:

- **Contracts:** 67 files / 1,560 tests — PASS.
- **Runtime:** 39 files / 1,030 tests — PASS.
- **Runtime typecheck:** Worker and integration configurations — PASS.
- **Migration and repository guards:** six reserved migrations, v0.4 generated freshness, old-fixture preservation, OpenAPI, package manager, runtime placement, and guard self-tests — PASS.
- **TDD/adversarial coverage:** v0.3 round trip, atomic rollback, exact idempotency/digest conflict, forged owner/product binding, lease/fence/cancellation freshness, retry/cancel history, replay/late observation, timeout ambiguity, restart reconstruction, fail-closed downgrade, property sequences, and fake-consumer reconstruction — PASS.
- **QA breaker:** PASS; prior authority, stale-cancellation, global cancel replay, canonical digest, and retry-history exploits were fixed and rechecked.
- **Standards:** PASS with no actionable finding.
- **Spec:** PASS; no #87/#88/B2-B6 scope entered.
- **Security:** PASS; prior caller-forged authority and stale-cancellation findings are closed, with no credential, health, transcript, prompt, inline-evidence, cross-product-write, unsafe-downgrade, or transaction/I/O finding remaining.
- **Complete repository wall:** Linux Node 22 `pnpm verify` with pinned pnpm 10.34.4 and Supabase CLI 2.109.1 — PASS at documentation head `01e1786adeafb300cbaa7e3ae3d929541d096deb`; workspace typechecks, contracts, Supabase reset/pgTAP/history, runtime, exact-token integration, and guards all passed.
- **Native host attempt:** macOS/OrbStack `supabase start` — FAILED before verification while applying the unchanged first migration because `public.users` already existed. It is classified as environment failure and was neither hidden nor counted green; no migration source was changed.

This is `module_implemented` local repository evidence. It is not adapter conformance, cross-surface acceptance, staging, deployment, production, or live-consumer proof.

## What Does Not Work Yet

- **#80 is not landed:** severity HIGH; disposition converge [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125), confirm the documentation-only final delta and exact-head wall, then merge; owner next #80 convergence session if this session ends first.
- **Execution-environment port and fake adapters:** severity HIGH; disposition blocked [#87](https://github.com/Pin4sf/waldo-backend/issues/87); dependency landed #80 runtime SHA.
- **Public WorkUnit-to-trusted-execution bridge:** severity HIGH; disposition blocked [#88](https://github.com/Pin4sf/waldo-backend/issues/88); dependencies landed #80 and #87.
- **Evidence/Verification/Acceptance/OpenLoop runtime:** severity CRITICAL; disposition B2 issues #82/#84/#85 after the B1 gate. Execution settlement is not product closure.
- **Live consumers and operations:** severity CRITICAL; disposition later named gates. No real Kennel/mobile/Telegram/Discord consumer, staging environment, deployment, deletion/restore, or production operation was run or accepted.
- **Supabase versus Cloudflare D1:** severity MEDIUM architectural question; disposition explicitly deferred. #80 changes per-owner Durable Object SQLite only and does not decide or migrate the separate Supabase-backed surfaces.
- **External automation:** GitHub Actions and Supabase Preview are not counted green unless independently observed and recorded.

## Architecture Decisions or Conflicts

- `PlanningExecutionModule` deepens the existing writer instead of creating parallel canonical request/session/lease tables. `WaldoCoordinator` remains the trusted boundary that derives authority and digests before entering synchronous SQLite transactions.
- `*InCurrentTransaction` methods are internal trusted seams. Future #87/#88 routes or adapters must not expose or bypass them.
- Canonical reference digest material relies on the product writer's revision discipline: any bound Outcome or WorkUnit meaning change must advance its canonical revision.
- Provider and execution-environment identities, manifests, operations, and observations remain distinct. A model/provider receipt cannot be treated as an executor observation.
- Timed-out or disconnected execution is indeterminate until reconciliation. It is never rewritten as decisive failure merely to unlock a retry.
- Cancellation dominates stale observations and reconciliations. Only a current-generation cancellation acknowledgement may settle a cancelling attempt.
- No new state grants authority or stores credentials, raw health, full transcripts, composed prompts, or inline evidence payloads.
- PR #98 remains source-pinned decision evidence only; PR #125 is the implementation convergence barrier.

## Parallel Agent and Worktree Ledger

| Lane | Role | Result | Disposition |
|---|---|---|---|
| Root implementation | run contract, TDD, integration, verification, PR and handoff | adopted | branch/worktree retained through PR convergence |
| Planner / workflow mapper | existing flow, failure paths, final security review | recommendations adopted selectively; exact-SHA Security PASS | read-only, complete |
| QA breaker | adversarial lifecycle/authority/replay review | findings fixed; exact-SHA PASS | read-only, complete |
| Standards reviewer | repository standards and maintainability | exact-SHA PASS | read-only, complete |
| Spec reviewer | #80 acceptance and scope | exact-SHA PASS | read-only, complete |

Every unrelated checkout was preserved. No deployment, hosted database, live adapter, or external product state was changed.

## Hard-Won Lessons

- Comparing a request with a caller-supplied “trusted” binding is not authority. Canonical owner, presence, Outcome, and WorkUnit state must be read from the trusted store and revalidated inside the transaction.
- Exact product reference binding needs a server-derived digest, not only matching IDs and revisions supplied by the same caller.
- Cancellation is a generation transition across the active request, Attempt, Lease, and Session. Updating every historical lease corrupts retry reconstruction; updating only the request permits stale settlement to win.
- Idempotency keys are command identities, not target-row fields. Reusing one cancellation ID against another request must conflict globally.
- Reconciliation is a state machine, not a ceremonial receipt. It must bind current generation, attempt/lease state, known observation basis, trusted time, terminal monotonicity, and Session closure.
- Complete walls and review verdicts are SHA-bound. Documentation-only closeout changes still require final diff/guard verification and an exact PR-head evidence comment.

## Next-Session Prerequisites

1. Fetch fresh `origin/main`; read #116, #78, #80, PR #125, this handoff, and current review/check state. Preserve unrelated dirty checkouts.
2. Continue only #80 convergence. If PR #125 changes, rerun affected focused tests, the complete repository wall, QA, Security, Standards, and Spec at the corrected head.
3. Merge only after exact-head acceptance passes. Publish the landed #80 runtime SHA and worktree disposition on #80 and #116.
4. Only after that publication may #87 be promoted and claimed in a new worktree. Its adapters must enter through `WaldoCoordinator`, consume the released #81 fixtures, and treat observations as untrusted execution facts.
5. Do not add #87 or #88 code to PR #125. Do not start B2-B6, decide Supabase versus D1, deploy, or claim live consumer acceptance.

## Files Changed

- `packages/runtime/src/coordinator/planning-execution-module.ts`
- `packages/runtime/src/coordinator/waldo-coordinator.ts`
- `packages/runtime/src/do-schema.ts`
- `packages/runtime/do-migration-reservations.json`
- `packages/runtime/test/do-schema.test.ts`
- `packages/runtime/test/execution-writer-v0-4.test.ts`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`
- `docs/foundation/EXECUTION-LEDGER.md`
- `docs/ledger/2026-08-14-b1-sole-execution-writer.md`
