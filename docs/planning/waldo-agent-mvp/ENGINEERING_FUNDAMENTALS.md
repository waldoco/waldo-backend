# Engineering fundamentals (standing owner directive, 2026-09-24)

The owner wants senior product-engineer rigor on every slice, so a bug class shows up in our tests before it shows up in his hands. This file is the checklist. It applies at build time and at review time.

## How it is applied

1. **Before a slice ships**, walk the checklist below for every surface the slice touches. For each line that applies, point to the test that covers it, or write that test.
2. **When a bug is found** (by the owner, by a live run or by review), fix it and do both of these in the same commit:
   - add an adversarial test that reproduces the bug class, not just the one input;
   - add or sharpen a checklist line here, and add a row to the bug log at the bottom.
3. **A recurrence of a logged class is a process failure**, reported as such in the deploy report.
4. The deploy report says which checklist sections the slice touched and what is proven live versus only by tests.

## Checklist

### Tokens, auth and sessions
- A one-time token is spent only by a deliberate user action (a POST from our own page), never by a GET. Link previews, scanners and prefetchers issue GETs.
- Every URL we send in chat has previews turned off unless the preview is the point.
- Tokens have an expiry, a single use, and are compared in full. Minting a new one invalidates the old one on purpose, and the tests say so.
- Cookies: HttpOnly, Secure, a narrow Path, and a SameSite value that works for the actual navigation (Strict cookies are dropped on cross-site redirects).
- Every state-changing request checks CSRF and the owner identity. Callback data from buttons is checked against the owner before it acts.
- Secrets never reach the repo, chat, logs or traces.

- Every code-based sign-in proves in a real run that the code actually arrives: the email template must carry `{{ .Token }}`, which Supabase's default does not.

### Idempotency and retries
- Every webhook, callback, scheduled fire and migration can run twice without a second effect. Store the offset or the key before or atomically with the effect.
- Every button press is safe when pressed twice or late ("Already handled", "expired").
- Retries have a bound and a backoff. A failed step logs and leaves state that the next run can resume.

### Concurrency and ordering
- Writes that belong to one turn settle before the next turn reads them.
- Anything that reads and then writes shared state runs inside the DO's serial queue or one transaction.
- External writes use a version check (etag / If-Match) so we never overwrite a change the owner made meanwhile.

### Time
- All user-facing times are in the owner's timezone. Tests cover midnight crossings, quiet hours across midnight and DST-free zones like IST.
- Expiry checks use one clock source, injected in tests.
- Anything scheduled in the past (late fire, expired proposal) has a defined outcome, and it is logged.

### Data and migrations
- Every migration takes a backup first, is idempotent, and leaves the old data in place until a later cleanup.
- Schema changes on existing Durable Object storage are additive (new table, `ADD COLUMN`) and tolerate the column already existing.
- Invariants are enforced in the database where possible (primary keys, CHECK, UNIQUE), not only in code.
- Deletes that the owner asked for are real, and anything kept afterwards (a do-not-relearn note) is disclosed.

### Failure paths
- Every external call (model, Telegram, Google) has a timeout, and its failure path sends the owner something true or nothing, never a broken half-state.
- A turn that fails still records what happened in the trace.
- Model output is parsed defensively. Invalid output is rejected and logged, and it never partly applies.
- Tool output and prompt inputs have size caps.
- Gate scripts propagate failure: any failed step makes the run exit non-zero. A green-looking log line is not a pass.

### Trust boundaries
- No bearer or refresh token reaches the model, the Durable Object or the Worker. Tokens are read and used only in the connector proxy, and the runtime's database key cannot execute the token functions.
- Only the owner's own words are evidence about the owner. Files, mail, calendar and web text are data, fenced in the prompt so they cannot break its structure.
- Judgment belongs to the model. Deterministic rejects are only for hard security and safety lines.

### Observability
- Every hop logs trace id, duration, ok/failed and a short detail. The E2E checklist names the hops that prove each step.
- A live claim in a report points to a trace or a curl, not to a test.

### Database tests
- pgTAP files set up their own fixtures and clear any row or Vault secret they depend on, so leftovers from a live-local run cannot fail them. Live-local runs delete what they create.
- A pgTAP check reads a function's writes in a later statement. One statement sees one snapshot, so a check in the same statement sees the old rows.

## Bug log

| Date | Bug | Class | Test added | Checklist line |
|---|---|---|---|---|
| 2026-09-23 | Post-turn memory and spot writers raced the next turn | Concurrency | settle-before-next-turn test (W0, 96c7683) | Concurrency: writes settle before the next turn |
| 2026-09-23 | An approval could be applied after its time had passed, or over an edited event | Time, concurrency | approval expiry and etag tests (96c7683) | Time: past-scheduled outcome; Concurrency: version check |
| 2026-09-24 | Console sign-in link was spent by Telegram's link preview, so every link showed "used or expired" | Tokens | `console.test.ts` sign-in page test; token redeemed by POST only (8167bbf) | Tokens: one-time tokens spent only by a POST |
| 2026-09-24 | Console email sign-in sent Supabase's default magic-link email, which has no code to type | Tokens | `scripts/guards/guard-otp-template.mjs`; template in `supabase/templates/magic_link.html` | Tokens: code sign-in proves the code arrives |
| 2026-09-24 | A pgTAP check for Vault secret deletion read in the same statement as the revoke, so it saw the pre-delete snapshot and failed on correct code | Database tests | `supabase/tests/waldo_connections.sql` checks deletion in its own statement | Database tests: read writes in a later statement |
| 2026-09-24 | W3.2 had the DO read the refresh token back from Vault and refresh it itself, breaking the hard line that no token reaches the DO | Trust boundaries | `connections.test.ts` asserts no token in a proxy call; `waldo_connections.sql` asserts the runtime key cannot execute `proxy_secret` or `proxy_store` (W3.4) | Trust boundaries: tokens only in the connector proxy |
| 2026-09-24 | pgTAP files failed after a live-local run left an owner, presences and the router Vault secret behind | Database tests | every pgTAP file clears the router secret before creating it; live-local scripts delete their rows | Database tests: own fixtures, clear leftovers |
| 2026-09-24 | gates.sh printed "GUARDS fail" but exited 0, and its test steps could not fail the run either, so f0cbb4a was pushed with failing guards | Failure paths | scripts/gates.sh exits non-zero on any failed step; scripts/guards/guard-gates-exit.mjs (proven against the pre-fix script) | Failure paths: gate scripts propagate failure |
