# B1 public WorkUnit-to-trusted-execution bridge — issue #88 frontier

## Identity

- **Handoff owner:** authorized #87 merge and build-frontier convergence session; human owner `@Pin4sf`
- **Session / parent / primary agent:** delegated task from source thread `019ffffa-ccea-7ef3-ab83-2af4391c80f1`; primary agent `/root`; no #88 runtime writer was spawned or claimed
- **Review roster:** QA breaker `Noether`; mandatory Security/authority reviewer `Kuhn`; independent Spec/Standards reviewer `Volta`
- **Repository / gate / issue:** `Pin4sf/waldo-backend` / B1 / [#88](https://github.com/Pin4sf/waldo-backend/issues/88)
- **Umbrella / coordination:** [#78](https://github.com/Pin4sf/waldo-backend/issues/78) / [#116](https://github.com/Pin4sf/waldo-backend/issues/116)
- **Implementation source pin:** `origin/main@9a2b11bb2527e0c15dcbfb5f32f86bafe99301d9`
- **Docs handoff branch / worktree / initial commit:** `codex/88-frontier-handoff` / `/Users/shivanshfulper/.codex/worktrees/6c03/waldo-backend` / base `9a2b11bb2527e0c15dcbfb5f32f86bafe99301d9` / initial docs commit `e482f9564bd65f6151fa5ab51cf088cf5f98d94f`; the final PR head and merge disposition are recorded in the live #88/#116 handoff
- **Landed #87 dependency:** PR #126 merge `9a2b11b`; reviewed head `5b3d9f510a8aaa8243a476d2ba97abef08fc8da8`; identical tree `8a202c5ee6d96a297ce203a2036279557b05291a`
- **Earlier dependencies:** #80 runtime `eebe931fb94cf4d5847c7accac9e19842ade5ad4`, landed at `cffae3b`; #81 release `df0abae1c74c24029556f47ba8b7ed49e83a40b8`, fixture tree `adff7e52da78d5523363a634eef1df8d62b3dffb`
- **Implementation branch / worktree / owner:** not yet claimed; the next write-capable session must create a fresh clean worktree from current `origin/main` and register ownership on #88 and #116

This ledger supersedes only stale next-session directions that described #87 as unmerged and #88 as dependency-blocked. It does not rewrite the historical #80, #81, or [#87](./2026-08-14-b1-execution-environment-port-frontier.md) ledgers.

## What Was Built

No #88 runtime implementation is claimed here. The authorized predecessor merge established the dependencies #88 may consume:

- #80 is the sole canonical v0.4 ExecutionRequest/Attempt/Session/Lease/Observation/cancellation/reconciliation writer behind public `WaldoCoordinator` methods;
- #87 adds a leaf-only execution-environment port with effectful `execute`, read-only `recover`, strict server binding, private trusted operation intent, target-side fencing obligations, deterministic fake receipts/high-water, and strict observation/reconciliation materializers;
- PR #126 deliberately adds no public WorkUnit route, production composition root, root runtime export, real adapter, contract/fixture revision, migration, deployment, or live-consumer proof.

#88 owns the missing public composition seam only: one owner-authenticated WorkUnit command must reach the existing writer and environment boundary without becoming a second engine or widening caller authority.

## What Works (with evidence)

### Observed

- PR #126 merged as `9a2b11b`; reviewed head and landed merge have the identical tree `8a202c5`.
- The clean pre-merge Linux/Docker host-network wall at reviewed head `5b3d9f5` passed Node `22.23.2`, pnpm `10.34.4`, Supabase CLI `2.109.1`, contracts 67/1,560, eight migrations plus 53 pgTAP, runtime 42/1,060, integration 2/5, both runtime typechecks, and all guards.
- Independent QA breaker, mandatory Security/authority, Standards, and Spec reviews passed at the reviewed head.
- The public responsibility surface currently exposes the guarded five-route v0.1-v0.3 capture/planning inventory. No public v0.4 execution route or #87 production composition is present.
- Contracts, fixtures, migrations, DO schema, dependencies, root runtime export, and the #80 writer were unchanged by #87.
- #88 was open, unclaimed, and had no concurrent ownership comment at this handoff.

### Decision

- The public request is untrusted. It may identify a bounded command and supply only an expected WorkUnit revision as a concurrency precondition. The server re-reads canonical state and derives or validates the authoritative WorkUnit revision/digest, Outcome binding, owner, authority ceiling, Durable Object route, provider, execution environment, context, lease/fence/cancellation generation, and operation intent; the caller cannot supply or substitute them.
- Gateway/owner-root code derives identity and routing; `WaldoCoordinator` validates and sequences; #80 alone persists canonical execution truth; #87 performs recovery/issue outside the SQLite transaction and returns a bounded untrusted draft for later public Coordinator admission.
- Provider/session/environment completion remains an observation. It cannot mutate Outcome/WorkUnit, admit Evidence, certify Verification, decide Acceptance, or close an OpenLoop.
- Deterministic fake-consumer proof may establish the backend composition contract only. It is not `adapter_conformance_passed`, Kennel/cloud/local-runtime acceptance, staging, deployment, or live product proof.

## What Doesn't Work Yet

| Severity | Disposition | Owner | Dependency | Gap |
|---|---|---|---|---|
| blocking for B1 | active frontier | next #88 owner | landed #80/#87 | no owner-authenticated public command composes canonical WorkUnit authority through the sole writer and environment boundary |
| architecture falsifier | must resolve before effectful implementation | next #88 owner | released v0.4 model | #80 has no canonical per-command resume/steer/pause operation-intent record; if safe public routing requires a new writer, migration, or released-contract field, stop and request direction |
| contract risk | inspect before write | next #88 owner | released #81 fixtures and current five-route manifest | the next session must prove whether an additive public route can use released schemas; it may not silently mutate #81 or overwrite v0.1-v0.3 bytes |
| adapter proof | deferred | future real-adapter issues | #88 fake composition first | target-side authentication/fencing, credentials, payload authorization, and live recovery remain unproved |
| product proof | deferred | B2-B6 | later gates | execution completion still proves no Evidence, Verification, Acceptance, Outcome, OpenLoop, surface, staging, or production result |

## Architecture Decisions or Conflicts

```text
authenticated public request (untrusted payload)
  -> gateway derives owner/presence/session and owner-root route
  -> owner Durable Object / WaldoCoordinator compares the bounded expected revision, then re-reads and validates canonical WorkUnit revision/digest, Outcome binding, and authority ceiling
  -> #80 sole writer commits execution request/claim/session/lease authority
  -> trusted router resolves a stable server intent from an independently proven durable source or stops
  -> transaction ends
  -> existing RunLoopDO remains the trusted composition and I/O shell
  -> #87 recover (read-only)
  -> if known-not-applied: fresh authority/expiry check
  -> #87 execute (atomically fenced external issue)
  -> strict observation/reconciliation draft
  -> public WaldoCoordinator admission
  -> #80 sole-writer transaction
```

The exact durable source of the stable operation intent is intentionally not invented in this handoff. The next session must map current canonical state first. Adapter-local state may deduplicate an external effect but cannot become Waldo's canonical operation-intent or execution writer.

## Acceptance and Falsifiers for #88

Acceptance requires one deterministic fake executor to run one bounded canonical WorkUnit through the authenticated public owner path while preserving:

- exact owner, Outcome, WorkUnit revision/digest, authority ceiling, execution binding, context, provider/environment category, lease/fence/cancellation generation, and stable operation intent;
- one retry owner, recover/reconcile before reissue, no external I/O inside SQLite transaction, and no duplicate physical issue across replay/restart;
- bounded mapped public errors with no owner, Durable Object, authority, credential, provider, environment, or internal-state leakage;
- byte-stable Outcome/WorkUnit and non-self-certifying Evidence/Verification/Acceptance/OpenLoop truth.

The implementation is falsified by any client-supplied owner or routing authority; treating the expected revision as authoritative instead of comparing it to re-read canonical state; cross-owner WorkUnit access; stale revision admission; request-digest conflict treated as replay; provider/environment/context/intent substitution; two claims or adapters acting on one lease; stale fence or cancellation issue; blind restart reissue; timeout/disconnect becoming false decisive failure; any invalid, late, stale, contradictory, or provider-receipt observation being accepted as an execution-environment observation; adapter completion changing product truth; a sibling physical execution engine bypassing the existing `RunLoopDO`; or external I/O inside the SQLite transaction.

## Privacy and Authority Impact

- No authority is widened by this handoff. #88 must keep the public payload limited to a bounded command plus expected-revision precondition, with owner, route, canonical product bindings, authority ceiling, provider/environment/context, operation intent, lease/fence, and cancellation state derived inside the trusted owner path.
- Credentials, raw health data, transcripts, composed prompts, and inline evidence payloads must not enter the public command, v0.4 execution contracts, persisted execution state, adapter command, public error, or logs. Any future credential seam requires audience/purpose/resource/expiry-bound opaque handles and separately authorized review.
- Candidate Evidence remains attributable ref/digest material only and is non-self-certifying. Provider, session, adapter, or execution-environment completion cannot admit Evidence, certify Verification, decide Acceptance, mutate Outcome/WorkUnit, or close an OpenLoop.

## Rollback

- This handoff is documentation and tracker state only. If a dependency pin or readiness assertion is falsified before implementation ownership, revert the docs merge, remove `ready-for-agent`, restore `blocked`, and post the exact unmet dependency on #88/#116; no runtime data or migration rollback is involved.
- Once a #88 implementation session claims the seam, rollback means closing that session's public route/composition behind its existing default-disabled guard and reverting only its bounded branch/PR. It must not roll back or weaken landed #80/#87 authority, rewrite released #81 fixtures, or issue compensating external effects without a separately reviewed plan.

## Parallel Agent and Worktree Ledger

| Lane | Write authority | State |
|---|---|---|
| this handoff session | frontier documentation and tracker convergence only | no #88 runtime source claimed |
| next #88 owner | must register exact branch/worktree/files on #88 and #116 | not yet claimed |
| planner / workflow-mapper | read-only before implementation | required by `AGENTS.md` |
| QA / Security / Standards / Spec | read-only independent review at final SHA | required before merge |

No new runtime worktree is created or implied by this document. The next session must verify live GitHub state and current `origin/main`; those outrank this handoff if they change.

## Hard-Won Lessons

- A stable operation identity cannot be reconstructed from a generic observation cursor or caller nonce. Public routing must consume server-owned durable truth or stop for a separately authorized model change.
- Committing intent and issuing an external effect are different phases. The transaction may persist canonical authority; the adapter call occurs only after commit and must revalidate/fence before issue.
- A public route is an authority boundary, not a forwarding method. Every caller-visible field must earn its place, and server-derived bindings must be non-substitutable.
- Fake composition proof closes only the backend contract gap. Real adapter and product proof remain separate gates.

## Next-Session Prerequisites

1. Fetch current `origin/main` into a new clean worktree; record base/head/divergence and preserve unrelated checkouts.
2. Inspect live #88/#116/#78 state, related PRs, consumers, and concurrent claims. Post `SESSION START` on #88 and #116 before writes; remove `ready-for-agent` only after the seam is actually owned.
3. Read the current public route manifest/OpenAPI, Worker adapter, owner Durable Object composition in `packages/runtime/src/index.ts`, `WaldoCoordinator`, #80 writer/tests, #87 port/fake/tests, and released v0.3/v0.4 schemas/fixtures.
4. Use `/waldo-isa-run-contract` or `/current-ideal-gap`, planner, and workflow-mapper to enumerate every public-to-environment data path and failure path before implementation.
5. Use TDD for the smallest public vertical slice, then `/check-contract`, `/break-feature`, `/code-review`, mandatory Security review, exact-SHA QA/Standards/Spec, and the complete clean Linux/Docker wall.
6. Do not merge, deploy, close #88, start B2-B6, alter released #81 contracts/fixtures, add real adapters, decide Supabase versus D1, or claim live/product acceptance without explicit authorization.

## Files Changed

This frontier-only handoff updates:

- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`
- `docs/foundation/EXECUTION-LEDGER.md`
- `docs/ledger/2026-08-14-b1-workunit-execution-bridge-frontier.md`
- the materially stale backend evidence-pin row in `docs/planning/WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md`

No runtime, contract, fixture, migration, dependency, or deployment file is changed by this handoff.
