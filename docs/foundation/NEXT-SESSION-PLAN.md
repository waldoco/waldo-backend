# Next Session Plan — Waldo Backend Production Convergence

**Status:** current repository entrypoint
**Updated:** 2026-08-17
**Milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Next action:** **STOP pending fresh human direction.** [#82](https://github.com/Pin4sf/waldo-backend/issues/82) is landed and closed. [#84](https://github.com/Pin4sf/waldo-backend/issues/84)'s additive v0.6 contract release is ready as [PR #133](https://github.com/Pin4sf/waldo-backend/pull/133), but is unmerged and requires separate exact-SHA merge authorization. Do not begin #84 runtime, #85, B2 closure, or B3–B6 work.

Waldo is one private, user-owned agent account across three primary launch surfaces: Electron Kennel desktop, Waldo mobile with optional Health/Care, and messaging presence. Telegram and Discord are required at launch; WhatsApp remains a primary target whose vendor approval cannot block launch. The backend owns identity, authority, canonical Outcome state, context governance, evidence, verification, acceptance, continuity, and ordered projections. Presences render or propose; providers, executors, connectors, tools, channels, and people contribute bounded observations or effects. None can declare the user's Outcome complete.

The product promise is: **Waldo continuously understands the person from sources it is permitted to use, so they can say “Make sure this gets handled” without repeating themselves—and trust Waldo to carry the responsibility until the result is verified, accepted, reopened, or consciously released without taking control away.** The full current understanding remains local/Waldo-owned; every external provider receives only a consented, Scribe-sanitized destination projection. Health First is a recommended and differentiated enhancement, never a prerequisite.

## Read in this order

1. [Documentation map](../README.md) — live authority versus reference-only evidence.
2. [Production run contract](./NEXT-BACKEND-SESSION-PROMPT.md) — B0-B6 criteria, dependency map, issue links, falsifiers, and verification wall.
3. [Product and architecture convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md) — current product definition and experience authority.
4. [Product capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md) — whole-product envelope and honest delivery classification.
5. [Architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) — placement, definitive writers, trust boundaries, and invariants.
6. [B2–B6 goal execution contract](../planning/WALDO_BACKEND_B2_B6_GOAL_EXECUTION_CONTRACT_2026-08-15.md) and [benchmark capability audit](../research/2026-08-15-benchmark-agent-capability-audit.md) — safe parallelism, promotion barriers, and honest parity gaps.
7. [Contributor onboarding](./CONTRIBUTOR-ONBOARDING.md), [operating workflow](./AGENT-OPERATING-WORKFLOW.md), and [local verification](./LOCAL-DEV-TESTING-PIPELINE.md).
8. Fresh source/tests, the current issue/PR, and accepted ADRs for the exact seam being changed.

Planning text is never shipped proof. Re-pin `origin/main`, inspect the implementation, preserve dirty work, and classify claims as `architecture_specified`, `contract_defined`, `module_implemented`, `adapter_conformance_passed`, `cross_surface_acceptance_passed`, or `operational_proof_passed`.

## Current evidence

Checked 2026-08-16 after the authorized [PR #131](https://github.com/Pin4sf/waldo-backend/pull/131) merge and the bounded #84 contract release:

- `origin/main@105e4b5137ed6281a5d731e0cc1ff1d5a5827800` is the landed #82 merge; its tree is `a211b791cb3eff889152d4780804be2e1e6e777d`, identical to reviewed #131 head `c67922bce54c7307951d046d2d5bb14b2cb81cc3`; #82 is closed;
- #82 supplied durable JudgmentAuthority v0.5 runtime proof without grant consumption or external I/O. At its fresh-main wall: contracts 71 files / 1,572 tests, runtime 43 files / 1,152 tests, responsibility integration 2 files / 5 tests, eight Supabase migrations/reset/parity, 53 pgTAP assertions, typechecks, all guards, and independent Security/authority, Standards, Spec, and adversarial QA all passed. This is `module_implemented`, not Evidence/Verification/Acceptance/OpenLoop, cross-surface, staging, deployment, or operational proof;
- #84's contract-only v0.6 candidate is [PR #133](https://github.com/Pin4sf/waldo-backend/pull/133): base `105e4b5137ed6281a5d731e0cc1ff1d5a5827800`, head `5e6ed074c9ae49ba95ff13c107997aa6b84010ff`, tree `754b926456782bcdf342b58097f45b5e8f89aa1d`. It is open, ready, and cleanly mergeable, but is not landed;
- v0.6 makes Acceptance explicit-owner-only and requires the independently reread complete active-check set plus passed, available, independent Verification over exact admitted current Evidence. Release remains distinct and cannot claim verified acceptance. It preserves v0.1–v0.5 bytes (211-file composite `f5bf7db0d5cef40f5acd8f9b04467e605a38cb6ab1d4e8ed15c0e6dd3db15a64`); source/fixture/OpenAPI hashes and the clean Linux/Docker wall are recorded in the [2026-08-16 handoff](../ledger/2026-08-16-b2-judgment-closure-contract-handoff.md);
- exact-SHA Security/authority/privacy, Spec, Standards, and adversarial QA passed for PR #133. The clean Linux/Docker/full-history wall passed contracts 74 files / 1,584 tests, runtime 43 files / 1,152 tests, responsibility integration 2 files / 5 tests, eight migrations/reset/parity, 53 pgTAP assertions, typechecks, guards, and `git diff --check`;
- human scope stopped this backend run so attention can move to the Kennel backend harness. #84 runtime/migration, #85, B2 closure integration, and B3–B6 are `DEFERRED`/`NOT RUN`, not completed. No staging, credentials, deployment, or production action occurred.

Checked 2026-08-15 after the authorized #88 merge:

- landed pin: `origin/main@883ef9138df0bdbad70fcbc4d45cfec203d942ad`; reviewed PR #128 head `85e59e68377037043290ec1657262742c9f0ba3a` and landed merge have the identical tree `2d2b0ec2505fbdfd5370b44bf74014589d00f973`; [#88](https://github.com/Pin4sf/waldo-backend/issues/88) is closed and no deployment exists;
- B0 implementation landed in [PR #119](https://github.com/Pin4sf/waldo-backend/pull/119), test isolation in [PR #121](https://github.com/Pin4sf/waldo-backend/pull/121), additive v0.4 responsibility contracts/fixtures in [PR #123](https://github.com/Pin4sf/waldo-backend/pull/123), #80's sole writer in [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125), #87's execution-environment boundary in [PR #126](https://github.com/Pin4sf/waldo-backend/pull/126), and #88's public bridge in [PR #128](https://github.com/Pin4sf/waldo-backend/pull/128);
- #80 is closed and [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) is merged at `cffae3b`; reviewed runtime implementation `eebe931` and landed `origin/main` have the identical tree `43aa5b9`;
- canonical Linux Node 22 `pnpm verify`: passed at reviewed release `df0abae`; landed merge `7067f15` has the identical Git tree;
- contracts: 67 files and 1,560 tests passed;
- Supabase: eight migrations applied/reset from zero and 53 pgTAP assertions passed;
- runtime: 38 files and 1,001 tests passed;
- exact-token/session-revocation integration: 2 files and 5 tests passed;
- guards and generated-artifact checks: passed, including v0.1-v0.3 byte preservation and v0.4 generator freshness;
- #80 exact-SHA evidence at `eebe931`: 67 contract files / 1,560 tests, eight Supabase migrations from zero/reset / 53 pgTAP assertions, 39 runtime files / 1,038 tests, 2 integration files / 5 tests, both runtime typechecks, all migration/repository guards, and independent QA breaker, Security, Standards, and Spec reviews passed;
- #87 is closed and PR #126 is merged as `9a2b11b`; reviewed head `5b3d9f5` and landed merge have the identical tree `8a202c5`. Its backend contract/fake boundary passed 4 focused files / 54 tests, 42 runtime files / 1,060 tests, both runtime typechecks, the complete clean Linux/Docker wall, and independent QA, Security, Standards, and Spec review. No contract, fixture, migration, dependency, root-export, or sole-writer change was introduced.
- #88 is landed. The start-only path adds one strict v0.4 public route, derives all execution authority server-side, commits through #80, reconstructs private start intent from the immutable request, performs #87 recovery/I/O after commit, and admits the bounded observation through the public Coordinator. At the final reviewed SHA, contracts passed 68 files / 1,563 tests, runtime passed 42 files / 1,066 tests, integration passed 2 files / 5 tests, eight Supabase migrations plus 53 pgTAP assertions passed, and QA/Security/Standards/Spec passed.

GitHub Actions was unavailable for the user and Supabase Preview was skipped; neither was counted as green. Native macOS `supabase start` again failed while applying the unchanged first migration because `public.users` already existed; that host attempt is failed environment evidence, not a source failure or green result. The reproducible Linux/Docker host-network path passed with pinned Node, pnpm, Supabase CLI, a clean clone, and full Git history. This is contract and local repository proof, not runtime-adapter, staging, deployment, or production evidence.

Implemented on landed `origin/main`: authenticated owner-routed responsibility ingress, capture/projection v0.1/v0.2, bounded planning v0.3, owner events/projections, additive v0.4 contract/fixture families, and one generalized durable v0.4 execution writer for request, Attempt, Session, Lease, Observation, cancellation, and reconciliation state. The writer derives owner and product bindings from canonical state, preserves v0.3 reads, and keeps provider and execution-environment operations distinct. A separate trusted RunLoop substrate provides journal/outbox, recovery, scheduling, safety, provider, context, and effect foundations.

Missing or unproved: resume/steer/pause intent durability; upgrade of a WorkUnit already claimed by the legacy v0.3 planning row; every real execution-environment adapter and live acceptance; #84 Evidence/Verification/Acceptance; #85 OpenLoop/ReEntry; multi-presence Home/channel gateway; service-first Connections and real reversible effects; `SourceAdmissionPolicy`, automatic Personal Profile compilation, current local/Waldo kernel, provider-specific projections, universal external-LLM egress, record-scoped Kennel attachment, and cross-provider fresh-session continuity; governed routines, credentials and laptop-off execution; Kennel/mobile/Telegram/Discord acceptance; deletion/restore; staging; and production operations. B0/B1/#82 establish a trustworthy kernel and Judgment writer, not present-day capability parity with Pi, Hermes Agent, OpenClaw, or a complete personal agent.

## Stable kernel

- One owner maps to one canonical backend authority root.
- One named reducer is the durable writer for each aggregate.
- `WaldoCoordinator` authenticates, authorizes, and sequences; the existing `RunLoopDO`/RunLoopEngine remains the only trusted composition and physical execution/effect path during additive migration. #87 is a seam within that path, not a sibling engine.
- Kennel owns device-local process/workspace durability plus pre-attachment and `local_only` Profile/Memory records; it never owns canonical Waldo identity, admitted `waldo_synced` claims, Outcome truth, authority, Acceptance, or closure.
- Provider or executor `done` is an observation. Evidence, Verification, Acceptance, Outcome state, and OpenLoop closure are distinct.
- Effects persist frozen intent and digest before I/O; ambiguity reconciles before retry; each call path has one retry owner.
- User statements and corrections outrank inference. Memory is not permission.
- Connected-source data is unavailable to Profile/Memory compilation until `SourceAdmissionPolicy` admits lawful access, account/category/organization policy, purpose, processor region/retention, and current revocation generation.
- `ContinuityModule` owns admitted `waldo_synced` Profile/Memory Claim revisions; `ContextCompiler` owns the current owner-root kernel and context/provider projections. Kennel separately owns pre-attachment and `local_only` records. Attachment is content-free-inventory first and record-scoped; it never bulk-uploads local memory.
- `ExternalLLMEgressGate` applies to every remote model path. It requires explicit destination/data-class consent, an active applicable DPA, `RemoteContextEgressPolicy`, processor region/retention, and fail-closed Scribe masking of PII, secrets, and health values. No provider/tool/MCP/recovery fallback can bypass it.
- Health-declined users retain the complete core agent product without invented readiness or pressure.
- Ordinary setup exposes one Waldo account, recognizable Connections, plain-language authority, and truthful placement/status—not MCP, CLI, Markdown, repositories, API keys, models, or runtimes.
- Protocol 0.1/v0.2 advertises `offlineCommands: "none"`; disconnected presences show only explicitly stale read-only projections until the accepted offline-draft ADR conflict is reconciled.

## Build order

| Gate | Required result | Issues | Promotion rule |
|---|---|---|---|
| B0 | trustworthy baseline and public route/OpenAPI parity | #107; merged PRs #119 and test-only #121 | complete at landed implementation `c37956a`; reproducibility harness hardened at `182a775` |
| B1 | shared command primitives and one WorkUnit-to-execution writer | #81, #80, #87, #88 | complete for the bounded start-only gate at landed `883ef91`; #86 owns the later B3 channel envelope; resume/steer/pause and the v0.3-row upgrade remain separate architecture stops |
| B2 | durable judgment and honest closure spine | #82, #84, #85 | #82 landed; #84 contract PR #133 ready but unmerged; runtime/#85/closure proof deferred by human scope |
| B3 | one Waldo across ordered desktop/mobile/messaging presences | #95, #104, #108, #86 | require both health states plus link/revoke/gap/cross-owner proof |
| B4 | Connections, source admission, universal external-model egress, effects and real Telegram/Discord adapters | #90, #91, #109, #83, #89, #112, #113 | require Calendar/inbox test accounts, organization/account/category denial, DPA/region/retention/Scribe no-bypass fixtures, and credentialed channel staging |
| B5 | Personal Profile/kernel/context, record-scoped Kennel attachment, routines, cloud execution and durable messaging | #92, #94, #110, #114; Personal Profile/attachment issue required before implementation | require fresh-session continuity, correction/exclusion convergence, content-free inventory/per-item receipts, attach/detach/non-resurrection, restart/fault/rate-limit/retry/deletion/budget proof |
| B6 | portability, deletion and three-surface production release | #96, #111 | require Electron, mobile, Telegram and Discord operational proof with every prior personal-understanding and egress gate still green |

Model-routing breadth (#93), MCP distribution (#97), and approval-dependent WhatsApp activation (#115) are post-launch/non-blocking. Telegram and Discord messaging are launch-critical. Gate labels express dependency order; they are not independent product editions or permission to omit later whole-product acceptance.

Pull requests are reconciled in the [production run contract](./NEXT-BACKEND-SESSION-PROMPT.md): #99/#100 are closed and superseded by merged #119; #117 is closed and superseded by merged #118; test-only #121 and contract release #123 are merged; #98 remains source-pinned #80 decision evidence; #103 is stale contract evidence superseded by #81 for released B1 families and must not merge wholesale; #105 informs B3; #101 informs B4; #102 is superseded by #78; and merge-dirty pre-convergence PRs #30/#59/#70 must not merge as-is.

Parallel surface work is tracked in GitHub, not Linear: Kennel [#26–#28](https://github.com/Pin4sf/kennel/issues/26), mobile [#6–#8](https://github.com/Pin4sf/waldo-app/issues/6), and messaging backend #86/#112–#114. Surface teams may consume only released, version-pinned fixtures from the current backend gate; real integration waits for the named barrier. Kennel's standalone no-account Local Memory/Personal Profile proof may advance independently once it has its own bounded GitHub issue and local contracts, but it cannot claim Waldo sync or alter B0–B6 backend authority. Owner-root attachment and remote-egress integration wait for released B4/B5 contracts.

## Resume only with fresh human direction

1. Re-pin `origin/main`, inspect [#78](https://github.com/Pin4sf/waldo-backend/issues/78), [#84](https://github.com/Pin4sf/waldo-backend/issues/84), [#116](https://github.com/Pin4sf/waldo-backend/issues/116), and [PR #133](https://github.com/Pin4sf/waldo-backend/pull/133). Live state outranks this document.
2. Do not merge PR #133 unless the human separately authorizes that exact reviewed head. If it is authorized and lands, compare the reviewed/landed trees, refresh `origin/main`, and run the applicable fresh-main integration wall before any next write lane.
3. Only after a separate human instruction to resume backend work, create a fresh bounded #84 runtime worktree. Recheck Durable Object migration lineage before allocation; the runtime must transactionally reread the authoritative active AcceptanceCheck set and exact current Evidence envelopes required by v0.6. Do not reuse the contract worktree.
4. Keep #85 and every B3–B6 lane blocked. The broad B2–B6 persistent goal remains incomplete; this handoff does not authorize or claim its completion.
5. The immediate user priority is the Kennel backend harness, outside this backend write lane.

### Copy-ready next-session prompt

> Backend work is paused by human scope. First inspect the [2026-08-16 B2 handoff](../ledger/2026-08-16-b2-judgment-closure-contract-handoff.md), live #78/#84/#116, and PR #133. Do not merge PR #133, start #84 runtime, start #85, or advance B3–B6 without fresh explicit human direction. If the human authorizes the exact #133 merge and it lands, compare reviewed and landed trees and run the fresh-main wall. If the human then authorizes backend continuation, create a fresh single-writer #84 runtime worktree with a complete source packet; do not reuse the v0.6 contract worktree and do not allocate a migration without rechecking live lineage.

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
