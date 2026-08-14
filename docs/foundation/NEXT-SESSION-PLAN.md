# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-14
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** B1 sole execution writer only — [#80](https://github.com/Pin4sf/waldo-backend/issues/80); [#81](https://github.com/Pin4sf/waldo-backend/issues/81) is complete, while #87 and #88 remain blocked on their named predecessors

Waldo is one private, user-owned agent account across three primary launch surfaces: Electron Kennel desktop, Waldo mobile with optional Health/Care, and messaging presence. Telegram and Discord are required at launch; WhatsApp remains a primary target whose vendor approval cannot block launch. The backend owns identity, authority, canonical Outcome state, context governance, evidence, verification, acceptance, continuity, and ordered projections. Presences render or propose; providers, executors, connectors, tools, channels, and people contribute bounded observations or effects. None can declare the user's Outcome complete.

The product promise is: **a person can tell Waldo, “Make sure this gets handled,” and trust it to carry the responsibility until the result is verified, accepted, reopened, or consciously released—without taking control away.** Health First is a recommended and differentiated enhancement, never a prerequisite.

## Read in this order

1. [Documentation map](../README.md) — live authority versus reference-only evidence.
2. [Production run contract](./NEXT-BACKEND-SESSION-PROMPT.md) — B0-B6 criteria, dependency map, issue links, falsifiers, and verification wall.
3. [Product and architecture convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md) — current product definition and experience authority.
4. [Product capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md) — whole-product envelope and honest delivery classification.
5. [Architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) — placement, definitive writers, trust boundaries, and invariants.
6. [Contributor onboarding](./CONTRIBUTOR-ONBOARDING.md), [operating workflow](./AGENT-OPERATING-WORKFLOW.md), and [local verification](./LOCAL-DEV-TESTING-PIPELINE.md).
7. Fresh source/tests, the current issue/PR, and accepted ADRs for the exact seam being changed.

Planning text is never shipped proof. Re-pin `origin/main`, inspect the implementation, preserve dirty work, and classify claims as `architecture_specified`, `contract_defined`, `module_implemented`, `adapter_conformance_passed`, `cross_surface_acceptance_passed`, or `operational_proof_passed`.

## Current evidence

Checked 2026-08-14 after the B1 contract/fixture release:

- current repository pin: `origin/main@7067f15`; B0 implementation landed in [PR #119](https://github.com/Pin4sf/waldo-backend/pull/119), test isolation in [PR #121](https://github.com/Pin4sf/waldo-backend/pull/121), and additive v0.4 responsibility contracts/fixtures in [PR #123](https://github.com/Pin4sf/waldo-backend/pull/123);
- canonical Linux Node 22 `pnpm verify`: passed at reviewed release `df0abae`; landed merge `7067f15` has the identical Git tree;
- contracts: 67 files and 1,560 tests passed;
- Supabase: eight migrations applied/reset from zero and 53 pgTAP assertions passed;
- runtime: 38 files and 1,001 tests passed;
- exact-token/session-revocation integration: 2 files and 5 tests passed;
- guards and generated-artifact checks: passed, including v0.1-v0.3 byte preservation and v0.4 generator freshness;
- independent QA breaker, Standards, and Spec reviews: passed at the exact reviewed #81 release SHA.

GitHub Actions was unavailable for the user and Supabase Preview was skipped; neither was counted as green. Two full-wall attempts exposed unrelated runtime-alarm timing flakes that passed in isolation and in the final same-SHA wall. The native macOS Supabase CLI/OrbStack path remained unreliable, so the accepted reproducible wall used the pinned CLI in a clean Linux container with Docker, host networking, and full Git history. This is contract and local repository proof, not runtime-adapter, staging, deployment, or production evidence.

Implemented locally: authenticated owner-routed responsibility ingress, capture/projection v0.1/v0.2, bounded planning v0.3, owner events/projections, one leased/fenced/cancellable zero-tool planning turn, and additive v0.4 contract/fixture families for presence/channel, execution, acceptance-check, judgment-authority, closure, continuity, effect, and Outcome-bound obligation context. A separate trusted RunLoop substrate provides journal/outbox, recovery, scheduling, safety, provider, context, and effect foundations.

Missing or unproved: the WorkUnit-to-trusted-execution bridge; Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry; multi-presence Home/channel gateway; service-first Connections and real reversible effects; governed context, routines, credentials and laptop-off execution; Kennel/mobile/Telegram/Discord acceptance; deletion/restore; staging; and production operations.

## Stable kernel

- One owner maps to one canonical backend authority root.
- One named reducer is the durable writer for each aggregate.
- `WaldoCoordinator` authenticates, authorizes, and sequences; `RunLoopEngine` remains the only physical trusted execution/effect path during additive migration.
- Kennel owns device-local process/workspace durability, never canonical identity, context, Outcome truth, authority, Acceptance, or closure.
- Provider or executor `done` is an observation. Evidence, Verification, Acceptance, Outcome state, and OpenLoop closure are distinct.
- Effects persist frozen intent and digest before I/O; ambiguity reconciles before retry; each call path has one retry owner.
- User statements and corrections outrank inference. Memory is not permission.
- Health-declined users retain the complete core agent product without invented readiness or pressure.
- Ordinary setup exposes one Waldo account, recognizable Connections, plain-language authority, and truthful placement/status—not MCP, CLI, Markdown, repositories, API keys, models, or runtimes.
- Protocol 0.1/v0.2 advertises `offlineCommands: "none"`; disconnected presences show only explicitly stale read-only projections until the accepted offline-draft ADR conflict is reconciled.

## Build order

| Gate | Required result | Issues | Promotion rule |
|---|---|---|---|
| B0 | trustworthy baseline and public route/OpenAPI parity | #107; merged PRs #119 and test-only #121 | complete at landed implementation `c37956a`; reproducibility harness hardened at `182a775` |
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | #81 fixtures released at `df0abae`; #80 is the only next frontier; #87 waits for #80; #88 waits for #80/#87; #86 owns the B3 channel envelope |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | start after B1 contracts/replay proof |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts and credentialed channel staging |
| B5 | context, routines, cloud execution and durable messaging | #92, #94, #110, #114 | require restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Pull requests are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are closed and superseded by merged #119; #117 is closed and superseded by merged #118; test-only #121 and contract release #123 are merged; #98 remains source-pinned #80 decision evidence; #103 is stale contract evidence superseded by #81 for released B1 families and must not merge wholesale; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. Surface teams may consume only released, version-pinned fixtures from #81; real integration waits for the named backend gate.

## Start the next session

1. Read [execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116), [#78](https://github.com/Pin4sf/waldo-backend/issues/78), [#80](https://github.com/Pin4sf/waldo-backend/issues/80), closed [#81](https://github.com/Pin4sf/waldo-backend/issues/81), the [latest ledger handoff](../ledger/2026-08-14-b1-contract-fixture-release.md), PR #98 as source-pinned decision evidence only, and fresh `origin/main`; preserve every unrelated dirty checkout.
2. Create a clean worktree and register `SESSION START` on #80 and #116 with exact runtime/schema/test ownership, current migration lineage, dependencies and consumers, acceptance, falsifier, verification, privacy/authority impact, and rollback.
3. Define the sole-writer run contract and every transaction/I/O failure path before writing. Deepen the existing `PlanningExecutionModule` additively; do not create a sibling execution writer, rename the legacy `runtime_runs` substrate into the target aggregate, or start #87/#88/B2-B6.
4. Consume the released v0.4 execution fixtures without weakening them. Keep provider invocation and execution-environment operation as distinct internal seams. No adapter observation may supply owner authority or imply Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure.
5. Use TDD for v0.3 read compatibility, atomic admission, idempotency/digest conflict, lease/fence/cancellation, expiry/reclaim, replay/late observation, ambiguity, restart, rollback, and content-free public failures. Check live Durable Object migration lineage before allocating any migration.
6. Run focused contracts/runtime/migration proof, the full repository wall at one SHA, QA breaker, Security review for Durable Object writes/authority, and independent Standards/Spec review. Post `SESSION HANDOFF` before promoting #87. Do not deploy or claim live adapter acceptance.

### Copy-ready next-session prompt

> Continue Waldo backend production convergence from fresh `origin/main` after the #81 additive B1 contract/fixture release. The last landed handoff pin is `7067f15a837878eccf28fa5bf897051c6a0847dd`, reviewed release `df0abae1c74c24029556f47ba8b7ed49e83a40b8`, fixture tree `adff7e52da78d5523363a634eef1df8d62b3dffb`; fetch again and record the current SHA before claiming state. Read `AGENTS.md`, `.claude/rules/INDEX.md`, `docs/foundation/NEXT-SESSION-PLAN.md`, `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`, `docs/foundation/EXECUTION-LEDGER.md`, `docs/ledger/2026-08-14-b1-contract-fixture-release.md`, the architecture lock, current source/tests, GitHub issues #116, #78, #80 and closed #81, plus PR #98 as evidence only. Start only #80's additive sole execution-writer convergence; do not start #87, #88, or B2-B6. Create a clean worktree, preserve every unrelated dirty checkout, and post `SESSION START` on #80 and #116 with session/parent ID, owner and agent roster, branch/worktree/base SHA, exact runtime/schema/test ownership, migration-lineage evidence, dependencies/consumers, acceptance, falsifier, verification, privacy/authority impact, and rollback. Before implementation, define the run contract and failure paths for atomic admission, idempotency/digest conflict, lease/fence/cancellation, expiry/reclaim, replay/late observation, ambiguity, restart, rollback and external-I/O separation. Deepen `PlanningExecutionModule` as the sole durable writer while preserving v0.3 reads; do not create a sibling writer or rename legacy `runtime_runs` into target truth. Keep provider and execution-environment seams distinct, consume v0.4 fixtures without weakening them, and never let adapter `done` imply Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure. Use TDD; run focused contract/runtime/migration proof and the full repository wall at one SHA; classify passed, failed, skipped, unavailable, deferred and not-run evidence separately. Run QA breaker, mandatory Security review for Durable Object writes/authority, and independent Standards/Spec review; then post `SESSION HANDOFF` before promoting #87. Do not deploy or claim live adapter or consumer acceptance.

## Retired guidance

The HEY-109 cluster workflow, session-bus skill, completed Gate A/Gate B/capture handoffs, July wave plans, superseded app/health-only plans, and one-off verification logs are retired. Git history preserves tracked files. Do not restore their labels, ownership split, “start now” directions, or parallel sequencing as current authority.

## Verification

Documentation and governance changes:

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
```

Runtime, contracts, migration, or integration changes:

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify
git diff --check
```

Record passed, failed, expired, skipped, unavailable, deferred, and not-run evidence separately. Local/fake proof is not staging, production, adapter-conformance, or product-acceptance proof.
