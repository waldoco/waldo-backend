# Waldo Backend Production Run Contract — B0 to B6

**Status:** current durable backend build and launch handoff
**Updated:** 2026-08-14
**GitHub milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Product authority:** [Product and Architecture Convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md)
**Architecture authority:** [Architecture Lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md)
**Capability/status authority:** [Product Capability Matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md)

This file is the repository's single persistent run contract. GitHub issues carry bounded work and current evidence. There is no HEY-109/session-bus workflow. Source, tests, accepted ADRs, and the user's latest instruction outrank both this file and tracker text.

## Current

At current `origin/main@cffae3b`, B0 baseline convergence, its test-isolation follow-up, #81's additive B1 contract/fixture release, its handoff, and #80's sole v0.4 execution writer are landed. [#80](https://github.com/Pin4sf/waldo-backend/issues/80) is closed and [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) is merged; reviewed runtime SHA `eebe931` and landed `origin/main` have the identical Git tree `43aa5b9`. [#87](https://github.com/Pin4sf/waldo-backend/issues/87) is the active frontier and [#88](https://github.com/Pin4sf/waldo-backend/issues/88) remains blocked on it:

- implemented: authenticated owner-routed responsibility ingress; v0.1/v0.2 capture/projection contracts; v0.3 planning turn; `IdentityPresenceModule`, `WaldoCoordinator`, `OutcomeModule`, `PlanningExecutionModule`; one owner/presence path; events/projections; one leased/fenced/cancellable zero-tool planning turn;
- separate foundations: trusted RunLoop, journal/outbox, leases/fences/cancellation, ContextComposer, DeliveryGate, scheduler, governor/safety, provider gateway, contract adapters and fakes;
- baseline additions: deterministic active-session fixtures, collision-only Durable Object migration allocation/history guard, one exact five-route responsibility manifest shared by exhaustive Worker dispatch and generated OpenAPI, truthful default-disabled/public contract documentation, and non-vacuous manifest mutation proof;
- verification follow-up: the inspection-only tracer test cancels the real alarm it creates, preventing delayed wake-up leakage into later module-global sink assertions;
- released contract boundary: strict additive v0.4 schemas, generated JSON Schemas, valid/rejection fixtures, manifests, generators and freshness guards for presence/channel, execution, acceptance-check, judgment-authority, closure, continuity, effect and Outcome-bound obligation context; v0.1-v0.3 fixture bytes are unchanged;
- landed #80 runtime boundary: one additive v0.4 writer owns ExecutionRequest/Attempt/Session/Lease/Observation/Reconciliation state; canonical authority and server-derived Outcome/WorkUnit digests bind admission; cancellation/retry/reconciliation are fenced; v0.3 reads and distinct provider/environment seams remain intact;
- active #87 boundary: define one backend execution-environment port and deterministic fake-adapter conformance around that writer, with external I/O outside SQLite transactions and restart reconciliation before any reissue; this is not a public WorkUnit route or a real adapter;
- missing or unproved: #87 conformance, the #88 public WorkUnit bridge, canonical Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry, multi-presence Home and channel gateway, service-first Connections, real effects, governed context/routines/cloud execution, Kennel/mobile/Telegram/Discord acceptance, staging, and production.

Released #81 contract evidence observed 2026-08-14 at reviewed head `df0abae`; its fixture tree is `adff7e5` and its released contract families remain unchanged by #87:

- complete canonical Linux Node 22 `pnpm verify`: passed at `df0abae`;
- contracts: 67 files, 1,560 tests passed;
- Supabase: eight migrations from zero plus reset, 53 pgTAP assertions, and canonical-history checks passed;
- runtime: 38 files, 1,001 tests passed;
- exact-token/session-revocation integration: 2 files, 5 tests passed;
- guards and generated artifacts: passed, including v0.1-v0.3 preservation and v0.4 freshness;
- QA breaker, Standards review, and Spec review: passed at the exact reviewed head;
- GitHub Actions: unavailable for this user; Supabase Preview: skipped. Two unrelated runtime-alarm timing flakes and failed host setups were classified separately before the final same-SHA pass. No runtime-adapter, staging, deployment, live-consumer, or production inference follows.

#80 evidence at exact reviewed implementation SHA `eebe931fb94cf4d5847c7accac9e19842ade5ad4`: contracts 67/1,560, runtime 39/1,038, both runtime typechecks, all guards, QA breaker, Security, Standards, and Spec passed. The complete Linux Node 22 `pnpm verify` passed at that exact SHA, including eight Supabase migrations from zero/reset, 53 pgTAP assertions, and five integration tests. Native macOS `supabase start` separately failed on the unchanged first migration because `public.users` already existed; it is classified as an environment failure and was not counted green. #87 has no implementation or conformance proof yet.

## Ideal

The backend is complete when one owner-authenticated path carries responsibility from intent through bounded execution, candidate Evidence, independent Verification, conscious Acceptance/reopen/release, OpenLoop/ReEntry, and ordered projection across the three primary launch surfaces: Electron Kennel, Waldo mobile, and messaging. Telegram and Discord must pass real adapter and production acceptance; WhatsApp remains a tracked primary target but vendor approval cannot block launch. The backend must also safely perform and read back one real reversible effect, govern context/credentials/routines/workspace/deletion, and pass staging plus production operating proof without making health or agent infrastructure prerequisites.

## Stable criteria

- [x] **ISC-1 — Baseline truth:** current main has reproducible contracts, runtime, Supabase integration, guards, OpenAPI/route parity, and classified failures. Landed proof: implementation `main@c37956a`, fresh detached checkout, merged PR #119; test-isolation follow-up #121 at `main@182a775`. **Falsifier:** expired fixtures, unavailable prerequisites, stale generated routes, or cross-test alarm leakage are called green.
- [ ] **ISC-2 — One execution writer:** #80's reviewed writer is landed, but this criterion remains open until #87 proves the environment-port boundary and #88 proves the public WorkUnit bridge. **Falsifier:** two writers, adapter-local canonical truth, a Coordinator bypass, or local/fake proof called live integration.
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
| **B1** | shared command primitives and WorkUnit to one trusted execution writer | completed [#81](https://github.com/Pin4sf/waldo-backend/issues/81) → landed [#80](https://github.com/Pin4sf/waldo-backend/issues/80)/[PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) → active [#87](https://github.com/Pin4sf/waldo-backend/issues/87) → barrier [#88](https://github.com/Pin4sf/waldo-backend/issues/88) | #81 fixtures released at `df0abae`; #80 landed at `cffae3b` with reviewed runtime `eebe931`; #87 owns only the backend port/fake conformance; #88 remains blocked; ISC-2 and the execution half of ISC-3 pass only after #87/#88 fake-execution proof; #86 specializes shared command primitives into the channel envelope at B3 |
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

## Next session

Continue only active B1 issue #87:

1. read #116, #78, #87, blocked #88, closed #80/#81, PR #125, the current frontier ledger, the architecture lock, and current source/tests; fetch fresh `origin/main` and preserve every unrelated dirty checkout;
2. implement one backend execution-environment port for start, resume, steer, pause, cancel, reconcile, and attributable observations without exposing `*InCurrentTransaction` methods or creating a second writer;
3. keep provider and environment identity/manifest/operations/observations distinct, fail unsupported capabilities closed, keep credentials out of contracts and persisted execution state, perform I/O outside SQLite transactions, and reconcile indeterminate work before restart reissue;
4. prove exact binding plus duplicate, two-claimant, stale fence/generation, cancellation-race, timeout/disconnect, contradictory reconciliation, terminal-monotonicity, and non-closure falsifiers with deterministic fakes, then run the complete exact-SHA wall and QA/Security/Standards/Spec review;
5. open a review-ready PR and hand off evidence only after acceptance passes. Do not merge, deploy, close #87, unblock #88, start B2-B6, change released contracts/fixtures, add real adapters, or claim live acceptance.

## Verification wall

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify
git diff --check
```

Record passed, failed, expired, skipped, unavailable, deferred, and not-run separately. Production deployment is destructive/external work and always requires an explicit change plan and approval.
