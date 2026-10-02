# Amendment to Draft A: canonical owner admission policy

Status: proposal for review, docs only. Layer: SOURCE design. Nothing is implemented or deployed. This amends `STAGING_SKILL_HOST_ADMISSION_A_2026-10-01.md` (#520) and the A section of issue #519. Origin: engineering coordination relayed by main from the Codex admission lane on 2026-10-02, not an owner decision.

## Supersedes

The earlier text in #520 that describes a do_name / constant-tenant staging design is superseded by this policy. Do not hash `doName` or `subject` into authority.

## Policy

1. Identity source. A verified canonical owner UUID read from the authenticated directory, inside the owner host. Never from a message, request parameter, transport or model.
2. Mapping. `principal_ref = prn_<32hex(uuid)>` and `tenant_ref = ten_<same 32hex>`. Both are opaque refs per `verifiedInvocationAuthoritySchema` (contracts/src/runtime/invocation.ts). One personal owner per tenant.
3. Verification ref. `verification_ref` (`ver_...`) records the directory row and revision that proved the UUID, so a ref is more than a label.
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
