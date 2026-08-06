# Next Backend Session Prompt — Responsibility Adapter Conformance

Copy the prompt below into a new Codex session rooted at `waldo-backend`. Its first gate determines whether the Outcome capture module is present in the chosen base; this document does not establish merge status.

---

Continue Waldo's durable responsibility backbone with the smallest production adapter-conformance bullet. Do not repeat the completed responsibility-handshake contract work or the Outcome capture domain/persistence implementation.

## Re-pin before claiming state

1. Read `AGENTS.md`, every file required by `.claude/rules/INDEX.md`, `NEXT-SESSION-PLAN.md`, `AGENT-OPERATING-WORKFLOW.md`, and the three current architecture/product plans.
2. Fetch and pin current `origin/main`; inspect source, tests, PR #75's live state, and its handoff. Plans, PR descriptions, and this prompt are not shipped proof.
3. Preserve dirty checkouts and work only in a clean `codex/` worktree.
4. Use `/waldo-isa-run-contract`, `/codebase-design`, the planner and workflow-mapper, `/tdd`, separate Standards/Spec reviews, the mandatory security reviewer, and `/break-feature`.

## Starting boundary

Released protocol v0.1 remains the strict, byte-stable simple-capture contract from PR #74. Negotiated v0.2 defines optional Mission input, bounded `WorkUnitProposal` records, typed responsibility projection pages with owner-global cursors, and `offlineCommands: "none"`. The implementation evidence in PR #75 places Outcome state and proposal records inside the existing per-owner `RunLoopDO` SQLite boundary, routes root binding through `IdentityPresenceModule`, and allocates domain event cursors through one owner-wide event log. Verify every claim from the pinned source before relying on it.

The local-only methods used for module integration tests are not a production adapter and are not evidence of Kennel conformance.

## Observable outcome

A version-pinned, authenticated production backend adapter can negotiate responsibility-handshake v0.2, route one `responsibility.capture` request to the correct per-owner Durable Object, build the trusted envelope only from server context, invoke the existing Coordinator for authorization/sequencing, and return either the exact idempotent result or a non-enumerating protocol error. `IdentityPresenceModule`, `OwnerEventLog`, `OutcomeModule`, and `ProjectionPublisher` retain their single-writer responsibilities. A read adapter can deliver the typed v0.2 projection page with stable snapshot/cursor behavior. No new durable store, Durable Object, writer, offline command queue, or provider path is introduced.

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

Use the normative [Outcome Finisher ownership split](./NEXT-SESSION-PLAN.md#outcome-finisher-ownership-split), including its clarification about subordinate Kennel capabilities, Waldo completion authority, and Paxel-style analysis.

## Out of scope

- Kennel repository changes or UI;
- Mission execution leases, provider execution, effects, Evidence/Verification, Acceptance, OpenLoop, or ReEntry implementation;
- disconnected local command/draft reconciliation until the accepted ADR conflict is resolved;
- new services, stores, Durable Objects, providers, connectors, personal surfaces, or workspace products.

## Verification and delivery

Run the affected package tests, all schema/fixture freshness and hostile-input guards, `DOCKER_CONTEXT=desktop-linux npx -y pnpm@10.34.4 verify` when that context is available without changing global Docker state, and `git diff --check`. Record passed, failed, skipped, unavailable, deferred, and not-run separately. Commit and open a focused PR against `main` only after the full verification/review wall passes; do not merge it.

End with a `/phase-handoff` report distinguishing `architecture_specified`, `contract_defined`, `module_implemented`, `adapter_conformant`, `cross_surface_accepted`, and `operationally_proven`.

---
