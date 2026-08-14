# B1 execution-environment port frontier — issue #87 handoff

## Identity

- **Session:** source task `019ffffa-ccea-7ef3-ab83-2af4391c80f1`; clean-worktree continuation owner for [#87](https://github.com/Pin4sf/waldo-backend/issues/87)
- **Repository / gate:** `Pin4sf/waldo-backend` / B1
- **Issue / umbrella / coordination:** [#87](https://github.com/Pin4sf/waldo-backend/issues/87) / [#78](https://github.com/Pin4sf/waldo-backend/issues/78) / [#116](https://github.com/Pin4sf/waldo-backend/issues/116)
- **Branch / worktree:** `codex/87-execution-environment-port` / `/Users/shivanshfulper/.codex/worktrees/6c03/waldo-backend`
- **Base:** `origin/main@cffae3b406e3141b26649e502d3c1fad1a14dd08`
- **Reviewed dependency:** #80 runtime `eebe931fb94cf4d5847c7accac9e19842ade5ad4`; landed/reviewed tree `43aa5b98cb28b9396dec0c80bf6f3c287c03e394`
- **Released contract dependency:** #81 `df0abae1c74c24029556f47ba8b7ed49e83a40b8`; fixture tree `adff7e52da78d5523363a634eef1df8d62b3dffb`
- **Runtime candidate:** `07636b200fbd2e2558bd07348c0a7e2fa92fa017`
- **Commits:** frontier docs `60ed065`; initial port/fake `ea82bee`; authority hardening `8a5e30c`; expired-recovery correction `508e7c1`; repeat-operation investigation `57631c8`; private trusted-intent and adapter-pin correction `233faaa`; unresolved-effect gate `4a50b6a`; retry-fence liveness correction `07636b2`
- **PR:** publish only after the final exact-SHA wall and independent reviews pass; the live issue/PR is current authority after publication

This ledger supersedes only stale next-session directions for #87. It does not rewrite the historical [#80 writer ledger](./2026-08-14-b1-sole-execution-writer.md) or [#81 contract release ledger](./2026-08-14-b1-contract-fixture-release.md).

## What Was Built

Issue #87 adds a leaf-only backend execution-environment boundary under `packages/runtime/src/execution-environment/`:

- one `ExecutionEnvironmentPort` with effectful `execute` and read-only `recover` for `start`, `resume`, `steer`, `pause`, `cancel`, and `reconcile`;
- an independent server-pinned descriptor for adapter ID/version, complete execution-environment reference/manifest, and exact native/emulated/unsupported capability versions;
- a private server operation-intent resolver whose strict opaque reference/digest is unavailable to dispatch callers and adapters as an authority input;
- canonical request/attempt/session/lease/fence/cancellation/provider/environment/context binding derived from #80 state and rechecked before recovery, immediately before issue, and after issue;
- SHA-256 operation identity over the server intent plus the complete bounded command; recover-before-issue and exact recovered/nested receipt identity binding;
- a deterministic fake with shared receipt, verified-command, and authority-high-water stores for restart, duplicate, stale-delivery, two-claimant, adapter-substitution, disconnect, expiry, and reconciliation proof;
- strict attributable observation/reconciliation drafts which materialize only through existing public `WaldoCoordinator` commands.

No production composition root or public route uses this seam. `WaldoCoordinator` remains the public authority boundary and `PlanningExecutionModule` remains the only canonical v0.4 execution writer. No contract, fixture, migration, DO schema, dependency, root runtime export, real adapter, staging, deployment, or #88 routing change was added.

## What Works (with evidence)

### Observed

- The session began clean at `origin/main@cffae3b`, `0/0` divergence. #80 was closed, PR #125 merged, #87 had no overlapping writer, and #88 remained blocked.
- `SESSION START` was posted to #87 and #116 before writes; `ready-for-agent` was removed only after the claim.
- Focused source proof at runtime candidate `07636b2`: four port/fake/Coordinator/#80-writer files / 54 tests pass; both runtime typechecks pass; `git diff --check` passes.
- The runtime wall at `07636b2` passed 42 files / 1,060 tests.
- Independent QA breaker, mandatory Security/authority review, and Standards review pass at exact source SHA `07636b2`. Spec review and the complete documentation-inclusive wall remain final-head gates.
- Contracts remain 67 files / 1,560 tests. The #81 contract/fixture trees, eight Supabase migrations, DO schema, and dependency lock are byte-unchanged from `origin/main`.
- Native macOS Supabase bootstrap repeated the unchanged `public.users already exists` failure in the first migration. This is `FAIL — environment`, not a source pass. The clean Linux/Docker host-network wall is the required repository oracle.

### Decision

- Descriptor/capability truth is server-pinned, not adapter-self-attested. Unsupported fails closed; emulated never reports native.
- Dispatch callers provide only an action and, for steer, a bounded reference/digest. They cannot provide operation identity, owner, Outcome, WorkUnit, authority, provider, environment, context, lease/fence/cancellation values, or credentials.
- A private server resolver supplies the stable operation-intent reference/digest. Unrelated observations cannot turn an indeterminate retry into a new operation. A genuinely new repeat operation requires a distinct trusted intent.
- Recovery is read-only and allowed for an expired but still matching binding. `known_not_applied` requires a fresh active-lease check immediately before `execute`. This permits post-expiry failed reconciliation without permitting expired issue.
- `execute` invocation is the effect linearization point. Conforming adapters must atomically enforce expiry, lease/fence/cancellation high-water, adapter/environment pinning, idempotency, and target-side fencing without an unfenced asynchronous gap.
- Candidate Evidence remains a reference/digest observation and cannot certify Evidence admission, Verification, Acceptance, Outcome completion, or OpenLoop closure.

### Verification classification

| Class | Evidence |
|---|---|
| PASS | focused port/fake/Coordinator/#80 writer tests; runtime wall; runtime worker and integration typechecks; independent QA/Security/Standards source reviews; contracts; guards; diff check; unchanged contract/fixture/migration/dependency surfaces |
| FAIL — environment | native macOS Supabase bootstrap at unchanged first migration: `public.users` already exists |
| SKIPPED | Supabase Preview, consistent with the established local verification path |
| UNAVAILABLE | GitHub Actions unless PR checks become available after publication |
| DEFERRED | #88 public routing, real Kennel/cloud/local adapters, staging, deployment, live consumers, B2-B6, Supabase-versus-D1 |
| NOT RUN | any real credential, provider, execution environment, production effect, or cross-surface acceptance test |

The final clean Linux/Docker `pnpm verify`, exact final head, remote-head equality, and final independent QA/Security/Standards/Spec dispositions belong in the #87/#116 `SESSION HANDOFF`; they must not be inferred from this pre-publication runtime candidate.

## What Doesn't Work Yet

| Severity | Disposition | Owner | Dependency | Gap |
|---|---|---|---|---|
| blocking for #88 | blocked | future #88 owner | #87 landed evidence and explicit authorization | public WorkUnit-to-execution routing remains outside this branch |
| bounded architecture limit | preserved | future routing/intent owner | released v0.4 / #80 writer | #80 has no canonical per-command resume/steer/pause intent record; this seam consumes a stable private server intent but does not persist or reconstruct that intent after total resolver-state loss |
| adapter obligation | deferred | each real adapter owner | real adapter issue | target-side atomic fencing, credentials, payload authorization, deployment, and live recovery require separate proof |
| product proof | deferred | B2-B6 owners | dependency gates | adapter completion does not prove Evidence, Verification, Acceptance, Outcome, OpenLoop, surface, staging, or production acceptance |

### Hypothesis and falsifier disposition

The hypothesis survived only after rejecting two unsafe shortcuts: caller-variable intent metadata and generic observation high-water. The final seam instead requires a non-caller-accessible trusted intent. If a production router cannot durably supply that identity without a new canonical writer, migration, or released-contract change, it must stop and request direction; #87 does not hide that requirement in fake state.

## Architecture Decisions or Conflicts

```text
future trusted router (#88; not built here)
  -> private stable operation intent + current #80 aggregate
  -> ExecutionEnvironmentBoundary binding and descriptor checks
  -> adapter recover (read-only, outside SQLite transaction)
  -> if known-not-applied: fresh authority/expiry check
  -> adapter execute (atomically fenced external issue)
  -> strict attributable draft
  -> WaldoCoordinator public observation/reconciliation command
  -> #80 sole-writer SQLite transaction
```

Provider invocation and execution environment remain different categories, identities, manifests, operations, observations, and proof ledgers. A provider/session receipt cannot substitute for an execution-environment observation.

The deterministic adapter store is external-effect conformance state only. It cannot persist canonical ExecutionRequest, Attempt, Session, Lease, Observation, cancellation, reconciliation, or product truth.

## Parallel Agent and Worktree Ledger

| Agent | Role | Write authority | Disposition |
|---|---|---|---|
| root | #87 integration owner | claimed files only | implemented and source-checked every adopted finding |
| Locke | planner | none | adopted after source check |
| Meitner | workflow mapper | none | adopted after source check |
| Noether | independent QA breaker | none | PASS at exact source `07636b2` after earlier blockers were adopted |
| Kuhn | mandatory Security/authority reviewer | none | PASS at exact source `07636b2` after earlier blockers were adopted |
| Aquinas | Standards reviewer | none | PASS at exact source `07636b2` after earlier blockers were adopted |
| independent Spec reviewer | acceptance/scope review | none | adapter-choice blocker adopted; final exact-SHA verdict required |

The worktree remains the retained #87 review checkout. No unrelated checkout or uncommitted work was modified.

## Hard-Won Lessons

- Stable retry identity cannot come from a caller nonce or a generic session cursor. It must name the same trusted operation intent across restart and unrelated progress.
- Read-only recovery and effect authority are different: expiry blocks new issue, not receipt inspection or failed reconciliation.
- A local reread cannot close the final network gap. The port must make adapter/target fencing part of the conformance contract and test the physical issue linearization point.
- Adapter identity and complete environment identity belong in the external authority high-water; a lease/fence alone does not prevent two adapters from issuing.
- Fake proof establishes backend contracts only. It does not establish durable production intent storage, real adapter behavior, or product completion.

## Next-Session Prerequisites

1. Read the live #87 PR and #116 handoff, then verify local head, remote head, base, checks, and review comments before changing anything.
2. Keep #88 blocked unless #87 is explicitly authorized and landed. Do not merge or deploy #87 without explicit human authorization.
3. Preserve the trusted-operation-intent boundary. If #88 needs new canonical persistence or contract fields, post `NEEDS DIRECTION` rather than adding a second writer.
4. Treat all real adapter, credential, staging, deployment, and cross-surface work as separate proof levels.

## Files Changed

Runtime:

- `packages/runtime/src/execution-environment/port.ts`
- `packages/runtime/src/execution-environment/binding.ts`
- `packages/runtime/src/execution-environment/conformance.ts`
- `packages/runtime/src/execution-environment/deterministic-fake.ts`
- `packages/runtime/src/execution-environment/index.ts`
- `packages/runtime/test/execution-environment-port.test.ts`
- `packages/runtime/test/execution-environment-port.property.test.ts`
- `packages/runtime/test/execution-environment-coordinator.test.ts`

Documentation:

- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`
- `docs/foundation/EXECUTION-LEDGER.md`
- `docs/ledger/2026-08-14-b1-execution-environment-port-frontier.md`
- `docs/planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md`
