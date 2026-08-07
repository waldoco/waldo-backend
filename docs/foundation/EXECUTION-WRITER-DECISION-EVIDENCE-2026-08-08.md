# Execution writer decision evidence

**Date:** 2026-08-08

**Pinned `origin/main`:** `dd434e9bb5dedc4a135e43e30571a141599e8991`

**Issue:** [#80](https://github.com/Pin4sf/waldo-backend/issues/80)

**Status:** implementation evidence and recommendation, not an accepted ADR

**Authority:** the [architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md) and accepted ADR history remain normative.

## Verdict

Choose **Option A: one generalized `RunLoopEngine` writer** for target
`ExecutionRequest`, target `RuntimeRun`, `AgentSession`, and `ExecutionLease` state.
Do not add a sibling Kennel writer.

Apply one correction to the issue wording before encoding the decision in contracts:
the AI Gateway is a provider adapter, while Kennel is an execution-environment adapter.
They must not be collapsed into one `ExecutorRef` adapter interface. The one
`RunLoopEngine` module should own the durable lifecycle and use distinct internal
provider-invocation and execution-environment seams.

This backend artifact does not close #80. The issue explicitly requires an accepted ADR
in `waldo-brain`, including migration and rollback. That ADR should ratify Option A with
the adapter-category correction above.

## Decision experiment

Two hypotheses were tested against source:

1. **Single-writer hypothesis:** `PlanningExecutionModule` already owns the reusable
   request/session/lease invariants, so it should deepen into `RunLoopEngine`.
2. **Sibling-writer hypothesis:** Kennel execution has a materially independent durable
   lifecycle that requires another writer beside the planning module.

The single-writer hypothesis would be falsified if Kennel required a different authority
root or transaction boundary, if another module already wrote the planning execution
tables, or if request/session/lease state did not share idempotency, fencing,
cancellation, and ambiguity invariants. None of those falsifiers was observed.

The sibling-writer hypothesis is instead contradicted by the definitive writer matrix,
the same-DO transaction requirement, and the current storage ownership. The architecture
lock assigns the complete aggregate family to one `RunLoopEngine`; the final architecture
also requires provider and executor observations to normalize before they affect durable
state ([writer rules](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md#42-ownership-and-definitive-writer-rules)).

## Current writer inventory

| Durable state | Observed writer | Evidence | Disposition |
|---|---|---|---|
| `planning_execution_requests` | `PlanningExecutionModule` only | All source inserts/updates are in [`planning-execution-module.ts`](../../packages/runtime/src/coordinator/planning-execution-module.ts); the table begins at line 574 of [`do-schema.ts`](../../packages/runtime/src/do-schema.ts). | Generalize this writer. |
| `planning_agent_sessions` | `PlanningExecutionModule` only | Session inserts and transitions are at lines 232-248, 375, 544-574, 660-668, 728-737, and 795-806 of [`planning-execution-module.ts`](../../packages/runtime/src/coordinator/planning-execution-module.ts). | Preserve one writer. |
| `planning_execution_leases` | `PlanningExecutionModule` only | Claim, recovery, fence, expiry, and cancellation-generation writes are at lines 121-184, 353-376, 515-542, and 684-775 of [`planning-execution-module.ts`](../../packages/runtime/src/coordinator/planning-execution-module.ts). | Preserve and generalize these invariants. |
| WorkUnit authorization state | `OutcomeModule` | [`authorizePlanningInCurrentTransaction`](../../packages/runtime/src/coordinator/outcome-module.ts) changes the WorkUnit and emits its domain event at lines 304-369. | Remains separate; `RunLoopEngine` must not write WorkUnit truth. |
| Planning cross-aggregate commit | `WaldoCoordinator` transaction runner | [`authorizePlanningTurn`](../../packages/runtime/src/coordinator/waldo-coordinator.ts) commits WorkUnit authorization plus execution request/session/projection/idempotency at lines 188-254. | Coordinator sequences; owning modules still produce their writes. |
| Provider issue/reconcile I/O | `RunLoopDO` shell through `RuntimeLLMProvider` | [`RunLoopDO.#executePlanningTurn`](../../packages/runtime/src/run-loop/do.ts) prepares durable state, performs I/O outside the SQLite transaction, then settles through the Coordinator at lines 460-598. | Keep external I/O outside transactions. |
| Legacy `runtime_runs` substrate | private `RunLoopDO` methods | [`#openRuntimeRunInCurrentTransaction`](../../packages/runtime/src/run-loop/do.ts) and transition helpers write the legacy table beginning at lines 4001 and 4081. | Do not rename it into target `RuntimeRun`; it is a documented false friend. |
| Public planning route and failure mapping | responsibility Worker adapter | The adapter derives provider/executor references server-side at lines 193-261 and maps typed domain conflicts to content-free responses at lines 353-357 of [`worker-adapter.ts`](../../packages/runtime/src/responsibility/worker-adapter.ts). | Reuse the trust boundary; add no client-selected executor authority. |

No source outside `PlanningExecutionModule` writes the three planning execution tables.
`do-schema.ts` provisions them, but is not a behavioral writer. `RunLoopDO` and
`WaldoCoordinator` host and sequence the module; neither directly writes those tables.

## Current execution path

```text
authenticated public request
  -> responsibility Worker adapter
  -> signed owner-derived RunLoopDO RPC
  -> WaldoCoordinator authority check
  -> same-DO transaction:
       OutcomeModule authorizes WorkUnit
       PlanningExecutionModule persists ExecutionRequest + AgentSession
  -> RunLoopDO performs provider I/O outside the transaction
  -> same-DO settlement transaction:
       PlanningExecutionModule validates lease/fence/generation
       persists provider result + session transition + candidate plan
```

The path already exhibits the desired split between a durable engine and an outer I/O
shell. Generalizing the durable module deepens the existing seam; a sibling writer would
duplicate its hardest invariants.

## Required adapter-category correction

The target architecture explicitly draws two separate seams from `RunLoopEngine`:
`ProviderAdapter` for Codex, Claude, Hermes, Pi, and future providers, and
`ExecutionEnvironmentAdapter` for Kennel, containers, and Computer preview
([architecture lines 161-186](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md#4-target-container-architecture)).
Kennel is specifically the first local `ExecutionEnvironmentAdapter`
([Kennel boundary](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md#111-boundary)).

Current v0.3 also stores these identities separately:
`planningProviderReferenceV03Schema` and `planningExecutorReferenceV03Schema` are distinct
contracts at lines 200-211 of
[`responsibility-planning-turn-v0-3.ts`](../../packages/contracts/src/protocol/responsibility-planning-turn-v0-3.ts).
The Worker stamps both server-side, but the runtime calls only `RuntimeLLMProvider`; the
literal `run_loop_planning_executor` is used as the lease holder at lines 529-539 of
[`run-loop/do.ts`](../../packages/runtime/src/run-loop/do.ts). There is no current executor
adapter behind that identifier.

Therefore:

- define a provider reference and an execution-environment reference as different
  contracts;
- let an `AgentSession` bind the provider and environment manifests it actually uses;
- keep provider issue/reconcile behind a provider-invocation port;
- keep Kennel start/resume/steer/pause/cancel/reconcile behind an
  execution-environment port; and
- normalize both families' results into typed, untrusted execution observations before
  `RunLoopEngine` changes session state.

Provider-neutrality is proved by replacing providers without changing Waldo truth.
Environment portability is proved by replacing Kennel with another admitted execution
environment. They are related product properties, not one adapter category.

## Implementation slices and barriers

### Barrier 0: ratify and correct the decision

1. Accept an ADR for Option A in `waldo-brain`.
2. Correct #81 and #87 so they do not require the AI Gateway and Kennel to implement one
   `ExecutorRef` interface.
3. Keep the architecture-lock rule: `RunLoopEngine` is the sole target execution writer;
   `RunLoopDO` remains the deployed shell name during migration.

**Proof:** ADR accepted, issues cite it, contract proposal preserves provider and execution
environment as distinct categories.

### Slice 1: publish general execution contracts

The contracts lane should publish strict, versioned `ExecutionRequest`, `AgentSession`,
`ExecutionLease`, execution-operation, and execution-observation schemas. They must bind:
owner and WorkUnit revision; provider and execution-environment manifest refs; context and
authority refs; operation/request digest; lease/fence; cancellation generation; budgets;
and observation provenance.

Resolve these cardinalities in the contract before schema work:

- current SQL allows only one execution request per `(owner_id, work_unit_id)`;
- current SQL allows only one AgentSession per execution request; and
- target WorkUnits and scenarios permit multiple sessions and repeated execution attempts.

**Proof:** valid/invalid fixtures, strict unknown-field rejection, digest conflict,
revision/generation cases, and Kennel consumption of the same fixtures.

### Slice 2: deepen `PlanningExecutionModule` into `RunLoopEngine`

Rename/generalize the module while initially preserving v0.3 behavior and storage. Keep
planning-specific provider rendering and candidate-plan validation outside the durable
engine interface. The engine interface should express durable commands such as admit,
claim/reclaim, accept observation, mark ambiguity, cancel, and read projection.

Do not move provider or Kennel I/O into `WaldoCoordinator` or a SQLite transaction.

**Proof:** all existing planning tests remain green, including atomic authorization,
restart reconciliation, no blind reissue, settlement rollback, lease expiry, fence
renewal, cancellation fencing, hostile input, and content-free public 409 mapping.

### Barrier 1: serialize the schema migration

One migration captain owns `do-schema.ts`. Rebuild/rename the planning execution tables
into canonical execution tables only after the general contracts fix cardinality and
state vocabulary. Preserve rows and digests; do not create new canonical tables with a
second writer while the planning writer remains live.

The existing `runtime_runs` table is a legacy scheduled/tool/delivery FSM with fields such
as trigger, variant, tool scratch, and delivery state
([runtime contract](../../packages/contracts/src/runtime/run.ts)). The source-pinned
architecture calls it a false friend and forbids a name-only promotion
([current-state finding](../planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md#33-preserve-but-do-not-let-current-code-define-the-product)).
Leave it as an explicitly legacy substrate until target `RuntimeRun` semantics and a
preservation migration are defined.

**Proof:** migration collision rollback, row-for-row upgrade preservation, fail-closed
downgrade once generalized rows exist, schema-manifest freshness, and `runtime_runs`
unchanged.

### Slice 3: add a fake execution-environment adapter

Add an in-memory execution-environment adapter behind the Kennel operation protocol:
stable operation ID/digest, `StartSession`, `ResumeSession`, `SteerSession`,
`PauseSession`, `CancelSession`, and `ReconcileOperation`. The outer `RunLoopDO` shell
performs adapter I/O; `RunLoopEngine` alone persists lease/session transitions.

**Proof:** same operation/same digest is idempotent; same operation/different digest
conflicts; two claimants yield one lease holder; reconnect reconciles before retry;
stale fence/generation observations are rejected or quarantined; provider/session `done`
does not mutate Outcome, Verification, Acceptance, or closure.

### Barrier 2: capability and identity admission

Do not activate a real Kennel adapter until the CapabilityRegistry and authenticated
presence/executor identity can pin eligibility, protocol version, manifest digest,
expiry, revocation, and quarantine. The current v0.3 Worker literals are safe only for
the fixed empty planning harness; they are not general capability admission.

**Proof:** revoked/expired/version-drifted executor is ineligible before enqueue and
before I/O; client-supplied owner, authority, grant, verification, acceptance, and closure
fields fail before routing or durable mutation.

### Slice 4: real Kennel adapter and cross-surface acceptance

Implement the authenticated Kennel `ExecutionEnvironmentAdapter` and device-local
operation ledger. The backend remains retry owner. Kennel persists local operation intent
before spawning/resuming, reports bounded observations with a contiguous cursor, and
reconciles after reconnect.

The acceptance comparison should be at the `RunLoopEngine` lifecycle interface, not by
pretending the AI Gateway and Kennel implement the same adapter. Provider-backed planning
and Kennel-hosted sessions may share canonical session transitions while using their
respective internal seams.

**Proof:** shared fixture conformance in both repos, fake-backed backend integration, then
real `Pin4sf/kennel` cross-surface acceptance. A fake proves the contract only.

## Test matrix for the generalized writer

| Case | Required assertion |
|---|---|
| Atomic admission | WorkUnit transition and ExecutionRequest commit together or neither commits. |
| Duplicate admission | Same request ID/digest returns the persisted result; changed digest is a content-free 409. |
| Concurrent claim | Exactly one lease/fence wins; the loser performs no external I/O. |
| Expired lease | Reclaim increments the fence before reconcile; an old fence cannot settle. |
| Cancellation | Generation increments across request, session, lease, and outbound command; late output cannot mutate canonical state. |
| Disconnect after start | Reconcile stable operation ID; never blind-start another process/session. |
| Ambiguous observation | Session remains honestly ambiguous/reconciling; no candidate Evidence, Verification, Acceptance, or closure is fabricated. |
| Hostile executor report | Server-owned owner, authority, credential, verification, acceptance, and closure fields are rejected. |
| Capability drift | Revoked, expired, quarantined, or version-drifted adapter is denied before enqueue and before I/O. |
| Provider/harness terminal | `done` changes only admitted execution/session observation state; Outcome remains unchanged. |
| Eviction/restart | The exact request, lease, fence, generation, operation key, and acknowledged cursor survive reconstruction. |
| Public failure mapping | Expected conflicts stay generic 409/404 responses and do not call the internal failure reporter. |

Mutation checks should at minimum revert the typed conflict used for a cancelled retry,
remove the lease-generation update, bypass the fence comparison, and turn reconcile into
issue. Each corresponding test must fail.

## Ownership and overlap boundaries

| Surface | Single owner during implementation | Other lanes |
|---|---|---|
| `packages/contracts/**` execution vocabulary and fixtures | Contract writer | Consume only after its commit is pinned. |
| `PlanningExecutionModule` / future `RunLoopEngine` | Execution writer | No parallel edits. |
| `do-schema.ts` migration and schema manifest | Migration captain | Feature branches do not preassign migration numbers. |
| `WaldoCoordinator`, `RunLoopDO`, runtime `index.ts` integration | Integration owner after module barriers | Module/adapters return evidence packets; they do not integrate themselves. |
| Kennel adapter implementation | Adapter owner after contract and capability barriers | Must not write execution tables or Outcome truth. |
| Orchestration ledger | Sprint orchestrator | This artifact is evidence input only. |

## Remaining blockers and unknowns

1. **Blocked:** #80's accepted ADR is not present in this repository's accepted-ADR
   manifest.
2. **Blocked:** #81/#87 currently conflate provider and execution-environment adapters.
3. **Blocked:** general request/session cardinality and target `RuntimeRun` semantics are
   not yet published contracts.
4. **Blocked for real Kennel:** capability admission, authenticated executor identity,
   credential brokering, and the Kennel client/operation ledger are not implemented here.
5. **Unverified:** no `Pin4sf/kennel` source or runtime was inspected in this pass; Kennel
   implementation claims above come from the locked architecture and issue scope, not
   current cross-repo proof.

## Proof level

This pass establishes `architecture_specified` evidence for the writer decision and an
implementation order. It does not establish a new contract, runtime implementation,
adapter conformance, cross-surface acceptance, or operational proof.
