# Obligation Spine Sprint Ledger

**Started:** 2026-08-08  
**Pinned base:** `dd434e9bb5dedc4a135e43e30571a141599e8991` (`origin/main`)  
**Umbrella:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78)  
**Authority:** the architecture lock and issue-specific accepted decisions remain normative. This file records execution, dependency, and verification evidence; it is not a parallel product specification.

## Sprint outcome

Build the durable obligation spine: Waldo carries a person's responsibility from canonical capture through bounded execution, judgment, authority, effects, evidence, independent verification, acceptance, and exact re-entry. Provider, executor, connector, and presence reports remain untrusted observations. None can close an Outcome.

## Non-negotiable acceptance boundary

- Stable responsibility identity and canonical owner binding survive retry and restart.
- An `OpenLoop` exists from responsibility capture, before provider or executor work begins.
- Authority grants are exact, backend-owned, expiring/revocable, and consumed atomically with frozen effect intent.
- Cancellation, expiry, revocation, reconciliation ambiguity, and stale lease generations fail closed.
- Provider or Kennel completion cannot imply Verification, Acceptance, OpenLoop closure, or Outcome closure.
- Evidence and Acceptance remain bound to the exact Outcome and acceptance-criteria revision.
- Eviction/restart restores the exact surviving `ReEntryPoint` without inventing continuity.
- One reversible connector effect is proven by independent read-back before the connector capability is claimed.
- Kennel remains an untrusted executor/presence with its own local operation ledger, never an alternate Waldo truth store.

## Corrected dependency graph

The live #78 body is a historical planning input, not current sequencing authority. This run applies these corrections:

1. #80 resolves to one execution writer: evolve `PlanningExecutionModule` into the `RunLoopEngine`; do not add a sibling writer over `ExecutionRequest`, `AgentSession`, or `ExecutionLease`. Keep provider invocation and execution-environment adapters as distinct internal seams: AI Gateway is not a Kennel-style executor.
2. #81 publishes contract slices vertically, beginning with `AcceptanceCheck`, then the judgment/authority, effect, evidence/verification/acceptance, continuity, admission, and executor families required by consumers.
3. #85 is two delivery points: capture-time OpenLoop/ReEntry creation, then verified acceptance/reopen/release transitions.
4. #88 is two barriers: fake-backed spine integration first; real adapter/connector integration only after adapter conformance.
5. #89 depends on #83, #90, and #91. It does not depend on its own later integration barrier.
6. #86 is not on the critical path until Telegram terminal-ambiguity/idempotency semantics satisfy the delivery contract or the contract is deliberately changed.
7. Migration numbers are allocated at rebase/integration time from the live schema head. Issue-time V6-V10 assignments are invalid.
8. #92 and #93 are outside this sprint. Existing governed context and provider seams may be consumed, but their full promotion is not required for the obligation-spine proof.

## Single-writer and integration reservations

| Surface | Sole writer in this run | Reservation |
|---|---|---|
| `packages/contracts/**` | contracts lane | No other lane edits contracts; consumers pin its commit. |
| Migration policy/guard | migration-safety lane | No feature migration is allocated until the guard lands and live schema head is rechecked. |
| Feature migration blocks in `do-schema.ts` | one merge captain at integration | Feature lanes return schema requirements; the captain allocates and integrates in dependency order. |
| `PlanningExecutionModule` / future `RunLoopEngine` | execution lane | No sibling execution aggregate writer. |
| `waldo-coordinator.ts`, `run-loop/do.ts`, `runtime/src/index.ts` | #88 integration lane | Module PRs expose transaction-scoped seams and do not self-wire. |
| This ledger | root orchestration lane | Workers return evidence packets; only root updates rows. |

## Worktree ledger

| Lane | Issue / purpose | Branch | Worktree | Base / dependency | Allowed writes | State | Head / PR |
|---|---|---|---|---|---|---|---|
| orchestration | #78 evidence and barriers | `codex/obligation-spine-ledger` | `/Users/shivanshfulper/.codex/worktrees/osp-orchestrator/waldo-backend` | `dd434e9` | this ledger only | active | pending |
| contracts | #81 protocol v0.4 vertical slices | `codex/obligation-contracts` | `/Users/shivanshfulper/.codex/worktrees/osp-contracts/waldo-backend` | `dd434e9` | `packages/contracts/**` | active | pending |
| migration safety | parallel migration collision guard | `codex/obligation-migration-guard` | `/Users/shivanshfulper/.codex/worktrees/osp-migration/waldo-backend` | `dd434e9` | guard/tests/docs required by the guard | active | pending |
| execution decision | #80 writer map and safe refactor plan | `codex/obligation-execution-map` | `/Users/shivanshfulper/.codex/worktrees/osp-execution/waldo-backend` | `dd434e9` | bounded decision artifact only | complete | `a12c6d2`; PR pending |
| credential boundary | #91 secret-flow map and safe first slice | `codex/obligation-credential-map` | `/Users/shivanshfulper/.codex/worktrees/osp-credential/waldo-backend` | `dd434e9` | disjoint port/guard or evidence artifact | active | pending |

## Planned implementation barriers

| Barrier | Required evidence | State |
|---|---|---|
| B0 preflight | live base pinned; dirty main untouched; worktrees and ownership recorded | passed |
| B1 contract kernel | strict schemas, exports, valid and rejection fixtures; contract tests; downstream handoff commit | active |
| B2 migration safety | collision/reservation guard is non-vacuous and feature migrations remain unallocated | active |
| B3 capture continuity | capture transaction creates canonical OpenLoop and exact initial ReEntry | blocked by B1/B2 |
| B4 judgment and authority | exact grant, revision/digest binding, expiry/revocation, atomic consume | blocked by B1/B2 |
| B5 effects | frozen intent before I/O, single retry owner, reconcile-before-retry, terminal ambiguity | blocked by B4 |
| B6 evidence and acceptance | candidate evidence separated from independent verification and human acceptance | blocked by B1/B2 |
| B7 capability/identity admission | version-pinned capability admission and model-invisible credential broker seam | blocked by B1/B2 |
| B8 execution seam | one writer plus fake Kennel executor conformance and cancellation/fencing | blocked by #80/B1 |
| B9 fake-backed whole spine | nine-step public path, restart/replay, breaker and mutation probes | blocked by B3-B8 |
| B10 real reversible effect | real connector, frozen key, independent read-back, ambiguity drill | blocked by B5/B7/B9 |
| B11 Claude review packets | independently reproducible PR evidence; no merge performed by this run | blocked by each PR completion |

## Migration allocation ledger

No feature migration version is reserved yet. A row may be added only after rebasing the owning integration branch onto live `origin/main` and recording `max(existing)+1`.

| Feature | Dependency commit | Live schema head at allocation | Allocated version | Captain | State |
|---|---|---|---|---|---|
| none | — | — | — | — | unallocated |

## Evidence packet schema

Every worker handoff and PR must report:

- issue and observable scope;
- base SHA and dependency SHA(s);
- permitted and changed files;
- first failing test and why it proved absence of the behavior;
- passing focused tests and mutation/non-vacuity probe;
- contract/architecture mapping;
- full verification-wall result with skipped/unavailable checks separated;
- security, standards, specification, and breaker dispositions where triggered;
- commit SHA, PR URL, residual blockers, rollback, and next dependency.

## Evidence log

| Time (Asia/Kolkata) | Lane | Event | Evidence / disposition |
|---|---|---|---|
| 2026-08-08 | orchestration | Base pinned | `origin/main` and clean worktrees start at `dd434e9`; the original main checkout has unrelated user changes and is not used for edits. |
| 2026-08-08 | orchestration | Authorship decision | Codex owns implementation lanes for this sprint. Claude is reserved for later independent PR review. |
| 2026-08-08 | orchestration | TDD policy | Vertical public-interface RED-GREEN cycles; mocks only at external boundaries; no bulk speculative contract scaffolding. |
| 2026-08-08 | execution decision | #80 source map complete | `a12c6d2` proves `PlanningExecutionModule` is the only behavioral writer for the current request/session/lease tables. It also corrects #81/#87: provider adapters and execution-environment adapters remain different categories behind one durable engine. |
| 2026-08-08 | orchestration | Worker transport recovery | Contract and migration worker streams disconnected; worktrees were inspected before resumption. Contract had no diff; migration retained one self-test diff. No work was discarded or duplicated. |

## Honest capability status

Until later rows contain their required proof, every capability remains independently classified. `contract_defined` never implies `module_implemented`; module tests never imply adapter conformance, cross-surface acceptance, or operational proof.

| Capability | Architecture specified | Contract defined | Module implemented | Adapter conformance | Cross-surface acceptance | Operational proof |
|---|---:|---:|---:|---:|---:|---:|
| obligation spine v0.4 | yes | no | no | no | no | no |
| exact judgment and authority | yes | no | no | no | no | no |
| governed external effect | yes | no | no | no | no | no |
| evidence, verification, acceptance | yes | no | no | no | no | no |
| OpenLoop and ReEntry | yes | no | no | no | no | no |
| Kennel executor | yes | no | no | no | no | no |
| credential broker | yes | no | no | no | no | no |
| reversible connector | yes | no | no | no | no | no |
