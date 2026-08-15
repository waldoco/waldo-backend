# Waldo Backend B2–B6 Goal Execution Contract

**Status:** proposed operating contract for the next human-authorized implementation goal
**Date:** 2026-08-15
**Current base:** `origin/main@883ef9138df0bdbad70fcbc4d45cfec203d942ad`
**Umbrella / coordination:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78) / [#116](https://github.com/Pin4sf/waldo-backend/issues/116)
**Product authority:** [Product and Architecture Convergence](./WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md)
**Architecture authority:** [Architecture Lock](./WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md)
**Capability comparison:** [Benchmark Agent Capability Audit](../research/2026-08-15-benchmark-agent-capability-audit.md)
**Thesis authority:** [Waldo Emerging AI Problem Pool and Company Philosophy](https://github.com/Pin4sf/waldo-brain/blob/b5362ac4d052814a4c4265dece95835706607799/03-References/research/waldo-emerging-ai-problem-pool-and-company-philosophy-2026-08-09.md)

This contract plans a future root goal. It does not create or mutate a runtime `GoalRecord`, start B2–B6 implementation, authorize real credentials, deploy, or establish product parity.

## Current

B0 and bounded B1 are landed. The backend has a reproducible contract/runtime/migration wall, strict owner-routed public ingress, released v0.4 responsibility contracts, one canonical execution writer, a recover-before-issue execution-environment seam, and one authenticated start-only WorkUnit path through the trusted RunLoop composition. The reviewed PR #128 tree and the landed merge tree are identical.

This is strong kernel and repository evidence. It is not a complete agent product. B2–B6 runtime writers, real adapters, cross-surface acceptance, staging, operations, and production proof remain open. Resume/steer/pause intent durability and upgrade of a WorkUnit already occupying the legacy v0.3 planning row remain explicit B1 architecture stops.

## Thesis checksum

The build must preserve the source order `world change -> emerging behavior -> interlinked human problem pool -> company philosophy -> product requirements -> replaceable surfaces and implementations -> evidence and falsifiers`. Waldo's center of gravity is epistemic: helping a person know what became true, what remains, what authority was used, and what consequence is still theirs. Orchestration, memory, channels, Home, Kennel, and the responsibility-continuity model are candidate means, not the definition of the problem or proof of a market.

B2 addresses activity without Outcome truth and action without transferred accountability. B3 tests one understandable relationship rather than fragmented interfaces. B4 tests safe real-world consequence. B5 tests continuity, attention, and user-owned context across time and placement. B6 tests custody, portability, deletion, and whether the whole product works outside its implementation story. Each gate must retain falsifiers and user evidence; benchmark feature breadth cannot substitute for those tests.

## Ideal

One owner can ask Waldo to handle a responsibility and observe the same truthful state through Electron Kennel, mobile, Telegram, and Discord. Waldo can obtain consequential judgment, execute bounded work, perform and independently read back one reversible real-world effect, preserve evidence separately from verification and acceptance, keep unresolved consequences alive, continue eligible work in cloud, recover without duplicate effects, and support inspect/correct/revoke/export/delete. Health may improve the plan when consented but is never required.

The future root goal is:

> Complete Waldo backend gates B2–B6 through their stated contract, implementation, adapter-conformance, cross-surface-acceptance, and operational-proof criteria, preserving one canonical writer per aggregate and advancing only dependency-frontier work. Use credentialed staging and real reversible API tests where required. Prepare production promotion, but do not deploy or activate production without separate explicit authorization.

Do not set a token budget unless the human explicitly requests one. Continue the same goal through bounded sessions and durable gate handoffs; context length is not a reason to weaken acceptance.

If production approval is not granted, the goal remains active at the B6 deployment barrier. A complete change plan and green staging evidence are not `operational_proof_passed` and cannot close #111 or the goal.

## Goal and ask protocol

The future session prompt should explicitly authorize creation of the persistent goal above. The root then creates that one goal without an inferred token budget and reports its exact objective back to the human. It does not create a product `GoalRecord` or a separate goal per gate.

The root continues autonomously through already authorized, reversible repository work. It asks the human only when the answer changes authority or product truth: an ADR or released-contract revision; a new canonical writer/store or migration policy; access to staging tenants or credentials; permission for a real reversible external effect and cleanup; PR merge order when several reviewed lanes converge; destructive deletion/restore drills; or staging/production promotion. A child never asks around the root to obtain broader authority.

At each ask, provide the exact decision, evidence, safe default, consequence of waiting, rollback, and which lanes remain productive meanwhile. An unanswered ask parks only the dependent lane; the root keeps eligible read-only/review work moving and records the blocker in #116.

## Stable criteria

Each criterion is atomic. Its anti-criterion is a falsifier, not an optional warning.

| ID | Criterion | Anti-criterion |
|---|---|---|
| G-1 | Only the current dependency frontier has write-capable worktrees; later gates may prepare read-only evidence. | B2–B6 start as five independent writers or share unreleased assumptions. |
| G-2 | Every aggregate, migration lineage, generated contract surface, and retry path has one named owner. | Two lanes edit one canonical writer, schema lineage, barrel, fixture family, or composition root concurrently. |
| G-3 | A contract release records source SHA, fixture tree/hash, compatibility window, consumers, and byte-preservation checks. | A downstream lane copies DTOs or implements against a draft. |
| G-4 | Provider, environment, effect, or channel completion remains an observation until the owning Evidence, Verification, Acceptance, Outcome, and OpenLoop reducers act. | A receipt or `done` state implies product closure. |
| G-5 | Exact owner, purpose, revision, digest, authority, credential, lease/fence/cancellation, and retry bindings are derived or re-read server-side. | Caller, surface, model, provider, connector, or payload mints authority or canonical truth. |
| G-6 | Every real adapter passes injected conformance before credentialed staging, then recovery/ambiguity/revoke tests with synthetic accounts. | A fixture, dashboard response, or one successful API call is called real integration. |
| G-7 | Kennel, mobile, Telegram, and Discord consume released fixtures and prove the same ordered owner truth; health-connected and health-declined paths both remain complete. | A presence becomes a truth store or declining health removes core capability. |
| G-8 | Export/delete/restore inventories every landed B1–B5 store and proves no resurrection before production promotion. | B6 is implemented against a guessed store list or unreachable deletion is called complete. |
| G-9 | Every reviewed head receives exact-SHA QA, Security/authority where triggered, independent Standards and Spec review, and the applicable clean Linux/Docker wall. | A fix lands after review without invalidating and repeating the affected evidence. |
| G-10 | PASS, FAIL, SKIPPED, UNAVAILABLE, DEFERRED, and NOT RUN remain distinct; production deployment requires a separate explicit approval. | Missing infrastructure or fake/local success is rewritten as green or deployed implicitly. |

## Dependency frontier

Gates are integration checkpoints. Issues or explicitly named vertical slices are the worktree unit.

```text
B1 landed
  |
  v
#82 JudgmentAuthority
  |
  v
#84 Evidence + Verification + Acceptance
  |
  v
#85 OpenLoop + ReEntry
  |
  v
#108 presence/projection writer + released HomeProjection
  |
  v
#95 Home recipe/actions against the released projection
  |
  v
       B3 contract barrier
                |
       #104a conversation/persona/read path
                |
       #86 channel-neutral contract
                |
       #104b channel delivery integration
                |
               B3
                |
              #90 CapabilityRegistry
                |
              #91 credential custody
                |
              #109 Connections
                |
              #83 EffectEngine
                |
       +--------+---------+
       |                  |
      #89           #112 and #113
   Calendar         Telegram / Discord
       +--------+---------+
                |
               B4
                |
       +--------+------------------+
       |                           |
      #92                         #114a
 governed context          delivery/recovery core
       |
      #94 commitments/scheduler
       |
      #110 routines/cloud execution
       |
      #114b scheduled/routine delivery integration
       |
               B5
                |
              #96 export/delete/restore
                |
              #111 staging/production proof
```

The current tracker wording contains a B3 dependency cycle: #104 depends on B3 channel contracts while #86 depends on #104. Before B3 writes, the root must amend or decompose the issues into `#104a -> #86 -> #104b`. #108 owns the `HomeProjection` aggregate and release; #95 consumes that release and may prepare recipes read-only beforehand but cannot write the same projection surface concurrently. Parallel agents must not resolve either boundary through private interpretation.

## Promotion barriers

| Barrier | Required release or proof | What it unlocks |
|---|---|---|
| B2 entry | Freeze released #81 v0.4 B2 fixture bytes; create a separate additive contract lane only if source proves insufficiency. | #82 implementation. |
| B2 closure | Judgment, Evidence, Verification, Acceptance, OpenLoop, and ReEntry commands/projections pass replay, stale-revision, authority, and no-implied-closure tests. | B3 presence/Home consumers. |
| B3 presence | Owner/presence link/revoke, ordered HomeProjection, cursor/gap/account-switch, conversation, and channel-safe fixtures are released. | B4 capability/credential/connection work and surface integration. |
| B4 authority | CapabilityRegistry, workload identity, credential handles, ConnectionBinding, and frozen EffectIntent semantics are landed. | Real Calendar/inbox, Telegram, and Discord adapters. |
| B4 adapter | Calendar mutation/read-back, inbox read/triage/draft, Telegram, and Discord pass injected conformance and credentialed staging with synthetic data. Email sending remains a separate effect family and cannot be inferred from inbox read/draft proof. | B5 durability work. |
| B5 durability | Governed context, scheduler, routines, workspace/checkpoint, and channel-outbox contracts plus recovery evidence are pinned. | B6 complete store inventory. |
| B6 ownership | Registered-store export/delete/restore matrix passes no-resurrection proof. | #111 release evidence and a production change plan. |

## Parallel worktree topology

With four active contexts, use the root plus at most two implementation children and one independent reviewer. During a final review wall, park a writer if additional independent review is required.

```text
Human
  └─ root goal session
       ├─ implementation child A: one issue/slice
       ├─ implementation child B: disjoint and contract-pinned only
       └─ independent QA / Security / Standards / Spec reviewer
```

Safe parallel lanes include read-only research, failure maps, threat models, adversarial-fixture proposals, Standards versus Spec review, staging plans, and downstream client shells against an exact released fixture SHA. After the B4 authority barrier, Calendar, Telegram, and Discord adapters may run in parallel if their files and vendor semantics are disjoint.

Never parallel-write shared contracts or protocol barrels, generators/OpenAPI/golden fixtures, Durable Object schema initialization, Supabase migrations/history guards, Coordinator/composition roots, runtime barrels/errors, or one canonical writer. “Different files” is insufficient when lanes change one aggregate or schema lineage.

## Root responsibilities

The root owns the live DAG and frontier in #78/#116; exact base and clean-worktree checks; issue promotion; file/module/writer arbitration; schema/migration allocation; contract release pins; merge order; cross-repository consumer notification; source spotchecks; review orchestration; landed-tree verification; gate integration walls; and durable checkpointing.

The root does not edit a running child worktree. To take over, stop the child, receive `SESSION HANDOFF`, transfer ownership explicitly, then write. Child output is evidence to inspect, not proof to trust.

## Child source packet

Every write-capable child receives:

- owning issue, gate, parent goal/session, repository, worktree, branch, base commit and tree;
- integration branch, merge order, dependency commits, contract and fixture hashes;
- required rules, architecture sections, ADRs, source and tests;
- exact allowed files/modules and forbidden shared surfaces;
- canonical writer and data-authority boundary;
- atomic acceptance, anti-criterion, first expected failing test, and mutation/adversarial candidate;
- verification wall, toolchain/environment pins, privacy/security/health classification;
- rollback/feature flag, consumers, compatibility requirements, and stop conditions.

Before edits, the child posts `SESSION START` on its issue and #116.

## Child return contract

Each child returns base/head/tree SHAs, divergence and dirty state; branch/worktree/PR and disposition; exact files/contracts/schemas/migrations/modules changed; red-to-green TDD evidence; classified focused/full wall output; contract preservation or release hashes; exact-SHA review verdicts; residual risks and rollback; consumer actions; and a `SESSION HANDOFF` link. It recommends adopt, reject, rework, or block.

## Unblock and stop rules

The child posts `NEEDS DIRECTION` and stops when it needs an unowned writer/store, migration, Durable Object schema change, released-contract revision, ADR change, another lane owns the same seam, provider ambiguity lacks safe reconciliation, private material would enter an unsafe surface, a surface/adapter would become canonical, required credentials/test tenants are unavailable, or deployment/destructive external mutation lacks approval.

For ordinary breaker failures, fix and rerun no more than two times. On the third failed QA cycle, decompose and escalate. The root resolves shared-seam blockers by selecting one writer and release order; it never asks both writers to continue and reconcile later.

## Exact-SHA convergence wall

1. Freeze the child implementation SHA.
2. Run focused tests, `/check-contract`, and applicable typechecks.
3. Run `/break-feature` or `qa-breaker`.
4. Run mandatory Security/authority review for auth, credentials, RLS, Durable Object state, health, effects, or external I/O.
5. Run independent Standards and Spec reviews.
6. Run the applicable pinned clean Linux/Docker/full-history wall at the same SHA.
7. Invalidate and repeat affected evidence after any fix.
8. Root-inspect diff, writers, schema history, generated artifacts, privacy, and rollback.
9. Merge only with human authorization and the recorded order.
10. Compare landed and reviewed tree SHAs; rerun gate integration from fresh `main`; then update issues/docs and promote the next frontier.

## Real-world testing ladder

Real testing begins progressively; it does not wait until all B6 code exists.

1. Strict contract fixtures and rejection tests.
2. Reducer/property tests for replay, stale revision, owner isolation, cancellation, and mutation candidates.
3. Injected adapter conformance with synthetic data.
4. Credentialed staging test tenants for Calendar/inbox, Telegram, and Discord.
5. One reversible Calendar mutation, independent read-back, and restoration.
6. Telegram/Discord signature, linking, duplicate/reorder/replay, rate-limit, block/removal, revoke, and ambiguous-send drills.
7. Kennel/mobile/channel staging with health connected and declined.
8. Laptop-off routine, restart/checkpoint, outbox recovery, budget, and deletion tests.
9. Export/delete/pre-deletion-backup restore and no-resurrection proof.
10. Load/cost/observability/incident/rollback exercise.
11. Separate production plan and explicit approval.
12. Limited canary, canonical live verification, and rollback readiness.

Use synthetic/test accounts until credential custody, privacy, retention, deletion, observability, and revoke controls pass. No dashboard parsing, fake adapter, or fixture response establishes real integration.

## Verification and learning

At each issue and gate boundary, record the smallest failed assumption, the test or source that exposed it, whether the lesson belongs in a guard/fixture/skill/ADR, and the exact consumer affected. Use `/compound-learning-capture` only when the lesson is reusable; do not turn one failure into broad policy by assertion.

This documentation contract is accepted when it is internally consistent with live issues, the architecture lock, the capability matrix, and the benchmark audit; `git diff --check` and `pnpm@10.34.4 verify:guards` pass; and an independent Spec/Standards review finds no sequencing or truth-classification blocker.
