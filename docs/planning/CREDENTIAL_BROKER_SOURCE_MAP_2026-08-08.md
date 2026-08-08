# Credential broker source map

**Status:** implementation preflight for issue #91

**Pinned source:** `dd434e9bb5dedc4a135e43e30571a141599e8991`

**Decision:** do not add a runtime broker interface before the handle contract and writer migration are published.

## Result

Issue #91 is three independently reviewable packages, not one change:

| Package | Owner and seam | Dependency | Proof |
|---|---|---|---|
| A. Handle control plane | `WorkloadIdentityModule` is the sole DO writer for `CredentialHandle` metadata. A runtime port carries opaque handles only. | Published handle/workload-identity contract; migration reservation and merge captain. | Owner, audience, purpose, resource, lease, expiry, state, and revocation-generation fault tests. No credential value reaches the DO. |
| B. Secret custody and egress | A Supabase Edge Function or equivalently isolated egress adapter owns service-role/Vault access and performs redemption at the connector egress boundary. | Package A contract plus a source-pinned Supabase Vault design and migration. | Vault unavailable, wrong audience, expired/revoked handle, rotation race, and service-role isolation tests. |
| C. Canary integration | An integration harness seeds a synthetic credential-class canary in the broker fake/Vault test adapter, runs planning plus one reversible effect, then scans every forbidden sink. | Packages A and B, EffectEngine, the first real connector, and the final sink manifest at the integration head. | Exact canary absent from prompts, events, logs, traces, artifacts, projections, and checkpoints; expired and wrong-audience redemption fail before egress. |

This split preserves the architecture lock's writer assignment and its rule that the secret value remains outside the DO (`docs/planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md:162`, `:184-185`). It also prevents the Vault adapter from widening the current runtime trust boundary.

## Why code does not start in this branch

Two plausible first slices were tested against source:

1. **Add a runtime-only `CredentialBrokerPort`.** Rejected. The first operation would need a not-yet-published `CredentialHandle`; adding a parallel local value shape would create contract drift. It would also be a hypothetical seam with one unimplemented adapter and no caller.
2. **Reuse the current Scribe canary path as the #91 gate.** Rejected. `CanaryTokens` is exactly three 16-character hexadecimal tokens (`packages/contracts/src/core/trigger.ts:23-35`), and current runtime call sites use fixed values (`packages/runtime/src/run-loop/do.ts:158`). This detects some prompt/trace/persistence leaks, but it neither represents a brokered credential nor enumerates the complete #91 sink set.

The action threshold for implementation is: the handle contract identifies every nonsecret metadata field and the DO migration is reserved. Until then, a production module would duplicate vocabulary or guess persistence.

## Existing identity and secret boundaries

### Owner and presence identity

- The public responsibility adapter authenticates the bearer with Supabase, validates the active session, hashes subject/session identifiers, and returns a content-free canonical authority (`packages/runtime/src/responsibility/supabase-authority.ts:31-85`).
- `IdentityPresenceModule` is the sole DO writer for owner root, presence registration, and active session state (`packages/runtime/src/coordinator/identity-presence-module.ts:44-167`).
- Coordinator admission compares the routed owner and every server-derived authority field before planning (`packages/runtime/src/coordinator/waldo-coordinator.ts:621-653`).

Package A should bind credential-handle metadata to this canonical owner and to a server-admitted execution principal. Surface or model input must not choose owner, audience, purpose, lease, or revocation generation.

### Existing secret mechanisms

- The Cloudflare AI Gateway adapter accepts a secret binding and resolves its value immediately before constructing the Authorization header (`packages/runtime/src/llm/gateway.ts:22-61`, `:110-140`). This is a useful egress-local custody pattern, but it has no owner, audience, purpose, resource, lease, expiry, rotation, or revocation contract and is not a general credential broker.
- Gateway payload logging is explicitly disabled by a literal contract (`packages/contracts/src/adapters/llm.ts:43-53`).
- The runtime package may not reference `SUPABASE_SERVICE_ROLE_KEY`; the blocking guard scans runtime source and config (`scripts/guards/guard-do-only-runtime.mjs:133-155`) and its self-test mutation proves that rule (`scripts/guards/guards-selftest.mjs:277-333`). Package B therefore belongs outside `packages/runtime`.

### Supabase/Vault finding

There is no implemented Supabase Vault adapter or Vault SQL precedent in this repository. A repository-wide search found no `vault.*`, `decrypted_secrets`, `create_secret`, `pgsodium`, or Vault RPC use.

The existing migration comment says “encrypted credentials via Supabase Vault,” but the implementation creates service-role-only `access_token_enc` and `refresh_token_enc` text columns (`supabase/migrations/20260709171953_0005_integrations.sql:28-51`). The schema does not identify the encryption owner, key lifecycle, ciphertext format, rotation behavior, or a Vault secret identifier. Package B must treat these columns as legacy/unproven storage, not as a working Vault adapter. It needs a migration and rollback decision rather than silently reusing them.

## Forbidden sink baseline

This is the current baseline to extend at package C. It is not a frozen exhaustive list: the canary harness must regenerate the list after EffectEngine, workspace, artifact, and connector tables land.

| Sink class | Current source path | Current protection or gap |
|---|---|---|
| Model-visible prompt | `ContextComposer` returns the rendered prompt (`packages/runtime/src/context-composer/composer.ts:94-140`); AI Gateway serializes system/messages to the provider (`packages/runtime/src/llm/gateway.ts:110-152`). | Terminal Scribe pass rejects configured canaries and known secret patterns. Package C must capture the exact provider request and assert absence of its synthetic credential canary. |
| Planning provider intent | `PlanningExecutionModule` stores only the request digest and content-free execution witness (`packages/runtime/src/coordinator/planning-execution-module.ts:378-415`). | No prompt is stored in this table today. Scan it anyway so later contract drift is detected. |
| Canonical events | `OwnerEventLog` persists `payload_json` (`packages/runtime/src/coordinator/owner-event-log.ts:47-64`); planning records status and candidate-plan events (`packages/runtime/src/coordinator/planning-execution-module.ts:583-603`). | Direct schema validation and serialization, not a universal credential canary pass. Package C must scan all event payloads. |
| Product projections | Outcome projection items persist as JSON (`packages/runtime/src/coordinator/outcome-module.ts:111-120`); planning projections do the same (`packages/runtime/src/coordinator/planning-execution-module.ts:809-815`). | Schema-bounded but not credential-canary aware. Scan both tables and future projection tables. |
| Runtime traces | Trace details pass through Scribe and degrade to a content-free `scribe_denied` event (`packages/runtime/src/run-loop/do.ts:4773-4821`). | Protected for current static canaries and patterns. Package C must inject its exact canary set into the test runtime or verify a broker-specific guard before trace persistence. |
| Runtime/checkpoint state | `runtime_invocation_v2.state_json`, `runtime_runs.context_json`, and `scratch_json` are persisted in the DO (`packages/runtime/src/run-loop/do.ts:5076-5123`); persisted rows have Scribe audit/scrub paths (`packages/runtime/src/run-loop/do.ts:5187-5222`, `:5279-5294`). Context checkpoints contain refs, digests, taint, and source metadata rather than prompt text (`packages/runtime/src/context-composer/provenance.ts:112-162`). | Current state is content-minimized but still part of the exact canary scan. Future workspace checkpoints must be added before C passes. |
| Application logs | The public failure reporter logs only event/code/error names (`packages/runtime/src/index.ts:146-153`); unexpected context errors report only phase and error kind (`packages/runtime/src/context-composer/composer.ts:157-175`). | Error messages and causes are intentionally excluded. Package C should capture console and every observer/reporter seam during the turn. |
| Artifacts/tool observations | Current trusted RunLoop stores content-free checkpoint metadata in state and resolves replay artifacts behind an adapter; the target `ArtifactRegistry` and workspace stores are not implemented. | Package C cannot claim artifact/checkpoint coverage until the new artifact/workspace sinks exist or the acceptance case explicitly proves they were not invoked. |
| Supabase operational stores | `oauth_tokens`, `one_time_tokens`, and `agent_logs` exist in Supabase migrations. | Broker custody is allowed only in the declared Vault/egress store. The canary may exist in the test Vault row, but must be absent from `agent_logs`, token metadata, receipts, and all unrelated tables. |

## Interface constraints for package A

The contract slice must resolve these questions before runtime code:

- distinguish the opaque handle identifier from the Vault secret identifier; the latter must never leave package B;
- bind handle metadata to owner, execution principal, WorkUnit/effect resource, audience, purpose, lease/fence, expiry, and revocation generation;
- make state and generation explicit enough for immediate revoke and deterministic rotation races;
- prohibit credential material, authorization headers, refresh tokens, or reusable bearer values in every public/DO contract;
- keep redemption internal to the trusted egress adapter. A general runtime method returning `string` would widen secret visibility and is rejected;
- define content-free broker errors for missing, expired, revoked, wrong-audience, stale-generation, and unavailable cases.

## Package C test shape

Use a synthetic token generated solely inside the test broker adapter. It must look credential-like enough to exercise exact-match detection, but it is not a live provider credential and must never be committed as fixture data.

The integration test should:

1. create an owner-bound handle whose secret lives only in the broker fake/test Vault;
2. run the real public admission, planning, authority/effect, connector issue, reconciliation/read-back, evidence, and acceptance path;
3. capture the exact outbound connector request after trusted injection and prove the canary appears only in the authorization slot at that egress seam;
4. scan provider requests, all DO text/blob columns, Supabase non-Vault rows, reporter/observer records, console output, traces, projections, artifacts, and workspace checkpoints for the exact canary;
5. run expired, revoked-mid-flight, wrong-audience, Vault-unavailable, and rotation-during-redemption cases and assert zero connector I/O where applicable;
6. mutation-test by routing the canary into one forbidden event or prompt field and proving the test fails.

A static source guard should complement this behavioral test by rejecting obvious credential fields and service-role bindings in forbidden packages. It cannot replace the full canary integration test.

## Blockers and merge order

1. Publish the credential/workload-identity contract slice. Issue #81 currently scopes v0.4 to Acceptance, Judgment, Authority, Effect, Evidence, Verification, Continuity, and `ExecutorRef`; it does not declare `CredentialHandle`. Add an explicit sibling contract package or an approved extension before package A.
2. Reserve the DO migration for handle metadata and name the `WorkloadIdentityModule` integration owner.
3. Decide how the legacy `oauth_tokens.*_enc` rows migrate to real Vault identifiers, including rollback and deletion/rotation behavior.
4. Implement package A with an in-memory broker adapter for contract tests only.
5. Implement package B in the isolated Supabase/egress trust boundary; never add the service-role key to the DO runtime.
6. Integrate package C only after EffectEngine and one reversible connector expose the real effect/read-back path and the final forbidden-sink manifest can be frozen.
