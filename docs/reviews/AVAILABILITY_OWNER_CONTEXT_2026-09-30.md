# Availability and owner context read slice

Issue #444. Source implementation only, not deployed or live-certified.

- `query_availability`: Google FreeBusy across up to 50 explicit calendar IDs, provider range/coverage checks, merged busy intervals, explicit work windows, duration-fitting gaps. Missing/error coverage is unknown, never free. Read-only; no proposal, approval, booking or intent.
- New consent requests `calendar.events.freebusy`. Existing events-only and legacy-null grants do not cover it. Official compatible broader scopes are accepted: calendar.freebusy, calendar.readonly, calendar. Reference: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- `read_owner_context`: host-bound owner-local lexical recall, whole statements, evidence and provenance, retirement/deletion filtering, 64KiB whole-row budget with explicit omissions. Context is not action approval. It does not claim to read full chat history or current external state.
- Both reads preserve external taint. Existing effect gates and blocked native fixture support remain unchanged. Probe capture strips both. Existing Google handler ordering is preserved.

## Evidence

Red-first test initially failed for absent availability module. Final targeted actual-handler/dispatcher/proxy/owner DO gate: 32 tests passed. Real two-owner DO isolation, transactional correction, deletion, oversized whole-statement handling, direct dispatcher schema admission, malformed provider coverage, scope alternatives and signed proxy rejection are exercised with fictional data.

Full contracts: 1696 tests. Full runtime default inventory: 153 files, 2166 tests across five bounded batches, then the changed actual-dispatch tests rerun (three additional assertions/tests). All default files passed; dashboard assets required the CI build prerequisite. Separate scenarios: 69; workspace: 26; owner ingress: 5. Full typecheck passed. All guards including unchanged 274 pgTAP passed with UTC and an explicit historical migration base in this shallow checkout.

Initial pgTAP failure was textual timezone rendering under the local Asia/Calcutta environment; UTC rerun passed without editing SQL or assertions. Responsibility integration remains unverified here: local Supabase service unavailable (four non-Supabase integration tests passed, one local test skipped after suite setup failure). CI must verify the exact pushed head.

ACL snapshots and one deterministic context digest changed only to include the two new tool names. No prompt-template, provider/model, schema migration or deployment changes.

## Open limitations

Existing account selection still uses the first healthy account covering the feature. No account-selection API or calendar enumeration is added. Missing scope can surface as the existing not-connected affordance when account filtering returns no client; reconnect is necessary. Source mocks prove request/response semantics, not live Google consent or availability. Native scenario mapping for these tools remains explicitly blocked pending its own reviewed adapter.

## Cold-review correction

Independent review found malformed `errors:{reason:'notFound'}` could claim complete free coverage. Actual dispatcher repro failed red. The provider connector and actual handler now both validate calendar objects, busy arrays/intervals and errors arrays/items; malformed values give unknown/no openings or typed failure. Direct connector HTTP200 and actual dispatcher regressions cover null/nonobject rows and malformed error/busy shapes. This correction requires exact-new-head CI and reviewer re-gate; earlier six-green CI is not the correction's evidence.
