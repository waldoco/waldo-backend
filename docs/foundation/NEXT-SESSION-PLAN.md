# Next Session Plan — Whole-Product Waldo Build

**Status:** current repository entrypoint after the 2026-08-05 architecture lock
**Scope:** backend, Kennel protocol/executor seams, other presences, connectors, governed execution, evidence, continuity, workspace, and distribution contracts

## Build authority

This is one whole-product build across personal assistance, work orchestration, and their bridge. Work is organized through parallel, dependency-aware workstreams; there are no product phases or slices and no team-size scope cuts.

Read in this order:

1. [Architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) — build authority, owner placement, definitive writers, governance, workspace, workstreams, and proof gates.
2. [Final Home + Work architecture](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md) — pinned current state, target contracts/state machines, failure semantics, migration, and unknowns.
3. [Product capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md) — committed product envelope and honest delivery statuses.
4. [Capability source notes](../planning/WALDO_PRODUCT_CAPABILITY_VALIDATION_SOURCE_NOTES_2026-08-04.md) — comparator evidence and interpretation limits.
5. [Contributor onboarding](./CONTRIBUTOR-ONBOARDING.md), [agent workflow](./AGENT-OPERATING-WORKFLOW.md), and [local verification](./LOCAL-DEV-TESTING-PIPELINE.md).
6. Fresh source/tests, the current issue/PR, and accepted ADRs for the exact seam being changed.

Do not treat a planning document as shipped truth. Pin the current `origin/main` SHA, inspect implementation and tests, preserve dirty checkouts, and distinguish `shipped`, `partial`, `stub`, `proposed`, `missing`, and `rejected`.

## Stable kernel

- One Waldo identity and one per-owner backend authority root.
- `WaldoCoordinator` is logically above providers/executors and remains inside the owner Durable Object transaction boundary with `RunLoopEngine` until measured evidence earns another placement.
- The trusted RunLoop remains the only physical execution/effect path while the Coordinator and product domain are added around it.
- Kennel proposes and executes under a valid backend lease; the owner backend admits. Kennel owns local operation/process durability, never canonical identity, memory, Outcome truth, authority, Acceptance, or closure.
- Providers, connectors, people, and execution environments return untrusted observations, receipts, and candidate evidence.
- External effects persist frozen intent and digest before I/O, reconcile ambiguity before retry, and have exactly one retry owner.
- Agent activity, Evidence, Verification, Acceptance, and Open Loop closure remain separate.
- User statements and corrections outrank inference. Health is optional passive context inside a user-grounded purpose, never the product category or authority source.
- Protocol 0.1 advertises `offlineCommands: "none"`. Disconnected presences can show only an explicitly stale read-only projection.

## Session start

1. Run `git status -sb`, inspect worktrees, fetch the relevant remote branch, and record the SHA being claimed.
2. Read the current contract/module/test surfaces for the assigned workstream. Never infer implementation from a plan or ticket.
3. Define one observable outcome, dependencies, data/privacy and authority impact, invalid/degraded cases, exact verification, and rollback.
4. Use the definitive writer matrix. Do not add a second durable writer, alternate truth store, direct provider authority, or speculative microservice.
5. Build against released contracts and shared fixtures. Fakes prove contracts only; real adapter/product claims require version-pinned conformance and cross-surface acceptance.
6. Run the affected package tests plus the full integration gate before merge.

## Current work organization

The architecture lock defines these concurrent workstreams:

- contract and conformance spine;
- owner root and product domain;
- trusted execution and effects;
- Kennel and desktop harness;
- workspace, artifacts, and knowledge;
- connectors and real-world effects;
- personal assistance and continuity;
- work orchestration and distribution;
- security, portability, deletion, and operations.

Dependency edges determine what can integrate, not a smaller product release order. An issue is assignable only when its required contracts, scope, proof cases, and rollback are explicit.

## Known reconciliation requirement

The architecture lock's current offline decision is stricter than accepted ADR-0077 and ADR-0082, which preserve device-local chat drafts. Do not silently choose either behavior. Reconcile the accepted ADRs before merging implementation that removes or retains disconnected draft creation/queueing.

## Historical documents

`HARNESS-RUNTIME-BUILD-PLAN.md`, `HARNESS-WAVE-COORDINATION.md`, July phase handoffs, and the former health-first Alpha sequence are historical evidence. They can explain existing code and tests but do not define current product scope, work order, ownership, or public claims.

## Verification

Documentation-only changes:

```bash
git diff --check
npx -y pnpm@10.34.4 verify:guards
```

Runtime, contract, or integration changes:

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test
npx -y pnpm@10.34.4 --filter @waldo/runtime test
npx -y pnpm@10.34.4 verify
git diff --check
```

Record passed, failed, expired, skipped, unavailable, deferred, and not-run evidence distinctly. A green local test is not staging, production, adapter-conformance, or product-acceptance proof.
