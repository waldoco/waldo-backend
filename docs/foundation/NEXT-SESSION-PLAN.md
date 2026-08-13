# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-13
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** B0 only — [#107](https://github.com/Pin4sf/waldo-backend/issues/107), with PRs #99 and #100 reviewed against fresh main

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

Checked 2026-08-13:

- repository documentation pin: `origin/main@51da2d1`;
- newest product-code pin represented by the convergence: `dd434e9`;
- contracts: 58 files and 1,475 tests passed;
- guards: passed, including self-tests;
- runtime: 37 files passed and 1 failed; 994 tests passed and 7 failed because two authorization fixtures expired on 2026-08-08;
- Docker/Supabase: unavailable at the local OrbStack socket, so the full repository wall and Supabase integration are not proved.

Implemented locally: authenticated owner-routed responsibility ingress, capture/projection v0.1/v0.2, bounded planning v0.3, owner events/projections, and one leased/fenced/cancellable zero-tool planning turn. A separate trusted RunLoop substrate provides journal/outbox, recovery, scheduling, safety, provider, context, and effect foundations.

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
| B0 | trustworthy baseline and public route/OpenAPI parity | #107; PRs #99, #100 | only B0 is active now |
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | start #81 after B0 proof; #86 owns the B3 channel envelope |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | start after B1 contracts/replay proof |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts and credentialed channel staging |
| B5 | context, routines, cloud execution and durable messaging | #92, #94, #110, #114 | require restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Open PRs are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are B0 candidates; #98/#103 inform B1/B2; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. During B0, Kennel may prepare its contract client shell and mobile may resolve its canonical lineage; real integration waits for the named backend fixture gate.

## Start the next session

1. Read [execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116), register `SESSION START` on #107, preserve unrelated dirty checkouts, and create a clean worktree from fresh `origin/main` for B0 implementation.
2. Read issue #107 and inspect PRs #99 and #100 against the actual source and current CI. Do not merge from tracker prose alone.
3. Define the B0 run contract and failure paths, then repair the time-relative fixture, migration-lineage guard, and public Worker/OpenAPI parity as separate reviewable changes.
4. Run contracts, runtime, Supabase integration, guards, generated-artifact checks, and the full repository wall at one SHA. Classify unavailable/skipped evidence explicitly.
5. Run breaker plus independent Standards and Spec review. Close B0 only when another clean checkout can reproduce the evidence.
6. Promote #81—and no other B1 issue—after B0 closes.

### Copy-ready next-session prompt

> Continue Waldo backend production convergence from the current `origin/main`. Read `AGENTS.md`, `.claude/rules/INDEX.md`, `docs/foundation/NEXT-SESSION-PLAN.md`, `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`, `docs/foundation/EXECUTION-LEDGER.md`, the latest `docs/ledger/` handoff, GitHub issues #116, #78, and #107, then inspect PRs #99 and #100 against fresh source and CI. Start only B0. Before writing, create a clean worktree, preserve every unrelated dirty checkout, and post `SESSION START` on #107 with session/parent ID, owner and agent/subagent roster, branch/worktree/base SHA, exact file ownership, dependencies, acceptance, falsifier, verification, and rollback. Define the B0 run contract and failure paths before implementation. Repair the time-relative authorization fixture, migration-lineage guard, and public Worker/OpenAPI route parity as separate reviewable changes. Run contracts, runtime, Supabase integration, guards, generated-artifact checks, and the full repository wall at one SHA; classify passed, failed, skipped, unavailable, deferred, and not-run evidence separately. Run breaker plus independent Standards and Spec review. Post `SESSION HANDOFF` with commits, PR, evidence, residual risks, next owner, and worktree disposition. Close B0 only when another clean checkout can reproduce the evidence, then promote #81 and no other B1 issue. Do not start B1-B6, merge from tracker prose, deploy, fabricate Docker/Supabase proof, or let provider completion imply Outcome completion.

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
