# Responsibility Capture Tracer Bullet — Phase Handoff

**Date:** 2026-08-06
**Starting `origin/main`:** `6aa9c77126c92859cbb33153cd02fd620b1e56e9`
**Branch:** `codex/responsibility-capture-outcome`
**Authority:** the current architecture lock remains authoritative; this handoff reports implementation evidence only.

## Outcome

The branch implements the smallest owner-domain responsibility-capture module inside the existing per-owner `RunLoopDO` SQLite boundary. A strict surface request plus server-created trusted envelope can create a canonical Outcome directly, optionally create one Mission and up to 32 ordered WorkUnits, persist current state/events/idempotency/projection state in one synchronous Durable Object transaction, return the exact persisted result for an exact retry, replay recorded events deterministically, and page a typed Kennel-facing projection.

No production HTTP/gateway adapter is added. The module is exercised through locally guarded Durable Object methods; therefore this branch proves the module and storage seam, not production routing or Kennel conformance.

## Durable ownership and trust

- `RunLoopDO` remains the only physical Durable Object and transaction boundary. No service, alternate store, second Durable Object, or provider execution path was added.
- A singleton `owner_roots` row binds the Durable Object to one trusted `ownerId`; cross-owner calls fail before idempotency lookup or domain mutation.
- The concrete protocol schemas reject unknown/server-owned fields. Admission recomputes the canonical digest from the admitted surface request and compares it to the trusted envelope, verifies canonical payload equality, and uses the original surface `requestId` for idempotency.
- IDs, owner binding, revisions, timestamps, event cursors, and projection cursors are allocated by the server-side module.
- Outcome, Mission, WorkUnit, and AgentSession remain separate. A real terminal fake RunLoop session is tested to leave Outcome state, revision, and exact user statement unchanged.
- Capture and replay share explicit owner-root capacity ceilings: 10,000 domain events and 8 MiB of decoded event payload. Capture fails atomically before admitting history that cannot be reconstructed. Checkpointing/compaction beyond that bounded tracer-bullet policy remains operational follow-up.
- The existing trusted RunLoop remains the only execution/effect path. This branch adds no provider, effect, verification, acceptance, closure, or re-entry behavior.

Durable SQL writes for current aggregate state, append-only events, idempotency result, projection items, and projection high-water state share one `storage.transactionSync`; an injected failure after the idempotency insert proves all are rolled back, including the newly inserted owner root. Authentication, routing, and delivery outside the Durable Object cannot be atomic with that commit; persisted idempotency is the retry boundary.

## Protocol additions

The released v0.1 capture payload is extended additively with optional Mission and bounded WorkUnit proposals. A typed `responsibility.summary` projection page now distinguishes Outcome, Mission, and WorkUnit items while retaining the released snapshot/cursor envelope and `offlineCommands: "none"`. Generated JSON Schemas, valid typed projection fixture, and manifest digests are committed and freshness-tested.

Raw JSON duplicate-key rejection remains an adapter responsibility because this module receives already-parsed values. The next adapter session must prove that boundary before canonicalization.

## Product ownership split

| Capability | Kennel’s job | Waldo’s job |
|---|---|---|
| Mission planning | Interactive planning UI; propose Mission and WorkUnits | Validate and persist canonical Mission/WorkUnits |
| Prompt enhancement | Present/edit the brief and send it to Codex | Compile governed context from Outcome, decisions, constraints and evidence requirements |
| Session dashboard | Show running/waiting/blocked/completed sessions | Ensure session status cannot falsely determine Outcome status |
| Agent control | Start, steer, pause, resume, cancel; recover local processes | Authorize the bounded work and determine whether it remains valid |
| Evidence | Gather diffs, tests, artifacts and provider reports | Decide what counts as candidate evidence and run independent verification |
| Re-entry | Show the exact place to return in Kennel | Persist the canonical OpenLoop/ReEntryPoint |
| Completion | Present acceptance/reopen controls | Own verified state and record the user’s acceptance/reopen decision |

“Not a prompt enhancer or agent-session dashboard” does not reject those features. Kennel must provide prompt/context enhancement, session visibility/control, mission planning UI, supervision, and re-entry presentation beneath the Waldo-powered Outcome Finisher. They are not canonical product truth or sufficient completion conditions. Waldo owns and adjudicates durable Outcome/Mission/WorkUnit state, acceptance criteria, authority, verification, OpenLoop, and re-entry state; Kennel proposes, plans, renders, executes, and owns local process recovery. Paxel-style historical session analysis is only an optional evidence/continuity input, not the main product loop.

## Delivery status

| Level | Status | Evidence / remaining proof |
|---|---|---|
| `architecture_specified` | yes | Current architecture lock and owner/writer matrix; not rewritten here. |
| `contract_defined` | yes | Protocol v0.1 plus additive planning payload and typed projection schemas/fixtures. |
| `module_implemented` | yes, on this branch | Coordinator admission, schema V3, state/events/idempotency/projection transaction, replay, pagination, and focused tests. Not shipped until merged. |
| `adapter_conformant` | no | No production authentication, raw-body admission, owner-to-DO router, HTTP error mapping, or version-pinned Kennel adapter. |
| `cross_surface_accepted` | no | No Kennel repository/client/UI change or end-to-end product acceptance. |
| `operationally_proven` | no | No staging/production deployment, migration rehearsal on production data, load/retention/compaction proof, monitoring, rollback drill, or SLO evidence. |

## Required next work

Use `NEXT-BACKEND-SESSION-PROMPT.md` for the production adapter-conformance bullet after this branch merges. Separately, Kennel can consume the committed protocol fixtures to implement its proposal and projection client without owning canonical product truth. Evidence/Verification, Acceptance/reopen, OpenLoop/ReEntry, governed context compilation, execution leases, and effects remain later domain bullets and must not be inferred from this capture module.

## Verification ledger

The final PR report must record each command as passed, failed, skipped, unavailable, deferred, or not run. At handoff-writing time:

- passed: exact pnpm 10.34.4 frozen dependency install; Node 26.4.0 engine check; pre-change contracts/runtime/full `verify` baseline using `DOCKER_CONTEXT=desktop-linux`;
- passed after implementation: contracts package tests (54 files, 1,464 tests); runtime package tests (33 files, 895 tests); frozen install and all package typechecks; local Supabase reset, seven canonical migrations, and 44 pgTAP tests; every repository guard including responsibility fixture freshness; final post-breaker `DOCKER_CONTEXT=desktop-linux npx -y pnpm@10.34.4 verify`; `git diff --check`; independent Standards, Spec, security, and adversarial breaker reviews;
- failed: none in the final wall (review findings were fixed and re-reviewed before this handoff);
- skipped: none in the required local wall;
- unavailable: production adapter, Kennel client, staging, and production environments were not present in this repository/session and are not claimed;
- deferred by scope: production adapter conformance, Kennel cross-surface acceptance, and operational proof;
- not run because no implementation exists: provider/effect, Verification, Acceptance, OpenLoop/ReEntry, and disconnected-draft reconciliation tests.
