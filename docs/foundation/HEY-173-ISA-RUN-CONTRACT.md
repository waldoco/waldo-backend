# HEY-173 ISA Run Contract — ContextComposer

- Status: In Progress
- Issue: [HEY-173](https://linear.app/heywaldo/issue/HEY-173/harness-contextcomposer-trusted-invocation-to-provenance-backed)
- Stack base: `codex/hey-172-surface-neutral-invocation-contract` at `b9bea89ff945f58759bb41e74749bf5f99cd6869`

## Intent

Build one deep runtime-local seam:

```ts
compose(trustedInvocation, runtimeOwnedInputs)
```

It must turn an already admitted `TrustedInvocationEnvelope` plus a bounded, runtime-owned
source capture (and, on replay, an optional prior V2 context-ref witness) into either:

- an ephemeral seven-layer REASONS prompt, a V2 `RuntimeContextCheckpoint`, and non-content
  selection/recall evidence; or
- an explicit fail-closed result with no prompt and no checkpoint.

This is a headless/local context lane only. It does not wire `RunLoopDO`, choose a provider,
write a run record, deliver output, access Supabase, or claim a production profile, connector,
FTS/RRF, pending-memory union, or live health projection.

## Current → Ideal

### [observed] Current

- PR #67 supplies strict `TrustedInvocationEnvelope` and V2 checkpoint contracts, but the
  run-loop still owns fake-derived context and a fixed prompt path.
- HEY-14 supplies canonical in-memory SkillLoader filtering/ranking; no SQLite system-skill
  repository exists.
- HEY-15 supplies an owner-bound RecallGateway contract and fail-open retrieval behavior; no
  SQLite owner-binding adapter exists, and its public result does not retain provenance/status.
- HEY-16 supplies canonical seven-layer REASONS primitives, but accepts a preformed fake canvas
  and owns neither snapshot provenance nor trusted invocation authority.
- The current DO schema has globally keyed `skills` and legacy `user_id` memory/episode rows. It
  has no tenant column, FTS/RRF data, agent-evolution table, or enough fields for a truthful
  pending/committed union conflict hydration.

### [ideal] This slice

- A sole public composer accepts a parsed/re-parsed trusted envelope, derives trigger, variant,
  recall key, and tool ACL only from `runtime_binding`, and never accepts surface authority.
- Constructor-injected, local-substitutable adapters provide system-only active skills, an exact
  `(principal_ref, tenant_ref) → legacy user_id` owner binding, owner-bound local recall, and a
  bounded required context capture. Each SQLite adapter freezes both successful and rejected
  reads per adapter lifetime, including concurrent reads for the same snapshot key. Public
  callers cannot select a tenant, user, trigger, ACL,
  model, provider, tier, DO, or delivery policy.
- Runtime-owned inputs may carry `replay_context_ref`: `null` for a first compose or the prior
  V2 `context_ref` for a retry in a fresh adapter/process. It is a witness, not a prompt source:
  recomposition returns only when the newly derived V2 context ref matches; otherwise it fails
  closed before any prompt escapes.
- The composer makes exactly one selection and at most one recall call; it forwards only the
  highest-ranked selected skill's `trigger_condition` as the recall hint.
- It renders canonical REASONS order with `wrapSkills` and canonical recall rendering, creates
  deterministic opaque V2 refs/provenance, and leaves raw prompt/health/connector content out of
  the durable result.
- It admits only a backend `DerivedHealthDestinationView` eligible for `trigger_prompt`; health
  text is nonnumeric and Scribe-admitted. Unsafe/malformed health fails closed.

### [blocked] Deliberately not claimed

- Production tenant routing, Supabase/RLS, live profiles/goals/workspace/connectors, provider
  calls, retries/deadlines, delivery, run persistence, and run-loop wiring.
- BM25/RRF, episode FTS, agent evolutions, full ADR-0046 union/conflict hydration, or retained
  source-taint recovery from legacy committed memory rows. The local adapter delegates canonical
  key/config/query/hint admission to HEY-15, but returns `partial` on every successful local
  read and excludes an unproven legacy row rather than laundering its taint. See
  [HEY-174](https://linear.app/heywaldo/issue/HEY-174/backend-local-recall-source-proof-ftsrank-episode-admission-and-union).
- A production-proven source for connector availability, dismissals, provisional reverts,
  identity drift, and invocation priority. The composer accepts a required, principal-scoped,
  revision-attested state adapter; this lane's adapter is an explicit frozen headless fixture.
  `skills.pinned` remains curator lifecycle metadata, not invocation priority. See
  [HEY-175](https://linear.app/heywaldo/issue/HEY-175/backend-proven-system-skill-runtime-state-source-connector-dismissal).
- Durable cross-restart source snapshots. The current DO schema has no source revision,
  snapshot manifest, or historical row capture for skills, legacy memory, materials, staged
  inputs, owner bindings, or runtime skill state. A fresh adapter can verify an unchanged
  context through `replay_context_ref`, and fails closed on divergence; it cannot reconstruct
  a mutated historical prompt. [HEY-176](https://linear.app/heywaldo/issue/HEY-176/backend-durable-contextcomposer-source-snapshot-manifest-and-replay)
  owns that durable source boundary and later single-writer handoff.

## Stable ISC criteria and falsifiers

| Criterion | Proof | Falsifier |
| --- | --- | --- |
| Trusted authority only | `compose` parses `TrustedInvocationEnvelope`; derives trigger/variant/ACL from it; public runtime inputs have no authority selectors. | A raw surface request or caller-provided user/tenant/trigger/tool list can influence output. |
| Explicit local ownership | Owner binding matches both opaque principal and tenant before every current-schema local memory read; all queries are parameterized. Episode reads are deliberately absent in this temporal-partial lane. | Unmapped/mismatched binding, or a cross-principal row appears in result/evidence/prompt. |
| System-only skills | SQL reader admits active, identity-locked `provenance='system'` rows through `SkillRow` then `Skill`; a repository that exposes a non-system row fails closed without leaking its metadata. | Connector/user/agent row reaches `wrapSkills`, or a corrupt active row yields a prompt. |
| Canonical selection | H14 filter/rank/top-K behavior and canonical exclusion reasons remain observable. | Wrong order, invented exclusion reason, forbidden-tool skill, or beyond-K skill appears. |
| Recall is bounded and honest | Key/variant config is canonical; exactly one call uses the top selected condition; skipped/empty/failed are distinguishable. | A recall retry/second call happens, a failed retrieval reports `ok`, or another principal's data appears. |
| Fail-open is narrow | Retrieval failure renders canonical empty recall and succeeds with `failed` evidence; all authority, integrity, safeguard, health, sanitizer, and provenance failures return no prompt/checkpoint. | A fail-closed condition exposes a partial prompt, or recall failure blocks a valid invocation. |
| REASONS is deterministic | The seven fixed layers are joined canonically; recall begins Operations and Safeguards is last. Same adapter capture produces identical bytes and V2 provenance; a fresh replay must match the runtime-owned V2 witness or fail closed. | Layer/order/suffix drift, changing prompt/checkpoint for equivalent capture, a fresh replay escaping with a mismatched witness, or mutable input observed after an await. |
| Health and taint safety | Only destination-approved nonnumeric health view/narrative crosses Scribe; external connector/workspace sources retain external taint and sanitize before use. | Raw/numeric health or unsafe external text appears in prompt/checkpoint, or external taint becomes null. |
| Durable provenance is safe | Checkpoint matches envelope refs; source refs are opaque/unique/time-valid/scoped; durable evidence has hashes/status/refs only. | Prompt, recall content, raw health, secret, arbitrary connector text, duplicate/mis-scoped ref, or invalid taint aggregate is durable. |
| Scope discipline | No RunLoopDO/adapters/schema migration/central contract edits. | Diff touches a forbidden path or new migration. |

### Stable ISC probes

- [x] **ISC-1 — Trusted composition only.** `compose()` accepts only a strict trusted envelope
  plus strict runtime-owned snapshot inputs. **Anti:** a raw surface request or caller-selected
  identity/trigger/ACL reaches any adapter.
- [x] **ISC-2 — Scoped bounded captures.** Every mutable adapter response carries matching
  principal/tenant and snapshot/revision attestation; SQLite captures both in-flight and failed
  reads without eviction. **Anti:** an accessor, mismatched snapshot, foreign staged input,
  non-injective legacy mapping, or repaired live row changes a claimed capture.
- [x] **ISC-3 — System-only H14 selection.** Active system rows are parsed, bounded,
  filtered/ranked/top-K'ed, and emit only canonical selected/exclusion evidence. **Anti:**
  another provenance's name/count reaches output or persisted `pinned` becomes priority.
- [x] **ISC-4 — Honest H15 recall.** Exactly one canonical recall plan/read occurs; ordinary
  source failure is explicit failed-empty, while taint/canary/integrity failures close. **Anti:**
  an unsupported local source reports `ok`, leaks another owner/tenant, or silently skips.
- [x] **ISC-5 — Canonical safe REASONS.** Seven layers render in order, recall leads Operations,
  safeguards finish, and only derived health/context survives final Scribe. **Anti:** raw health,
  unsafe external text, or a partial prompt exits a failed composition.
- [x] **ISC-6 — Deterministic V2 provenance and replay verification.** Same frozen adapter
  capture produces identical bytes and opaque scoped refs. A fresh adapter may replay only with
  an equal runtime-owned `replay_context_ref`; source drift fails closed instead of emitting a
  changed prompt. **Anti:** arbitrary source content/raw health is durable, taint is laundered,
  a cache evicts a capture, or a fresh replay silently drifts. Durable historical reconstruction
  is explicitly deferred to HEY-176.

## Data and failure map

```mermaid
flowchart LR
  E["TrustedInvocationEnvelope"] --> A["parse + derive trigger / variant / ACL"]
  A --> B["exact local owner binding"]
  B --> S["system-only SQLite skills"]
  B --> R["owner-bound SQLite recall"]
  A --> M["attested runtime-owned materials"]
  S --> L["canonical H14 selection"]
  L --> H["top skill condition hint"]
  H --> R
  R --> C["canonical REASONS + Scribe"]
  M --> C
  C --> V["ephemeral prompt + V2 refs/evidence"]
  V --> W["optional replay_context_ref witness check"]
```

| Stage | Input / owner | Success | Failure policy |
| --- | --- | --- | --- |
| Admission | PR #67 envelope | Parsed trusted authority and derived binding. | Invalid envelope fails closed before any adapter call. |
| Snapshot | Runtime-owned attested capture + optional V2 witness | Required identity/safeguards/material sources are bounded and time-valid; the witness is compared after V2 derivation. | Missing mandatory identity/safeguards, unsafe source/time/ref, cache capacity exhaustion, or witness mismatch fails closed. |
| Owner binding | Injected local resolver | Exact principal+tenant binding yields a legacy local user id. | Missing/mismatched binding fails closed; no SQL recall occurs. |
| Skills | SQLite/local repository → canonical row/skill parser → H14 loader | System-only candidates plus canonical selected/excluded list. | Corrupt or non-system exposed rows fail closed with no foreign provenance evidence. |
| Skill state | Required injected principal/tenant state adapter | Attested connector/dismissal/revert/drift/priority inputs drive H14 where supplied. | Missing/mismatched/corrupt state fails closed; fixture-only state is not a production claim (HEY-175). |
| Recall | Injected owner-bound H15 temporal-partial adapter | Canonical result, snapshot provenance, and `partial`/`skipped` status for a successful current-schema read. | Ordinary source retrieval failure is the sole fail-open: canonical empty recall + `failed` evidence; canary/security/integrity failures fail closed. Unproven legacy taint is excluded (HEY-174). |
| Health/external material | Derived destination view / source-fragment Scribe gate | Allowed, bounded text and unlaundered taint. | Raw/numeric/unsafe health, external sanitizer rejection, or invalid provenance fails closed. |
| Assembly | Canonical REASONS helpers | Stable prompt bytes, no partial output. | Any layer failure returns typed failure with no prompt/checkpoint. |
| Provenance | Internal deterministic ref factory | V2 parsed checkpoint matching envelope and captured source facts; fresh replay must match the supplied witness. | Duplicate/time-invalid/mis-scoped/taint-inconsistent source or replay witness mismatch fails closed. |

## Test strategy

Tests cross only the public `ContextComposer.compose()` seam. In-memory adapters model true
external or repository behavior; a Miniflare Durable Object test seeds `provisionDoSchema()` and
uses the local SQLite adapter for real current-schema query proof.

1. **Tracer bullet:** trusted `user_message`, one active system skill, exact principal-scoped
   recall, derived health narrative, derived ACL, all seven layers, and a valid V2 checkpoint.
2. **Isolation/admission:** cross-principal and same-principal/different-tenant rows are absent;
   corrupt/non-system/forbidden/over-K skills surface only correct selected/exclusion evidence and
   never prompt.
3. **Recall:** one call, selected-top hint, skipped key, deterministic ordering, empty memory,
   explicit failure-open state, and no silent failure.
4. **Safety:** safeguards-final/recall-first, zero skills, missing mandatory inputs, raw health,
   unsafe external text, taint propagation, provenance/scope/time violations, and no partial
   prompt on fail-closed results.
5. **Replay:** property-style fixed capture/repeated composition, same-adapter SQLite mutation
   proof, fresh-adapter V2-witness equality/mismatch proof, and one ordering/ACL/tenant mutation
   candidate.
6. **Local SQLite:** parameterized active-system skill and owner-bound temporal memory reads
   using the existing DO schema, including cross-owner negative proof; seeded episodes prove
   they are not fabricated/admitted by this partial capability.

## Vertical TDD slices

1. Define the public discriminated result, trusted snapshot material contract, and successful
   user-message tracer test. Make it red; add only enough composer behavior for green.
2. Add canonical selection and repository-admission truth-table evidence; keep corrupt input
   fail-closed.
3. Add exact owner binding plus one-call H15 recall status/provenance adapter and cross-tenant
   proof.
4. Add Scribe/health/external-taint/provenance fail-safe coverage and replay property.
5. Add the local SQLite implementation and Miniflare integration test; do not alter schema.
6. Run contract/standards/security/health/adversarial review and whole verification wall; repair
   until falsifiers are closed or explicitly blocked.

## Verification plan

- `pnpm --filter @waldo/runtime test -- context-composer.test.ts` after every tracer slice.
- Runtime typecheck and repeated complete runtime suite after implementation.
- `/check-contract`, `/break-feature`, independent standards/spec code review, and focused
  health-data/security review against this document and the final diff.
- `git diff --check`, forbidden-file/import scans, and local SQLite test.
- The established local-only Supabase verification procedure; if its required local service is
  unavailable, record that exact blocked condition without claiming the aggregate wall passed.
- Recheck PR #67/#61 heads and changed-file overlap immediately before push/PR creation.

## Learning capture hypothesis

### Lightweight capture — source-proof boundaries in a deep composition module

- **Mode:** Lightweight.
- **Lesson:** A local table can prove a bounded owner-filtered temporal read without proving its
  origin taint, FTS rank, episode search, or union conflict semantics. Treat that capability as
  explicit `partial`; exclude unproven legacy content rather than inventing benign provenance.
- **Lesson:** Treat raw local rows as hostile before parsing: SQLite `length(TEXT)` stops at a
  NUL, unordered source rows can perturb a provenance digest, and a literal-only prompt-fence
  check misses decoded closers. Reject NUL-bearing/oversized fields—including every field used
  by a temporal eligibility predicate—before materialisation, canonicalise source ordering before
  hashing, and inspect the same bounded JSON-escape, percent, and printable-base64 views used at
  the source boundary.
- **Track:** Bug/failure and knowledge/practice.
- **Symptom/opportunity:** An adversarial public-seam pass found that byte-truncated SQLite text,
  encoded reserved fence closers, and unordered source snapshots could bypass an otherwise
  deterministic/safe composition boundary.
- **Root cause:** The tempting shortcut is to label legacy `user_id` data as trusted because it is
  local. That silently escalates source trust and makes a headless fixture look production-ready.
- **What worked:** Snapshot/revision attestation, bounded in-flight/failure capture, the
  runtime-owned V2 replay witness, an explicitly injected test-only taint proof, canonical H15
  temporal planning, and public SQLite tests for no-proof exclusion, proof failure,
  same-principal/cross-tenant isolation, offset-safe point-in-time queries, real bound NUL-row
  preflight, encoded fence-closer rejection, and permutation-stable selection provenance.
- **What did not work:** Counting/exposing non-system rows, lexical ISO ordering, and using
  curator `pinned` as invocation priority all leaked or invented facts and were removed. A
  text-only length guard, literal-only fence check, and digesting repository order were likewise
  insufficient and were replaced with byte/NUL-aware, decoded-view, and canonical-order guards.
- **Overlap check / destination:** `rg` found no existing ContextComposer or legacy-recall
  source-proof home beyond this issue-owned ISA document; this section is the smallest durable
  Evidence Trail rather than a new governance artifact.
- **Where to look first:** This ISA section and the public ContextComposer/SQLite tests; future
  production source adapters must re-prove the same boundaries before widening the capability.
- **Source/provenance:** `packages/runtime/src/context-composer/{index,sqlite}.ts`,
  `packages/runtime/src/recall/gateway.ts`, HEY-174, HEY-175, and HEY-176.
- **Applicability limit:** Do not use this pattern to authorize production legacy-memory ingress;
  it applies only until the source schema/proof adapter retains taint and full recall facts. Do
  not call the V2 witness a durable snapshot: it verifies an unchanged recomposition and closes
  on drift, while HEY-176 owns historical source reconstruction.
- **Eval/pressure scenario:** Remove `user_id = ?`, replace `unixepoch()` with text comparison,
  admit no-proof rows, or relabel partial recall as `ok`; the public SQLite/temporal tests must
  fail.
- **Refresh outcome:** New, narrow, and linked to follow-up ownership.
- **Evidence Trail:** This learning capture is the evidence trail for the adversarial repairs;
  its focused public-suite command is recorded in the PR and Linear issue evidence.
- **Impact surface:** ContextComposer, local SQLite adapters, and future HEY-174/HEY-175 source
  adapters; no ADR, run-loop, or schema mutation.
