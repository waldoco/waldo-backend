# Next Session Plan — Whole-Product Waldo Build

**Status:** current repository entrypoint after the 2026-08-05 architecture lock
**Scope:** backend, Kennel protocol/executor seams, other presences, connectors, governed execution, evidence, continuity, workspace, and distribution contracts

## Build authority

This is one whole-product build across personal assistance, work orchestration, and their bridge. Work is organized through parallel, dependency-aware workstreams; there are no product phases or slices and no team-size scope cuts.

The product promise is: **a person can tell Waldo, “Make sure this gets handled,” and trust it to carry the responsibility until the result is verified, accepted, reopened, or consciously released—without taking control away.**

Read in this order:

1. [Product capability matrix](../planning/WALDO_PRODUCT_CAPABILITY_MATRIX_AND_THESIS_VALIDATION_2026-08-04.md) — positioning, promised product envelope, user value/falsifiers, and honest delivery statuses.
2. [Architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) — build authority, owner placement, definitive writers, governance, workspace, workstreams, and proof gates.
3. [Final Home + Work architecture](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md) — pinned current state, target contracts/state machines, failure semantics, migration, and unknowns.
4. [Capability source notes](../planning/WALDO_PRODUCT_CAPABILITY_VALIDATION_SOURCE_NOTES_2026-08-04.md) — comparator evidence and interpretation limits.
5. [Contributor onboarding](./CONTRIBUTOR-ONBOARDING.md), [agent workflow](./AGENT-OPERATING-WORKFLOW.md), and [local verification](./LOCAL-DEV-TESTING-PIPELINE.md).
6. Fresh source/tests, the current issue/PR, and accepted ADRs for the exact seam being changed.

Do not treat a planning document as shipped truth. Pin the current `origin/main` SHA, inspect implementation and tests, preserve dirty checkouts, and distinguish `shipped`, `partial`, `stub`, `proposed`, `missing`, and `rejected`.

## Immediate implementation start

Responsibility-handshake v0.1 and its golden fixtures landed in PR #74. PR #75 is the dated review artifact for the owner-domain tracer bullet and negotiated v0.2 planning/projection additions. Neither this document nor a PR proves current `main`; every continuation must fetch and pin `origin/main`, inspect the live PR state, and classify its evidence again. The [next backend session prompt](./NEXT-BACKEND-SESSION-PROMPT.md) begins with that re-pin and targets adapter conformance only when the module is actually present in the chosen base.

That contract work is the first dependency of one complete responsibility backbone:

1. capture responsibility in Kennel;
2. admit a canonical Outcome in the backend;
3. delegate a bounded WorkUnit to Kennel;
4. receive session observations and candidate evidence;
5. pause for a durable Needs You judgment;
6. perform one reversible effect through the trusted execution path;
7. verify independently;
8. accept, reopen, or release; and
9. restore the exact surviving OpenLoop/ReEntryPoint the next day.

Backend domain/reducer work and the Kennel protocol client begin in parallel as soon as their exact shared fixtures land. More providers, cloud workspaces, DeepWiki ingestion, capability marketplaces, and dashboard breadth must not substitute for this proof.

## Outcome Finisher ownership split

| Capability | Kennel’s job | Waldo’s job |
|---|---|---|
| Mission planning | Interactive planning UI; propose Mission and WorkUnits | Validate and persist canonical Mission/WorkUnits |
| Prompt enhancement | Present/edit the brief and send it to Codex | Compile governed context from Outcome, decisions, constraints and evidence requirements |
| Session dashboard | Show running/waiting/blocked/completed sessions | Ensure session status cannot falsely determine Outcome status |
| Agent control | Start, steer, pause, resume, cancel; recover local processes | Authorize the bounded work and determine whether it remains valid |
| Evidence | Gather diffs, tests, artifacts and provider reports | Decide what counts as candidate evidence and run independent verification |
| Re-entry | Show the exact place to return in Kennel | Persist the canonical OpenLoop/ReEntryPoint |
| Completion | Present acceptance/reopen controls | Own verified state and record the user’s acceptance/reopen decision |

“Not a prompt enhancer or agent-session dashboard” does not reject those Kennel capabilities. Kennel must provide prompt/context enhancement, session visibility/control, mission planning UI, supervision, and re-entry presentation beneath the Waldo-powered Outcome Finisher. They are not canonical product truth or sufficient completion conditions. Waldo owns and adjudicates durable Outcome/Mission/WorkUnit state, acceptance criteria, authority, verification, OpenLoop, and re-entry state; Kennel proposes, plans, renders, executes, and owns local process recovery. Paxel-style historical session analysis remains an optional evidence/continuity input, not the main product loop.

The capture tracer bullet records bounded canonical `WorkUnit` objects with dependencies, evidence requirements, required capabilities, stop conditions, and server-owned deny-by-default authority, budget, isolation, assignee, and session fields. It does not authorize or execute them: promotion, non-zero execution budget, leases, provider sessions, evidence, verification, and completion remain separate work.

## Stable kernel

- One Waldo identity and one per-owner backend authority root.
- `WaldoCoordinator` is logically above providers/executors and remains inside the owner Durable Object transaction boundary with `RunLoopEngine` until measured evidence earns another placement.
- The trusted RunLoop remains the only physical execution/effect path while the Coordinator and product domain are added around it.
- Kennel proposes and executes under a valid backend lease; the owner backend admits. Kennel owns local operation/process durability, never canonical identity, memory, Outcome truth, authority, Acceptance, or closure.
- Providers, connectors, people, and execution environments return untrusted observations, receipts, and candidate evidence.
- External effects persist frozen intent and digest before I/O, reconcile ambiguity before retry, and have exactly one retry owner.
- Agent activity, Evidence, Verification, Acceptance, and Open Loop closure remain separate.
- User statements and corrections outrank inference. Health is optional passive context inside a user-grounded purpose, never the product category or authority source.
- Protocol 0.1 and the negotiated v0.2 capability advertise `offlineCommands: "none"`. Disconnected presences can show only an explicitly stale read-only projection.

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

## Retired documents

Completed ticket handoffs, July wave plans, superseded app/health-first plans, and one-off verification logs are intentionally absent from the live documentation tree. Git history preserves them for archaeology. Do not restore or cite them as current product scope, work order, ownership, or shipped proof.

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
