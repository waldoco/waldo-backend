# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-14
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** review [PR #128](https://github.com/Pin4sf/waldo-backend/pull/128) for [#88](https://github.com/Pin4sf/waldo-backend/issues/88) at its exact head; do not merge, close #88, promote B2-B6, add real adapters, deploy, or claim live acceptance without explicit authorization

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

Checked 2026-08-14 on #88 review branch `codex/88-workunit-execution-bridge`, based on `origin/main@4e1695c`:

- landed implementation pin: `origin/main@4e1695c`; B0 implementation landed in [PR #119](https://github.com/Pin4sf/waldo-backend/pull/119), test isolation in [PR #121](https://github.com/Pin4sf/waldo-backend/pull/121), additive v0.4 responsibility contracts/fixtures in [PR #123](https://github.com/Pin4sf/waldo-backend/pull/123), #80's sole writer in [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125), #87's execution-environment boundary in [PR #126](https://github.com/Pin4sf/waldo-backend/pull/126), and the #88 frontier handoff in [PR #127](https://github.com/Pin4sf/waldo-backend/pull/127);
- #80 is closed and [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) is merged at `cffae3b`; reviewed runtime implementation `eebe931` and landed `origin/main` have the identical tree `43aa5b9`;
- canonical Linux Node 22 `pnpm verify`: passed at reviewed release `df0abae`; landed merge `7067f15` has the identical Git tree;
- contracts: 67 files and 1,560 tests passed;
- Supabase: eight migrations applied/reset from zero and 53 pgTAP assertions passed;
- runtime: 38 files and 1,001 tests passed;
- exact-token/session-revocation integration: 2 files and 5 tests passed;
- guards and generated-artifact checks: passed, including v0.1-v0.3 byte preservation and v0.4 generator freshness;
- #80 exact-SHA evidence at `eebe931`: 67 contract files / 1,560 tests, eight Supabase migrations from zero/reset / 53 pgTAP assertions, 39 runtime files / 1,038 tests, 2 integration files / 5 tests, both runtime typechecks, all migration/repository guards, and independent QA breaker, Security, Standards, and Spec reviews passed;
- #87 is closed and PR #126 is merged as `9a2b11b`; reviewed head `5b3d9f5` and landed merge have the identical tree `8a202c5`. Its backend contract/fake boundary passed 4 focused files / 54 tests, 42 runtime files / 1,060 tests, both runtime typechecks, the complete clean Linux/Docker wall, and independent QA, Security, Standards, and Spec review. No contract, fixture, migration, dependency, root-export, or sole-writer change was introduced.
- #88 is implemented for review in PR #128. The start-only path adds one strict v0.4 public route, derives all execution authority server-side, commits through #80, reconstructs private start intent from the immutable request, performs #87 recovery/I/O after commit, and admits the bounded observation through the public Coordinator. Digest-conflict correction `27ed9e8` passed 4 focused runtime files / 86 tests, 42 runtime files / 1,066 tests, both runtime typechecks, and independent QA/Security re-review. Final exact-SHA Standards/Spec and clean-wall evidence live on #88/#116/PR #128.

GitHub Actions was unavailable for the user and Supabase Preview was skipped; neither was counted as green. Native macOS `supabase start` again failed while applying the unchanged first migration because `public.users` already existed; that host attempt is failed environment evidence, not a source failure or green result. The reproducible Linux/Docker host-network path passed with pinned Node, pnpm, Supabase CLI, a clean clone, and full Git history. This is contract and local repository proof, not runtime-adapter, staging, deployment, or production evidence.

Implemented on landed `origin/main`: authenticated owner-routed responsibility ingress, capture/projection v0.1/v0.2, bounded planning v0.3, owner events/projections, additive v0.4 contract/fixture families, and one generalized durable v0.4 execution writer for request, Attempt, Session, Lease, Observation, cancellation, and reconciliation state. The writer derives owner and product bindings from canonical state, preserves v0.3 reads, and keeps provider and execution-environment operations distinct. A separate trusted RunLoop substrate provides journal/outbox, recovery, scheduling, safety, provider, context, and effect foundations.

Missing or unproved: authorized merge of #88; resume/steer/pause intent durability; upgrade of a WorkUnit already claimed by the legacy v0.3 planning row; every real execution-environment adapter and live acceptance; Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry; multi-presence Home/channel gateway; service-first Connections and real reversible effects; governed context, routines, credentials and laptop-off execution; Kennel/mobile/Telegram/Discord acceptance; deletion/restore; staging; and production operations.

## Stable kernel

- One owner maps to one canonical backend authority root.
- One named reducer is the durable writer for each aggregate.
- `WaldoCoordinator` authenticates, authorizes, and sequences; the existing `RunLoopDO`/RunLoopEngine remains the only trusted composition and physical execution/effect path during additive migration. #87 is a seam within that path, not a sibling engine.
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
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | #81 fixtures released at `df0abae`; #80 landed at `cffae3b`; #87 landed at `9a2b11b`; #88 is review-ready in PR #128 but unmerged; B1 is not promoted until authorized merge and landed-tree verification; #86 owns the B3 channel envelope |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | start after B1 contracts/replay proof |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts and credentialed channel staging |
| B5 | context, routines, cloud execution and durable messaging | #92, #94, #110, #114 | require restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Pull requests are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are closed and superseded by merged #119; #117 is closed and superseded by merged #118; test-only #121 and contract release #123 are merged; #98 remains source-pinned #80 decision evidence; #103 is stale contract evidence superseded by #81 for released B1 families and must not merge wholesale; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. Surface teams may consume only released, version-pinned fixtures from #81; real integration waits for the named backend gate.

## Start the next session

1. Review PR #128 against base `4e1695c`, the [review handoff](../ledger/2026-08-14-b1-workunit-execution-bridge-review.md), and live #88/#116 evidence. Confirm the reviewed head, clean worktree, mergeability, checks, exact-SHA QA/Security/Standards/Spec verdicts, and complete verification classifications.
2. Verify the strict additive public route, full-command digest idempotency, canonical state rereads, #80 sole-writer boundary, immutable start-intent reconstruction, commit-before-I/O ordering, #87 recover-before-execute, and non-self-certifying public result. Confirm released #81 bytes and schema/migration history remain unchanged.
3. Treat resume/steer/pause and execution of a WorkUnit already claimed by v0.3 planning as architecture stops. If either is requested, post `NEEDS DIRECTION` with source evidence before adding a writer, migration, schema, or row-upgrade rule.
4. Do not merge or close #88 without explicit human authorization. If authorized, verify the landed tree equals the reviewed tree, update #88/#116 and the durable pin, then decide the next dependency frontier separately. Do not start B2-B6 in the review session.

### Copy-ready next-session prompt

> Review Waldo backend B1 issue #88 in PR #128; do not merge without explicit authorization. Fetch current `origin/main` and the PR head; live state outranks this prompt. Read the #88 review handoff, #88/#116/PR comments, architecture lock, convergence, released #81 contracts, #80 sole writer, #87 boundary, public route/Worker/DO/Coordinator source, and tests. Verify the exact diff and SHA; full-command digest conflict behavior; canonical WorkUnit/Outcome/authority rereads; one committed writer; immutable start-intent reconstruction; recover-before-execute outside transactions; bounded observation admission; and no implied Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure. Confirm no released #81 fixture, migration, DO schema, real adapter, or deployment change. Run `/check-contract`, `/break-feature`, `/code-review`, Security/authority, independent QA/Standards/Spec, and the exact-SHA wall. Treat resume/steer/pause and v0.3-planned WorkUnit upgrade as `NEEDS DIRECTION`. Do not start B2-B6, merge, deploy, or claim live/product acceptance.

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
