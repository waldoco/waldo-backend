# Calendar coverage Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Preserve bounded Calendar pagination and truthful selected-account coverage for query_calendar.
**Architecture:** Add calendarPage beside unchanged events(). The client factory supplies authoritative proxy connection ID or local nullable-ID/email metadata. Continuation handles are versioned and HMAC-bound to the refresh grant, proxy connection, calendar, exact window, limit and filters. Legacy first primary reads report unknown account and incomplete coverage.
**Tech Stack:** TypeScript, Zod, Vitest, Google Calendar REST, existing connector proxy.
**Spec:** Approved delegated request, issues #177 and #444.

## Global Constraints
- No owner-DO/console edits, consent/policy changes, external publication or live OAuth.
- Base 5958a8f73be68d083c78508b9b0aacb67854ce60; branch codex/calendar-coverage.
- Tokens never enter model output. Existing events() consumers remain unchanged.
- SESSIONSTART publication pending; this document is the local run contract only.

## Review Focus
- Malformed provider pages fail closed.
- Empty pages with continuation never imply absence.
- Cursor replay with changed account, calendar, window or filter rejects.
- Revocation rejects without account fallback.
- All-day dates and DST offset instants retain provider semantics.

### Task 1: Add bounded provider page
**Files:** connectors/google.ts, connector-proxy/index.ts, test/calendar-coverage.test.ts.
**Interface:** calendarPage(calendarId,from,to,limit,includeDeclined,pageToken?) returns events,next_page_token,fetched_count,account,observed_at.
- [x] Write tracer test and watch missing operation fail.
- [x] Implement page validation/projection; add operation to shared proxy method inventory.
- [x] Add malformed, all-day, declined, DST, empty-continuation tests in red/green cycles.

### Task 2: Model coverage and continuation
**Files:** contracts tools/schemas/reads.ts, tools/live/google.ts, associated tests.
**Interface:** calendar_id and bounded page_token arguments; selected account/calendar/window/observed_at coverage, current-page completeness only.
- [x] Write receipt test and watch old result fail.
- [x] Implement schema and handler with fail-closed selection and continuation.
- [x] Verify multipage, truncation, mismatch and revocation tests.

### Task 3: Verify and hand off
- [x] Run contracts/runtime tests and types, diff check and practical broad wall; classify failures.
- [x] Preserve exact commands/results and remaining nullable local canonical mapping for independent parent review.

Ruling: no optional host selection seam or in-memory custody. Existing factories attest actual grant metadata; proxy receives body.connection. Local connection_id stays null. Refresh-grant replacement invalidates cursors intentionally. No secret or email enters the cursor payload.

Review fixes: require the real calendar#events provider collection envelope and reject error envelopes; strict normalized receipts gate coverage. Keep edge-shared Google code independent of bare workspace imports, proven by scripts/tests/calendar-edge-dependencies.test.mjs. Add only generic test adapter mapping in scenarios/isolated-google-client.ts and isolated-google-client.test.ts; no source-world or native36 case changes.

Engineering checklist: explicit-offset/DST/all-day time tests, injected world-clock observation, malformed provider and proxy receipts, bounded cursors/page counts, revoked grants and connection/query fences, no secret output, and concrete isolated adapter mapping. Historical bug-class checklist edits under docs/planning are reserved, so no governance document changed.

Observed verification: final targeted Google/Calendar/proxy 76 tests pass; isolated adapter 8 tests pass; edge dependency graph 1 test passes; contracts 1723 tests pass; all repository types pass after final review fixes. Interrupted full test attempts (exit 130) were not counted as passes; one saw a newly added RED request-window test while editing, subsequently fixed. Initial guards were blocked by missing origin/main; task-base override was rejected because base equals HEAD, preserving strict ancestry. Parent supplied authentic origin/main for final guard run. Full verify and Supabase reset checks not run because reset can disturb the shared local stack; Deno compiler unavailable.

Final verification (uncommitted candidate on base 5958a8f73be68d083c78508b9b0aacb67854ce60):
- PASS: `pnpm typecheck` all packages, including runtime worker/integration.
- PASS: `WRANGLER_LOG_PATH=/tmp/waldo-calendar-logs pnpm --filter @waldo/runtime test test/calendar-coverage.test.ts test/google.test.ts test/connections.test.ts` — 76 tests.
- PASS: `pnpm --filter @waldo/runtime exec vitest run --config vitest.scenarios.config.ts test/isolated-google-client.test.ts` — 8 tests.
- PASS: `node --test scripts/tests/calendar-edge-dependencies.test.mjs` — 1 test; Deno itself unavailable.
- PASS: `pnpm verify:node` — contracts 1723, workspace 26, browser fixture 7, relay 26.
- PASS: documented CI prerequisite `pnpm --filter @waldo/dashboard-app build` then `pnpm --filter @waldo/dashboard-app verify:assets`; generated output only.
- PASS: `WRANGLER_LOG_PATH=/tmp/waldo-calendar-logs pnpm test` after prerequisite — runtime 207 files/2704 tests; all workspace packages exited zero. Full log `/tmp/calendar-full-built.log`. Runtime emitted owner-unconfigured, digest-conflict and owner-root-mismatch fixture warnings; no claim about baseline warning status.
- Prior stable full run FAILED only dashboard-static-worker (expected index HTML 200, got 404) because generated dist was absent. Rebuilt documented assets; failing test passed 2/2 before final full run. Prior log `/tmp/calendar-full-stable.log`.
- FAIL (environment): `pnpm verify:guards` passed 66 script tests and architecture guards through package-manager, then Linux pgTAP bootstrap failed on this Mac (no /etc/os-release, dpkg or PostgreSQL15 binary; out-of-workspace bootstrap write denied). `/tmp/calendar-guards-authentic.log`.
- NOT RUN: full `pnpm verify`, Supabase local reset/migration checks, deployment/live OAuth/provider calls. No broad-check bypass.
- PASS: independent parent/spec/standards reviews and parent reruns of focused 76, isolated 8 and edge 1 tests.

Dependencies were reused from the installed offline cache via temporary setup symlinks; these are removed after verification and are not deliverables. No governance/owner-DO/console-signin source, consent, permissions or default-policy edits.
