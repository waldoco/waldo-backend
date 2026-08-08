# Credential broker source map

**Status:** implementation preflight for issue #91

**Pinned source:** `dd434e9bb5dedc4a135e43e30571a141599e8991`

**Decision:** start the contract, pure state-machine, and deterministic leakage-guard work now. Do not add a production redemption path until the handle contract, writer migration, least-privilege egress identity, and authenticated redemption/effect protocol are separately accepted.

## Result

Issue #91 is four independently reviewable packages, not one change:

| Package | Owner and seam | Dependency | Proof |
|---|---|---|---|
| A0. Contract and deterministic guards | Publish the nonsecret `CredentialHandle`/workload-identity vocabulary, a pure handle/revocation reducer, and a generated forbidden-sink manifest with a drift guard. | Ready now. No DO migration or secret adapter is required. | Contract fixtures and reducer fault tests cover owner, audience, purpose, resource, lease/fence, expiry, state, rotation, and revocation generation. A mutation adding a credential-bearing field or unmanifested text/blob sink fails CI. |
| A1. Handle control plane | `WorkloadIdentityModule` is the sole DO writer for `CredentialHandle` metadata. A runtime port carries opaque handles or content-free receipts only. | A0 plus a reserved DO migration and named merge captain. | Durable equivalents of the A0 fault tests; no credential value or Vault identifier reaches the DO. |
| B. Secret custody and trusted egress | A separately authorized component maps opaque handles to Vault identifiers and performs connector I/O without returning credential material to the runtime. Its implementation location and credential are not yet selected. | **Decision-blocked:** accept a least-privilege identity that does not widen the service-role boundary; a source-pinned Vault migration; and an authenticated, signed, short-lived, single-use redemption/effect permit with an online current-revocation check immediately before I/O. | Local broker tests cover unavailable custody, forged/replayed permits, wrong audience/purpose/resource, expired/revoked/stale-generation handles, lease/fence mismatch, revoke-after-admission, rotation races, ambiguous egress, and exact-canary absence from every B-side log/error/trace/receipt/response. |
| C. Cross-surface canary integration | An integration harness uses distinct synthetic canaries for the existing model-gateway credential and the brokered connector credential, runs planning plus one reversible effect/read-back, then scans the generated forbidden-sink manifest. | **Integration-blocked:** A1 and B, EffectEngine, one real reversible connector, and the integration-head manifest. | Each canary appears only in its own trusted Authorization-injection slot and is absent from model-visible and durable sinks; expired, revoked, forged, replayed, and wrong-audience cases fail before connector I/O. |

This split preserves the architecture lock's `WorkloadIdentityModule` writer assignment and broker/Vault custody rule (`docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md:182`) and its credential exclusion/egress-injection invariant (`:207`). It does not infer that moving code outside `packages/runtime` creates an authorized trust boundary.

## Why production redemption code does not start in this branch

Two plausible production-first slices were tested against source:

1. **Add a runtime-only `CredentialBrokerPort`.** Rejected. The first operation would need a not-yet-published `CredentialHandle`; adding a parallel local value shape would create contract drift. It would also be a hypothetical seam with one unimplemented adapter and no caller.
2. **Reuse the current Scribe canary path as the #91 gate.** Rejected. `CanaryTokens` is exactly three 16-character hexadecimal tokens (`packages/contracts/src/core/trigger.ts:23-35`), and current runtime call sites use fixed values (`packages/runtime/src/run-loop/do.ts:158`). This detects some prompt/trace/persistence leaks, but it neither represents a brokered credential nor enumerates the complete #91 sink set.

A0 is safe to start without either production persistence or a credential value. The action threshold for A1 is a published nonsecret contract and reserved migration. The action threshold for B is higher: the least-privilege identity and authenticated redemption/effect protocol must be accepted before implementation. Until then, production code would guess authority, replay, revocation, and egress semantics.

## Existing identity and secret boundaries

### Owner and presence identity

- The public responsibility adapter authenticates the bearer with Supabase, validates the active session, hashes subject/session identifiers, and returns a content-free canonical authority (`packages/runtime/src/responsibility/supabase-authority.ts:31-85`).
- `IdentityPresenceModule` is the sole DO writer for owner root, presence registration, and active session state (`packages/runtime/src/coordinator/identity-presence-module.ts:44-167`).
- Coordinator admission compares the routed owner and every server-derived authority field before planning (`packages/runtime/src/coordinator/waldo-coordinator.ts:621-653`).

Package A should bind credential-handle metadata to this canonical owner and to a server-admitted execution principal. Surface or model input must not choose owner, audience, purpose, lease, or revocation generation.

### Existing secret mechanisms

- The Cloudflare AI Gateway adapter accepts a secret binding and resolves its value immediately before constructing the Authorization header (`packages/runtime/src/llm/gateway.ts:22-61`, `:110-140`). This is a useful egress-local custody pattern, but it has no owner, audience, purpose, resource, lease, expiry, rotation, or revocation contract and is not a general credential broker.
- Gateway payload logging is explicitly disabled by a literal contract (`packages/contracts/src/adapters/llm.ts:43-53`).
- The runtime package may not reference `SUPABASE_SERVICE_ROLE_KEY`; the blocking guard scans runtime source and config (`scripts/guards/guard-do-only-runtime.mjs:133-155`) and its self-test mutation proves that rule (`scripts/guards/guards-selftest.mjs:277-333`). The same self-test deliberately permits a non-runtime package to reference that binding (`scripts/guards/guards-selftest.mjs:255-265`), so passing this guard does not authorize Package B.
- The repository-wide security rule restricts the service-role key to `build-intelligence` and audit-write paths and says it must never leave that boundary (`.claude/rules/security-checklist.md:140-141`). Package B therefore has no accepted runtime identity yet. Its least-privilege database/RPC grants, secret delivery, rotation, and revocation procedure require an explicit security and architecture decision.

### Supabase/Vault finding

There is no implemented Supabase Vault adapter or Vault SQL precedent in this repository. An implementation search excluding this source map found no `vault.*`, `decrypted_secrets`, `create_secret`, `pgsodium`, or Vault RPC use. Supabase's current Vault interface uses `vault.create_secret` and the access-controlled `vault.decrypted_secrets` view; those official interfaces are design inputs, not evidence of repository implementation ([Supabase Vault](https://supabase.com/docs/guides/database/vault)).

The existing migration comment says “encrypted credentials via Supabase Vault,” but the implementation creates service-role-only `access_token_enc` and `refresh_token_enc` text columns (`supabase/migrations/20260709171953_0005_integrations.sql:28-51`). The schema does not identify the encryption owner, key lifecycle, ciphertext format, rotation behavior, or a Vault secret identifier. Package B must treat these columns as legacy/unproven storage, not as a working Vault adapter. It needs a migration and rollback decision rather than silently reusing them. That decision does not authorize service-role use: Supabase documents service-role/secret keys as elevated credentials that bypass RLS ([Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)).

## Versioned forbidden-sink manifest

A0 must replace reviewer-maintained sink memory with a checked-in, versioned manifest and a generator/drift guard. The generator must enumerate every current DO and tracer text/blob column; the checked-in manifest must also declare non-SQL outputs such as provider requests, reporter/observer records, console output, and connector responses. A schema or persistence change that is not classified must fail CI. The generator mechanism is an implementation choice; the required property is deterministic drift detection.

The current manifest seed must include at least these source-backed families. This table describes inputs to the generated artifact; it is not itself the final manifest.

| Sink class | Current source path | Current protection or gap |
|---|---|---|
| Model-visible prompt and provider payload | `ContextComposer` returns the rendered prompt (`packages/runtime/src/context-composer/composer.ts:94-140`); AI Gateway serializes system/messages to the provider (`packages/runtime/src/llm/gateway.ts:110-152`). | Terminal Scribe rejects configured canaries and known secret patterns. Capture the exact model request and assert absence of both synthetic credentials. The model-gateway credential may appear only in its trusted Authorization-injection slot. |
| Memory and behavior stores | `memory_blocks.content`/`decision_log`, `memory_inbox.claim`/`content`/rationale fields, and `skills.body_markdown` persist text (`packages/runtime/src/do-schema.ts:101-151`, `:233-252`). | These current sinks were absent from the earlier manual baseline. The manifest generator must enumerate them rather than relying on a hand-maintained table. |
| Obligation and responsibility stores | Outcomes, Missions, and WorkUnits persist user statements, briefs, responsibility and multiple JSON fields; owner events, command results, and projections also persist text/JSON (`packages/runtime/src/do-schema.ts:377-459`). | Scan every manifested field, including command and projection payloads, not only canonical events. |
| Planning provider intent | `PlanningExecutionModule` stores only the request digest and content-free execution witness (`packages/runtime/src/coordinator/planning-execution-module.ts:378-415`). | No prompt is stored in this table today. Scan it anyway so later contract drift is detected. |
| Planning and execution state | Planning requests, sessions, invocations, candidate plans, commands, controls, and projections contain governed inputs, provider/executor/capability JSON, execution JSON, plan JSON, results, and projection items (`packages/runtime/src/do-schema.ts:574-667`). | Schema bounds are not credential-canary proof. Every text/blob field belongs in the generated manifest. |
| Canonical events | `OwnerEventLog` persists `payload_json` (`packages/runtime/src/coordinator/owner-event-log.ts:47-64`); planning records status and candidate-plan events (`packages/runtime/src/coordinator/planning-execution-module.ts:583-603`). | Direct schema validation and serialization, not a universal credential canary pass. Package C must scan all event payloads. |
| Product projections | Outcome projection items persist as JSON (`packages/runtime/src/coordinator/outcome-module.ts:111-120`); planning projections do the same (`packages/runtime/src/coordinator/planning-execution-module.ts:809-815`). | Schema-bounded but not credential-canary aware. Scan both tables and future projection tables. |
| Runtime traces | Trace details pass through Scribe and degrade to a content-free `scribe_denied` event (`packages/runtime/src/run-loop/do.ts:4773-4821`). | Protected for current static canaries and patterns. Package C must inject its exact canary set into the test runtime or verify a broker-specific guard before trace persistence. |
| Runtime/checkpoint state | `runtime_invocation_v2.state_json`, `runtime_runs.context_json`, and `scratch_json` are persisted in the DO (`packages/runtime/src/run-loop/do.ts:5076-5123`); persisted rows have Scribe audit/scrub paths (`packages/runtime/src/run-loop/do.ts:5187-5222`, `:5279-5294`). Context checkpoints contain refs, digests, taint, and source metadata rather than prompt text (`packages/runtime/src/context-composer/provenance.ts:112-162`). | Current state is content-minimized but still part of the exact canary scan. Future workspace checkpoints must be added before C passes. |
| Tracer delivery and scheduling stores | `run_candidates.candidate_json`, `outbox.payload`/`last_error`, `held_candidates.candidate_json`, and `schedule.payload_json` persist text/JSON (`packages/runtime/src/tracer/schema.ts:25-28`, `:97-110`, `:175-193`). | These current sinks were absent from the earlier manual baseline. Manifest and scan them, including error fields. |
| Application logs | The public failure reporter logs only event/code/error names (`packages/runtime/src/index.ts:146-153`); unexpected context errors report only phase and error kind (`packages/runtime/src/context-composer/composer.ts:157-175`). | Error messages and causes are intentionally excluded. Package C should capture console and every observer/reporter seam during the turn. |
| Artifacts/tool observations | Current trusted RunLoop stores content-free checkpoint metadata in state and resolves replay artifacts behind an adapter; the target `ArtifactRegistry` and workspace stores are not implemented. | Package C cannot claim artifact/checkpoint coverage until the new artifact/workspace sinks exist or the acceptance case explicitly proves they were not invoked. |
| Supabase operational stores | `oauth_tokens`, `one_time_tokens`, and `agent_logs` exist in Supabase migrations. | Broker custody is allowed only in the declared Vault/egress store. The canary may exist in the test Vault row, but must be absent from `agent_logs`, token metadata, receipts, and all unrelated tables. |

## Interface constraints for package A

The contract slice must resolve these questions before A1 runtime code:

- distinguish the opaque handle identifier from the Vault secret identifier; the latter must never leave package B;
- bind handle metadata to owner, execution principal, WorkUnit/effect resource, audience, purpose, lease/fence, expiry, and revocation generation;
- make state and generation explicit enough for immediate revoke and deterministic rotation races;
- prohibit credential material, authorization headers, refresh tokens, or reusable bearer values in every public/DO contract;
- keep redemption internal to the trusted egress adapter. A general runtime method returning `string` would widen secret visibility and is rejected;
- define content-free broker errors for missing, expired, revoked, wrong-audience, stale-generation, and unavailable cases.

## Decision gate for package B

Package B is not merely a Vault adapter. An opaque handle proves no current authority by itself. Before implementation, an accepted design must identify:

- the least-privilege component identity and exact database/RPC grants without extending the repository's service-role boundary;
- the trust root and canonical signed shape for a short-lived, single-use redemption/effect permit bound to owner, handle, EffectIntent, audience, purpose, resource, lease/fence, expiry, revocation generation, and idempotency/reconciliation key;
- how B performs an authenticated online current-state check immediately before connector I/O, so revocation after admission cannot win a time-of-check/time-of-use race;
- where permit consumption and egress-attempt state commit, how replay is rejected, and which component owns reconciliation after a timeout or ambiguous connector result;
- how the handle maps to a Vault identifier only inside B, including rotation, rollback, and deletion semantics;
- how EffectEngine's pre-I/O validation, idempotency, reconciliation, and terminal-ambiguity rules remain authoritative (`docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md:196-203`).

The repository's signed Worker-to-DO ingress demonstrates an HMAC request-signing mechanism (`packages/runtime/src/responsibility/ingress-signature.ts:30-96`), but reusing its key or protocol for B is not accepted by this map. The identity, signing topology, online check, and atomicity boundary remain explicit decisions.

## Package C test shape

Use two distinct synthetic tokens generated solely inside test adapters: one resolved through the existing model-gateway secret-binding path and one stored only in the broker fake/test Vault. They must look credential-like enough to exercise exact-match detection, but they are not live provider credentials and must never be committed as fixture data.

Before C, Package B has a local breaker: capture its request injection, logs, errors, traces, receipts, and responses; prove the broker canary appears only in the connector Authorization slot; then mutation-test a leak into each output class. This does not require EffectEngine or a real connector and must not be deferred to the cross-surface test.

The integration test should:

1. configure a model-gateway canary through the existing secret-binding fake and create an owner-bound handle whose distinct connector canary lives only in the broker fake/test Vault;
2. run the real public admission, planning, authority/effect, connector issue, reconciliation/read-back, evidence, and acceptance path;
3. capture both trusted egress requests and prove each canary appears only in its own Authorization-injection slot;
4. scan every entry in the generated manifest, including Supabase non-Vault rows, reporter/observer records, console output, traces, projections, artifacts, workspace checkpoints, and B-side outputs, for both exact canaries;
5. run forged/replayed permit, expired, revoked-mid-flight, wrong-audience, Vault-unavailable, and rotation-during-redemption cases and assert zero connector I/O where applicable;
6. mutation-test by routing each canary into a forbidden event, prompt, error, or receipt field and proving the test fails.

A static source guard should complement this behavioral test by rejecting obvious credential fields and service-role bindings in forbidden packages. It cannot replace the full canary integration test.

## Blockers and merge order

1. **A0 — ready now:** publish the credential/workload-identity contract slice, pure handle/revocation reducer and fixtures, static forbidden-field guard, and versioned generated sink manifest with drift tests. Issue #81 currently does not declare `CredentialHandle`; use an explicit sibling contract package or an approved extension rather than silently widening it.
2. **A1 — migration-dependent:** reserve the next DO migration at rebase, name the `WorkloadIdentityModule` integration owner, and implement durable handle metadata against A0. Migration work must not block the pure A0 slice.
3. **B — decision-blocked:** accept the least-privilege identity/grants, signed single-use permit and online revocation-check topology, replay/TOCTOU boundary, and EffectEngine attempt/reconciliation ownership. In parallel, decide how legacy `oauth_tokens.*_enc` rows migrate to Vault identifiers, including rollback and deletion/rotation behavior.
4. **B implementation after decisions:** implement Vault mapping and trusted connector egress with the local broker-canary breaker. Do not use `SUPABASE_SERVICE_ROLE_KEY` unless the repository security rule is explicitly changed through its decision process; this map does not recommend that change.
5. **C — integration-blocked:** integrate the distinct model-gateway and brokered-connector canaries only after A1/B, EffectEngine, and one reversible connector expose the real effect/read-back path. Regenerate the manifest at the integration head rather than manually freezing a list.
