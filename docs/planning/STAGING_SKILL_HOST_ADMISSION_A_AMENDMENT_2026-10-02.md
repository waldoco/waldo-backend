# Amendment to Draft A: canonical owner admission policy

Status: proposal for review, docs only. Layer: SOURCE design. Nothing is implemented or deployed. This amends `STAGING_SKILL_HOST_ADMISSION_A_2026-10-01.md` (#520) and the A section of issue #519. Origin: engineering coordination relayed by main from the Codex admission lane on 2026-10-02, not an owner decision.

## Supersedes

The earlier text in #520 that describes a do_name / constant-tenant staging design is superseded by this policy. Do not hash `doName` or `subject` into authority.

## Policy

1. Identity source. A verified canonical owner UUID read from the authenticated directory, inside the owner host. Never from a message, request parameter, transport or model.
2. Mapping. `principal_ref = prn_<32hex(uuid)>` and `tenant_ref = ten_<same 32hex>`. Decision from the Codex admission lane (option b), recorded here: these refs encode the verified canonical UUID, are explicitly NON-SECRET identifiers, and are never authorization tokens. No opacity claim is made and no HMAC is used. Core's earlier objection (identical, reversible refs reach every trace) is resolved by stating this plainly: the UUID may appear in traces and context records, and nothing may treat possession or knowledge of a ref as proof of identity. The contract's error text still says "opaque" (invocation.ts:12-15); that wording is a separate cleanup. One personal owner per tenant.
3. Verification ref. `verification_ref` must match `ver_<32hex>`. Proposed definition: the first 32 hex of SHA-256 over the canonical string `owner-verification:v1:<directory_row_id>:<directory_revision>`. "Revision" is not defined today: `RouteRow` in owner-directory.ts has do_name, subject and timezone only. Codex lane's proposal (not installed): `owners.admission_revision`, monotonic and trigger-bumped on custody-relevant owner or presence changes, including a same-row delete and re-create (ABA). The lookup returns the revision and the exact row identity. Core accepts the `ver_` definition with that revision. Until the directory has it, no `ver_` ref can be minted and admission fails closed.
4. Fresh checks. Lifecycle (linked, unlinked, closed, revoked) is re-read before any disclosure or effect, and again after every awaited read and after resume of a run. A failed or unavailable check fails closed.
5. Conversation. The canonical conversation is a fresh source with an explicit label (a closed enum in the context source record, not free text). Legacy rows are preserved and labelled as legacy; they are not rewritten.
6. Default and production callers are unchanged and get no skills.

## Mapping table (proposal)

| Input | Check | On failure |
| --- | --- | --- |
| directory row (uuid, status) | row exists, status active, uuid canonical | refuse before any read |
| uuid to prn/ten | pure function, same 32 hex | none, deterministic |
| verification_ref | names row id and revision | refuse, no fallback ref |
| presence row (telegram, whatsapp) | maps to this uuid | refuse; no same-string comparison across surfaces |
| lifecycle re-check | before disclosure or effect, after awaited read, after resume | stop the run, no effect |

## Reuse of existing contracts

- Authority and context binding: `verifiedInvocationAuthoritySchema`; the context record already rejects a principal or tenant mismatch against the invocation.
- Tool ACL for the snapshot: intersection of handlers registered in this host, `TOOL_PERMISSIONS[trigger]` (the per-handler inverse is enforced in contracts/src/tools/handler.ts), and the owner's current grants and connector state. Computed once when the snapshot is taken and passed to the dispatcher. No second ACL table.
- Context sources and revisions: `runtimeContextSourceSchema` (source_ref, source_kind, scope, source_taint, produced_at) inside `runtimeContextCheckpointSchema` v2. Canonical conversation uses `thread` scope; legacy rows use `principal` scope. A new source_kind is added only if none fits.
- Input: `invocationInputReferenceSchema`.

## Ownership split (proposal)

- Codex / dashboard lane: the private host lookup, the A1 helper (`identity/owner-message-admission.ts` and its test), and the edits in `telegram-owner-do.ts` and `owner-turn.ts`.
- Core: contracts changes (label enum, ACL-intersection function), loader and connector admission checks, context-composer provenance, and the tests (wrong owner or tenant, stale, resume, closed run).
- Core does not edit `telegram-owner-do.ts` or `console-signin.ts`.

## Merge order

1. This amendment (docs).
2. A1 helper plus test (inert, new files).
3. Core contracts and loader PR against the helper's types.
4. DO and owner-turn edits behind the staging allowlist.
5. #519 B (token counter) and C (manifest). Skill activation stays off until step 4 is staged and tested.

## Open facts, not assumed

- The A1 helper is not visible in the repo yet. This amendment describes it only from the relay.
- `RouteRow` in `owner-directory.ts` has do_name, subject and timezone only. Whether the directory can return a canonical UUID today is unconfirmed. If it cannot, step 2 has no source.
- Where the owner's current grant state is read from is unresolved.
- The directory has no lifecycle or status field either (RouteRow carries do_name, subject, timezone). The "fresh lifecycle check" rule has no source until the directory exposes status and revision. Today the DO's own `telegram_unlinked` flag is the only lifecycle signal, and it is DO-local, not directory state.
- CI note: "Workers Builds: waldo-runtime-staging" must be checked on this PR before any merge; it was pending at push time.

## Follow-up: verification receipt, canonical vs legacy label, grants (proposal)

Source: second relay from the Codex admission lane via main, 2026-10-02 14:41 IST. Engineering coordination only, not an owner decision. Types below are proposals; none exists yet.

### 1. Verification receipt

Existing: `verification_ref` is only `opaqueRef('ver')` inside `verifiedInvocationAuthoritySchema` (contracts/src/runtime/invocation.ts line 55). No evidence contract stores or looks it up by that ref.

Recommendation: Core needs no receipt type. The receipt stays private to the host helper (immutable directory row and revision captured at admission, compared by `assertCurrent()`). A contract would only add a place for it to leak. Core's part is a test: the `ver_` ref and the row digest never appear in a context checkpoint, prompt, tool result or log.

If a durable receipt is wanted later, the proposed type is `OwnerVerificationReceiptV1` in `packages/contracts/src/runtime/owner-admission.ts`, a strict object: `receipt_version: 1`, `verification_ref: opaqueRef('ver')`, `principal_ref`, `tenant_ref`, `directory_row_digest` (sha256 hex), `directory_revision` (non-negative int), `verified_at` (int). It is host-private, never part of any serialized checkpoint.

### 2. Canonical vs legacy label

Existing: `runtimeContextSourceSchema.scope` (invocation, principal, tenant, thread, system) says where a source applies. It says nothing about lineage, so it cannot carry this label.

Proposal, in `packages/contracts/src/runtime/invocation.ts`:
- Add to `runtimeContextSourceSchema` the field `lineage: z.enum(['canonical_v1', 'legacy_preserved'])`.
- Bump the checkpoint to `context_version: 3`. In v3 `lineage` is required on every source. v2 parsing is unchanged, so old records still read.
- Checkpoint rule (superRefine): a v3 checkpoint admitted through canonical authority rejects any source with `lineage: 'legacy_preserved'`. Legacy rows are stored and never become context. Their bytes are preserved, not rewritten.
- The label is never authority. A row is `canonical_v1` only when the host's check shows it was written under the same `principal_ref` and `tenant_ref` as the invocation (equality, not a string on the row). A row with a mismatched or missing ancestry is denied and its bytes kept. The enum only records the outcome of that check for audit.
- Surface to surface: a same-owner claim across surfaces still needs the directory mapping, not label or string equality.

Tests (red first): legacy source in canonical checkpoint rejected; v2 record still parses; row with other principal denied and unchanged; missing lineage in v3 rejected; label cannot be set from message text.

### 3. Grants not integrated: fail closed

Implemented as a draft in #556: `packages/contracts/src/tools/acl-intersection.ts`, `intersectToolAcl`.
- Input: `{ trigger, handlers, grants, connectors, connector_backed }`. `grants` and `connectors` are each `{ status: 'available', tools: ToolName[] }` or `{ status: 'unavailable' }`. `connector_backed` is the list of tools that need a live connector, supplied by the host. Connectors are tool lists, not feature names.
- Result is the intersection of handlers, `TOOL_PERMISSIONS[trigger]` and grants, in handler order with duplicates removed.
- When `grants.status` is `unavailable` the result is `{ status: 'denied', reason: 'grants_unavailable', tools: [] }`: ALL tools are denied, not only effect-capable ones.
- When `connectors.status` is `unavailable`, tools in `connector_backed` are removed, the rest stay, and the result carries `degraded: 'connectors_unavailable'`. A connector-backed tool is also removed when connectors are available but do not list it.
- No default-allow and no fallback to the static list. An empty available grant set admits nothing and is not the same as unavailable.

### Required test in the next host slice

A test that a stored row whose principal_ref or tenant_ref differs from the invocation's (or lacks ancestry) can never be given `lineage: 'canonical_v1'`. The label is only the recorded outcome of the host's ancestry check; the contract does not perform that check. This test belongs with the A1 adapter and the DO/owner-turn slice, not with #556.
