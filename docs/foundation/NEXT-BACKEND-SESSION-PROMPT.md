# Next Backend Session Prompt — Responsibility Adapter Conformance

Copy the prompt below into a new Codex session rooted at `waldo-backend` only after the Outcome capture PR has merged.

---

Continue Waldo's durable responsibility backbone with the smallest production adapter-conformance bullet. Do not repeat the completed responsibility-handshake contract work or the Outcome capture domain/persistence implementation.

## Re-pin before claiming state

1. Read `AGENTS.md`, every file required by `.claude/rules/INDEX.md`, `NEXT-SESSION-PLAN.md`, `AGENT-OPERATING-WORKFLOW.md`, and the three current architecture/product plans.
2. Fetch and pin current `origin/main`; inspect source, tests, the merged Outcome capture PR, and its handoff. Plans and this prompt are target intent, not shipped proof.
3. Preserve dirty checkouts and work only in a clean `codex/` worktree.
4. Use `/waldo-isa-run-contract`, `/codebase-design`, the planner and workflow-mapper, `/tdd`, separate Standards/Spec reviews, the mandatory security reviewer, and `/break-feature`.

## Starting boundary

The released protocol v0.1 contract defines strict capture envelopes, canonical request digests, typed responsibility projection pages, and `offlineCommands: "none"`. The Outcome capture module is expected to own canonical Outcome, optional Mission, bounded WorkUnits, idempotency, events, current state, replay, and projections inside the existing per-owner `RunLoopDO` SQLite transaction boundary. Verify all of that from merged source before relying on it.

The local-only methods used for module integration tests are not a production adapter and are not evidence of Kennel conformance.

## Observable outcome

A version-pinned, authenticated production backend adapter can route one protocol-v0.1 `responsibility.capture` request to the correct per-owner Durable Object, build the trusted envelope only from server context, invoke the existing Coordinator for authorization/sequencing, and return either the exact idempotent result or a non-enumerating protocol error. `OutcomeModule` and `ProjectionPublisher` remain the sole domain/projection writers. A read adapter can deliver the released typed projection page with stable snapshot/cursor behavior. No new durable store, Durable Object, writer, offline command queue, or provider path is introduced.

## Required proof

- Raw request parsing rejects duplicate JSON keys before canonicalization, malformed Unicode, oversized bodies, unknown keys, and every server-owned-field smuggling path.
- Authentication and owner-root routing are concrete and fail closed; client input cannot choose owner identity, Durable Object routing, actor authority, revision, IDs, timestamps, or cursors.
- The adapter reconstructs and verifies the trusted request digest against the admitted surface request and preserves the exact user statement.
- Same request identity plus same digest returns the persisted result; a digest mismatch fails without information leakage or partial writes.
- Projection reads enforce owner/root binding, snapshot replacement, cursor-ahead rejection, bounded pagination, and online-only behavior consistent with `offlineCommands: "none"`.
- Cross-owner, cross-account, stale-session, replay, timeout, retry, malformed input, and injected transport failure cases are adversarially tested.
- The adapter adds no provider/session execution and cannot infer Outcome completion from provider `done` or session status.
- Run real version-pinned adapter conformance where the repository supports it. Fakes are contract proof only.

## Product ownership that must remain intact

| Capability | Kennel’s job | Waldo’s job |
|---|---|---|
| Mission planning | Interactive planning UI; propose Mission and WorkUnits | Validate and persist canonical Mission/WorkUnits |
| Prompt enhancement | Present/edit the brief and send it to Codex | Compile governed context from Outcome, decisions, constraints and evidence requirements |
| Session dashboard | Show running/waiting/blocked/completed sessions | Ensure session status cannot falsely determine Outcome status |
| Agent control | Start, steer, pause, resume, cancel; recover local processes | Authorize the bounded work and determine whether it remains valid |
| Evidence | Gather diffs, tests, artifacts and provider reports | Decide what counts as candidate evidence and run independent verification |
| Re-entry | Show the exact place to return in Kennel | Persist the canonical OpenLoop/ReEntryPoint |
| Completion | Present acceptance/reopen controls | Own verified state and record the user’s acceptance/reopen decision |

“Not a prompt enhancer or agent-session dashboard” does not reject those Kennel capabilities. Prompt/context enhancement, session visibility/control, mission planning UI, supervision, and re-entry presentation sit beneath the Waldo-powered Outcome Finisher; they are neither canonical product truth nor a sufficient completion condition. Paxel-style historical session analysis is an optional evidence/continuity input, not the main product loop.

## Out of scope

- Kennel repository changes or UI;
- Mission execution leases, provider execution, effects, Evidence/Verification, Acceptance, OpenLoop, or ReEntry implementation;
- disconnected local command/draft reconciliation until the accepted ADR conflict is resolved;
- new services, stores, Durable Objects, providers, connectors, personal surfaces, or workspace products.

## Verification and delivery

Run the affected package tests, all schema/fixture freshness and hostile-input guards, `DOCKER_CONTEXT=desktop-linux npx -y pnpm@10.34.4 verify` when that context is available without changing global Docker state, and `git diff --check`. Record passed, failed, skipped, unavailable, deferred, and not-run separately. Commit and open a focused PR against `main` only after the full verification/review wall passes; do not merge it.

End with a `/phase-handoff` report distinguishing `architecture_specified`, `contract_defined`, `module_implemented`, `adapter_conformant`, `cross_surface_accepted`, and `operationally_proven`.

---
