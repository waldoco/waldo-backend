# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-14
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** implement only [#87](https://github.com/Pin4sf/waldo-backend/issues/87)'s backend `ExecutionEnvironmentPort` and deterministic fake-adapter conformance around the landed #80 sole writer; keep [#88](https://github.com/Pin4sf/waldo-backend/issues/88) blocked until #87 lands

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

Checked 2026-08-14 at the start of #87:

- current repository pin: `origin/main@cffae3b`; B0 implementation landed in [PR #119](https://github.com/Pin4sf/waldo-backend/pull/119), test isolation in [PR #121](https://github.com/Pin4sf/waldo-backend/pull/121), additive v0.4 responsibility contracts/fixtures in [PR #123](https://github.com/Pin4sf/waldo-backend/pull/123), and their handoff in [PR #124](https://github.com/Pin4sf/waldo-backend/pull/124);
- #80 is closed and [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) is merged at `cffae3b`; reviewed runtime implementation `eebe931` and landed `origin/main` have the identical tree `43aa5b9`;
- canonical Linux Node 22 `pnpm verify`: passed at reviewed release `df0abae`; landed merge `7067f15` has the identical Git tree;
- contracts: 67 files and 1,560 tests passed;
- Supabase: eight migrations applied/reset from zero and 53 pgTAP assertions passed;
- runtime: 38 files and 1,001 tests passed;
- exact-token/session-revocation integration: 2 files and 5 tests passed;
- guards and generated-artifact checks: passed, including v0.1-v0.3 byte preservation and v0.4 generator freshness;
- #80 exact-SHA evidence at `eebe931`: 67 contract files / 1,560 tests, eight Supabase migrations from zero/reset / 53 pgTAP assertions, 39 runtime files / 1,038 tests, 2 integration files / 5 tests, both runtime typechecks, all migration/repository guards, and independent QA breaker, Security, Standards, and Spec reviews passed;
- #87 is claimed on branch `codex/87-execution-environment-port` from `origin/main@cffae3b`; implementation and conformance proof are not yet established, and #88 remains blocked.

GitHub Actions was unavailable for the user and Supabase Preview was skipped; neither was counted as green. Native macOS `supabase start` again failed while applying the unchanged first migration because `public.users` already existed; that host attempt is failed environment evidence, not a source failure or green result. The reproducible Linux/Docker host-network path passed with pinned Node, pnpm, Supabase CLI, a clean clone, and full Git history. This is contract and local repository proof, not runtime-adapter, staging, deployment, or production evidence.

Implemented on landed `origin/main`: authenticated owner-routed responsibility ingress, capture/projection v0.1/v0.2, bounded planning v0.3, owner events/projections, additive v0.4 contract/fixture families, and one generalized durable v0.4 execution writer for request, Attempt, Session, Lease, Observation, cancellation, and reconciliation state. The writer derives owner and product bindings from canonical state, preserves v0.3 reads, and keeps provider and execution-environment operations distinct. A separate trusted RunLoop substrate provides journal/outbox, recovery, scheduling, safety, provider, context, and effect foundations.

Missing or unproved: the active #87 execution-environment port/fake-adapter conformance; the #88 public WorkUnit-to-trusted-execution bridge; Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry; multi-presence Home/channel gateway; service-first Connections and real reversible effects; governed context, routines, credentials and laptop-off execution; Kennel/mobile/Telegram/Discord acceptance; deletion/restore; staging; and production operations.

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
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | #81 fixtures released at `df0abae`; #80 landed at `cffae3b` with reviewed runtime `eebe931`; #87 is the active backend port/fake-adapter frontier; #88 waits for #87; #86 owns the B3 channel envelope |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | start after B1 contracts/replay proof |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts and credentialed channel staging |
| B5 | context, routines, cloud execution and durable messaging | #92, #94, #110, #114 | require restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Pull requests are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are closed and superseded by merged #119; #117 is closed and superseded by merged #118; test-only #121 and contract release #123 are merged; #98 remains source-pinned #80 decision evidence; #103 is stale contract evidence superseded by #81 for released B1 families and must not merge wholesale; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. Surface teams may consume only released, version-pinned fixtures from #81; real integration waits for the named backend gate.

## Start the next session

1. Read [execution ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116), [#78](https://github.com/Pin4sf/waldo-backend/issues/78), active [#87](https://github.com/Pin4sf/waldo-backend/issues/87), blocked [#88](https://github.com/Pin4sf/waldo-backend/issues/88), closed [#80](https://github.com/Pin4sf/waldo-backend/issues/80), [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125), closed [#81](https://github.com/Pin4sf/waldo-backend/issues/81), and the [active frontier ledger](../ledger/2026-08-14-b1-execution-environment-port-frontier.md); fetch fresh `origin/main` and preserve every unrelated dirty checkout.
2. Continue only #87 on its registered branch. Map the landed Coordinator-to-environment paths, then implement the backend port and deterministic fake/conformance without adding a public route or a second writer.
3. Keep provider invocation and execution-environment identity, manifests, operations, observations, and ledgers distinct. All canonical writes enter through `WaldoCoordinator`; external I/O stays outside SQLite transactions; restart reconciles indeterminate work before reissue.
4. Prove native/emulated/unsupported honesty, exact binding, duplicate/two-claimant/cancel/restart/ambiguity safety, and non-self-certifying observations at one SHA. Fakes establish backend contract conformance only.
5. Do not start #88, B2-B6, the Supabase/D1 decision, deployment, staging, real Kennel/cloud/local adapters, or live consumer acceptance in #87.

### Copy-ready next-session prompt

> Continue Waldo backend production convergence for active #87 from fresh `origin/main@cffae3b`. Read `AGENTS.md`, `.claude/rules/INDEX.md`, the foundation entrypoints, `docs/ledger/2026-08-14-b1-execution-environment-port-frontier.md`, GitHub issues #116/#78/#87, blocked #88, closed #80/#81, and merged PR #125. Implement only the backend `ExecutionEnvironmentPort` and deterministic fake-adapter conformance around reviewed runtime `eebe931` and released v0.4 fixtures `df0abae` / tree `adff7e5`. Preserve `WaldoCoordinator` as the public authority boundary and #80 as sole writer; keep provider and environment categories distinct; perform I/O outside transactions; reconcile before restart reissue; fail unsupported behavior closed; and treat adapter completion as untrusted execution observation only. Run the exact-SHA wall plus QA/Security/Standards/Spec review. Do not start #88/B2-B6, change contracts/fixtures, add real adapters, decide Supabase versus D1, deploy, or claim live acceptance.

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
