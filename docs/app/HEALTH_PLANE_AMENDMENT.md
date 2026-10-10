# Health plane amendment (beta, staging)

Status: owner-ruled scope, not yet implemented. Applies to ADR-0081, ADR-0024 and the 21 June 2026 meeting note. Implementation lands in separate red-first PRs; migrations are staging-only and apply only after the owner approves the design note.

## Rulings applied
1. Recovery is the only score shipped in the first app stage. Form and Weight report "unavailable" with a reason until their inputs exist (intraday signals, calendar demand). ADR-0081's algorithm is re-versioned as `recovery.v1` (sleep, HRV, resting HR against the owner's own baseline); the view schema and registry change with it.
2. The owner's wearable readings and derived health context may reach model context and owner-channel replies end to end. This replaces the 28 Sep owner-typed-text-only ruling and the ADR-0081 "no numerics in prompts" row for the owner's own data.
3. The consent contract is the beta-mvp one (class, status, integer version, source/purpose evidence). Health ingest and consent tables follow in a migration PR after a design note. Staging only.
4. App Store, DPDP, residency and withdrawal-purge scope stay a hard gate before any outside user.
5. The 21 June note "health stays on-device, never auto-synced" is superseded by consent-bound server storage.

## What changes in the sanitiser (scope the owner approved)
- Structured health objects and health numerics stop hard-denying at model-bound destinations (system_prompt, internal_context, owner_reply) when the source taint is null (owner or system-derived). `health_value_leak` leaves the hard-reason set for those destinations.
- The derived view gets a non-Form schema and carries both `trigger_prompt` and `volatile_run` eligibility.
- A bounded read tool lets the agent pull daily or series readings on demand; the composer still injects only a compact derived view each turn.

## What stays blocked
- Third-party egress (send_message, draft_email, draft_document): health values blocked unless the owner explicitly asks to share a specific item.
- Externally tainted content (mail, web, files): redaction stays.
- Logs, audit records, R2 summaries, browser jobs: no health values.
- Traces: during alpha and beta, by owner ruling (10 October 2026), the staging Langfuse project captures model text for opted-in testers, health included. Production never captures text (enforced in code); revisit before production.
- Secrets, canaries, forget and withdrawal guarantees.
- Long-term memory: no bulk readings; qualitative patterns only, with the existing distinct-day evidence rule. Numeric pattern evidence (owner ruling, 10 October 2026) lives in the Supabase health plane, with memory holding the qualitative pattern and a pointer.
- Provider requests set `store: false`.

## Retention and access (recommendation the owner approved in scope, "90 d raw / 24 mo aggregate")
- Raw readings: 90 days in owner-only tables. Daily aggregates and scores: while the account is active, at most 24 months. All deleted on withdrawal or account delete.
- Encrypted at rest and in transit; row-level security per owner; writes only from the ingest route with service credentials; agent reads through the signed owner-scoped RPC; raw reads leave count-only receipts.
- No health values in analytics, traces or error text.
