# Responsibility Capture Tracer Bullet — Phase Handoff

**Date:** 2026-08-06
**Starting `origin/main`:** `6aa9c77126c92859cbb33153cd02fd620b1e56e9`
**Review artifact:** PR #75; re-check its live head and status before use
**Authority:** the current architecture lock remains authoritative; this handoff reports implementation evidence only.

## Outcome

PR #75 contains implementation evidence for the smallest owner-domain responsibility-capture module inside the existing per-owner `RunLoopDO` SQLite boundary. The released v0.1 simple-capture command and negotiated v0.2 command both pass the same trusted owner-domain admission. v0.2 can optionally create one Mission and up to 32 ordered canonical `WorkUnit` records. The module persists current state/events/idempotency/projection state in one synchronous Durable Object transaction, returns the exact version-matched persisted result for an exact retry, replays recorded events deterministically, and pages version-compatible Kennel-facing projections.

No production HTTP/gateway adapter is included. Locally guarded Durable Object methods prove only the module and storage seam, not production routing or Kennel conformance.

## Durable ownership and trust

- `RunLoopDO` remains the only physical Durable Object and transaction boundary. No service, alternate store, second Durable Object, or provider execution path was added.
- `IdentityPresenceModule` is the sole writer for the singleton `owner_roots` binding; cross-owner calls fail before idempotency lookup or domain mutation.
- `OwnerEventLog` is the single owner-wide domain-event cursor allocator. Responsibility replay and projections preserve those global cursors and tolerate gaps occupied by other domain families.
- The concrete protocol schemas reject unknown/server-owned fields. Admission recomputes the canonical digest from the admitted surface request and compares it to the trusted envelope, verifies canonical payload equality, and uses the original surface `requestId` for idempotency.
- IDs, owner binding, revisions, timestamps, event cursors, and projection cursors are allocated by the server-side module.
- Outcome, Mission, WorkUnit, and AgentSession remain separate. A real terminal fake RunLoop session is tested to leave Outcome state, revision, and exact user statement unchanged.
- Capture and replay share explicit responsibility-domain capacity ceilings: 10,000 responsibility events and 8 MiB of decoded responsibility-event payload. Other owner-global event families do not consume this domain-specific replay allowance. Capture fails atomically before admitting responsibility history that cannot be reconstructed. Checkpointing/compaction beyond that bounded tracer-bullet policy remains operational follow-up.
- The existing trusted RunLoop remains the only execution/effect path. The tracer-bullet module adds no provider, effect, verification, acceptance, closure, or re-entry behavior.

Durable SQL writes for current aggregate state, the owner-wide event stream/cursor, idempotency result, projection items, and projection snapshot state share one `storage.transactionSync`; an injected failure after the idempotency insert proves all are rolled back, including a newly inserted owner root and cursor allocation. Authentication, routing, and delivery outside the Durable Object cannot be atomic with that commit; persisted idempotency is the retry boundary.

Schema V3 is rewritten because PR #75 is unmerged and no repository, CI, staging, or production evidence shows the earlier PR-only V3 shape was deployed to durable state. If such state exists outside the inspected evidence, migration is blocked until a V4 preservation plan is added; resetting it must not be assumed.

## Protocol additions

Released v0.1 remains byte-for-byte unchanged and its strict simple-capture request, trusted envelope, exact idempotent result, and generic projection envelope are executable through the module. Negotiated v0.2 adds optional Mission input, bounded canonical `WorkUnit` records, typed `responsibility.summary` projection items, and filtered owner-global cursor semantics consistent with `offlineCommands: "none"`. Separate v0.1 and v0.2 fixtures and manifests provide compatibility and freshness evidence.

Raw JSON duplicate-key rejection remains an adapter responsibility because this module receives already-parsed values. The next adapter session must prove that boundary before canonicalization.

## Product ownership split

The normative [Outcome Finisher ownership split](./NEXT-SESSION-PLAN.md#outcome-finisher-ownership-split) preserves the required Kennel capabilities, Waldo authority, and Paxel clarification. This handoff does not duplicate or redefine it. The capture seam validates Kennel-proposed planning input and persists canonical WorkUnits with deny-by-default execution authority and zero budgets. It does not promote, lease, assign, or execute them.

## Delivery status

| Level | Status | Evidence / remaining proof |
|---|---|---|
| `architecture_specified` | yes | Current architecture lock and owner/writer matrix; not rewritten here. |
| `contract_defined` | yes | Released strict v0.1 plus separately negotiated v0.2 planning/projection schemas and dual-version fixtures. |
| `module_implemented` | yes in PR #75 evidence | Coordinator admission, schema V3, single-writer modules, state/event/idempotency/projection transaction, replay, pagination, and focused tests. Current `main` status must be pinned live. |
| `adapter_conformant` | no | No production authentication, raw-body admission, owner-to-DO router, HTTP error mapping, or version-pinned Kennel adapter. |
| `cross_surface_accepted` | no | No Kennel repository/client/UI change or end-to-end product acceptance. |
| `operationally_proven` | no | No staging/production deployment, migration rehearsal on production data, load/retention/compaction proof, monitoring, rollback drill, or SLO evidence. |

## Required next work

Use `NEXT-BACKEND-SESSION-PROMPT.md` for the production adapter-conformance bullet when the pinned base contains this module. Kennel can consume the v0.2 fixtures to implement its proposal and projection client without owning canonical product truth. Canonical WorkUnit promotion, Evidence/Verification, Acceptance/reopen, OpenLoop/ReEntry, governed context compilation, execution leases, and effects remain later domain bullets and must not be inferred from this capture module.

## Verification ledger

The final PR report must record each command as passed, failed, skipped, unavailable, deferred, or not run. For the corrected diff:

- passed: Node 26.4.0 engine check and exact pnpm 10.34.4 frozen dependency install;
- passed: 56 contract test files / 1,465 tests and 33 runtime test files / 907 tests in the final Docker-backed merge wall. Package typechecks, seven migrations, 44 pgTAP assertions, every repository guard, v0.1 fixture immutability, v0.2 fixture generation/freshness, and `git diff --check` also passed;
- passed with `DOCKER_CONTEXT=desktop-linux`: a clean local Supabase reset, seven applied migrations, and 44 pgTAP schema checks as part of the complete `npx -y pnpm@10.34.4 verify` wall;
- passed: separate Standards and Spec reviews, mandatory owner-routing/DO-write security review, and the adversarial breaker pass after their blockers were reproduced and corrected;
- failed during iteration and fixed: the bare `vitest` invocation, initial missing v0.2 module, v0.2 generator resolution of the absent root Vitest binary, five focused runtime assertions that exposed cursor/page/error-contract differences, owner-event high-water corruption and deletion cases, an idempotency record that borrowed another Outcome's cursor, missing v0.1 runtime admission/projection compatibility, and proposal-only WorkUnit persistence;
- skipped: none in the required local wall;
- unavailable: Linear/HEY issue and label evidence because the connector requires reauthentication; hosted GitHub Actions because workflow dispatch returned `422 Actions has been disabled for this user`; production adapter, Kennel client, staging, and production environments are not present and are not claimed;
- deferred by scope: production adapter conformance, Kennel cross-surface acceptance, and operational proof;
- not yet run: independent other-cluster PR review requested with `@waldo-review`;
- not run because no implementation exists: provider/effect, Verification, Acceptance, OpenLoop/ReEntry, and disconnected-draft reconciliation tests.
