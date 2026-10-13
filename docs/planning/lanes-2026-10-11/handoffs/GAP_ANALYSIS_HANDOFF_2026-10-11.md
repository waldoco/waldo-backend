# Handoff: gap-analysis lane, 11 October 2026 (00:20 IST)

This is for the new chat that continues the gap-analysis lane. It links to durable sources instead of restating them, and records only what exists nowhere else. It is not committed; delete it once you have absorbed it. Current source, tests and the ledger win over this file.

## 0a. Update at ~19:10Z (read this first)
- **Merged:**
  - #1026 (ledger, rulings 11–17) as `4b7f7b10`;
  - #1022 (H2) as `bf477a4e`, by the handoff session, and APPLIED to staging (060000 then 20261011000000; 48 history rows; 0 health rows);
  - #1028 as `1757beb2`;
  - #1025 (`c081254d`), #1027 (`7b23f83d`) and #1030 (`ce80802f`): other lanes' test and egress fixes. I reviewed their diffs before merging.
- **CI on push at `ce80802f`:** verify was queued when I left. Check it, because #1027 and #1030 were green on their own merge refs but not re-run on the final combination.
- **Staging Worker:** still `fec37a43` / `ef01d61c`. #1024 isn't deployed yet; the handoff successor does it on the owner's go.
- **H3:** draft #1031 (head `c17dedea`). The handoff session is being replaced by a successor; its state is in project memory `waldo-session-handoff-2026-10-11`.
- **New owner decisions (19:05Z):**
  - alpha cohort 5–10, at most 50;
  - cost ceiling $25 per user per month (#915 L, not wired yet; build it before outside users);
  - browser tasks can be requested from any surface, and Waldo reports back on that surface.
  - Record these in the ledger in a new docs PR: #1026 is merged.
- **Pushback the owner heard:** when they asked not to let unnecessary security or privacy rules block the agent, I kept the legal and safety gates (consent, deletion on withdrawal, no credentials in prompts, approval before sends and purchases, the App Store AI disclosure, DPDP and residency) and dropped nothing else.
- **Browser lane:** session "Finalize the Waldo browser lane (app-first)" is running. It has the owner direction and the caps.
- **Browser lane coordination (~19:30Z):**
  - #987 (approved browser upload) lands BEFORE piece A, on the owner's go. It adds an optional `nativeUpload` to `BrowserSubmitProposal` in approvals.ts. Piece A rebases; there are two mechanical conflicts in telegram-owner-do.ts (#116 comment 6101328651).
  - #973 (workspace_compute) is being re-cut as a draft.
  - The browser lane's app.v1 part proposals are on #116, comment 6101183252, with design §5 in draft #1032. Contract decisions are ours.
  - I told it not to add `exact.browser`. Round 4 meets ruling 16 through the `review` text, so no contract change is needed.

## 0. Read first
- `CLAUDE.md`, `.claude/rules/*`.
- The ledger, `docs/planning/WEBSITE_PROMISE_LEDGER_2026-10-10.md`. Read it on PR **#1026** (branch `docs/ledger-status-2026-10-10-night`, head `09b6ec9a`). That version has owner rulings 11–17 and the refreshed §12 lanes, staging and PR table.
- `docs/planning/OMNIPRESENCE_SEAM_DESIGN_2026-10-10.md`, slices S0–S8. Ruling 13 supersedes its WhatsApp and iMessage renderer table.
- `docs/app/HEALTH_INGEST_DESIGN_2026-10-10.md`, H1–H6 and D1–D7.
- Memory, especially `waldo-owner-rulings-2026-10-10.md`, `waldo-lanes-and-hot-files.md` and `local-verify-pitfalls-in-worktrees.md`.

## 1. What this lane owns
- The ledger, as sole writer. A new docs session sends corrections; it does not edit.
- `packages/contracts/src/app/*`, as sole editor. The app pins six files byte for byte: approvals, controls, core, health-ingest, parts, surfaces.
- Omnipresence pieces A (S1+S3), B (S2+S4), C (S5+S6 plus context engineering) and D (S7+S8 plus the work log).
- Health in context, and the health reader.

## 2. Owner rulings tonight (all recorded in #1026 and memory)
- **18:20Z:** "merge 1024 and go with your consent recommendation" (ruling 11).
  - Withdrawing model processing deletes nothing.
  - Withdrawing storage withdraws both and purges.
  - Model use needs both grants.
  - Re-granting storage never restores model use.
- **18:45Z:** "For zone bands, I agree. … MCP and browser approvals in the app: agreed to it. … For all the other things, I agree with you." and "we can record the rulings and go with your recommendations" (rulings 12–17):
  - App first; Telegram is test-only.
  - Ashish builds WhatsApp and iMessage in parallel: text, images, PDF/TXT and sign-in links.
  - The browser hold is lifted, with a dedicated session.
  - D7 candidate bands come from the app's existing ones.
  - MCP and browser approvals in the app show full details and are approvable.
  - Audit the old drafts.
  - Deploy #1024, and apply 060000 with #1022.
- **Still to explain or decide:**
  - the eval provider key;
  - whether the first consent screen asks for model processing (owner answers in the app session's chat);
  - cohort size and spend ceilings, including browser purchase limits.

## 3. Work in flight

### Piece A: approvals from any surface (S1+S3). No PR yet.
- **Where:** worktree `/Users/shivanshfulper/Developer/Pin4sf/waldo-backend/.claude/worktrees/agent-a0ed40ccc8b8f1ce6`, branch `feat/approvals-any-surface`. Pushed to origin as a backup, no PR. Head `9c6056b0` merges beta-mvp `a7b80436` on top of round 3 (`00dcf597`). Typecheck is clean after the merge.
- **Done:**
  - Rounds 1–3 of independent-review fixes are in.
  - The last review found nothing blocking apart from the items below.
  - Hashes at `00dcf597`: approvals `14c9c0d9…`, parts `f2dc0ec1…`. `parts.ts` is identical to beta-mvp apart from the `google_task_change` kind. Both are superseded by round 4.
- **Round 4, not started (owner ruling 16).** Give this brief to an implementer:
  1. MCP and browser cards on the app show the full review (the same text Telegram shows) and offer approve. Keep stripping the query and fragment from `exact.scope`. Update the `approvals.ts` contract comment that says the app never gets MCP arguments or browser bindings, and flip the skip-only tests.
  2. Grep `describeBrowser` and the MCP review for secret-type fields (password, card number, OTP). Mask any of them on every surface, Telegram included.
  3. Optional: make the legacy free-text browse path (`tools/live/browser.ts:246`) aware of where the card landed. It needs a signature change; otherwise list it as a follow-up.
  4. Then run ONE full runtime suite, nothing else running. Open the PR, put the hashes in its body, and send the app lane one final set covering approvals, parts and health-ingest.
- **Rules for any agent on it:** targeted tests while iterating; no local `verify:supabase`, which resets the shared stack; no push until the final head.
- **Known follow-ups for the PR body:**
  - `GET /app/v1/approvals` returns full reviews of up to 100 decided rows; ledger retention is a forget gap.
  - Older DOs created under the `63e93797` schema keep a `part_json` column. That build was never deployed, so this is plausible only.
- **App lane facts:**
  - The `/chat/main` reader drops parts it can't parse and keeps the row text, so no gating is needed.
  - Every row that carries an approval part must have readable text; that's done.
  - No new row-level or page-level enum values.

### #1028: the health contract (MERGED by the handoff session as `1757beb2`; H3 routes are up as draft #1031 on top of it)
- **Branch and head:** `contracts/health-consent-withdrawal`, head `4097325e`.
- **What it contains:**
  - the comment change for ruling 11;
  - a nullable zone on available pillars while bands are unratified;
  - the scores no-row answer, a 200 `{state:'unavailable', day, reason}` via `healthScoresResponseV1Schema`;
  - the amendment line 27 change (deletion follows storage withdrawal).
- **Hash:** `health-ingest.ts` SHA-256 `bbe7369d…dbc52d`.
- **Remaining:** the app re-pins health-ingest.ts together with piece A's final approvals and parts hashes.
- **Known consequence:** until D7 bands exist, a Recovery score shows in the app but the agent gets no health, because the reader requires a mapped Recovery zone. D7 is now ruled, so H4 should write candidate bands.

### #1026 (open): docs only
- The ledger refresh plus rulings 11–17. The merge needs the owner's go.

### #1022 (draft, handoff lane): the H2 health plane
- **Head:** `4d21fcf9` (the three small fixes are in). The handoff session will merge it once verify passes, then run the staging preflight and apply 060000 and then 20261011000000, approved by the owner in its chat. It will report before and after.
- **Review state:** three independent review passes. The last says it's safe to apply once merged.
- **Owed by the handoff session:** assert `deletion_state: completed`, fix the stale test comment at :289, and drop `begin;`/`commit;` from the rollback body.
- **Order:** the apply pushes `20261010060000` (owner runtime authority, #1013, unreviewed tonight) first. The handoff session is reading 060000 before applying. Ask it for that report.

### Merged tonight
- #1023: Recovery-first reader, deployed.
- #1021: Tasks proposal fix, deployed.
- #1024: C1 stable prefix and C2 tool eligibility, `a7b80436`, NOT deployed. The cache-hit and tool-byte checks from staging traces are owed after the deploy.

### Staging
- Release `fec37a43`, Worker version `ef01d61c`, built clean from that commit (the handoff session confirmed).
- `health-sync` is deleted from staging.

### Solved: the staging controls 400
The handoff session's request-line tail (18:53Z) showed `GET /app/v1/controls?view=…&_=<13 digits>`. The client's fetch polyfill appends a `_` cache-buster when `cache: 'no-store'` is set [inference: whatwg-fetch behavior], and the strict key allowlist (app-controls.ts:32) rejects it. The app lane is dropping the `cache` option on GETs. The server stays strict. Follow-up: no runtime test exercises `/app/v1/controls`, so add one.

### Browser lane
- A chip (task `task_38a603e0`) is offered to the owner as "Finalize the Waldo browser lane (app-first)". Its brief:
  - audit drafts #881, #894, #895, #908, #911, #941, #966, #987, #906 and #973, recommending land, re-cut or close;
  - define an errand set;
  - design the in-app browser experience: live view, takeover in the app, step log with screenshots, persistent sign-ins;
  - keep the S0 network-block gate on the staging Browser Rendering binding;
  - no purchases without spend limits.

## 4. Sessions (addresses change; always use ListAgents)
- **"Waldo app-backend handoff":**
  - owns H2–H6, Google connectors and staging deploys from the Mac;
  - confirms owner rulings with its own user, so relaying alone isn't enough;
  - the H3 routes branch is local, built on #1028;
  - has the three #1022 fixes, the 060000 read, the #1024 deploy (clean checkout, check Ashish first) and the D7 band values from the app.
- **"Take over waldo-app PR #16 in slices":**
  - app main `30579e1f` (#30 pin, #31 trace line, #32 build order, #33 schedule screen);
  - holds the re-pin until the final hash set;
  - was asked for the D7 band values (to the handoff session) and the controls discriminators.
- **"Start waldo-app session":** comes and goes. An undelivered note is below.
- **Docs session:** to be created by the owner through a chip. It keeps a traceability file only, sends ledger corrections to this lane, and posts #116 comments.
- **Ashish (human):** WhatsApp, iMessage (#1017), device bridge (#1006).

**Undelivered to "Start waldo-app session":**
- `view=connections` never fills `channels[]`; use the `telegram` block.
- `POST /app/v1/actions` accepts only `view: 'day'` (`timezone.set`, `proactivity.set`). `channel.unlink` is in the enum but refused with 400.
- Settle `src/agent/**` ownership with the #16 session (waldo-app#32 §6).

## 5. Queue for this lane (app first)
1. Piece A round 4, then the PR, then the hash set to the app lane.
2. Get #1028 and #1026 merged on the owner's go. Answer the handoff session's 060000 report.
3. S2: proactive delivery to app-only owners (needs 060000 applied). S7: push, with a new `20261012…` migration.
4. C3 (store hardening) and C4 (skills on every surface). Then C5 one transcript (after A), C6 compaction (needs contract/ADR review), and C7–C8 threads.
5. S8: rich output in the app, plus an artifact and file library (Instinct-style). Sending files into WhatsApp and iMessage chats is new per ruling 13.
6. Google connect from the app: no contract exists; schedule it.
7. Tracing: build an eval loop once the owner provides a key, with a release scorecard (task completion, approval acceptance, tool error rate per tool, p50/p95 latency, cost per turn, cached tokens). Eval fixtures use synthetic health values only.

## 6. Verification habits learned tonight
- Run one full runtime suite at a time, queued with an until-loop. A "Timeout starting cloudflare-pool runner" means files never ran: compare the file count (404 is clean).
- `guard-pgtap` is UNAVAILABLE on macOS, and `run-all.mjs` stops at it. Run the guards individually; a runner script lives in the scratchpad (session-local), or loop over `scripts/guards/*.mjs` yourself.
- Merging means merged, not deployed. Report PASS / FAIL / NOT RUN / UNAVAILABLE per stage at an exact SHA.
