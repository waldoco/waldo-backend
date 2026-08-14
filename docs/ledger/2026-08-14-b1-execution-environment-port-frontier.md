# B1 execution-environment port frontier — issue #87 handoff

## Identity

- **Session:** source task `019ffffa-ccea-7ef3-ab83-2af4391c80f1`; clean-worktree continuation owner for [#87](https://github.com/Pin4sf/waldo-backend/issues/87)
- **Parent / owner:** delegated Codex session / human owner `@Pin4sf`
- **Repository / gate:** `Pin4sf/waldo-backend` / B1
- **Issue / umbrella / ledger:** [#87](https://github.com/Pin4sf/waldo-backend/issues/87) / [#78](https://github.com/Pin4sf/waldo-backend/issues/78) / [#116](https://github.com/Pin4sf/waldo-backend/issues/116)
- **Branch / worktree:** `codex/87-execution-environment-port` / `/Users/shivanshfulper/.codex/worktrees/6c03/waldo-backend`
- **Base / integration branch:** `origin/main@cffae3b406e3141b26649e502d3c1fad1a14dd08` / `main`
- **Reviewed dependency:** #80 runtime `eebe931fb94cf4d5847c7accac9e19842ade5ad4`; landed and reviewed trees both `43aa5b98cb28b9396dec0c80bf6f3c287c03e394`
- **Released contract dependency:** #81 `df0abae1c74c24029556f47ba8b7ed49e83a40b8`; fixture tree `adff7e52da78d5523363a634eef1df8d62b3dffb`
- **Current head / PR:** implementation not yet established / not opened
- **Agents:** root integration owner; Locke (`planner`, adopted after source check); Meitner (`workflow-mapper`, adopted after source check)

This entry supersedes only the stale next-session direction that described #80 and PR #125 as unmerged. It does not replace or rewrite the historical [#80 writer ledger](./2026-08-14-b1-sole-execution-writer.md) or [#81 contract release ledger](./2026-08-14-b1-contract-fixture-release.md).

## What Was Built

No #87 runtime implementation is claimed at this frontier. The bounded first write updates the durable handoff from landed #80 truth to active #87 truth before adapter code begins.

The registered #87 source boundary is:

- one backend-facing execution-environment port for `start`, `resume`, `steer`, `pause`, `cancel`, and `reconcile`, plus attributable environment observations;
- deterministic fake-adapter and conformance proof only;
- `WaldoCoordinator` remains the only public execution authority boundary and `PlanningExecutionModule` remains the only canonical v0.4 execution writer;
- no public WorkUnit routing, real adapter, contract/fixture revision, migration, staging, deployment, or live-consumer proof.

## What Works (with evidence)

### Observed

- `origin/main` was fetched and observed at `cffae3b406e3141b26649e502d3c1fad1a14dd08`; the starting worktree was clean and `0/0` from that ref.
- [#80](https://github.com/Pin4sf/waldo-backend/issues/80) is closed and [PR #125](https://github.com/Pin4sf/waldo-backend/pull/125) is merged at `cffae3b`; reviewed runtime `eebe931` and the landed merge have the identical tree `43aa5b9`.
- [#87](https://github.com/Pin4sf/waldo-backend/issues/87) was open, dependency-ready, and had no overlapping active writer when claimed. `SESSION START` was posted on #87 and #116 before repository writes, then `ready-for-agent` was removed.
- [#88](https://github.com/Pin4sf/waldo-backend/issues/88) remains open and blocked on #87.
- #80 exact-SHA proof at `eebe931`: 67 contract files / 1,560 tests, eight Supabase migrations from zero/reset / 53 pgTAP assertions, 39 runtime files / 1,038 tests, 2 integration files / 5 tests, both runtime typechecks, guards, and independent QA/Security/Standards/Spec review passed.
- Native macOS Supabase bootstrap failed against the unchanged first migration because `public.users` already existed. That is failed environment evidence, not a source failure or a pass. The clean Linux/Docker host-network wall passed for #80.

### Decision

- #87 consumes released v0.4 references and the public Coordinator API; it does not expose or invoke trusted `*InCurrentTransaction` methods.
- Adapter input is server-owned and binding-complete. Adapter output is a bounded environment result that cannot supply owner, Outcome, WorkUnit, revision, canonical digest, admission authority, lease/fence/cancellation generation, provider substitution, or product closure truth.
- Provider invocation and execution environment remain separate categories, references, manifests, operations, observations, and proof ledgers.
- External I/O occurs only after a Coordinator transaction returns and before any subsequent Coordinator admission/reconciliation transaction begins.
- Unsupported capability fails closed. Native and emulated support remain explicitly version-pinned and cannot be inferred from a successful-looking result.
- Deterministic fake success proves backend conformance only; it is not Kennel, cloud, local-runtime, staging, deployment, or production acceptance.

### Inference

- Because #80 already derives owner/product binding and trusted receipt time, #87 can preserve authority by translating only server-bound operation envelopes and bounded adapter drafts into existing public Coordinator commands.
- A stable server-owned operation ID/digest plus an adapter-side idempotency/reconciliation ledger can make replay deterministic without allowing adapter-local state to become canonical Waldo state.

## What Doesn't Work Yet

| Severity | Disposition | Owner | Dependency | Gap |
|---|---|---|---|---|
| blocking for #87 completion | active | #87 owner | current implementation | port, fake adapter, conformance suite, exact-SHA wall, and independent reviews are not yet complete |
| blocking for #88 | blocked | #88 future owner | #87 landed evidence | public WorkUnit-to-execution routing is outside this branch and must remain blocked |
| bounded design limit | preserve | #87 owner | released v0.4 / #80 writer | v0.4 persists no separate resume/steer/pause operation-intent record; #87 must not claim durable backend reconstruction of an intent that no existing canonical record contains |
| not in scope | deferred | later B2-B6 issues | their dependency gates | Evidence/Verification/Acceptance/OpenLoop runtime, real adapters, staging, deployment, live consumers, and Supabase-versus-D1 remain unproved |

### Hypothesis and falsifier

**Hypothesis:** one authority-minimizing port can bind every environment call to the canonical #80 aggregate while a deterministic adapter ledger makes duplicate/restart delivery idempotent and reconcilable.

**Falsifier:** stop and post `NEEDS DIRECTION` if safe restart for a required operation needs a new canonical operation writer, migration, or released v0.4 contract change. Do not hide that need in a fake-only hook or silently alter #81.

The implementation also fails if any adversarial case permits adapter-supplied authority or binding, provider/environment substitution, two external issues for one stable operation, stale fence/generation action, blind restart reissue, native-success masquerading, provider receipt admission as an environment observation, contradictory reconciliation settlement, terminal reopening, implied product closure, credentials/content persistence, or external I/O inside SQLite transaction scope.

## Architecture Decisions or Conflicts

### Authority path

```text
trusted caller (future #88, not built here)
  -> WaldoCoordinator public command
  -> #80 canonical writer transaction
  -> server-bound environment operation envelope
  -> ExecutionEnvironmentPort (external I/O, outside transaction)
  -> bounded adapter result / attributable environment draft
  -> WaldoCoordinator public observation or reconciliation command
  -> #80 canonical writer transaction
```

The adapter never receives a write-capable Coordinator or `PlanningExecutionModule`. Canonical ExecutionRequest, Attempt, Session, Lease, Observation, cancellation, and reconciliation state remain owned by #80.

### Durable operation-intent limit

Observed v0.4 state gives durable identifiers for request/attempt/session/lease, a stored cancellation request ID/digest, observations, and reconciliation. It does not define a canonical operation record for each resume, steer, or pause command. Therefore:

- the port may require a server-owned stable operation ID/digest supplied by its trusted caller;
- the deterministic adapter may prove idempotent external issue and snapshot reconstruction for that envelope;
- #87 may not claim the backend can rediscover an unpersisted resume/steer/pause intent after total caller loss;
- adding such canonical durability belongs to a separately authorized writer/contract decision, not an implicit #87 expansion.

### Privacy and authority

- no raw credentials, health data, transcripts, composed prompts, or inline evidence payloads enter the port contract or persisted execution state;
- references and digests remain bounded and attributable but non-self-certifying;
- adapter completion cannot admit Evidence, Verification, Acceptance, Outcome completion, or OpenLoop closure.

## Parallel Agent and Worktree Ledger

| Agent | Role | Write authority | Disposition | Worktree |
|---|---|---|---|---|
| root | integration owner, documentation, implementation, verification, GitHub handoff | claimed #87 files only | active | `/Users/shivanshfulper/.codex/worktrees/6c03/waldo-backend` |
| Locke | planner | none; read-only | adopted after source check | shared read-only view |
| Meitner | workflow mapper | none; read-only | adopted after source check | shared read-only view |

No other checkout or uncommitted work was modified. Any later QA, Security, Standards, or Spec reviewer remains read-only and must be recorded as proposed, reviewed, adopted, or rejected after exact-SHA source checking.

## Hard-Won Lessons

- A port boundary is not an excuse to move canonical truth into adapter state. Adapter ledgers may deduplicate external effects; only #80 records canonical Waldo execution truth.
- “Reconcile before retry” is meaningful only when the same stable operation identity survives restart. Random retry IDs make duplicate issue inevitable.
- A provider receipt and an execution-environment observation can share transport timing without sharing category or authority.
- The absence of a canonical resume/steer/pause intent record is evidence, not an implementation detail to conceal. Claims must stop at the released model's boundary.

## Next-Session Prerequisites

1. Source-check and disposition the planner and workflow maps before adapter code.
2. Use TDD for the smallest vertical slice: exact server binding, fail-closed support declaration, one stable external issue, then bounded observation admission through public Coordinator methods.
3. Add restart, duplicate, two-claimant, cancellation, stale generation/fence, timeout/disconnect, reconciliation contradiction, terminal monotonicity, provider-category, non-closure, privacy, and transaction-order falsifiers.
4. Run focused tests, `/check-contract`, `/break-feature`, runtime/contract/migration/integration verification, repository guards, and the complete clean Linux/Docker wall at one exact SHA.
5. Run independent QA breaker, mandatory Security/authority review, and separate Standards and Spec reviews at the final SHA.
6. Open a review-ready PR linked to #87 and #116 only after acceptance passes; post `SESSION HANDOFF`. Do not merge, deploy, close #87, or promote #88 without explicit user authorization.

## Files Changed

At this frontier write:

- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`
- `docs/foundation/EXECUTION-LEDGER.md`
- `docs/ledger/2026-08-14-b1-execution-environment-port-frontier.md`
- `docs/planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md` only for the materially stale backend source pin/status

Runtime files and final evidence will be appended here after implementation; no future result is pre-claimed.
