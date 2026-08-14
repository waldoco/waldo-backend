# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-14
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** converge B1 sole execution writer [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) for [#80](https://github.com/Pin4sf/waldo-backend/issues/80); do not promote #87 until #80 is merged with a published runtime SHA, and keep #88 blocked on #80 plus #87

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

Checked 2026-08-14 during #80 convergence:

- current repository pin: `origin/main@cd96cbd`; B0 implementation landed in [PR #119](https://github.com/Pin4sf/waldo-backend/pull/119), test isolation in [PR #121](https://github.com/Pin4sf/waldo-backend/pull/121), additive v0.4 responsibility contracts/fixtures in [PR #123](https://github.com/Pin4sf/waldo-backend/pull/123), and their handoff in [PR #124](https://github.com/Pin4sf/waldo-backend/pull/124);
- #80 implementation is under review in [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) at reviewed runtime SHA `1ec8120`; it is not landed or deployed;
- canonical Linux Node 22 `pnpm verify`: passed at reviewed release `df0abae`; landed merge `7067f15` has the identical Git tree;
- contracts: 67 files and 1,560 tests passed;
- Supabase: eight migrations applied/reset from zero and 53 pgTAP assertions passed;
- runtime: 38 files and 1,001 tests passed;
- exact-token/session-revocation integration: 2 files and 5 tests passed;
- guards and generated-artifact checks: passed, including v0.1-v0.3 byte preservation and v0.4 generator freshness;
- #80 focused evidence at `1ec8120`: 39 runtime files / 1,030 tests, both runtime typechecks, all migration/repository guards, and independent QA breaker, Security, Standards, and Spec reviews passed; the complete final PR-head repository wall remains a convergence gate until recorded in PR #125 and #116.

GitHub Actions was unavailable for the user and Supabase Preview was skipped; neither was counted as green. Two full-wall attempts exposed unrelated runtime-alarm timing flakes that passed in isolation and in the final same-SHA wall. The native macOS Supabase CLI/OrbStack path remained unreliable, so the accepted reproducible wall used the pinned CLI in a clean Linux container with Docker, host networking, and full Git history. This is contract and local repository proof, not runtime-adapter, staging, deployment, or production evidence.

Implemented on the unmerged #80 branch: authenticated owner-routed responsibility ingress, capture/projection v0.1/v0.2, bounded planning v0.3, owner events/projections, additive v0.4 contract/fixture families, and one generalized durable v0.4 execution writer for request, Attempt, Session, Lease, Observation, cancellation, and reconciliation state. The writer derives owner and product bindings from canonical state, preserves v0.3 reads, and keeps provider and execution-environment operations distinct. A separate trusted RunLoop substrate provides journal/outbox, recovery, scheduling, safety, provider, context, and effect foundations.

Missing or unproved: landing #80; the #87 execution-environment port/fake adapters; the #88 public WorkUnit-to-trusted-execution bridge; Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry; multi-presence Home/channel gateway; service-first Connections and real reversible effects; governed context, routines, credentials and laptop-off execution; Kennel/mobile/Telegram/Discord acceptance; deletion/restore; staging; and production operations.

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
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | #81 fixtures released at `df0abae`; #80 implementation is in PR #125 and must merge before #87 is promoted; #88 waits for #80/#87; #86 owns the B3 channel envelope |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | start after B1 contracts/replay proof |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts and credentialed channel staging |
| B5 | context, routines, cloud execution and durable messaging | #92, #94, #110, #114 | require restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Pull requests are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are closed and superseded by merged #119; #117 is closed and superseded by merged #118; test-only #121 and contract release #123 are merged; #98 remains source-pinned #80 decision evidence; #103 is stale contract evidence superseded by #81 for released B1 families and must not merge wholesale; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. Surface teams may consume only released, version-pinned fixtures from #81; real integration waits for the named backend gate.

## Start the next session

1. Read [execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116), [#78](https://github.com/Pin4sf/waldo-backend/issues/78), [#80](https://github.com/Pin4sf/waldo-backend/issues/80), [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125), closed [#81](https://github.com/Pin4sf/waldo-backend/issues/81), and the [latest ledger handoff](../ledger/2026-08-14-b1-sole-execution-writer.md); fetch fresh `origin/main` and preserve every unrelated dirty checkout.
2. Converge only #80: resolve any current review or verification failure at the exact PR head, rerun the complete wall, and merge only when #80 acceptance and all review gates pass. Do not add #87 adapter code to PR #125.
3. Publish the landed #80 runtime SHA and `SESSION HANDOFF` on #80 and #116. Keep #87 blocked until that release evidence exists; #88 remains blocked until both #80 and #87 land.
4. Only after #80 is released may a fresh session promote and start #87's execution-environment port and fake-adapter conformance. It must consume the released #81 contracts and #80 writer without bypassing `WaldoCoordinator` or exposing trusted `*InCurrentTransaction` methods.
5. Do not start #88, B2-B6, the Supabase/D1 decision, deployment, staging, or live consumer acceptance in the #80 convergence lane.

### Copy-ready next-session prompt

> Continue Waldo backend production convergence from fresh `origin/main`. Read `AGENTS.md`, `.claude/rules/INDEX.md`, the foundation entrypoints, `docs/ledger/2026-08-14-b1-sole-execution-writer.md`, GitHub issues #116/#78/#80, and PR #125. Converge only #80's sole v0.4 execution writer: preserve v0.3 reads, canonical owner/product authority, one request/Attempt/Session/Lease writer, distinct provider/environment seams, cancellation and reconciliation fences, and the boundary that execution terminality cannot imply Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure. Resolve any live PR finding with TDD, run the complete repository wall and QA/Security/Standards/Spec rechecks at the corrected SHA, then merge only when acceptance passes. Publish the landed runtime SHA on #80 and #116 before promoting #87. Do not add #87/#88/B2-B6 code, decide Supabase versus D1, deploy, or claim live adapter/consumer acceptance in this lane.

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
