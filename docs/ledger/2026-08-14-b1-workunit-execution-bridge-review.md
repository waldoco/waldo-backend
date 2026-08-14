# B1 public WorkUnit-to-trusted-execution bridge — issue #88 review handoff

## Identity

- **Session / owner:** delegated clean-worktree implementation session from source thread `01a00051-6b24-7982-8007-c9b5e0191686`; human owner `@Pin4sf`; primary agent `/root`
- **Repository / gate / issues:** `Pin4sf/waldo-backend` / B1 / [#88](https://github.com/Pin4sf/waldo-backend/issues/88), coordinated through [#116](https://github.com/Pin4sf/waldo-backend/issues/116) and [#78](https://github.com/Pin4sf/waldo-backend/issues/78)
- **Branch / worktree / base:** `codex/88-workunit-execution-bridge` / `/Users/shivanshfulper/.codex/worktrees/df2e/waldo-backend` / `origin/main@4e1695ca8f966b60b3bedbf4467c02e1c22510fe`, initially clean at `0/0` divergence
- **Implementation commits / PR:** `3731e2c50b184d1354d2fbceb5d021af7373d500`, digest-replay correction `27ed9e8f4c4ece91ae9107afffe80aad15608d40`, review PR [#128](https://github.com/Pin4sf/waldo-backend/pull/128)
- **Dependencies:** #81 contract release `df0abae` / fixture tree `adff7e5`; #80 sole writer landed at `cffae3b`; #87 environment boundary landed at `9a2b11b`; #88 frontier handoff landed through PR #127 at base `4e1695c`
- **Planning / mapping:** planner `Zeno`, workflow mapper `Bernoulli`, independent source audit `Chandrasekhar`
- **Review roster:** QA breaker `Planck`; Security/authority `Ohm`; final independent Standards and Spec reviewers are recorded on the exact-SHA PR/issue handoff

This entry supersedes the implementation directions in the [#88 frontier ledger](./2026-08-14-b1-workunit-execution-bridge-frontier.md). It does not supersede the architecture, #80, #81, or #87 ledgers.

## What Was Built

- One additive authenticated `POST /public/responsibilities/work-units/executions` route using strict media type `application/vnd.waldo.responsibility.v0.4+json`. The frozen v0.1 five-route manifest and released #81 execution schemas/fixtures remain byte-identical.
- A strict public `work_unit.start_execution` command carrying only request/presence metadata, a WorkUnit ID, and `expectedRevision`. Owner, Outcome, authoritative revision/digests, authority ceiling, provider, environment, context, operation intent, attempt, lease, fence, and cancellation generation remain server-derived.
- Worker authentication, body/version/rate-limit checks, owner-root routing, HMAC-bound ingress, and owner Durable Object verification before the command reaches `WaldoCoordinator`.
- A start-only bridge through #80's committed ExecutionRequest/Attempt/Session/Lease, the existing `RunLoopDO` composition and I/O shell, #87 recover-before-execute, and public Coordinator observation admission. Adapter I/O occurs after commit and outside SQLite transactions.
- Restart-stable private start intent reconstructed from #80's immutable persisted `request_json` plus `request_digest`, with the digest recomputed before use. No new operation-intent writer, migration, Durable Object schema, or adapter-local canonical durability was added.
- Durable public idempotency material encoded into the existing ExecutionRequest ID: one full SHA-256 key binds authenticated owner plus public request ID; a second full SHA-256 binds the complete canonical public command. Exact retries recover the same row; altered timestamp, correlation, WorkUnit, revision, or other command material conflicts before effect issue, including a repeat check in the #80 transaction.
- A deterministic local/test-only execution environment proving one zero-authority captured WorkUnit path. Production/non-local composition has no adapter and returns bounded `503`; the existing public-route feature flag remains default-disabled.

## What Works (with evidence)

### Observed

- Contracts: full suite passed at the implementation head before the final documentation convergence: 68 files / 1,563 tests; contract typecheck, OpenAPI generation/freshness, and route parity passed.
- Runtime: 42 files / 1,066 tests passed after the digest-replay correction; both worker and integration TypeScript configurations passed.
- Focused public/Coordinator/environment wall: 4 files / 86 tests passed, including exact retry, Durable Object eviction/reconstruction, concurrent duplicate admission, stale revision, canonical-state mutation after recover, and changed `clientIssuedAt`/`correlationId` conflicts with one physical issue.
- `git diff --check` and repository guards passed during implementation. Released #81 execution source/fixture bytes, migrations, Durable Object schema, lockfiles, and dependency manifests were unchanged.
- The first focused aggregate run hit one real-clock owner-global rate-limit boundary flake; its exact rerun passed. It is classified as a test-isolation failure, not hidden as green.
- Supabase Preview on PR #128 was skipped and is not counted as passing evidence.

### Decision

- The immutable committed #80 ExecutionRequest is sufficient canonical durability for one `start` operation intent because #87 already binds action=`start` into operation identity. This decision does not generalize to resume, steer, pause, or repeated distinct commands.
- Provider/environment completion is only an executor observation. This bridge does not admit Evidence, certify Verification, decide Acceptance, mutate Outcome/WorkUnit completion, or close an OpenLoop.
- This is `module_implemented` plus deterministic local/fake composition proof. It is not real `adapter_conformance_passed`, cross-surface acceptance, staging, deployment, or operational proof.

## What Doesn't Work Yet

| Severity | Disposition | Owner | Dependency | Gap |
|---|---|---|---|---|
| blocking for merge | review only | human owner / PR reviewers | PR #128 exact-SHA wall and review | do not merge #128 without explicit authorization |
| architecture stop | deferred, needs direction before expansion | future execution owner | new canonical intent model | resume/steer/pause or multiple distinct command intents need durable identities not present in #80; do not invent adapter-local durability |
| architecture stop | deferred, needs direction before expansion | future B1/B2 owner | #80 writer/schema decision | a WorkUnit already occupying `planning_execution_requests` through the legacy v0.3 planning flow cannot be upgraded into this v0.4 start path because `(owner_id, work_unit_id)` is unique; this PR fails it closed and does not add a writer, migration, or row-upgrade rule |
| adapter proof | deferred | future real-adapter issues | reviewed credential/fencing contract | target authentication, real provider receipts, credentials, and live recovery remain unproved |
| product proof | deferred | B2-B6 | later gates | Judgment/Evidence/Verification/Acceptance/OpenLoop, presences, Connections, staging, deployment, and live acceptance are not started here |

## Architecture Decisions or Conflicts

```text
authenticated bounded command
  -> Worker auth/rate/body/version checks
  -> owner-derived Durable Object + signed full-command digest
  -> Coordinator canonical WorkUnit/Outcome/authority reread
  -> #80 sole-writer request + attempt/session/lease commit
  -> immutable request_json/request_digest resolves private start intent
  -> transaction ends
  -> #87 recover
  -> fresh canonical authority/lease/fence/cancellation reread
  -> #87 execute through local deterministic proof environment
  -> strict bounded observation draft
  -> public Coordinator admission -> #80 transaction
```

The public request digest is not stored in a new table or adapter. Its complete digest and stable authenticated command key are encoded as server-owned ExecutionRequest identity, which is already immutable #80 state. Same-key/different-digest and same-WorkUnit/different-command checks are repeated in the writer transaction, preventing a race from becoming a second issue.

## Privacy and Authority Impact

- No credentials, raw health data, transcripts, composed prompts, provider receipts, or inline evidence payloads were added to commands, execution state, adapter commands, errors, or logs.
- The public response exposes only request/WorkUnit/execution/attempt identifiers, `started` or `indeterminate`, and a bounded started-observation identity/sequence. It does not expose owner routing, canonical digests, authority, provider, environment, context, lease, fence, cancellation, receipt, or closure state.
- Caller fields remain concurrency and routing references, never canonical authority. Owner routing and every effect-authority binding are derived and rechecked server-side.

## Rollback

- The route remains behind the existing default-disabled public responsibility feature flag; non-local composition has no execution adapter.
- Before merge, close PR #128 or revert its bounded commits. After an authorized merge, revert the #88 merge commit and regenerate OpenAPI. No migration, data rollback, external compensation, or credential rotation is introduced by this slice.
- Do not weaken #80/#87 or modify released #81 fixtures as rollback.

## Parallel Agent and Worktree Ledger

| Lane | Write authority | Result |
|---|---|---|
| `/root` | #88 contracts, public route, Worker/DO composition, Coordinator bridge, tests, generated OpenAPI, handoff docs | adopted and pushed to PR #128 |
| planner / workflow mapper / source auditor | read-only design and failure mapping | adopted: start-only immutable-request intent; no resume/steer/pause expansion |
| QA breaker | read-only adversarial review | first pass found the full-command replay bug; correction landed at `27ed9e8`; final exact-SHA verdict is recorded live |
| Security / Standards / Spec | read-only independent review | exact-SHA verdicts are recorded on PR #128 and #88/#116 handoff |

## Hard-Won Lessons

- A request ID alone is not an idempotency digest. Every authenticated command field that may change must be bound to durable replay identity, even when only a smaller subset reaches domain admission.
- One immutable start intent can be reconstructed from an existing committed ExecutionRequest; control commands with distinct semantics cannot borrow that conclusion.
- A uniqueness constraint is an architecture boundary, not permission to mutate an older row. The v0.3-to-v0.4 upgrade gap remains explicit and fail-closed.
- Fake composition proves ordering and authority mechanics only. It cannot certify credentials, real adapter behavior, user acceptance, or product completion.

## Next-Session Prerequisites

1. Review PR #128 at its exact current head and compare it to base `4e1695c`; confirm all QA, Security, Standards, Spec, contract, runtime, guard, and clean Linux/Docker wall evidence on #88/#116.
2. Do not merge, close #88, deploy, or promote B2 without explicit human authorization. If merge is authorized, verify the landed tree against the reviewed tree before changing issue/frontier state.
3. Treat resume/steer/pause and the v0.3-planned-WorkUnit upgrade as `NEEDS DIRECTION` architecture work. They may not be patched with adapter-local state or an unreviewed row mutation.
4. Keep real adapters, closure runtime, Supabase-versus-D1, staging, deployment, and live/product acceptance out of this PR.

## Files Changed

- Additive v0.4 public HTTP contract, test, export, OpenAPI route/schema, and generated OpenAPI artifacts.
- Worker adapter, ingress operation union, owner Durable Object RPC/composition, bounded error mapping, and root exports.
- `WaldoCoordinator`, `PlanningExecutionModule`, start-only bridge, local deterministic proof environment, and focused/runtime tests.
- Foundation entrypoints, convergence evidence pin, execution-ledger index, and this durable review handoff.

No released #81 execution contract/fixture, migration, Durable Object schema, dependency, lockfile, real adapter, staging, or deployment file changed.
