# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-13
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** B1 contract release only — [#81](https://github.com/Pin4sf/waldo-backend/issues/81); downstream runtime writers remain blocked until its fixtures land

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

Checked 2026-08-13 after B0 closure and verification-harness cleanup:

- current repository pin: `origin/main@182a775`; B0 implementation landed in [PR #119](https://github.com/Pin4sf/waldo-backend/pull/119) at `c37956a`, followed by the test-only alarm-isolation repair in [PR #121](https://github.com/Pin4sf/waldo-backend/pull/121);
- fresh detached-checkout `pnpm verify`: passed at the exact landed SHA;
- contracts: 58 files and 1,476 tests passed;
- Supabase: eight migrations applied/reset from zero and 53 pgTAP assertions passed;
- runtime: 38 files and 1,001 tests passed;
- exact-token/session-revocation integration: 2 files and 5 tests passed;
- guards and generated-artifact checks: passed, including self-tests and non-vacuous route-manifest mutation proof;
- independent QA breaker, Security, Standards, and Spec reviews: passed on the reviewed PR head before merge.

GitHub Actions was unavailable for the user and Supabase Preview was skipped; neither was counted as green. The native macOS Supabase CLI/OrbStack path remained unreliable, so the accepted reproducible local wall used the pinned CLI in a clean Linux container with Docker, host networking, and full Git history. This is baseline proof, not staging or production evidence.

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
| B0 | trustworthy baseline and public route/OpenAPI parity | #107; merged PRs #119 and test-only #121 | complete at landed implementation `c37956a`; reproducibility harness hardened at `182a775` |
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | only #81 is ready now; #80/#87/#88 wait for its released fixtures; #86 owns the B3 channel envelope |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | start after B1 contracts/replay proof |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts and credentialed channel staging |
| B5 | context, routines, cloud execution and durable messaging | #92, #94, #110, #114 | require restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Pull requests are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are closed and superseded by merged #119; #117 is closed and superseded by merged #118; test-only #121 is merged; #98/#103 inform B1/B2 but are not merge authority; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. Surface teams may consume only released, version-pinned fixtures from #81; real integration waits for the named backend gate.

## Start the next session

1. Read [execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116), [#81](https://github.com/Pin4sf/waldo-backend/issues/81), the latest ledger handoff, and fresh `origin/main`; preserve every unrelated dirty checkout.
2. Create a clean worktree and register `SESSION START` on #81 with the exact contract/generator files, source pin, dependency consumers, acceptance, falsifier, verification, privacy/authority impact, and rollback.
3. Define the B1 contract-release run contract before writing. Publish additive version-pinned fixtures in #81's declared order; do not bind runtime writers or begin #80/#87/#88 in the same lane.
4. Preserve distinct provider, execution-environment, presence, and channel adapter references. No contract may grant authority, carry credentials/raw health/full transcripts/composed prompts, or map external `done` to product completion.
5. Use TDD plus contract/freshness/property/adversarial checks, then run the full repository wall at one SHA and breaker plus independent Standards/Spec review.
6. Post `SESSION HANDOFF` and release the exact fixture SHA before promoting the next named B1 dependency. Do not start B2-B6.

### Copy-ready next-session prompt

> Continue Waldo backend production convergence from fresh `origin/main` after B0 closure. The last pre-handoff source pin was `182a775` (`c37956a` B0 implementation plus the #121 test-isolation follow-up), but fetch and record the new current SHA before claiming state. Read `AGENTS.md`, `.claude/rules/INDEX.md`, `docs/foundation/NEXT-SESSION-PLAN.md`, `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`, `docs/foundation/EXECUTION-LEDGER.md`, the latest `docs/ledger/` handoff, and GitHub issues #116, #78, and #81. Start only #81's additive B1 contract/fixture release; do not start #80, #87, #88, or B2-B6. Before writing, create a clean worktree, preserve every unrelated dirty checkout, and post `SESSION START` on #81 with session/parent ID, owner and agent/subagent roster, branch/worktree/base SHA, exact contract/generator file ownership, dependencies and consumers, acceptance, falsifier, verification, privacy/authority impact, and rollback. Define the contract-release run contract and failure paths before implementation. Keep provider, execution-environment, presence, and channel adapter categories distinct; preserve old v0.1-v0.3 fixtures; publish strict additive fixtures with negative and freshness tests; and never let external `done` imply Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure. Run contracts, property/adversarial tests, guards, generated-artifact checks, and the full repository wall at one SHA; classify passed, failed, skipped, unavailable, deferred, and not-run evidence separately. Run breaker plus independent Standards and Spec review, then post `SESSION HANDOFF` with commits, PR, released fixture SHA, residual risks, next owner, and worktree disposition. Do not deploy or claim live consumer acceptance.

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
