# Waldo Backend Production Run Contract — B0 to B6

**Status:** current durable backend build and launch handoff
**Updated:** 2026-08-16
**GitHub milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Product authority:** [Product and Architecture Convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md)
**Architecture authority:** [Architecture Lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md)
**Capability/status authority:** [Product Capability Matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md)

This file is the repository's single persistent run contract. GitHub issues carry bounded work and current evidence. There is no HEY-109/session-bus workflow. Source, tests, accepted ADRs, and the user's latest instruction outrank both this file and tracker text.

## Current

**Human-scope stop:** this backend run is paused so work can move to the Kennel backend harness. Do not start #84 runtime/migration, #85, B2 closure, or B3–B6 work. Those lanes are `DEFERRED`/`NOT RUN`, not complete. The broad B2–B6 persistent session goal remains incomplete.

At current `origin/main@105e4b5137ed6281a5d731e0cc1ff1d5a5827800`, [#82](https://github.com/Pin4sf/waldo-backend/issues/82) is landed and closed. Reviewed #131 head `c67922bce54c7307951d046d2d5bb14b2cb81cc3` and the landed merge have identical tree `a211b791cb3eff889152d4780804be2e1e6e777d`. JudgmentAuthority v0.5 is the sole writer for JudgmentRequest/Decision/AuthorityGrant; it preserves no-grant-consumption-before-#83 and performs no external I/O. Its fresh-main wall passed contracts 71/1,572, runtime 43/1,152, responsibility integration 2/5, eight migrations/reset/parity, 53 pgTAP, typechecks/guards, and independent Security/authority, Standards, Spec, and adversarial QA. That is `module_implemented`, not B2 closure or operational proof.

[#84](https://github.com/Pin4sf/waldo-backend/issues/84)'s additive v0.6 contract release is ready but unmerged as [PR #133](https://github.com/Pin4sf/waldo-backend/pull/133), exact base `105e4b5137ed6281a5d731e0cc1ff1d5a5827800`, head `5e6ed074c9ae49ba95ff13c107997aa6b84010ff`, tree `754b926456782bcdf342b58097f45b5e8f89aa1d`. It makes Acceptance explicit-owner-only; an accepted binding requires the independently reread complete active check set and passed, available, independent Verification over exact admitted Evidence. Release is distinct and cannot claim verified acceptance. Exact-SHA Security/authority/privacy, Spec, Standards, and adversarial QA passed; the clean Linux/Docker/full-history wall passed contracts 74/1,584, runtime 43/1,152, integration 2/5, eight migrations/reset/parity, 53 pgTAP, typechecks, all guards, and diff check. See the [bounded handoff](../ledger/2026-08-16-b2-judgment-closure-contract-handoff.md) for hashes and the future source packet. Separate human authorization is required to merge this exact head.

At landed pin `origin/main@883ef9138df0bdbad70fcbc4d45cfec203d942ad`, B0 and the bounded B1 start-only gate are complete. [#80](https://github.com/Pin4sf/waldo-backend/issues/80), [#81](https://github.com/Pin4sf/waldo-backend/issues/81), [#87](https://github.com/Pin4sf/waldo-backend/issues/87), and [#88](https://github.com/Pin4sf/waldo-backend/issues/88) are closed; PRs #123 and #125–#128 are merged. Reviewed #128 head `85e59e68377037043290ec1657262742c9f0ba3a` and the landed merge have the identical tree `2d2b0ec2505fbdfd5370b44bf74014589d00f973`. No deployment exists:

- implemented: authenticated owner-routed responsibility ingress; v0.1/v0.2 capture/projection contracts; v0.3 planning turn; `IdentityPresenceModule`, `WaldoCoordinator`, `OutcomeModule`, `PlanningExecutionModule`; one owner/presence path; events/projections; one leased/fenced/cancellable zero-tool planning turn;
- separate foundations: the existing trusted `RunLoopDO`/RunLoopEngine composition and I/O shell, journal/outbox, leases/fences/cancellation, ContextComposer, DeliveryGate, scheduler, governor/safety, provider gateway, contract adapters and fakes;
- baseline additions: deterministic active-session fixtures, collision-only Durable Object migration allocation/history guard, one exact five-route responsibility manifest shared by exhaustive Worker dispatch and generated OpenAPI, truthful default-disabled/public contract documentation, and non-vacuous manifest mutation proof;
- verification follow-up: the inspection-only tracer test cancels the real alarm it creates, preventing delayed wake-up leakage into later module-global sink assertions;
- released contract boundary: strict additive v0.4 schemas, generated JSON Schemas, valid/rejection fixtures, manifests, generators and freshness guards for presence/channel, execution, acceptance-check, judgment-authority, closure, continuity, effect and Outcome-bound obligation context; v0.1-v0.3 fixture bytes are unchanged;
- landed #80 runtime boundary: one additive v0.4 writer owns ExecutionRequest/Attempt/Session/Lease/Observation/Reconciliation state; canonical authority and server-derived Outcome/WorkUnit digests bind admission; cancellation/retry/reconciliation are fenced; v0.3 reads and distinct provider/environment seams remain intact;
- landed #87 boundary: one backend execution-environment port plus deterministic fake conformance around #80, with private trusted operation intent, recover-before-issue, external I/O outside SQLite transactions, and target-side adapter fencing; it is not a public WorkUnit route or real-adapter proof;
- landed #88 boundary: one authenticated, strict, default-disabled public start command carries only a WorkUnit reference plus expected-revision precondition; the owner Durable Object and Coordinator derive and re-read canonical revision/digests, Outcome, authority, provider/environment/context, committed start intent, lease/fence/cancellation, and route through #80/#87. Full-command digest conflicts fail closed and local deterministic proof cannot imply product closure;
- missing or unproved: resume/steer/pause intent durability; upgrade of WorkUnits already claimed by the legacy v0.3 planning row; every real adapter; canonical Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry; multi-presence Home and channel gateway; service-first Connections; real effects; governed context/routines/cloud execution; Kennel/mobile/Telegram/Discord acceptance; staging; and production.

Released #81 contract evidence observed 2026-08-14 at reviewed head `df0abae`; its fixture tree is `adff7e5` and its released contract families remain unchanged by #87:

- complete canonical Linux Node 22 `pnpm verify`: passed at `df0abae`;
- contracts: 67 files, 1,560 tests passed;
- Supabase: eight migrations from zero plus reset, 53 pgTAP assertions, and canonical-history checks passed;
- runtime: 38 files, 1,001 tests passed;
- exact-token/session-revocation integration: 2 files, 5 tests passed;
- guards and generated artifacts: passed, including v0.1-v0.3 preservation and v0.4 freshness;
- QA breaker, Standards review, and Spec review: passed at the exact reviewed head;
- GitHub Actions: unavailable for this user; Supabase Preview: skipped. Two unrelated runtime-alarm timing flakes and failed host setups were classified separately before the final same-SHA pass. No runtime-adapter, staging, deployment, live-consumer, or production inference follows.

#80 evidence at exact reviewed implementation SHA `eebe931fb94cf4d5847c7accac9e19842ade5ad4`: contracts 67/1,560, runtime 39/1,038, both runtime typechecks, all guards, QA breaker, Security, Standards, and Spec passed. The complete Linux Node 22 `pnpm verify` passed at that exact SHA, including eight Supabase migrations from zero/reset, 53 pgTAP assertions, and five integration tests. Native macOS `supabase start` separately failed on the unchanged first migration because `public.users` already existed; it is classified as an environment failure and was not counted green.

#87 evidence at reviewed head `5b3d9f510a8aaa8243a476d2ba97abef08fc8da8`, landed as merge `9a2b11bb2527e0c15dcbfb5f32f86bafe99301d9` with identical tree `8a202c5ee6d96a297ce203a2036279557b05291a`: focused port/fake/Coordinator/#80-writer proof passed 4 files / 54 tests; the clean Linux/Docker wall passed contracts 67/1,560, eight migrations plus 53 pgTAP, runtime 42/1,060, integration 2/5, both runtime typechecks, every guard, and `git diff --check`; independent QA breaker, Security, Standards, and Spec passed. Contracts, fixtures, migrations, DO schema, dependencies, root runtime export, and the sole writer are unchanged. This is `module_implemented` plus deterministic backend contract/fake proof, not `adapter_conformance_passed`, staging, deployment, or live acceptance.

#88 evidence at reviewed head `85e59e68377037043290ec1657262742c9f0ba3a`, landed as merge `883ef9138df0bdbad70fcbc4d45cfec203d942ad` with identical tree `2d2b0ec2505fbdfd5370b44bf74014589d00f973`: focused public/bridge proof passed 4 runtime files / 86 tests; the clean Linux/Docker wall passed contracts 68/1,563, eight migrations plus 53 pgTAP, runtime 42/1,066, integration 2/5, both runtime typechecks, every guard, and `git diff --check`; independent QA breaker, Security/authority, Standards, and Spec passed. Supabase Preview was skipped, GitHub-hosted Actions were unavailable, native macOS Supabase bootstrap failed as environment evidence, and deployment was not run. This is `module_implemented` plus deterministic local/fake vertical proof, not real adapter conformance or product acceptance.

## Ideal

The backend is complete when one owner-authenticated path carries responsibility from intent through bounded execution, candidate Evidence, independent Verification, conscious Acceptance/reopen/release, OpenLoop/ReEntry, and ordered projection across the three primary launch surfaces: Electron Kennel, Waldo mobile, and messaging. Telegram and Discord must pass real adapter and production acceptance; WhatsApp remains a tracked primary target but vendor approval cannot block launch. The backend must also safely perform and read back one real reversible effect, govern context/credentials/routines/workspace/deletion, and pass staging plus production operating proof without making health or agent infrastructure prerequisites.

## Stable criteria

- [x] **ISC-1 — Baseline truth:** current main has reproducible contracts, runtime, Supabase integration, guards, OpenAPI/route parity, and classified failures. Landed proof: implementation `main@c37956a`, fresh detached checkout, merged PR #119; test-isolation follow-up #121 at `main@182a775`. **Falsifier:** expired fixtures, unavailable prerequisites, stale generated routes, or cross-test alarm leakage are called green.
- [x] **ISC-2 — One execution writer:** #80's canonical v0.4 writer, #87's execution-environment seam, and #88's public start-only bridge are landed at tree `2d2b0ec`; deterministic local/fake proof covers replay and recovery, not a real adapter. **Falsifier:** two writers, adapter-local canonical truth, a Coordinator bypass, or local/fake proof called live integration.
- [ ] **ISC-3 — Closure truth:** provider/session/effect completion cannot imply Verification, Acceptance, Outcome completion, or OpenLoop closure. **Falsifier:** any external `done` changes product truth without the named reducers.
- [ ] **ISC-4 — One Waldo across launch presences:** enrolled Mobile, Kennel, Telegram, Discord, and test presences receive capability-appropriate views of the same ordered owner truth with link/revoke/gap/account-switch/cross-owner proof. **Falsifier:** a surface becomes a writer, a channel payload becomes owner authority, or state crosses owner boundaries.
- [ ] **ISC-5 — Optional Health First:** health-connected may improve planning; health-declined retains Home, capture, Connections, Outcomes, execution, verification, Open Loops, and Close. **Falsifier:** missing health disables or penalizes a core path.
- [ ] **ISC-6 — Complexity invisible, control inspectable:** ordinary setup uses recognizable services, plain-language authority, “Have Waldo handle this,” and truthful placement/status. **Falsifier:** MCP, CLI, Markdown, repositories, API keys, models, or runtimes are setup requirements.
- [ ] **ISC-7 — Safe effects, channels, and credentials:** intent precedes I/O, channel webhooks are verified and deduplicated, outbound delivery is durable and reconciled before retry, credentials never enter model-visible surfaces, and revoke fails closed. **Falsifier:** blind retry, ambient credential use, duplicate social effect, raw-health/message leakage, payload-derived authority, or receipt-as-completion.
- [ ] **ISC-8 — Durable context and work:** corrections, routines, schedules and cloud work remain attributable, reviewed, bounded, recoverable, pausable, and deletable. **Falsifier:** memory grants permission, drafts self-promote, or laptop-off work silently dies/duplicates.
- [ ] **ISC-9 — User-owned proof:** export/delete/restore covers every named store and deleted data cannot resurrect. **Falsifier:** unavailable deletion is called complete or restore revives content.
- [ ] **ISC-10 — Launch proof:** staging and production evidence cover security/privacy, recovery, observability, load/cost, rollback, real reversible effect/read-back, revoke, and next-day re-entry. **Falsifier:** local/fake success is called production.
- [ ] **ISC-11 — Anti:** no second Outcome/task/memory/execution truth store, no raw health in agent execution, no silent authority widening, and no deployment without explicit approval.

## Dependency-ordered work

| Gate | Outcome | Issues | Gate completion |
|---|---|---|---|
| **B0** | trustworthy baseline | completed [#107](https://github.com/Pin4sf/waldo-backend/issues/107); merged PR #119; test-only follow-up [#120](https://github.com/Pin4sf/waldo-backend/issues/120)/#121; #99/#100/#117 closed superseded | complete: ISC-1 passed at `c37956a`; verification harness hardened at `182a775` |
| **B1** | shared command primitives and WorkUnit to one trusted execution writer | completed [#81](https://github.com/Pin4sf/waldo-backend/issues/81) → [#80](https://github.com/Pin4sf/waldo-backend/issues/80)/[PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) → [#87](https://github.com/Pin4sf/waldo-backend/issues/87)/[PR #126](https://github.com/Pin4sf/waldo-backend/pull/126) → [#88](https://github.com/Pin4sf/waldo-backend/issues/88)/[PR #128](https://github.com/Pin4sf/waldo-backend/pull/128) | complete for the bounded start-only path at `883ef91`; resume/steer/pause and v0.3-row upgrade remain architecture stops; #86 specializes the B3 channel envelope |
| **B2** | Judgment, Evidence, Verification, Acceptance, OpenLoop/ReEntry | [#82](https://github.com/Pin4sf/waldo-backend/issues/82), [#84](https://github.com/Pin4sf/waldo-backend/issues/84), [#85](https://github.com/Pin4sf/waldo-backend/issues/85) | ISC-3 passes through public commands/projections |
| **B3** | daily interaction and ordered desktop/mobile/messaging presences | [#95](https://github.com/Pin4sf/waldo-backend/issues/95), [#104](https://github.com/Pin4sf/waldo-backend/issues/104), [#108](https://github.com/Pin4sf/waldo-backend/issues/108), [#86](https://github.com/Pin4sf/waldo-backend/issues/86) | ISC-4–ISC-6 pass with Kennel/mobile/fake-channel presences and both health states |
| **B4** | capability admission, credentials, Connections, first effects, Telegram and Discord | [#90](https://github.com/Pin4sf/waldo-backend/issues/90) → [#91](https://github.com/Pin4sf/waldo-backend/issues/91) → [#109](https://github.com/Pin4sf/waldo-backend/issues/109) + [#82](https://github.com/Pin4sf/waldo-backend/issues/82) → [#83](https://github.com/Pin4sf/waldo-backend/issues/83) → [#89](https://github.com/Pin4sf/waldo-backend/issues/89) + [#112](https://github.com/Pin4sf/waldo-backend/issues/112) + [#113](https://github.com/Pin4sf/waldo-backend/issues/113) | ISC-7 passes with Calendar/inbox test accounts and credentialed Telegram/Discord staging |
| **B5** | governed context, commitments, routines, cloud execution and durable messaging | [#92](https://github.com/Pin4sf/waldo-backend/issues/92), [#94](https://github.com/Pin4sf/waldo-backend/issues/94), [#110](https://github.com/Pin4sf/waldo-backend/issues/110), [#114](https://github.com/Pin4sf/waldo-backend/issues/114) | ISC-8 passes in fault-injected staging including channel restart/rate-limit/retry cases |
| **B6** | portability/deletion and three-surface production release | [#96](https://github.com/Pin4sf/waldo-backend/issues/96) → [#111](https://github.com/Pin4sf/waldo-backend/issues/111) | ISC-9–ISC-11 pass with Electron, mobile, Telegram and Discord operational evidence |

Post-launch breadth—model-routing [#93](https://github.com/Pin4sf/waldo-backend/issues/93), MCP distribution [#97](https://github.com/Pin4sf/waldo-backend/issues/97), and approval-dependent WhatsApp activation [#115](https://github.com/Pin4sf/waldo-backend/issues/115)—does not block the milestone. Messaging itself is launch-critical through Telegram and Discord.

## Parallel surface lanes

| Surface lane | GitHub work | May proceed against fixtures | Real integration gate |
|---|---|---|---|
| Electron Kennel | [contracts/client #26](https://github.com/Pin4sf/kennel/issues/26), [Home/Work #27](https://github.com/Pin4sf/kennel/issues/27), [B6 acceptance #28](https://github.com/Pin4sf/kennel/issues/28) | contract/client shell after B0; UI and fake-backend conformance as each fixture release lands | B1/B2 client, B3 presence, B4/B5 execution, B6 release |
| Waldo mobile | [lineage decision #6](https://github.com/Pin4sf/waldo-app/issues/6), [Health/Home integration #7](https://github.com/Pin4sf/waldo-app/issues/7), [B6 acceptance #8](https://github.com/Pin4sf/waldo-app/issues/8) | lineage audit during B0; Health/Home UI and fake-backend conformance after revision selection | B3 presence/health, B4/B5 Connections/continuity, B6 physical-device release |
| Messaging | [contract #86](https://github.com/Pin4sf/waldo-backend/issues/86), [Telegram #112](https://github.com/Pin4sf/waldo-backend/issues/112), [Discord #113](https://github.com/Pin4sf/waldo-backend/issues/113), [durability #114](https://github.com/Pin4sf/waldo-backend/issues/114) | channel-neutral fixtures and injected transports after B0/B1 | B3 channel presence, B4 real vendors, B5 recovery, B6 live acceptance |

Surface teams may work in parallel only against released contracts and golden fixtures. They must not copy backend internals, create surface-local canonical reducers, or call fixture success integration/production proof.

## GitHub operating workflow

- GitHub issue [#78](https://github.com/Pin4sf/waldo-backend/issues/78) owns the B0-B6 launch map. [#116](https://github.com/Pin4sf/waldo-backend/issues/116) plus the repository [execution ledger](./EXECUTION-LEDGER.md) own live session/worktree coordination and durable handoffs. Linear and HEY identifiers are historical evidence only.
- `gate:B0`–`gate:B6` labels express dependency order; surface/channel labels express acceptance impact.
- `ready-for-agent` requires explicit dependencies, acceptance, falsifier, verification, rollback, privacy/authority impact, and a current source pin. `blocked` must name the unmet dependency.
- Every branch and PR links its GitHub issue; evidence is written back before issue closure.
- Only dependency-frontier work becomes ready when shared contracts or writers could collide. Surface teams may build against released fixtures without claiming live integration.

## Open pull-request disposition

| PR | Current role | Required action |
|---|---|---|
| #99 | closed B0 fixture source evidence | superseded by merged #119; do not reopen or merge its stale branch |
| #100 | closed B0 migration-guard source evidence | superseded by merged #119; intermediate SQL-immutability claims remain rejected |
| #117 | closed governance publication | superseded by merged #118; do not merge or revive as current authority |
| #121 | merged B0 test-isolation follow-up | prevents an inspection-only tracer alarm from leaking into later tests; no production behavior change |
| #123 | merged B1 contract/fixture release | contract authority for the released v0.4 families; local/fake proof only |
| #125 | merged B1 sole execution writer for closed #80 | landed at `cffae3b`; reviewed runtime `eebe931` has the same tree `43aa5b9`; contains no adapter or deployment proof |
| #126 | merged B1 execution-environment port/fake boundary for closed #87 | landed at `9a2b11b`; reviewed head `5b3d9f5` has the same tree `8a202c5`; contains no public #88 route, real adapter, deployment, or live proof |
| #127 | merged #88 frontier handoff | documentation/coordination only; landed in base `4e1695c` |
| #128 | merged #88 public start-only bridge | landed as `883ef91` with the reviewed tree; additive public v0.4 route and local/fake composition through #80/#87; no deployment, real adapter, closure runtime, or live proof |
| #131 | merged #82 JudgmentAuthority runtime | landed as `105e4b5`; reviewed `c67922b` and landed tree `a211b791` match; #82 closed; no grant consumption, external I/O, staging, or deployment |
| #133 | ready #84 v0.6 contract release | exact base `105e4b5`, head `5e6ed07`, tree `754b926`; contract-defined PASS only; separate human merge authorization required; do not infer #84 runtime or B2 closure proof |
| #98 | B1 single-writer decision evidence | preserve as source-pinned design evidence; re-check every claim against current source; implementation belongs to #80/#88 |
| #103 | stale B1/B2 contract draft | #81 supersedes its released B1 families; do not merge wholesale; review any remaining B2 evidence independently |
| #105 | B3 delivery persona/privacy hardening | review under #104 and B3 security acceptance |
| #101 | B4 credential-boundary evidence | preserve/reconcile under #91; not implementation proof |
| #102 | superseded documentation umbrella | replace with #78/run contract; close only after preserving useful discussion |
| #30, #59, #70 | pre-convergence, merge-dirty changes | do not merge as-is; re-evaluate useful archive, migration, or observation evidence against current issues |

No open PR is launch authority by itself. Closing, rebasing, merging, or superseding one requires an explicit review of its current diff and retained evidence.

## Test strategy

| Criteria | Evidence | Threshold |
|---|---|---|
| ISC-1 | generated artifact/route guard, contracts/runtime/Supabase/guard wall | zero unexplained failures or skips |
| ISC-2–3 | contract, property, mutation-candidate, replay and hostile-adapter tests | no duplicate execution or implied closure |
| ISC-4–6 | tenant/link/revoke/cursor tests, shared fixtures, downstream Electron/mobile/fake-channel acceptance | same owner truth, understandable product, both health states complete |
| ISC-7 | canary-leak, verified channel ingress, dedupe/replay, fault-injected effect/delivery reconciliation, security review | no credential/content disclosure, payload-derived authority, duplicate send or blind retry |
| ISC-8 | scheduler/restart/checkpoint/deletion/budget conformance | at-most-once or reconciled; truthful placement |
| ISC-9 | export/delete/pre-deletion-backup restore adversarial test | no resurrection across named stores |
| ISC-10–11 | Electron/mobile/Telegram/Discord staging matrix, load/cost, observability, incident/rollback, canonical live verification | every claim tied to the proof level exercised |

## Resume boundary

Use the [B2–B6 goal execution contract](../planning/WALDO_BACKEND_B2_B6_GOAL_EXECUTION_CONTRACT_2026-08-15.md):

1. Do not resume backend writes until the human explicitly redirects work back from the Kennel harness.
2. At that time, re-pin `origin/main` and inspect live #78/#84/#116 and #133. If PR #133 was separately authorized and merged, compare reviewed and landed trees and run the fresh-main integration wall.
3. Only with a separate implementation instruction, create a fresh #84 runtime worktree and source packet. Recheck migration lineage; use the v0.6 contract's authoritative active-check and current-Evidence rereads. Do not reuse the contract worktree or start #85.
4. Keep B3–B6, credentials, staging, deployment, and production activation out of scope until their separate barriers and authorizations apply.

### Copy-ready root-session ask

> Create one persistent goal with the exact objective in the B2–B6 goal execution contract and coordinate it through B6. Before implementation or consolidation, register the root `SESSION START` on #116; require each child to register its own lane, and post the root `SESSION HANDOFF` before pause, transfer, PR, or end. Start only the current dependency frontier as write-capable work: first #82, then promote later issues only after their named barriers pass. Use separate clean worktrees for bounded, disjoint issue slices; keep shared contracts, migrations, schema lineages, composition roots and canonical writers single-owned. Run the required planning, TDD, adversarial QA, Security/authority, Standards, Spec and exact-SHA verification loop for every slice. Unblock children by deciding ownership and release order from evidence; do not let children widen authority or reconcile shared seams privately. Begin real credentialed API testing only at the B4 staging barrier with synthetic/test accounts and reversible effects. Preserve provider/tool success as evidence rather than Waldo Acceptance. Do not deploy, perform destructive drills, or use production credentials without a separate explicit approval.

This ask authorizes the future session to create the Codex session goal. It does not create a Waldo product `GoalRecord`, pre-authorize external mutations, or make all five gates independent concurrent writers.

## Verification wall

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify
git diff --check
```

Record passed, failed, expired, skipped, unavailable, deferred, and not-run separately. Production deployment is destructive/external work and always requires an explicit change plan and approval.
