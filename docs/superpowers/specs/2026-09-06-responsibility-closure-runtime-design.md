# Responsibility Closure Runtime Design

**Date:** 2026-09-06
**Owning issue:** #84
**Base:** `main@105e4b5137ed6281a5d731e0cc1ff1d5a5827800`
**Contract dependency:** PR #133 at exact head `5e6ed074c9ae49ba95ff13c107997aa6b84010ff`
**Status:** implementation-ready design; runtime writes remain blocked until PR #133 is explicitly merged and `main` is re-pinned

## Problem

Waldo can durably capture work, execute bounded WorkUnits, and persist exact owner decisions, but it cannot yet turn executor/provider observations into trustworthy responsibility closure. Provider `done`, an artifact existing, an effect receipt, or a model assertion are observations only. The owner backend needs a durable spine that keeps AcceptanceCheck, Evidence, Verification, owner Acceptance/release, and projection state separate and revision-bound.

The user-visible outcome is simple: when Waldo says a responsibility is handled, the backend can prove what success meant, what evidence was admitted, how it was independently verified, and whether the owner explicitly accepted or consciously released it.

## Scope

This design implements the runtime side of the additive v0.6 responsibility-closure contract in PR #133.

In scope:

- authoritative AcceptanceCheck declaration for current Outcome/WorkUnit revisions;
- bounded Evidence admission from canonical observation references;
- server-selected Verification with explicit independence and availability state;
- explicit-owner-only Acceptance and distinct conscious Release;
- request idempotency with byte-identical replay and changed-duplicate rejection;
- v0.6 owner-domain events and rebuildable closure projection;
- authenticated public HTTP routing through the existing responsibility worker adapter;
- hermetic injected verifier behavior for deterministic tests.

Out of scope:

- real provider/verifier network I/O;
- delegated Acceptance policy;
- OpenLoop/ReEntry transitions (#85);
- Outcome completion mutation beyond the v0.6 Acceptance record;
- Telegram/Discord/WhatsApp adapters;
- Connections, credentials, Kernel, Sandbox, or Kennel execution changes;
- health/mobile changes;
- staging, deployment, or production migration.

## Preconditions

Runtime implementation MUST NOT begin until all of the following are true:

1. PR #133 is explicitly authorized and merged at reviewed head `5e6ed074c9ae49ba95ff13c107997aa6b84010ff`, or a replacement head is independently re-reviewed.
2. `origin/main` is re-pinned after merge.
3. `packages/runtime/do-migration-reservations.json` is reread from landed `main`.
4. The next DO migration is allocated using the repo rule `rebase_then_append`; the current main ends at v7, but this design does not reserve v8 before the landed-tree recheck.
5. #116 has a fresh write-capable runtime SESSION START naming exact files and conflict boundaries.

If any condition fails, stop and reconcile rather than coding against an unlanded contract.

## Architectural ownership

### OutcomeModule — AcceptanceCheck sole writer

`packages/runtime/src/coordinator/outcome-module.ts` remains the sole reducer owner for Outcome/WorkUnit state and becomes the sole writer for AcceptanceCheck records attached to those exact revisions.

It will expose transaction-only methods to:

- resolve an exact closure subject from `{ kind, id, expectedRevision }`;
- declare one active AcceptanceCheck from the public proposal plus server-owned owner/subject/method material;
- reread the exact current active AcceptanceCheck set for an Outcome;
- reject stale target revisions, cross-owner targets, duplicate/conflicting criteria, and malformed current rows.

No separate AcceptanceCheck module is introduced because that would split ownership of the Outcome acceptance definition across writers.

### EvidenceVerifier — Evidence and Verification sole writer

Add `packages/runtime/src/coordinator/evidence-verifier.ts`.

This module owns:

- Evidence rows admitted from canonical observation references;
- provenance derived from trusted observation/runtime state, never public request fields;
- current Evidence-set envelopes per AcceptanceCheck;
- Verification rows and their state transitions;
- verifier identity, version, availability, independence, disclosure, findings reference, and exact method binding;
- canonical Evidence-set digest calculation.

The first implementation uses an injected trusted verifier policy/executor interface. No external verifier I/O is added in #84. Tests can return `passed`, `failed`, `indeterminate`, or unavailable results without teaching the model or provider to mint Verification state.

A `passed` Verification is allowed only when:

- the AcceptanceCheck is still active at the exact revision/digest;
- every referenced Evidence record is still current and admitted;
- the Evidence-set envelope and digest are independently recomputed in the same owner transaction;
- verifier method/version matches the AcceptanceCheck;
- verifier identity differs from every Evidence producer identity;
- verifier availability is `available` and `independentFromProducer` is true.

### AcceptanceModule — Acceptance/release sole writer

Add `packages/runtime/src/coordinator/acceptance-module.ts`.

This module owns Acceptance records only. It does not decide whether work succeeded and does not mutate Outcome/OpenLoop state.

For `accept` it requires, in the same transaction:

- authenticated actor is the exact owner;
- request targets the exact current Outcome revision;
- authoritative active AcceptanceCheck set is reread from OutcomeModule;
- current Evidence-set envelope for every active check is reread from EvidenceVerifier;
- exactly one current `passed`, available, independent Verification covers every active AcceptanceCheck;
- every Verification binds the exact check revision/digest and Evidence-set digest;
- the v0.6 verified-acceptance binding verifier succeeds against the authoritative reread set.

For `release` it requires exact owner identity, current Outcome revision, and a non-null reason reference. Release is auditable disposition, never verified success.

### ProjectionPublisher — closure projection writer/rebuilder

Deepen `packages/runtime/src/coordinator/projection-publisher.ts` rather than creating a second canonical projection system.

It currently owns the Judgment Needs You projection. Extend it with a v0.6 closure namespace that:

- accepts only schema version `0.6` and aggregate kinds `acceptance_check`, `evidence`, `verification`, `acceptance`;
- validates event type against aggregate kind;
- validates event payload against the canonical persisted row/digest;
- publishes ordered closure projection items by owner cursor;
- rebuilds from `owner_domain_events` with bounded event/decoded-byte limits;
- preserves Judgment projection behavior byte-for-byte and query semantics;
- emits `responsibility.closure` pages with the v0.6 page digest and size constraints.

The owner event log remains the durable source for rebuild. Projection tables remain rebuildable read models.

### WaldoCoordinator — authenticate, derive, reread, sequence

`packages/runtime/src/coordinator/waldo-coordinator.ts` orchestrates the transaction but does not become a second writer.

For each v0.6 command it will:

1. validate canonical owner authority and presence registration;
2. canonicalize the request and compute request digest;
3. check persisted command identity for exact replay vs changed duplicate;
4. reread current Outcome/WorkUnit/AcceptanceCheck/Evidence state;
5. derive server-owned IDs, owner, actor, provenance, verifier policy, clocks, digests, and authority material;
6. call exactly one definitive writer per aggregate;
7. append/publish owner events inside the same storage transaction;
8. persist the exact command result for byte-identical duplicate replay.

Public requests can select target/check/evidence references and owner decision only. They cannot submit owner identity, actor, producer/admitter, verifier, policy, clocks, result state, digests, or authority.

### Responsibility worker adapter — thin public ingress

`packages/runtime/src/responsibility/worker-adapter.ts` will match `responsibilityClosureHttpRouteManifestV06`, enforce the v0.6 media type, parse strict schemas, resolve authenticated canonical authority, and call WaldoCoordinator.

It MUST preserve existing endpoint controls: authentication, owner routing, request-size/input validation, generic errors, rate/budget controls, and no raw request body logging.

The adapter never constructs domain records.

## Durable Object schema

After fresh lineage allocation, add one additive migration containing owner-scoped tables for:

- `acceptance_checks` — canonical current/check history material keyed by id and owner, subject revision/digest, state, canonical JSON;
- `closure_evidence` — canonical Evidence and observation/provenance material;
- `closure_verifications` — canonical Verification and exact Evidence-set/check bindings;
- `closure_acceptances` — explicit owner Acceptance/release records;
- `closure_commands` — `request_id`, owner, command type, canonical request digest/material, exact persisted result bytes;
- `closure_projection_state` and `closure_projection` — rebuildable snapshot/page support if the existing projection tables cannot safely host the v0.6 namespace without ambiguity.

Every lookup is parameterized and owner-scoped. Uniqueness constraints enforce one command identity, exact revision identity, and observation/reference invariants where SQLite can enforce them. Semantic invariants remain transaction checks in the definitive writer.

The migration is additive. No released table/column is removed or retyped.

## Command semantics

### AcceptanceCheck declaration

Public input proposes target, criterion reference, and verification capability/kind. Server resolves target record, owner, exact revision/digest, trusted verification method version/material, IDs, clocks, and canonical digest. Exact duplicate returns persisted result; a changed duplicate requestId conflicts.

### Evidence admission

Public input references one canonical observation. Server rereads the observation from the trusted owning store, derives producer provenance and observedAt, validates it belongs to the exact owner/subject/check, creates Evidence, and appends `evidence.admitted` or bounded invalidation state. Caller-supplied provenance is impossible by schema and runtime.

### Verification request

Public input references the exact current Evidence set. Server rereads every Evidence record, constructs the current envelope, recomputes its digest, selects the verifier from trusted method/policy state, checks independence, invokes the injected verifier boundary, and persists Verification. Provider/model output alone cannot choose `passed`.

### Acceptance record

`accept` is an explicit owner decision over the current Outcome revision. The server ignores any attempt to infer Acceptance from Verification. It constructs the complete binding only after fresh same-transaction rereads and calls the contract verifier before persistence.

`release` is also explicit owner action but does not require passed Verification and cannot be represented as accepted.

## Idempotency and concurrency

All four POST commands use `requestId` as command identity.

- first request: persist canonical request digest/material and exact result in the same transaction as domain state;
- exact retry: return persisted result byte-for-byte and perform no new event/state write;
- same requestId with changed canonical material: fail closed with request conflict;
- stale `expectedRevision`: fail closed before mutation;
- concurrent commands serialize through the owner Durable Object and still reread current revision inside transaction;
- a Verification or Acceptance built against state that changes before commit is rejected.

## Security and privacy

- No raw health values enter these tables, events, logs, traces, fixtures, or model context.
- No credentials, OAuth tokens, prompts, full transcripts, artifact bytes, or arbitrary evidence bodies are stored in closure records.
- Evidence references canonical observations by bounded ref/digest; provenance is server-derived.
- LLM/provider output is untrusted input and never an auth/authz or Acceptance decision.
- All public endpoints remain authenticated, owner-scoped, strict-schema validated, bounded, and rate/budget controlled.
- Errors to clients remain generic; internal conflicts preserve typed causes.

## Testing strategy

Tests are TDD-first and include:

1. OutcomeModule AcceptanceCheck tests: happy path; stale revision; cross-owner; exact duplicate vs changed duplicate; active-set deterministic reread/digest.
2. EvidenceVerifier tests: trusted provenance derivation; missing/stale observation; duplicate observation; verifier/producer identity collision; unavailable verifier; passed/failed/indeterminate states.
3. AcceptanceModule tests: complete exact coverage succeeds; partial coverage fails; stale check/evidence/verification fails; non-independent verifier fails; explicit release remains distinct; non-owner fails.
4. Coordinator tests: exact request replay returns identical result and cursor; changed duplicate conflicts; owner identity/presence mismatch fails; transaction rollback leaves no partial rows/events.
5. Projection tests: ordered publish/read/rebuild; unknown/malformed v0.6 events fail closed; page cursor/byte limits; Judgment v0.5 regression preserved.
6. Worker-adapter tests: all five v0.6 routes; media type; malformed/caller-smuggled fields; auth/owner routing; generic error mapping.
7. Full repo verification wall after implementation.

Synthetic fixture identities and references only. No credentials or production data.

## Failure modes and falsifiers

Stop/rework if any of these is possible:

- a provider, model, executor, presence, or public caller chooses Acceptance, Verification state, verifier identity, Evidence provenance, or owner identity;
- `accept` succeeds without exact one-to-one current passed independent Verification coverage;
- stale Evidence or stale AcceptanceCheck survives a revision change as current truth;
- a duplicate command creates another event or record;
- projection rebuild changes canonical truth or cannot reproduce ordered closure state from owner events;
- runtime requires a second task/memory/Outcome truth store;
- implementation requires changing released v0.1-v0.5 contracts;
- migration lineage collides after re-pin.

## Rollback

Before any deployment, rollback is source-only: revert the additive runtime/migration commit(s). No hosted mutation is authorized by this design.

If a future staging migration is separately authorized, rollback must be proven against a disposable/staging owner store before any production claim. Production migration/deployment requires separate explicit authorization.