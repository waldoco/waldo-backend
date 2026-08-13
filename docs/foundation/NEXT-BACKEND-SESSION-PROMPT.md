# Waldo Backend Production Run Contract — B0 to B6

**Status:** current durable backend build and launch handoff
**Updated:** 2026-08-13
**GitHub milestone:** [Waldo Backend Production Launch](https://github.com/Pin4sf/waldo-backend/milestone/1)
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
**Execution ledger:** [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [protocol](./EXECUTION-LEDGER.md)
**Product authority:** [Product and Architecture Convergence](../planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md)
**Architecture authority:** [Architecture Lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md)
**Capability/status authority:** [Product Capability Matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md)

This file is the repository's single persistent run contract. GitHub issues carry bounded work and current evidence. There is no HEY-109/session-bus workflow. Source, tests, accepted ADRs, and the user's latest instruction outrank both this file and tracker text.

## Current

At current `origin/main@51da2d1`, the newest product-code pin is `dd434e9`:

- implemented: authenticated owner-routed responsibility ingress; v0.1/v0.2 capture/projection contracts; v0.3 planning turn; `IdentityPresenceModule`, `WaldoCoordinator`, `OutcomeModule`, `PlanningExecutionModule`; one owner/presence path; events/projections; one leased/fenced/cancellable zero-tool planning turn;
- separate foundations: trusted RunLoop, journal/outbox, leases/fences/cancellation, ContextComposer, DeliveryGate, scheduler, governor/safety, provider gateway, contract adapters and fakes;
- missing or unproved: general WorkUnit execution, canonical Judgment/Evidence/Verification/Acceptance/OpenLoop/ReEntry, multi-presence Home and channel gateway, service-first Connections, real effects, governed context/routines/cloud execution, Kennel/mobile/Telegram/Discord acceptance, staging, and production.

Fresh baseline observed 2026-08-13:

- contracts: 58 files, 1,475 tests passed;
- guards: passed, including self-tests;
- runtime: 37 files passed, 1 failed; 994 tests passed, 7 failed because two authority fixtures use `authenticatedSessionExpiresAt: 2026-08-08T00:00:00.000Z`;
- Docker/Supabase: unavailable at the local OrbStack socket, so the full repository wall and Supabase integration are not proved.

## Ideal

The backend is complete when one owner-authenticated path carries responsibility from intent through bounded execution, candidate Evidence, independent Verification, conscious Acceptance/reopen/release, OpenLoop/ReEntry, and ordered projection across the three primary launch surfaces: Electron Kennel, Waldo mobile, and messaging. Telegram and Discord must pass real adapter and production acceptance; WhatsApp remains a tracked primary target but vendor approval cannot block launch. The backend must also safely perform and read back one real reversible effect, govern context/credentials/routines/workspace/deletion, and pass staging plus production operating proof without making health or agent infrastructure prerequisites.

## Stable criteria

- [ ] **ISC-1 — Baseline truth:** current main has reproducible contracts, runtime, Supabase integration, guards, OpenAPI/route parity, and classified failures. **Falsifier:** expired fixtures, unavailable prerequisites, or stale generated routes are called green.
- [ ] **ISC-2 — One execution writer:** one durable writer owns ExecutionRequest/Attempt/Session/Lease across provider and execution-environment adapters. **Falsifier:** two writers or adapter-local truth.
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
| **B0** | trustworthy baseline | [#107](https://github.com/Pin4sf/waldo-backend/issues/107); review/land PRs #99 and #100 | ISC-1 passes at one fresh SHA |
| **B1** | shared command primitives and WorkUnit to one trusted execution writer | [#81](https://github.com/Pin4sf/waldo-backend/issues/81) → [#80](https://github.com/Pin4sf/waldo-backend/issues/80) + [#87](https://github.com/Pin4sf/waldo-backend/issues/87) → [#88](https://github.com/Pin4sf/waldo-backend/issues/88) | ISC-2 and execution half of ISC-3 pass with fake execution adapters; #86 specializes the shared command primitives into the channel envelope at B3 |
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
| #99 | B0 time-relative fixture candidate | review against current main; land only with complete B0 evidence |
| #100 | B0 migration-lineage guard candidate | re-pin live lineage, rebase, then review |
| #98 | B1 single-writer decision evidence | preserve as design evidence; implementation belongs to #80/#88 |
| #103 | B1/B2 contract draft | split/review against #81 release order; effect contracts must not block closure contracts |
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

Start only B0:

1. read #116, register `SESSION START` on #107, create a clean worktree from fresh `origin/main`, and preserve every unrelated dirty checkout;
2. inspect PR #99 (expiry fixture), PR #100 (migration-lineage guard), and issue #107 (OpenAPI/route/full-wall parity);
3. use `/waldo-isa-run-contract`, planner/workflow mapping, `/diagnose` or `/tdd`, `/check-contract`, breaker, Standards/Spec review, and security review where triggered;
4. close B0 only when the complete evidence is reproducible at one SHA;
5. post `SESSION HANDOFF` with commits, PR, classified evidence, next owner, and worktree disposition;
6. then promote #81, and only #81, into active B1 work.

## Verification wall

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify
git diff --check
```

Record passed, failed, expired, skipped, unavailable, deferred, and not-run separately. Production deployment is destructive/external work and always requires an explicit change plan and approval.
