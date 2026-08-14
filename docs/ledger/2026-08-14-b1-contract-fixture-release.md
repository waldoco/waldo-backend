# B1 Additive Contract/Fixture Release and #80 Frontier Handoff

## Identity

- **Date:** 2026-08-14
- **Implementation session:** `019ffb26-2d7f-75c2-87d9-8a73b660a338`
- **Owner:** Codex primary integration agent; planner/workflow-map input; independent QA breaker, Standards, and Spec reviewers
- **Repository / gate / issue:** `Pin4sf/waldo-backend` / B1 contract boundary / closed [#81](https://github.com/Pin4sf/waldo-backend/issues/81)
- **Base / reviewed head / fixture tree / landed main:** `0a72b07be5fc71221bf17657c20ce04464f41859` / `df0abae1c74c24029556f47ba8b7ed49e83a40b8` / `adff7e52da78d5523363a634eef1df8d62b3dffb` / `7067f15a837878eccf28fa5bf897051c6a0847dd`
- **Branch / retained worktree / PR:** `codex/81-b1-contract-fixtures` / `/Users/shivanshfulper/.codex/worktrees/waldo-backend-81-b1-contract-fixtures` / merged [#123](https://github.com/Pin4sf/waldo-backend/pull/123)
- **Next frontier:** [#80](https://github.com/Pin4sf/waldo-backend/issues/80) only; #87 waits for #80 and #88 waits for #80 plus #87

This handoff supersedes the next-session instructions in the [B0 closure handoff](./2026-08-13-b0-baseline-closure.md). It does not rewrite that historical evidence.

## What Was Built

- Released strict additive v0.4 protocol source, generated JSON Schemas, valid fixtures, named rejection catalogues, manifests, generators, and freshness guards for:
  - presence/channel commands, registrations, inbound envelopes, delivery intents, and settlements;
  - execution requests, attempts, sessions, leases, observations, cancellation, and reconciliation;
  - acceptance-check declaration and verification methods;
  - judgment requests, decisions, authority grants, and delegated-actor binding;
  - candidate Evidence, Verification, Acceptance, Outcome disposition, and OpenLoop closure boundaries;
  - OpenLoop/ReEntry continuity;
  - governed effect intent, receipt, ambiguity, and reconciliation;
  - Outcome-bound owner-stated obligation context.
- Published reusable semantic binders for exact environment/attempt/lease/fence/cancellation/freshness admission and delegated Acceptance authority. Portable JSON Schema validates wire shape; authenticated runtime code must still invoke the semantic binders with trusted time and authority inputs.
- Preserved provider, execution-environment, presence, and channel-adapter identity as distinct categories.
- Preserved every tracked v0.1-v0.3 fixture byte and added a guard that fails on old-fixture drift.
- Added distinct fake desktop, mobile, Telegram, and Discord contract consumers. They prove shared wire conformance only and write no canonical truth.

## What Works (with evidence)

At exact reviewed release SHA `df0abae1c74c24029556f47ba8b7ed49e83a40b8`:

- **Complete canonical wall:** pinned pnpm 10.34.4 under Linux Node 22 — PASS.
- **Contracts:** 67 files / 1,560 tests — PASS.
- **Supabase:** eight migrations applied/reset from zero / 53 pgTAP assertions — PASS.
- **Runtime:** 38 files / 1,001 tests — PASS.
- **Integration:** 2 files / 5 exact-token and session-revocation tests — PASS.
- **Generated artifacts and guards:** v0.4 freshness, v0.1-v0.3 preservation, repository guards, and `git diff --check` — PASS.
- **TDD coverage:** round-trip, strict negative, Ajv Draft 2020-12, freshness, property/adversarial mutation, exact binding, replay/expiry, authority forgery, and fake-consumer conformance — PASS.
- **Independent review:** QA breaker, Standards, and Spec — PASS at the same SHA.
- **Landing:** merge commit `7067f15a837878eccf28fa5bf897051c6a0847dd` has the identical Git tree as the reviewed release. Tree equality preserves the reviewed evidence; it is not represented as a second complete-wall run.

## What Does Not Work Yet

- **General execution writer:** severity CRITICAL; disposition next implementation frontier [#80](https://github.com/Pin4sf/waldo-backend/issues/80); owner next fresh backend session; dependency #81 is satisfied. Released contracts are not bound to a generalized durable runtime aggregate.
- **Execution-environment port and fake adapters:** severity HIGH; disposition blocked [#87](https://github.com/Pin4sf/waldo-backend/issues/87); owner later B1 session; dependency #80 remains unmet.
- **Public WorkUnit-to-trusted-execution bridge:** severity HIGH; disposition blocked barrier [#88](https://github.com/Pin4sf/waldo-backend/issues/88); owner later B1 integration session; dependencies #80 and #87 remain unmet.
- **Evidence/Verification/Acceptance/OpenLoop runtime:** severity CRITICAL; disposition B2 issues #82/#84/#85 after B1; the v0.4 closure fixtures do not implement their reducers.
- **Live consumers and operations:** severity CRITICAL; disposition later named gates; no real Kennel/mobile/Telegram/Discord consumer, staging, deployment, deletion/restore, or production operation was run or accepted.
- **Automated external checks:** severity MEDIUM; GitHub Actions was unavailable and Supabase Preview was skipped. Neither was counted green.
- **Native verification path:** severity MEDIUM; native macOS Supabase reset remains unreliable. The accepted wall used the reproducible Linux/Docker host-network path.

## Architecture Decisions or Conflicts

- `PlanningExecutionModule` is the existing sole writer for planning execution tables and must deepen additively toward the locked `RunLoopEngine` responsibility. Do not introduce a sibling Kennel or cloud execution writer.
- Provider invocation and execution-environment operation are separate seams behind one durable lifecycle. A provider model and Kennel are not interchangeable adapters.
- `runtime_runs` is a legacy runtime substrate, not a name-compatible target aggregate. Do not rename or promote it without explicit preservation semantics.
- External I/O stays outside the Durable Object SQLite transaction. The durable writer persists intent/lease state first, then admits bounded observations in a later transaction.
- Provider, executor, channel, session, delivery, or effect `done` is observation only. It cannot imply Evidence admission, Verification, Acceptance, Outcome completion, or OpenLoop closure.
- No released contract grants authority or carries credentials, raw health, full transcripts, composed prompts, or inline evidence payloads.
- The Supabase-versus-Cloudflare-D1 question is deliberately deferred. No storage/auth migration was decided or implemented, and #80 must not mix that architecture choice into execution-writer convergence.
- [PR #98](https://github.com/Pin4sf/waldo-backend/pull/98) remains source-pinned decision evidence only. Re-check it against current source and the released v0.4 contracts; do not merge its stale branch as implementation authority.

## Parallel Agent and Worktree Ledger

| Lane | Role | Result | Disposition |
|---|---|---|---|
| Root implementation session | single writer, integration, verification, GitHub release | adopted; PR #123 merged | clean branch/worktree retained |
| Planner / workflow mapper | dependency order and failure-path proposal | source-checked and adopted selectively | read-only, complete |
| QA breaker | adversarial schema/authority/freshness attacks | initial findings fixed; final PASS | read-only, complete |
| Standards reviewer | repository standards and tooling safety | initial findings fixed; final PASS | read-only, complete |
| Spec reviewer | #81 acceptance/scope conformance | final PASS | read-only, complete |

Every unrelated dirty checkout was preserved. No deployment, hosted database, live adapter, or external product state was changed.

## Hard-Won Lessons

- A Zod rejection does not prove the generated JSON Schema rejects the same payload. Portable-schema negatives must execute through Ajv.
- Exact authority binding includes the delegated actor, not only the owner and policy revision.
- Exact execution-environment binding includes category, kind, version, manifest identity, and digest; matching only ID/version is unsafe.
- Freshness admission must bind lease request to attempt request and prove `acquiredAt <= observedAt <= receivedAt < expiresAt` with monotonic observation sequence.
- Fake consumers must be distinct producers/consumers, not the same object reparsed under four labels.
- Freshness helpers and command runners are attack surfaces: validate family allowlists and avoid shell-enabled spawning.
- Review findings remain open until the exact corrected SHA is rechecked. A previous PASS cannot be carried across source changes by assertion.

## Next-Session Prerequisites

1. Fetch fresh `origin/main`; read #116, #78, #80, closed #81, this handoff, the architecture lock, current source/tests, and PR #98 as evidence only.
2. Create a clean worktree and register `SESSION START` on #80 and #116. Claim exact runtime/schema/test files only after checking current ownership and migration lineage.
3. Define the #80 run contract before implementation:
   - **Current:** `PlanningExecutionModule` durably owns v0.3 planning request/session/lease state; v0.4 execution contracts are released but not runtime-bound.
   - **Ideal:** one additive durable writer owns ExecutionRequest/Attempt/Session/Lease truth while preserving v0.3 reads and keeping provider/environment I/O outside transactions.
   - **Falsifier:** a second writer appears, old rows become unreadable, an adapter supplies owner authority, a stale fence/generation settles, or external `done` changes Outcome/Acceptance/closure.
4. Inspect before claiming the likely seams: `planning-execution-module.ts`, `waldo-coordinator.ts`, `run-loop/do.ts`, `do-schema.ts`, migration reservations/history, existing planning authorization tests, and the released v0.4 execution contracts/fixtures. Do not assume PR #98 line numbers or schema conclusions remain current.
5. Use TDD for v0.3 compatibility, atomic admission, duplicate/digest conflict, exact revision and authority binding, lease/fence/cancellation, expiry/reclaim, replay/late observation, ambiguity, restart/eviction, transaction rollback, and bounded public errors.
6. If a schema migration is necessary, appoint one migration captain, inspect live allocation history before choosing a number, preserve rows/digests, and prove rollback/fail-closed downgrade. Do not modify historical migrations.
7. Run focused contract/runtime/migration tests, the full repository wall at one SHA, QA breaker, mandatory Security review for Durable Object writes/authority, and independent Standards/Spec review. Post handoff before promoting #87.
8. Do not start #87, #88, B2-B6, the D1/Supabase decision, deployment, or live adapter acceptance in the #80 lane.

## Files Changed

The exhaustive release diff is [PR #123](https://github.com/Pin4sf/waldo-backend/pull/123). Its owned source surfaces are:

- `packages/contracts/src/index.ts`
- `packages/contracts/src/protocol/responsibility-protocol-v0-4.ts` and test
- `packages/contracts/src/protocol/responsibility-{presence-channel,execution,acceptance-check,judgment-authority,closure,continuity,effect,obligation-context}-v0-4.ts`
- matching `-fixtures.ts` and `.test.ts` files for all eight families
- `packages/contracts/fixtures/responsibility-*/v0.4/` generated schemas, valid/rejection fixtures, and manifests for those families
- `scripts/generate-responsibility-*-v0-4.mjs` and matching generator tests
- `scripts/guards/run-responsibility-v0-4-fresh-guard.js`, shared freshness support, per-family guard/test wrappers, and the v0.1-v0.3 preservation guard
- root `package.json` release/guard wiring

This documentation closeout changes only the maintained foundation entrypoints, current evidence pins, execution-ledger index, and this handoff.
