## Phase HEY-15 → HEY-16 Handoff

Status: local implementation/review evidence is complete; HEY-15 remains **In Progress** until the reviewed branch is PR-merged. HEY-16 remains blocked on that merge.

- [observed] On 2026-07-13, the [HEY-15 Linear ticket](https://linear.app/heywaldo/issue/HEY-15/backend-recall-before-act-module-deterministic-memory-consult-before) was reconciled to the implemented fake-first scope and received a verification-evidence comment. [Draft PR #64](https://github.com/Pin4sf/waldo-backend/pull/64) now contains the branch. The ticket intentionally remains **In Progress** while the PR is a draft; a human must mark it ready, review it, and merge it before HEY-15 can be Done or HEY-16 can proceed.

### What Was Built

- [observed] A fake-first, owner-bound `createRuntimeRecallGateway()` that consumes the existing `RecallGateway<RuntimeRecallContext>` contract without a new public seam.
- [observed] Parallel committed-memory and episode reads with bounded source arguments, skip/unmapped-key behavior, atomic all-empty source failure, and row-local partial admission.
- [observed] Current-invocation Scribe admission for prompt-destined retrieved text and the optional generic query hint; only the existing Scribe implementation is used.
- [observed] Closed, best-effort recall telemetry and typed canary halts without emitting content, identifiers, queries, exceptions, health values, or source handles.

### What Works (with evidence)

- [observed] First source failure settles the fake gateway without waiting for a hung sibling: targeted Vitest coverage passes in `packages/runtime/test/recall-gateway.test.ts`.
- [observed] Bounded descriptor snapshots reject malformed/over-limit/exotic source responses without invoking their iterator; safe rows retain source order.
- [observed] Raw-health-looking text, prompt-injection text, invalid taint/trust, provisional memory, malformed rows, and unsafe hints do not enter results, source args, `query_used`, or telemetry; a current canary halts before reads.
- [observed] Result construction precedes telemetry callbacks, so a synchronous observer cannot mutate the injected clock and change an already-decided invocation.
- [verified] Focused recall suite: `1 file / 68 tests` passed. Runtime suite: `25 files / 693 tests` passed. Recursive typecheck, all 11 static guards, `git diff --check`, and the scoped forbidden-surface scan passed.

### What Doesn't Work Yet (known issues)

- [blocked] **MEDIUM — total-hang deadline:** if both source fakes hang, H15 has no timeout/cancellation policy. A real adapter must own an invocation deadline, cooperative `AbortSignal` propagation, cleanup, and abort telemetry before that is added.
- [blocked] **HIGH — source proof:** no actual owner routing, storage reader, committed/pending provenance, FTS/BM25/RRF, or performance proof exists.
- [blocked] **HIGH — prompt seam:** HEY-16 owns canonical `renderRecall(result, conflicts, authority)` invocation, conflict-pair authority, and prompt composition. H15 does not call a renderer or provider.
- [blocked] **HIGH — operational proof:** no R2, staging, sink, deployment, provider, Alpha, or production behavior is proven.

### Architecture Decisions Made During This Phase

- [decision] Preserve source rejection as a private tagged failure through unwrapped `Promise.all`; do not use `Promise.allSettled`, `Promise.race`, a timer, or cancellation in this fake-first seam.
- [decision] Snapshot only bounded own data descriptors from an array-like source before row admission; never invoke source-owned iteration. A transparent/cooperative proxy may be indistinguishable in userland, so a real decoder boundary remains future work.
- [decision] Bound the injected clock at `9999-12-31T23:59:59.999Z`, the existing four-digit ISO contract maximum.
- [decision] Re-admit the optional generic hint via existing Scribe using conservative external taint; non-canary rejection omits it, while a current canary raises a typed closed `hint` halt before reads.
- [decision] Use module-private `WeakSet` identity rather than `instanceof` for caught private errors, and construct results before observational telemetry.
- [observed] These are local H15 implementation decisions under ADR-0031 and existing contracts; they do not amend the Master Reference or create a new canonical architecture decision.

### Hard-Won Lessons

- [observed] `Promise.allSettled` is safe for collecting every outcome but wrong for ADR-0031's first-failure fail-open liveness condition. ECMAScript’s aggregate rejection behavior makes the private tagged-rejection design sufficient for this bounded case.
- [observed] `AbortSignal` is cooperative: without a signal-bearing interface and a ratified deadline owner, a gateway-side timeout would not prove cancellation of a non-cooperative source.
- [observed] A callback described as “telemetry” is still attacker/integrator-controlled code at the seam; it must be downstream of the result decision.

### Prerequisites for Next Phase

1. [blocked] Review and merge the HEY-15 branch/PR; do not mark HEY-15 Done before that evidence exists.
2. [blocked] Only after merge may HEY-16 consume the reviewed gateway and own the canonical renderer/prompt composition plus conflict authority.
3. [blocked] Keep real-reader provenance, pending-union decisions, FTS, cancellation/deadline design, provider calls, and deployment in separately admitted work.

### Files Changed

- `packages/runtime/src/recall/gateway.ts`
- `packages/runtime/test/recall-gateway.test.ts`
- `docs/superpowers/plans/2026-07-13-hey-15-recall-before-act.md`
- `docs/superpowers/plans/2026-07-13-hey-15-review-repair.md`
- `docs/superpowers/specs/2026-07-13-hey-15-liveness-and-boundary-research.md`

### Verification Boundary

- [verified] The aggregate wall completed package-manager, frozen install, recursive typecheck, and contracts (`49 files / 1197 tests`).
- [blocked] `npx -y pnpm@10.34.4 verify` then stopped at `verify:supabase` because `supabase start is not running`. No service was started.
- [blocked] `tools/eval/run-suite.ts` is absent; no eval-suite pass is claimed.
- [verified] Independent spec/standards, security, health/privacy, contract, and adversarial reviews passed after the final repair.
