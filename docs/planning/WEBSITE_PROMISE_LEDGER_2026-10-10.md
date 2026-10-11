# Website promise ledger: every heywaldo.in promise, its real state, and how it lands

Planning document, 10 October 2026. It maps promises to source and records the owner's rulings. It does not itself merge, deploy, migrate or spend; those stay per-action owner confirmations. Current source and tests decide capability.

## Owner rulings (10 and 11 October 2026)

1. **Scope is final.** Every promise on heywaldo.in ships, including panels labelled "Coming next" and "Planned".
2. **One writer.** The owner and the owner's Claude Code sessions write and merge everything in `waldo-backend` and `waldo-app`. Instinct may take delegated, disjoint slices (`docs/app/codex-handover/OWNERSHIP_BOUNDARY.md`). Kennel's repository and the WhatsApp surface adapter are Ashish's.
3. **Omnipresence.** One brain plugs into any surface and uses what that surface allows (§2). Telegram is a development surface.
4. **Connectors for this push:** Google Calendar, Gmail, Google Tasks, Google Drive, Apple Watch (HealthKit through the app), Galaxy Watch (the app's Samsung Health manager, `modules/health/android/.../SamsungHealthManager.kt` on app `origin/main`), Health Connect, the five coding agents via Kennel, Weather and Location. Telegram stays as the development surface. The rest of the 50-name list follows after these pass.
5. **Rule and wording changes are approved** (§7): numeric health deltas in Patterns, HR/HRV stress for Form and Training, Quiet flags, interruption judgment instead of mail holding, the Brief/Fetch/Close/Spot moments, and Form-driven Windows that block time under a grant.
6. **Google OAuth app:** change scopes as features need; publication later.
7. **Event wakes:** stay on the 10-minute polling sweep. Adopt Gmail/Calendar push only where a promise needs latency below the sweep (Patrol fixes, reply watch, an invite landing in best hours). #998 already has the watch calls; push still needs a GCP topic, OIDC verification and watch renewal.
8. **WhatsApp** is not on this push's critical path. Ashish owns the adapter; the backend keeps the seam.
9. **Android:** the Samsung Health path is enough for now. A dedicated Health Connect client is built if a promise needs it.
10. **Website copy stays as published** (second ruling, 10 October). §6 is kept as a reference list, not planned work. Labels change only when the owner decides.
11. **Health consent** (10 October, 18:20Z). One screen with two separate agreements, `storage_compute` and `model_processing`, withdrawn separately. Withdrawing model processing stops Waldo using health in conversation and deletes nothing; storage and scores continue. Withdrawing storage withdraws both and purges the source's data. Model use needs both grants. Contract comment: #1028; the matching database change goes into #1022.
12. **App first; Telegram for testing** (10 October, 18:45Z). Backend build cycles go to the app at full capability. Telegram stays a test surface and gets no feature work.
13. **WhatsApp and iMessage in parallel** (same ruling). Ashish builds both now. Their scope is text, images, PDF/TXT files, and links that require sign-in to the app or console for anything those surfaces cannot show (approval reviews, charts, artifacts). Buttons, list pickers and numbered menus are out. This supersedes the omnipresence design's renderer table for those two surfaces.
14. **Browser hold lifted** (same ruling). One dedicated parallel session finalizes the browser: it audits the open browser and compute drafts (land or close each), defines a measured errand set, and owns the in-app browser experience. The S0 network-block test still gates the staging Browser Rendering binding. No purchases until the owner sets spend limits.
15. **Zone bands (D7)** (same ruling). Candidate bands come from the app's existing bands, written with `activation: candidate_unaccepted` until the formula review ratifies them.
16. **MCP and browser approvals in the app** (same ruling). The app shows the full review, as Telegram does, and can approve. Query strings and fragments stay stripped from the scope.
17. **Staging actions** (same ruling). Deploy #1024, and apply `20261010060000` with #1022 once it is merged. Each is still executed by the session that runs it, after that session confirms with the owner.
18. **Alpha cohort and spend** (10 October, 19:05Z). The alpha cohort is 5 to 10 people, at most 50. The cost ceiling is $25 per user per month. #915 L builds the ceiling; it is not wired yet.
19. **Browser tasks from any surface** (same ruling). The owner can request a browser task from any surface, and Waldo reports back on that surface.
20. **Proactive delivery** (11 October). Proactive messages go to the owner's chosen surface, otherwise to the app. Until a "deliver to" setting exists, this includes Telegram-linked owners. One exception, confirmed by the owner on 11 October, holds until L2's slice 1: a Telegram-linked owner who has never opened the app still gets proactive messages on Telegram.
21. **One main conversation** (11 October). Each owner has one main conversation across all surfaces. Threads stay app and console only.
22. **Who ties the app and backend together** (11 October). The owner's sessions own the work that ties the app and backend together. Instinct takes disjoint slices under `docs/app/codex-handover/OWNERSHIP_BOUNDARY.md`, and they are reviewed before merge.

**Pins (audit lane; baseline 11 October 12:10Z, delta pass 12:45Z).** `beta-mvp` @ `e5fd7200` (the #1053 merge; its code is identical to `81c4f892`, where every row below was read). Staging `/healthz` reads `81c4f892` [verified 12:31Z], so nothing merged is undeployed; the deploy was Worker-only, 54 migrations applied, 0 pending, through `20261011220000` [reported 6108618841]. Website copy `Pin4sf/waldo-landing` main @ `830bfc2`, unchanged since 9 October [verified]. App `waldoco/waldo-app` main @ `d20322ca` (#48–#58 merged on the owner's yes in L4's session [reported 6108662556]); all six contract pins match the backend tip [verified SHA-256 at `d20322ca`]. The app PRs still open (#16, #27, #29) are a recovery checkpoint, a readiness checklist and a Simulator seeder, none a screen. The delta pass changed merged and deployed cells only: the proven rung is unchanged, because no run on staging `81c4f892` or on a physical device has been reported since the baseline. Every staging run so far is the iOS Simulator with synthetic data on the owner's staging account; no physical iPhone or Watch has run and there is no TestFlight build [reported 6108110002, 6108455830]. `DO` below means `packages/runtime/src/channels/telegram-owner-do.ts`; lines after `DO:632` are one lower at `a5a523f9`. Rows are re-pinned after each staging deploy; do not rely on a row older than the latest pass.

## 1. The binding constraint is landing, not building

The 10 October reading, kept as the record of why Wave 0 came first. Current state is in §4, §5 and §12.

Much of what the site promises already exists as source on unmerged branches.

- 45 open PRs target `beta-mvp`, most of them drafts. The Google stack (#903 → #905/#907 → #919), the browser stack (#881, #894, #895, #908, #911, #941, #966, #987) and the grant stack (#918 → #932) overlap.
- #998 is 279 files and +52.8k lines from staging base `1206d7a8`. CI at its head shows 76 failing tests, all in-branch (CI is green at `1206d7a8`, `a13c1fb5` and `957a2cbb`), and its gate stopped at `verify:supabase`, so most suites never ran. Against `957a2cbb` it conflicts in 21 files, and where it overlaps #999 it holds the older copy. It carries most of the health plane, threads, rights, files/voice refs, artifacts and Gmail/Calendar watch calls.
- The app is split into two lines pinned to different backend contracts. Before #999, neither signed in against `beta-mvp` (16-hex `session_ref`, no `account_ref` or `absolute_expires_at`, `channels/app-api.ts:82-108` @ `a13c1fb5`). #999 is now merged; app line `a7a560d1` pins #999 at `153ba016`, so it re-pins to the merged contract and needs a device run against a staging deploy of `957a2cbb`.
- Staging was deployed with `957a2cbb` on 10 October with migrations through `20261010040000` applied, from the owner's Mac (GitHub Actions dispatch was disabled for the account). A merge is not a deploy: report merge, migration and deploy separately and check `/healthz`.

Wave 0 lands and converges existing work before new features start.

## 2. Omnipresence: the acceptance rule for every row

A promise is shipped only when all three hold:

1. **App at full capability.** Threads, sessions, approval cards, generated UI (AG-UI parts), charts, quick-reply chips, files, voice, push.
2. **Messaging surfaces at their own maximum, degrading honestly.** WhatsApp and iMessage carry text, images, files, URLs and voice notes. Where a surface has no native buttons or charts, the same output degrades: a chart becomes an image, quick replies become a short numbered line. Threads and sessions exist in the app and console only (owner ruling, 10 October); messaging surfaces keep one main chat, and a follow-up there continues the main chat anchored to the referenced message. A surface never claims an affordance it cannot render.
3. **One state across surfaces.** Start on one surface, continue or approve on another, one receipt. Context, approvals, responsibilities and history belong to the owner, not the channel.

Telegram traces are development evidence, not acceptance.

### Telegram-first defects found in source

Re-anchored at `81c4f892` [verified unless tagged].

| Defect | State at `81c4f892` |
|---|---|
| The owner runtime defaults to Telegram | `setup(channel = 'telegram')` (`DO:1541`). Partly fixed: the alarm runs an admitted app-only owner on `'app'` with an app sink (`DO:1239-1247`), and #1034 routes reminders to the app for app-bound owners (`DO:1300-1313`). Still Telegram: the default runtime, console `setup()`, the "Google is connected" notice (`DO:1218-1224`), and the final outbox keyed by `chat_id` (`telegram-final-outbox.ts:195,221`) |
| App-only owners' proactive jobs are never armed on sign-in | App `ready` is browser wait only (`DO:1992`). Cards arm only through `timezone.set` → nightly → `armDayCards` (`DO:2619`, `:2300`), a console visit (`DO:1050,1102,1117`) or the chat schedule tool (`schedule-preferences.ts:55-64`). No test and no staging run shows a card reaching the app |
| Arming at sign-in has no zone to arm in | Without a stored timezone the DO clock falls back to `WALDO_OWNER_TIMEZONE`, then UTC (`DO:1597,1602`). The app sends no timezone on sign-in; it only has the owner-initiated `timezone.set` (`controls.ts:14`). So an arming path at app sign-in would fire the nightly run and the Brief in the wrong local zone until the owner sets one. The choice (ask at sign-in, send the device zone, or arm only after `timezone.set`) is with the owner [verified; raised by the alignment session] |
| Console "sign out everywhere" leaves the app signed in (MEDIUM) | The in-DO action clears only the DO's local `console:sessions` (`DO:1082,1173`; `console.ts:90-92`). The app bearer is a directory session (`console-auth.ts:41-44`, `readAppCredential`), revoked only by the Worker route `/console/signout-all` (`console-signin.ts:301-307`, RPC `console_signout_all`). Needs a ticket; a small L2 change calling the directory `signOutAll` from the DO waits for the owner's go [verified; L2 confirms per the alignment session] |
| Calendar Prep exits on any non-Telegram channel | `DO:2385`, `:2410`, `:2416` |
| The app sink carries text only | `surfaces/app.ts:17-24`: `sendMessage` only; any keyboard with `callback_data` returns `undefined` (so the update card fails on the app, `DO:2482,2505-2507`); the ack is a fake `message_id: 1`. Approvals now reach the app by their own route (`/app/v1/approvals`, #1048), so "approvals never reach the app" is closed |
| App send is text only | `client_message_id` and `text` (`contracts/src/app/core.ts:33-35`); attachments throw (`DO:1956-1957`); no anchor or parent |
| Console approves calendar changes only | `console.ts:265`, `dashboard-waiting.ts:7`; it can dismiss email and message sends (`dashboard-control-actions.ts:38-40`) |
| Skills load on Telegram only | `DO:2045`, `:2080`; `curated-host.ts:41-49` |
| Ratings are Telegram update-card buttons only | `DO:2482`, `:1462-1467`; no app part |
| No `sendDocument` on any surface | `workspace-delivery.ts:6-19` |
| No APNs sender | `app_push_*` tables exist (`20261010040000`); the runtime calls only `app_push_revoke_session` at sign-out (`app-api.ts:161`); no register route, no sender |
| WhatsApp adapter unwired | `surfaces/whatsapp.ts` is imported by its test only; the webhook is routed (`index.ts:179-181`); `setup('whatsapp')` throws without its secrets (`DO:1556`) |

## 3. Evidence ladder and tags

Each row carries one rung, the lowest that is true at the pins:

- **none**: no source and no accepted design.
- **source**: code only on an open PR or branch, or a contract with no handler (`contract only`).
- **merged**: on `beta-mvp` at the pin, not on staging.
- **deployed**: on staging at the `/healthz` release, not seen working.
- **proven**: seen working on staging or a device, with the evidence pointer. `(Simulator)` marks an iOS Simulator run with synthetic data against staging; it never clears a device promise (HealthKit, background delivery, Watch, push).

A promise is **delivered** only at `proven` on the app under the §2 rule. Merged is not deployed; deployed is not proven. Tags: `[verified]` read at the pin SHA, `[reported <id>]` a lane said so on #116, `[inference]` reasoning. The old vocabulary maps as LIVE ≈ proven, ON-BETA ≈ merged or deployed, PR #n ≈ source, SPEC and NOTHING ≈ none.

‡ marks rows whose build can be delegated to Instinct under the delegation rule.

## 4. Feature ledger (37 promises)

Lane names are the lanes that own the area in `docs/planning/lanes-2026-10-11/README.md` today; "unassigned" means no lane holds it and the owner decides. The audit lane assigns nothing.

### Health (scores and panels)

| Promise | Site label | Rung | Evidence at the pins | Surfaces today | Lane | Gap |
|---|---|---|---|---|---|---|
| Recovery (sleep + HRV + resting state) | present tense | deployed (Simulator) | `recovery.candidate.v1`, activation `candidate_unaccepted` (`health/scores/index.ts:44-50`); the producer writes it after each committed ingest (`health/producer.ts:109-110`); the chat reader is Recovery-first (`channels/health-context.ts:84-85`). Simulator shows Recovery available [reported 6107519497, 6108184771] | app: `GET /app/v1/health/scores` on Health Stats and the Home summary (app #53, #57 merged; Simulator read only); console: "Not built yet" (`console.ts:235`); chat: only with both consents | L1; L4 | Formula not accepted; no physical device; the model sees candidate scores under legacy version names with no activation label (`health-context.ts:119-121`) |
| Form (circadian, motion, stress) | present tense | deployed (Simulator, `stale_inputs`) | `form.candidate.v1` with an HR/HRV stress part counted in awake hours outside workouts (`scores/form.ts:19-23,61-66`); `stale_inputs` when the newest hour is older than 6 h (`form.ts:11,40-43`) [reported 6108184771] | as Recovery | L1; L4 | No live Form yet: the app uploads in the foreground only (app `useHealthIngest.ts:12-16`, 10-min throttle), so inputs go stale; L1 is looking at `stale_inputs` on backfilled days [reported 6108618841] |
| Weight (meetings, messages, tasks, load) | present tense | deployed (always unavailable) | the math exists (`scores/weight.ts:28`) but the producer passes `demand: null` (`producer.ts:95`), so every result is `calendar_demand_unavailable` (`weight.ts:13`); no demand collector | as Recovery | L1 | Calendar demand input (reads across calendars, task estimates) |
| Sleep debt | Working today | merged (computed, not stored) | computed (`scores/index.ts:53`, `scores/sleep-debt.ts:12-28`); dropped by the producer (`producer.ts:104-117`); the write fence rejects `sleep_debt` (`20261011030000:21`); no contract field (`health-ingest.ts:193-201`) | none | L1 | Store, serve, prompt |
| Quiet flags (SpO2, breathing rate, wrist temp) | Working today | source (ingest only) | SpO2 and respiratory rate are ingested (`health-ingest.ts:132-133`) and unused by the producer (`producer.ts:16`); no wrist-temperature signal in the contract; no deviation logic | none | L1; app (HealthKit types) | Deviation-from-usual computation; wrist temperature in contract and app; non-diagnostic copy |
| Training (workouts with meetings; run vs desk heart rate) | Working today | source (partial) | `workout` is ingested (`health-ingest.ts:136`) and used only to exclude workout hours from Form stress (`form.ts:22`); manual `log_workout` (`channels/health-log.ts:115`) | chat: manual log | L1 | Workouts-against-meetings and run-vs-desk outputs |
| Weather and daylight ‡ | Working today | daylight: deployed; weather: source (branch) | `daylight_duration` is ingested (`health-ingest.ts:127`) and a Form input (`form.ts:56-57`); no weather tool on beta; `get_weather` exists only on `instinct/weather-daylight-tool` (`bc3d8cc9`, PR #1043) | none | Instinct brief 02 (L1 reviews; L2 registers) | Provider, coarse-location consent, registration |
| Your history (7/30/90 dots, tap a day) | Working today | none | app health routes are consents, withdraw, ingest and scores only (`health-ingest.ts:216-221`); scores takes one `day` (`:190`); the producer writes yesterday and today only (`producer.ts:137`), so a backfill leaves no past-day scores | none (app "All Data" is a placeholder with no link) | unassigned | Range route, past-day scores from backfill, a by-day activity read, app screen |
| Bring your past (Apple Health import) | Working today | deployed (Simulator) | chained-anchor ingest with a 90-day raw window (`health-ingest.ts:12`); pgTAP `waldo_health_backfill.sql` accepts 3,000 readings; the app runner on main sends 30 days (`healthIngestRunner.ts:11,96`) in the foreground only; the native `connect()` before `readRange` that cleared `NOT_CONNECTED` is merged (app #48); Simulator backfill acknowledged [reported 6107519497] | app | L1; L4 | Physical-iPhone backfill; background delivery (no `enableBackgroundDelivery` or `BGTaskScheduler` code, entitlement only) |

### Day to day (six moments and six panels)

| Promise | Site label | Rung | Evidence at the pins | Surfaces today | Lane | Gap |
|---|---|---|---|---|---|---|
| The Brief | present tense | deployed (Telegram); app path untested | `card:brief` 08:00 (`prompt/day-cards.ts:14`); composed with no health source (`channels/day-cards.ts:167-170`); sent with `api.sendMessage` (`DO:2532`). App-only owners run scheduled work on the app sink (`DO:1239-1247`), but nothing arms the cards at app sign-in (`DO:1992`); they arm through `timezone.set` → nightly → `armDayCards` (`DO:2619`, `:2300`) [verified path; end to end is inference] | Telegram (linked owners); app transcript for app-only owners once armed; the app `day` view shows card metadata only (`controls.ts:33`, no `latest`) | L2 (P3a) | No test or staging proof of a card reaching the app; no card content for the app; no push; health is not in the card prompt |
| The Window (block sharpest stretch) | present tense | none | vocabulary only (`messaging-behavior.ts:26`) | none | unassigned (Wave 4) | Everything (ruling: Form-driven, blocks under a calendar `auto` grant) |
| Prep (35 min before) | present tense | deployed (Telegram, staging only) | 40-min lead with a 10-min sweep (`event-briefs.ts:9-10`); `CALENDAR_GROUNDED_PREP` 0 in production, 1 on staging (`wrangler.jsonc:20,84`); primary calendar only (`DO:2368`); exits for any non-Telegram channel (`DO:2385,2410,2416`); no "last time's open items" | Telegram | L2 | App exit; open items from last time; copy says 35 min |
| The Heads-Up | present tense | deployed (as a 14:00 check-in card) | `card:midday` 14:00 (`prompt/day-cards.ts:23-29`), same path as the Brief | as the Brief | L2; Wave 4 | It is a check-in card, not pattern-driven |
| The Close | present tense | deployed (Telegram) | `card:close` 21:30 (`prompt/day-cards.ts:31-37`); previews tomorrow's calendar (`channels/day-cards.ts:124-128`) | as the Brief | L2 | "Moved / protected" counts need Waldo's own moves |
| The Adjustment (weekly) | present tense | none | no weekly card | none | unassigned (Wave 2) | Everything |
| Your best hours | Coming next | none | no source | none | unassigned (Wave 4) | Everything |
| The right task, at the right time | Working today | deployed (reads and approved writes) | `get_tasks` reads all lists with paging (`tools/live/google.ts:262-297`); `propose_google_task_change` creates, edits, completes or reopens after approval (`tools/live/tasks.ts:10-30`; app-approvable, `approvals.ts:77,105`); `write_task`/`update_task` names still have no handler (`tool-replay-class.ts:48`) | chat on any surface; approvals on app routes, Telegram | L3 (approvals) | Right-time ordering and the energy input; the app approvals screen (#54) is unmerged |
| Fewer pings | Coming next | none | fixed gates only: volume and quiet hours (`loops.ts:96-102`); `computeAdmission` is used for Prep only (`DO:2415`); no Slack | none | unassigned (#915 K) | Interruption judgment (ruling: no mail holding) |
| Fixed first, mentioned after (The Patrol) | Working today | deployed (list only) | heartbeat lists past-due loops with no model call and no effect (`heartbeat.ts:97-123`); no standing grant on beta (#932 unmerged); every loop pinned L0 (`loop-policy.ts:127-205`) | Telegram; app transcript for app-only owners [inference, untested] | unassigned (#915 I + J) | Grants, autonomous effects, overlap detector |
| Patterns (Spots → named pattern) | Coming next | deployed (constellations) | constellation tables (`memory/claims.ts:378-400`); promotion runs from nightly (`DO:2296-2299`, `owner-turn.ts:687`); a health exclusion is located only for transient decisions (`owner-turn.ts:659`) | console memory graph; app view decided (owner answer via L3, 6109120916: Constellations go in the app with full claim text; L3 builds a read-only `view=constellation` after the Brief `latest` field; app #60 renderer open, unwired) | L3 (view), L4 (screen) | Named patterns with numeric health deltas; the app view is not yet a contract |
| The Slope (six measures vs four weeks) | Coming next | none | labels only (`console.ts:203-204`, `messaging-behavior.ts:27`) | none | unassigned (Wave 4) | Producer and the Stack, Signal Pressure and Task Pileup signals |

### Talk to Waldo

| Promise | Site label | Rung | Evidence at the pins | Surfaces today | Lane | Gap |
|---|---|---|---|---|---|---|
| Threads | Working today | source (contract only) | thread tool schemas (`contracts/src/tools/schemas/threading.ts:59`), every one `NO_HANDLER` (`hooks/tool-replay-class.ts:50-51`); no app route or view | none (the app Chats list holds local drafts only, `chats.tsx:64-67`) | L3 (threads contract) | Handlers, app route, app screen; app and console only by ruling 21 |
| Follow up on anything ("Tell me more") | Coming next | deployed (Telegram reply-quote) | `telegram-polling.ts:141-150`, `owner-turn.ts:531-550`; the app send has no anchor (`core.ts:33-35`); only calendar proposals carry a reason, shown as `Proposed: …` (`approvals.ts:157,788`) | Telegram | unassigned (Wave 1 anchor, Wave 2 provenance) | App anchor; provenance on every kind |
| Quick replies | Working today | source (contract only) | `replyQuickRepliesPartV1Schema` (`parts.ts:31-36`, `core.ts:45`); no producer; `chat/main` emits `text` and `approval` parts only (`app-api.ts:203`) | none | unassigned (Wave 1) | Producer |
| Charts in replies | Working today | source (contract only) | `replyChartSeriesPartV1Schema` (`parts.ts:37-44`); no producer | none | unassigned (Wave 1 + 3) | Producer and series data; own surfaces only |
| Full history | Working today | proven (Simulator) | `GET /app/v1/chat/main` with an immutable `before:<id>` cursor, 20 per page (`app-api.ts:191-206`); the app's "Load earlier" uses it [reported 6106586883]; scheduled prompts are saved as `role:'user'` (`owner-turn.ts:580,596-597`) and the page filters by role only (`app-api.ts:192`) | app, Telegram | L3 | Machine prompts render as the owner's bubbles; no reason beside each move |
| Thumbs up / down | Working today | deployed (Telegram update cards only) | `DO:2482`, `:1462-1465`; `update-cards.ts:54-59`; no app part | Telegram | unassigned (Wave 1 + 4) | App part; ratings on Briefs and replies; rating changes style only |

### Your rules

| Promise | Site label | Rung | Evidence at the pins | Surfaces today | Lane | Gap |
|---|---|---|---|---|---|---|
| Three levels, per area | Working today | none (enum only) | `autonomyLevelSchema` L0–L3 (`contracts/src/runtime/loop-policy.ts:73`); every policy `'L0'` (`:127-205`) with no runtime consumer; #932 unmerged | none | unassigned (#915 I) | Everything beyond the enum |
| Always comes back to you | Working today | deployed (routes); app screen merged (app #54, Simulator list read) | six kinds (`parts.ts:18`; `approvals.ts:104-107`); the app decides any kind whose review is at most 32,000 chars (`app-approvals.ts:17-57`; `approvals.ts:159-162,310`), MCP and browser as approve/skip (ruling 16); Telegram up to 3,800 chars (`approvals.ts:120,289-292`); console calendar only (`console.ts:265`); WhatsApp by `a:<id>` text (`DO:748-749`); `secretKeys` is never set, so masking is by key name only (`approvals.ts:138,154`) | app (screen on main; Simulator list read; decisions against fixtures only), Telegram, console (calendar), WhatsApp (text) | L3; L4 | One real decision from the app on staging; console parity; secret-field producer; the protected-action list |
| The activity log | Working today | deployed (no app screen) | `controls?view=activity`: steps, hops, trace, runs, ledger text (`dashboard-controls.ts:62-70`), served to the app (`app-controls.ts:32`); no reason, no "left alone" | console; app route only (the Patrol screen is a placeholder) | unassigned (Wave 2) | Reasons, "left alone", app screen |
| Say it once | Working today | deployed (chat and console) | `remember` corrects atomically through `replaces_id` (`tools/live/memory.ts:58-65`); `forget_memory` by id clears saved wording only (`:135`); `update_memory` has no handler (`tool-replay-class.ts:48`); console `spot.*`/`node.forget` (`dashboard-control-actions.ts:19`); no app `memory` view (`controls.ts:8`) | chat, console | L3 (parity item 2 contract) | App memory controls (contract, host, screen); forget lineage across copies |
| Your schedule (+ quiet hours) | Working today | proven (Simulator; app Schedule screen) | app `day` view returns cards, proactivity and schedules (`controls.ts:31-36`); app actions are `timezone.set` and `proactivity.set` only (`:14`; `app-controls.ts:62`); `schedule.*` and `card.*` are console only; one `daily_brief` switch covers three cards (`schedule-preferences.ts:17-23`); quiet hours hold cards, heartbeat and prep, not reminders or standing orders (`DO:2160-2233`) | app (time zone, quiet hours, volume), console, chat tool | L3 (contract) | Per-card and schedule switches in the app; quiet hours for reminders and standing orders |
| Yours, always (export, delete) | Working today (body: under review) | delete: deployed (console and app route); app screen merged (app #56), not run; export: none | app `account.delete` with `confirmation: 'DELETE'` (`controls.ts:26-28`; `app-controls.ts:55-61`) then `deleteAll` (`DO:632`), deployed at `81c4f892`; the app's Account screen offers deletion only when `controls?view=account` says it is available and the owner types the word (app `AccountPanel.tsx:38-43`, `accountController.ts:24,43`), and its one Simulator run was against `a5a523f9`, which did not serve the view ("not available on this version") [reported 6108662556]; `delete_owner` removes Vault secrets, connections, sessions, health rows and the owner, and leaves `auth.users`, the redeemed invite row with its email, and R2 (`20261011010000:6-25`; `DO:1940`); both delete paths wipe the owner DO's own storage (`DO:632` via `eraseOwnerStorage`, `dashboard-owner-controls.ts:98-100`; console `DO:1169`), but `RunLoopDO` is a separate class (`run-loop/do.ts:344`) and nothing in either path touches it, so its root is deletion residue [verified]; console copy overclaims (`DO:1166-1169`, `console.ts:526`); rejoin pgTAP 11/11 in CI [reported 6108252821]; export is `export_artifact` only (`artifact-exports.ts:99-101`) | console (delete); app (screen on main, not run against `81c4f892`) | L2 (run); L1 (deletion gaps) | One delete-then-rejoin run from the app on a test account; auth identity, invite email, R2, RunLoopDO root; honest console copy; data export |

### Coming later

| Promise | Site label | Rung | Evidence at the pins | Surfaces today | Lane | Gap |
|---|---|---|---|---|---|---|
| Voice | Planned | deployed (speech in, Telegram and WhatsApp) | `telegram-media.ts:52-75`; WhatsApp shares the transcriber (`DO:750-752`); no TTS; app send is text only; `replyVoicePartV1Schema` (`parts.ts:50-52`) has no producer | Telegram, WhatsApp (in) | unassigned (Wave 6) | Speech out; app voice in; spoken approval never commits sends or spend |
| Your own routines | Planned | deployed (reminders proven in tests only) | `standing-orders.ts:43-60`; `reminders.ts:103-106`; an app-only owner's reminders go to the app sink (#1034, `DO:2187`; `test/app-owner-scheduled-work.test.ts:111-186`, the only tested app-sink job) | Telegram, app (reminders) | L2 | A live app delivery; a routines UI |
| Tomorrow, today | Planned | deployed (Close preview) | `prompt/day-cards.ts:31-34`; `channels/day-cards.ts:124-128` | Telegram | unassigned (Wave 4) | Forecast, calibrated, non-medical |
| Other agents ask Waldo | Planned | source (contract only) | `trusted-coordination.ts` barrel export (`contracts/src/index.ts:193`), no consumer | none | unassigned (Wave 6) | Everything |

**Count against the labels.** 19 panels say "Working today". Delivered under the §2 bar: 0. On staging: 8 are deployed or Simulator-proven in part (Bring your past, The right task, Fixed first, Full history, Always comes back, Activity log, Say it once, Your schedule); 2 are merged only (Sleep debt computed, app delete); 9 have nothing or a contract only (Quiet flags, Training, Weather, Your history, Threads, Quick replies, Charts, Thumbs on the app, Three levels, export). The three scores labelled present tense are deployed and Simulator-seen; Weight is always unavailable.

## 5. Connector ledger

### This push (ruling 4)

| Connector | Site label | Rung | Evidence at the pins | Connect from app | Lane | Missing |
|---|---|---|---|---|---|---|
| Google Calendar ‡ | today | deployed | reads any calendar: `list_calendars` (`connectors/google.ts:420-429`; `tools/live/google.ts:151-157`), then one named `calendar_id` per call (`google.ts:603-615`); location, attendee count and names (`google.ts:760-770`); writes hard-wired to `calendars/primary` (`google.ts:504,576-578`), approval-gated with 10-min undo and readback (`approvals.ts:185,357,374`) | yes in source (G1); app Connections screen on main (#55), connect not run | L3 | Writes to other calendars; attendee emails; inviting attendees |
| Gmail ‡ | today | deployed | Primary-category read (`tools/live/google.ts:186-223`); free search across categories (`:226-246`); threads 20 per page, bodies up to 32,000 chars (`google.ts:315-336,521`); draft; approved send with Message-ID readback (`google.ts:691-712`); no archive or label; no attachments; #919 unmerged | yes in source (G1) | L3 (Instinct brief 03 for depth) | Triage actions; attachments; multi-account fan-out |
| Google Tasks ‡ | today | deployed | reads all lists plus `list_task_lists` (`tools/live/google.ts:263-296`); `propose_google_task_change` create/edit/complete/reopen after approval (`tools/live/tasks.ts:10-30`) | yes in source (G1) | L3 | Delete; retire the dead `write_task`/`update_task` names |
| Google Drive ‡ | planned (site understates) | deployed (staging on, production off) | `read_drive` read-only (`tools/live/drive.ts:24,30`), 8,192-byte content cap (`drive-rest.ts:114,119`); `DRIVE_READS` 0 in production, 1 on staging (`wrangler.jsonc:20,84`) | yes in source (G1) | L3 | Writes; Sheets and Slides content; production on |
| Google connect from the app (G1) | — | deployed (unexercised) | `google.connect` on `controls?view=connections` (`contracts/src/app/controls.ts:14,22`; `app-controls.ts:62`); `/c/<ticket>` with surface `app` (`DO:635-636`); return page links `waldo://oauth/complete` (`google-oauth.ts:12,26-27`); migration `20261011200000` applied [reported 6107813219]; the "connected" notice still goes to Telegram (`DO:1218-1224`) and app-only owners get nothing [inference] | app (Connections screen on main, app #55; Simulator read path only; connect, Google consent and `waldo://oauth/complete` return not run) | L3; L4 | A live connect from the app; a per-surface "connected" notice (L2 slice 2, G3) |
| Apple Watch (HealthKit through the app) | today | deployed (Simulator) | source `apple`, read API `healthkit` (`health-ingest.ts:15,63`); full ingest → producer → scores path; console says "Not built yet" (`console.ts:235`) | n/a (app consent screen, real) | L1; app | Physical Watch and iPhone run; console copy; the Watch app has no data path (`WatchState.swift:83-99`) |
| Galaxy Watch | next | deployed (backend only) | source `samsung`, read API `samsung_health` in the contract and SQL (`health-ingest.ts:15,63`; `health_plane.sql:9`); generic ingest accepts it | no Android client | unassigned | Android client; device proof; Samsung partner approval [verify] |
| Health Connect | today | deployed (backend only) | source `health_connect` exists on the same lines; no client | no | unassigned | Android client (ruling 9: Samsung path first) |
| Codex, Claude Code, Cursor, OpenCode, Pi (via Kennel) | today | none (fake only) | `DeterministicFakeExecutionEnvironment` (`run-loop/work-unit-execution.ts:236-255`); no Kennel client | no | Ashish (Kennel); backend seam unassigned | Backend → Kennel → same owner conversation |
| Weather, Location ‡ | today | source (branch) | no tool on beta; `get_weather` on `instinct/weather-daylight-tool` (PR #1043) | no | Instinct brief 02 | Provider, consent, registration |
| Telegram | today | proven (development surface) | default runtime (`DO:1541`); webhook routed | n/a | — | — |

### Later (after this push)

| Group | Site label | Rung | Evidence at the pins |
|---|---|---|---|
| Oura, WHOOP, Garmin, Fitbit | next | source (enums) | contract enums only (Fitbit not even that); vendor partner approval per vendor [verify] |
| Outlook, Microsoft To Do, Slack, Todoist, Linear, Notion | next | none or contract only | — |
| WhatsApp | next | source (unwired) | webhook routed (`index.ts:179-181`); adapter imported by its test only; no link-code issuer; staging secrets unknowable from source; Ashish's adapter (ruling 8); text, images, files and sign-in links by ruling 13 |
| iMessage (homepage) | — | source (unwired) | `packages/imessage-relay` fixture-only; `channels/imessage/*` merged with no importer; presences check has no `imessage` value (`20260925110000:4`); #1017 draft, its migration must renumber above `20261011220000` |
| GitHub | planned | deployed (inbound only) | push and PR events behind `WALDO_EVENT_SOURCES` (`event-ingress.ts:33,77,110`) |
| Spotify | next | none | needs a stated job first |
| Strava, Apple Calendar, Zoom, Calendly, Discord, Asana, Trello, ClickUp, Airtable, Dropbox, Jira, Vercel, Supabase, Figma, HubSpot, Salesforce, Zendesk, Intercom, Stripe, QuickBooks, Shopify, Granola | planned | none | generic path is per-owner MCP with third-party OAuth; today one deploy-wide server list (`tools/live/mcp.ts:21-33,82-86`) with read intents off; money-moving connectors get their own authority review |

## 6. Website copy: reference only

The owner decided to keep the published copy (ruling 10). These are the lines where copy and source still differ, kept so the gap stays visible:

- FAQ wearables: name Apple Watch and Galaxy Watch now; Oura, WHOOP, Garmin and Fitbit as coming.
- FAQ "What can I use today?" vs "Telegram and the web today": one availability statement, app-first; Telegram not presented as the product surface.
- "Undo it in one tap" / "One tap takes it back": say reversibility depends on the action, as the panels already do.
- "Disconnect removes what Waldo learned": keep only once lineage purge ships (rights work in Wave 0/3).
- Fewer pings: "Waldo decides what needs you now and gathers the rest" instead of holding email.
- "Works with every agent", "all models", "200+ tools": state tested coverage.
- Understated items (routines, quiet hours, Drive) move up when traced.
- Status labels flip to "Working today" only when a row passes §2.

No landing edits are planned.

### 6a. Promises on the site that §4 does not cover (read at landing `830bfc2`, 11 October)

Raised by the alignment session's read-only audit and re-read here [verified unless tagged]. None is in a lane; whether each is launch scope is the owner's call. The "See" mockups (`components/site/see/*`) are rendered on the home page, so their lines are published copy, not fixtures.

| Promise | Where | Nearest ledger row | Rung |
|---|---|---|---|
| The Fetch as its own moment with its own switch | `app/how-it-works/page.tsx:88,465,476` | §7 (Fetch re-enters as a moment); `schedules` has no Fetch key (`controls.ts:35`) | none |
| A brief that changes through the day, with decisions and an outbox held until you send | `see/brief.tsx:9-11,18-44`; `see-fixture.ts:23` | one 08:00 Brief card | none |
| Answers that show what he read, compared and where each fact came from | `see-fixture.ts:24`; `app/page.tsx:167` | "Follow up" provenance only | source (receipts) |
| Texting a third party on WhatsApp; a watch-battery charge reminder | `see-fixture.ts:473-474` | WhatsApp is Ashish's (D7); no battery signal anywhere | none |
| Photos, voice notes, clips, screenshots, screen recordings and slides as inputs | `app/page.tsx:174-213` | speech in only | none |
| Terminal, Apple Watch, Figma comments and Slack as places to talk | `hats-scenes.tsx:10-11,421,585` | app, Telegram, console, WhatsApp | none |
| Rules per account: work mail batched into two blocks, personal never touched in work hours | `app/connectors/page.tsx:137-143` | conflicts with ruling 5 (no mail holding) | none |
| Routines by profession (Founders, Engineers, …) | `put-to-work-data.ts:31-104` | — | none |
| Autonomy that grows week by week: asks, then moves with Undo, then moves silently | `learning-weeks.tsx:13-15` | three-levels enum, no consumer | source (enum) |
| Works toward an outcome and comes back when done | `app/page.tsx:260` | Outcome and OpenLoop closure (§4 Patrol row) | deployed (Telegram) |
| An honest record across days, months and years | `handled-cards-section.tsx:63-64` | history 7/30/90 days, no route | none |
| Read-only shown per tool; one tap to disconnect and what he learned goes too | `key-window.tsx:15-18` | §6 disconnect line; no per-tool read-only switch | none |
| Spots from caffeine, meals, screen time and tool switches | `see/memory-data.ts:36-84`; `see-fixture.ts:520-524` | Patterns row (health signals only) | none |
| Weather moving an event; mail batched for 11:30; "breaks big tasks down" | `connector-uses.tsx:182,351-362`; `app/connectors/page.tsx:92` | D5 weather (not registered, #1043) | source |
| A speak button on every reply | `see/kit.tsx:215` | Voice row (speech in, no speech out) | none |

### 6b. Where the site claims less than the backend does

- **"Gmail access is read-only. Waldo reads when messages arrive and their labels, not subjects or text."** (`trust-panels.tsx:191`, rendered). The backend reads subjects, snippets and full thread bodies (`tools/live/google.ts:42,250`) and sends mail behind approval (`:347`). The "never the words" line is in source comments only (`hats-scenes.tsx:27`, `put-to-work-data.ts:7`). This is a published privacy claim, so the owner picks the copy or the capability; until then no message-content claim goes in the app (L4, 6109166420). The 32,000-character body figure is L4's [reported 6109166420], not re-read here.
- **"Read only, unless you say so"** (`key-window.tsx:16`) matches approval-gated calendar writes and Gmail send; not a conflict.
- **"Undo it in one tap"** (`app/page.tsx:272`) and **"What Waldo learned from that tool goes with it"** (`key-window.tsx:18`): already above; undo is calendar-only and there is no purge lineage.

### 6c. The ten most prominent weak promises (home page, by position) [reported, alignment session; quotes re-read]

"nothing hidden" (`app/page.tsx:80`); "Waldo reads all of it" (`:108`); "tells a rough day from an easy one" (`:149`); "One brief that follows your day" (`see-fixture.ts:23`); "where each fact came from" (`:24`); "At 6:30 you get one notification" (`:27`) with no push code and `expo-notifications` never imported in the app [verified at app `d20322ca`]; "Months in, Waldo gets to know you" (`app/page.tsx:244`); "Apple Watch, Oura, WHOOP, Garmin and Fitbit all work" (`:276`); "Done before you're up" (`handled-cards-section.tsx:36`).

## 7. Rule and wording changes (decided 10 October)

| Promise | Current rule | Change |
|---|---|---|
| Patterns with numeric health deltas | Qualitative-only health memory (`HEALTH_PLANE_AMENDMENT.md:22`; CLAUDE.md); `security-checklist.md` forbids health values in DO SQLite and R2 | Numeric evidence lives in the Supabase health plane under RLS, computed from owner data; DO memory holds the qualitative pattern and a pointer. Patterns show numbers; health values keep one store. CLAUDE.md and the amendment change in the same PR as the code |
| Form stress, Training "racing heart at a desk" | 24/7 stress detection removed (`docs/planning/waldo-agent-mvp/ADR_RECONCILIATION.md:50`; Brain ADR-0010/0014) | Amend: consented, non-diagnostic HR/HRV stress component with workout attribution; never an alarm |
| Quiet flags | Medical-claim boundary | Deviation from the owner's own usual, model decides whether to mention it, never a diagnosis |
| Fewer pings | — | Interruption judgment (#915 K) plus research on how mature agents decide now/batch/silent/escalate; no Gmail holding |
| The Brief, The Fetch, The Close, Spots | ADR-0015/0042/0072 superseded as launch pillars (`ADR_RECONCILIATION.md:51`) | Re-enter as launch moments, keeping shadow-before-promotion |
| The Window, best-hours moves | ADR-0018/0019: Form may shape a proposal, never creates effect authority (`ADR_RECONCILIATION.md:52`) | Form and predicted readiness choose the window; blocking executes under a matching standing grant (#915 I), otherwise proposes |
| One-tap undo, disconnect-forgets | Effects are not all reversible; no purge lineage | Per-action reversibility in receipts; lineage purge in the rights work |

ADR changes publish in Brain first: [Pin4sf/waldo-brain#34](https://github.com/Pin4sf/waldo-brain/pull/34) covers 0010/0014, 0015/0042/0072, 0018/0019, 0081 and the pinned launch contract. After it merges, this repo repins the CLAUDE.md launch-contract link and regenerates `docs/foundation/accepted-adrs.json`.

## 8. Health text in staging traces (decided)

Staging exports model input and output text to Langfuse (`packages/runtime/wrangler.jsonc:82`; the deploy command also passes `--var LANGFUSE_CAPTURE_TEXT:true`). Since #992, owner replies may carry health readings, and history carries them into later turns.

Owner ruling (10 October): keep text capture on for every opted-in alpha and beta tester, health included, because the traces are needed to make the agent deliver. Production never captures text (`observability/trace-privacy.ts` `resolveCaptureText` forces it off). The health-turn withholding gate (#1003) was closed. Before outside testers join, the opt-in they accept should name trace capture of health data. Health in traces is revisited with the other launch guardrails before production. CLAUDE.md records the exception; the mirrored Brain `security-checklist.md` still says health never reaches spans and needs the matching amendment there.

Day cards and update cards used to log no root hop, so their traces were never exported; #1007 closes them so they reach Langfuse.

## 9. Waves, in dependency order

"Proof" means a staging trace on the app plus one messaging surface (§2), not CI.

**Wave 0. Converge and land.**
- §8 trace fix.
- Baseline the full verify at `a13c1fb5` so pre-existing failures are classified before any landing.
- #999: merged. Deploy `957a2cbb` (after the §8 fix) to staging, re-pin app line `a7a560d1`. Exit: sign-in, send, history, receipt and signout from a physical iPhone against staging.
- #998: re-cut by path onto `beta-mvp`, never by taking #998's side of a conflict (that would revert #999's reviewed fixes). Order:
  1. zod direct dependency (owner approval: it moves the `openai` peer from zod 3 to 4);
  2. app route registry;
  3. Google paging (`d8b724a6`, applies cleanly);
  4. `guard-health-leak.mjs` as its own PR. #998 deletes the regex detector for prompt/append/push/emit sinks and exempts `health/calculations.ts`; repository rules forbid weakening guards, so any change must prove the old positives still fire;
  5. identity and owner runtime authority (`20261010060000`);
  6. owner-turn and composer seam ported onto #999's files, health branch excluded. `materials.ts` conflicts on purpose: #999 caps inputs at 4k/12k and keeps app health null;
  7. receipt kernel; 8. threads; 9. files, media and artifacts; 10. memory correction; 11. access and onboarding; 12. channels (`20261010070000`); 13. Tasks/Calendar effects; 14. work.v1; 15. controls;
  16. health, with its SQL promoted from fixtures in a separate reviewed migration PR;
  17. rights (`20261010050000`, add `force row level security`; pgTAP fails without it);
  18. personal day; 19. proactivity, after #1002.
  Browser stays held. The 43 "frozen fixture" failures need their repairs re-derived; only hashes exist. #998's docs describe a retired lane and are not landed verbatim.
- #915 status at `957a2cbb`: S0, A, B, C (loop), E, F and H mostly merged; leftovers are D-2 (one output budget, measured effort), D-4 (drop the reduced-context retry), E-3 (meal recall filter), B-3 (proactive gate on retained recall), A-8 (mail list OTP blanking) and C-3 (surface adapters). G (#931) and I (#932) are stale drafts; J and L modules exist but are not wired on the owner path; K is not started. I, J and L need owner-DO migrations.
- Google stack #903 → #919.
- Close superseded drafts (for example the `DO NOT MERGE` pin branches #840 and #847). One critical-path slice in flight at a time.

**Wave 1. Omnipresence seam.** Surface-neutral reply parts; one renderer per surface (app AG-UI, Telegram, and the seam WhatsApp and iMessage plug into); proactive delivery routed by owner preference and presence instead of the `'telegram'` default; approvals decidable from any authorized surface; message anchors; APNs sender. Exit: one Brief and one approval reach the app and a messaging surface, the owner approves on either, one receipt. Context test: the owner mentions something on a messaging surface, then says "that one" in the app, and Waldo resolves it. Today there is one shared transcript (`channels/conversation-store.ts`), a 100k-token window with oldest-first drops and no compaction (`conversation/window.ts:15-60`), and threads only on #998, so this exit also needs #915 D/G and a per-thread working set.

**Wave 2. Authority and follow-through.** #915 I (levels and grants), J (responsibilities, shared todo, background workers), K (now/batch/silent/escalate), L (cost ledger and ceiling). Patrol overlap detector bound to grants. Decision provenance at action time. Push wakes only per ruling 7. Exit: an external calendar change produces one useful proposal; a granted bounded fix executes and reads back; revoking the grant blocks a queued retry.

**Wave 3. Health plane.** Consent, ingest, producers from #998, HR/HRV stress component (§7), background delivery, backfill, Samsung source, retention and purge, history API; Recovery first, then sleep debt, Form, Weight; Quiet flags; Training; weather and daylight. Exit: a real consented iPhone produces a morning Recovery with coverage; sparse data shows unavailable, never an invented number; withdrawal purges.

**Wave 4. Learning layer.** Best hours, The Window, Heads-Up, Patterns with numeric deltas, The Slope, Tomorrow today, ratings feeding Brief selection, right-task ordering. Depends on Waves 2–3 and weeks of per-owner data; backfill shortens that.

**Wave 5. Connector depth for this push.** Calendar list and attendees, all task lists and task writes, Gmail triage actions, Drive writes, weather and location. Each with an operation ledger: read, write, approval, readback, reconnect and delete tested per operation. ‡ rows are delegation candidates.

**Wave 6. Coming later.** Voice in the app with spoken replies, other agents asking Waldo, backend → Kennel handoff into the same owner conversation, then the later connectors.

## 10. Decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | Website labels | Copy stays as published (ruling 10) |
| D2 | First slice | §12 |
| D3 | Google OAuth app | Update scopes as features need; publication later (ruling 6). Proactive cap: #915 default (6/day, 30 min cooldown) until K replaces it with judgment |
| D4 | Event wakes | Ruling 7 |
| D5 | Weather and location | Open-Meteo for forecast, UV and air quality (no key; check licence terms for commercial use [verify]); location is coarse, from the app with OS permission, never stored more precisely than needed |
| D6 | Rule changes | §7 |
| D7 | WhatsApp | Ashish (ruling 8) |
| D8 | Spotify | Deferred until it has a stated job |
| D9 | Lane conflicts | Retired by ruling 2 |
| D11 | Constellations in the app | Owner's answer in L3's session, 11 Oct (6109120916): the 11 Oct "memory graph web-only" ruling is superseded; the app shows the same `claims[]` with `text`; L3's order is Brief `latest`, `view=constellation`, memory controls and Spots, then "deliver to" |
| D10 | Cohort, spend ceiling, launch gate | Cohort 5 to 10, at most 50, and $25 per user per month (ruling 18); #915 L builds the ceiling. The launch gate and browser purchase limits are still the owner's to set |

## 11. Not website scope: the Instinct-parity bar

Booking, payments, logged-in browser errands, parallel workers, rich file outputs and person-to-person agent coordination came from the Instinct comparison. They set the quality bar for Waves 1–2 (claim verification, receipts, recovery, parallel workers) and stay separate from the website commitment.

## 12. Status, lanes and next slices (11 October, 12:10Z baseline)

The lane plan is `docs/planning/lanes-2026-10-11/README.md`. That plan assigns the work; this section records its state as the lanes report it on #116 and as the audit lane verifies it at the pins. #1029 is folded in as C11–C13.

### Lanes
| Lane | Owns | Open, as reported |
|---|---|---|
| L1: health plane and staging deploys | Health ingest backend, staging deploys from the Mac, reviews Instinct briefs 01 and 02 | H5 arrival events; the deletion gaps (`auth.users`, redeemed invite email, R2) [reported 6108331721]; first retention cron proof (12 October 03:17Z); the next deploy of the `beta-mvp` tip |
| L2: owner identity and delivery router | Proactive delivery routing, the app delivery sink, push (S7), `telegram-owner-do.ts` `setup()` and `alarm()` | O1 done in source; then O1b, P3a, S7, O2, P, slice 2 with G3, O3 [reported 6107783460] |
| L3: approvals, app contracts, Google connect | Piece A (merged), sole editor of `packages/contracts/src/app/*`, "deliver to" contract, G1 (merged), threads contract, reviews Instinct brief 03 | "Deliver to"; threads; the `cards[].latest` shape L2 proposed [reported 6108331721] |
| L4: app | waldo-app `src/agent/**` and the six-file contract pin; device build from source (app #50) | App #48–#58 merged on 11 October; pins match the backend tip; open app PRs #16, #27, #29 are not screens |
| Browser and computer (bounded) | #1032 audit, the errand set, the in-app browser | S0 network-block check FAILED twice; the staging Browser Rendering binding stays off |
| PR sweep | Short-lived | — |
| Instinct | Delegated, disjoint slices under `docs/app/codex-handover/OWNERSHIP_BOUNDARY.md` | Briefs 01, 02 (#1043 weather), 03 |
| Ashish | Kennel, WhatsApp and iMessage adapters (#1017), device bridge (#1006) | #1017 renumbers its migration above `20261011220000` |
| Audit: ledger owner and promise verifier | Sole writer of this ledger since 11 October 11:30Z (`docs/planning/lanes-2026-10-11/lanes/AUDIT-ledger-and-verification.md`); verifies every promise on the ladder; writes ledger docs and #116 comments only. Lanes post corrections on #116 starting with "Ledger correction:" | A delta pass after each staging deploy; probe runs only with the owner's go per probe |

### Rules between lanes
- **Hot files.** Announce before touching these on #116. Whoever merges second rebases.
  - `channels/approvals.ts`: L3.
  - `channels/telegram-owner-do.ts`: every lane. Keep diffs small and local; L2 owns `setup()` and `alarm()`.
  - `channels/app-api.ts`: L2 (`appSinkCaller`) and L3.
  - `channels/owner-turn.ts` and `context-composer/*`: the context track.
- **App contracts.** Only L3 edits `packages/contracts/src/app/*`.
  - The app pins six files byte for byte: approvals, controls, core, health-ingest, parts and surfaces. L3 posts SHA-256 hashes, not git blob ids.
  - Changes stay additive, and the app hears about a new enum value before it ships.
  - The chat reader drops a part it cannot parse and keeps the row's `text`, so every row carrying a new part must have readable `text`.
  - A new value in a row-level or page-level field fails the app closed. Such a value needs a version bump, or an app re-pin first.
  - The cheapest additive path is a new view or route the pinned app never requests.
  - Pin state at the delta pass (SHA-256, first 8), app main `d20322ca` vs backend `81c4f892`: approvals `ae0ba3a5`, controls `f429c04f`, core `62872be6`, parts `f2dc0ec1`, health-ingest `bbe7369d`, surfaces `18dae67e`, all six equal [verified]. At the baseline four of them differed (approvals, controls, core, parts); app #54 and #56 closed that.
- **Migration timestamps.** The staging apply (`scripts/staging-migration-preflight.mjs`) needs the hosted history to be a prefix of the sorted local list, and it applies every pending file in order. So a lower timestamp that lands after a higher one is applied is stranded.
  - Applied on hosted staging: everything through `20261011220000` (54 files, 0 pending) [reported 6107813219], including `20261010060000` (#1013), `20261011000000` (#1022), `20261011010000` (#1041), `20261011020000` and `…030000` (#1044), `20261011200000` (#1052), `20261011210000` and `…220000` (#1050, #1051).
  - These sort below the applied ones and must renumber above `20261011220000` before they can apply: `20261010120000` (#1017, draft); `20261010050000` (rights) and `20261010070000` (channels), held by unlanded #998 work.
  - Reserved: S7 push token RPC `20261012xxxxxx` (L2).
- **Merges, deploys and migrations.** Each needs the owner's go, given in the session that runs it. A message relayed from another session is not a go. Merged is not deployed.
- **Messages between sessions.** Peer messages can be dropped. Anything another lane must know goes on #116 or in a PR.

### Staging
- **Worker.** `/healthz` reads `81c4f892` [verified 12:31Z]; L1 deployed it Worker-only on the owner's go, preflight 54 applied / 0 pending, no wrangler change [reported 6108618841]. Nothing merged on `beta-mvp` is undeployed: `e5fd7200` adds only ledger docs. Served since this deploy: the app invite field (#1054), app `account.delete` (#1056) and in-app invite redemption (#1055). Unauthenticated check by L2: a well-formed `invite` on `/app/v1/auth/code` for an unknown address returns `200 {ok:true}`, a malformed one 403 [reported 6108630533]. The authenticated invite sign-up and `account.delete` have NOT RUN on staging.
- **Database.** 54 migrations applied, 0 pending, through `20261011220000` [reported 6107813219]. The owner's staging account holds synthetic Simulator health data and derived scores [reported 6107519497, 6108184771]; no physical device has uploaded. Retention cron `17 3 * * *` is registered on staging only; its first firing is 12 October 03:17Z.
- **Edge Functions.** The legacy `health-sync` Edge Function was deleted from the staging project on 10 October, with the owner's go. To restore it, redeploy `waldo-app/supabase/functions/health-sync`.
- **Browser.** The S0 network-block check FAILED twice; the Browser Rendering binding stays off staging [reported, browser lane].

### PRs
| PR | What | State |
|---|---|---|
| #1013 | Owner runtime authority without a messaging surface (`20261010060000`) | merged; applied |
| #1015, #1016, #1018 to #1021, #1023 | Tasks approvals, Weight, health design and H1 contract, calendar list, dispatcher fix, Recovery-first reader | merged; deployed |
| #1022 | H2 health plane (`20261011000000`) | merged as `bf477a4e`; applied; deployed |
| #1024 | Stable prompt prefix; tools the owner can use (C1, C2) | merged as `a7b80436`; deployed |
| #1028 | Health contract: withdrawing model use alone keeps the data (ruling 11) | merged as `1757beb2`; deployed; the app pin matches [reported 6108110002] |
| #1031 | H3 health routes | merged as `12bca625`; deployed |
| #1034 | App-only owners' reminders delivered in the app (L2) | merged as `07689f0a`; deployed |
| #1041 | Purge deletes an owner's derived health rows (L1, `20261011010000`) | merged as `e3c191a0`; applied; deployed |
| #1049 | Owner DO name bound only from a name that addresses it (L2) | merged as `98b3960d`; deployed |
| #1044 | H4a per-day health series read and stale-write fence (L1, `20261011020000`, `20261011030000`) | merged as `e24ab95f`; applied; deployed |
| #1040, #1047 | Daily score math; H4b scores after each committed ingest | merged as `b3a43013` and `c69188bb`; deployed |
| #1048 | Piece A: approvals from any surface, round 4 (L3) | merged as `3839e9d4`; deployed; contract hashes on #116 |
| #1052 | G1: Google connect from the app (L3, `20261011200000`) | merged as `f6a7d2a0`; applied; deployed; the app re-pins `controls.ts` (app #49, #55) |
| #1050, #1051 | Health retention rules and sweep (L1, `20261011210000`, `20261011220000`) | merged as `90b649ec` and `a5a523f9`; applied; deployed; cron registered |
| #1056 | Parity 1: delete the account from the app, at console parity (L3) | merged as `90e162d0`; deployed (`81c4f892`); the app pins `controls.ts` from `90e162d0` (app #56, merged); the owner ruled to ship at parity while L1 closes the deletion gaps |
| #1054 | O1 contract: optional `invite` on both app sign-in requests (L3, for L2) | merged as `980026c7`; deployed (`81c4f892`); the app pins `core.ts` from `90e162d0` (app #56, merged) |
| #1055 | O1: an invited person joins from the app with an email code; delete-then-rejoin pgTAP (L2) | merged as `81c4f892`; deployed; unauthenticated invite check only [reported 6108630533] |
| #1053 | Ledger: piece A and G1 status (L3's last ledger PR) | merged as `e5fd7200`; the ledger then passed to the audit lane |
| #1057 | Ledger: audit lane takes over; this baseline and the first delta pass | open (audit lane); merges with the owner's go |
| #1058 | Competitor refresh, 11 October (audit lane) | open; merges with the owner's go |
| #1043 | Instinct brief 02: `get_weather` backed by Open-Meteo, not registered | open |
| #987 | Browser retained-session upload | open (browser lane) |
| #1032 | Browser lane audit and any-surface design | draft; design until the owner approves |
| #1033 | Owner-ingress test isolation | open; rebase and merge, or close |
| #1029 | App requirements traceability | closed with the owner's go; C11–C13 folded here |
| #1017, #1006 | iMessage connector; device bridge (Ashish) | draft |
| App #48 | Native `connect()` before `readRange`; ingest `httpStatus`; consent copy | merged `b8e80d8b`; Simulator: backfill acknowledged, scores 200 |
| App #49 | Re-pin `controls.ts` to `6608677f` (G1) | merged `5aad702f`; superseded by #56 |
| App #50 | Build-from-source guide for Suyash (`Docs/ledger/2026-10-11-device-build-checklist.md`) | merged; still cites staging `c69188bb` and says "The app cannot redeem an invite" (guide line 118), which #56 made false; no deletion or re-sign-up steps |
| App #51, #52 | Unknown approval kind dropped (test); integration guide | merged |
| App #53 | Server Recovery, Form and Weight on Health Stats | merged `20d0b85e`; Simulator read only |
| App #54 | Approvals screen; re-pins `approvals.ts` and `parts.ts` | merged `fc334e47`; Simulator list read only; decisions against fixtures |
| App #55 | Connections screen and Google connect (`/c/<ticket>`, `waldo://oauth/complete`) | merged `67a831c1`; Simulator read path only; connect not run |
| App #56 | Re-pin `core.ts` and `controls.ts` from `90e162d0`; invite field on sign-in; Account screen with delete | merged `839f2133`; Simulator against `a5a523f9` only, where the account view was unserved |
| App #57 | Home summary: scores, cards, waiting approvals | merged `d7cf271f`; `pnpm test` 516 passed / 1 skipped at its head [reported 6108662556] |
| App #58 | Sidebar from the design; Home menu button | merged `d20322ca`; no staging evidence |
| App #59 | Home as stacked cards with score rings; Patrol and Spots as "not shown yet" cards | open; Simulator only against `81c4f892` [reported 6109166420] |
| App #60 | Constellations renderer | open; unwired until `view=constellation` is served |

### Findings that set the order
- **Health in chat.** The chat read needs both consents (`health_basis_live(…, true)`, `health_plane.sql:514`), while scores need storage only (`:486`). On the owner's staging account `model_processing` is off [reported 6107519497], so chat says no health was shared while the scores screen shows Recovery [inference]. The model also gets candidate scores under hardcoded legacy version names with no activation label (`health-context.ts:119-121`).
- **Proactive on the app.** Only reminders are tested on the app sink. Day cards, standing orders and heartbeat reach it in source through indirect arming (`DO:2619`, `:2300`, `:1239-1247`); Prep and the update card do not. No staging run shows any proactive message in the app.
- **Delete and re-sign-up from the app.** The backend side is deployed (`81c4f892`) and the app's sign-in screen (invite field) and Account screen (delete) are on main (#56). Neither has run against the deployed Worker: L2 checked only the unauthenticated invite path [reported 6108630533], and L4's Simulator run was against `a5a523f9` [reported 6108662556]. Until a run on a test account is reported, both steps count as browser-proven only. `delete_owner` leaves `auth.users`, the redeemed invite row with its email, R2 objects (`DO:1940`) and the RunLoopDO owner root (`index.ts:299-306`) [inference for the root]. The rejoin pgTAP proves the SQL path only.
- **C13, generalised: a new approval kind blanks the app.** App #54 re-pinned `approvals.ts`, so `google_task_change` now parses. But the list is still parsed as a strict array with a closed `kind` enum, and one failed parse rejects the whole response (app `appRoutesClient.ts:29-30`); app #51 protects chat history only. So the next kind added to `parts.ts` empties the Approvals screen and the Home "waiting" count on every app built before the re-pin. A kind is a row-level field under the additive-only rule above: version bump or app re-pin first.
- **A second brain in the app repo** [verified at app `d20322ca`; deploy state unverified]. `supabase/functions/agent` and `insights` call OpenAI with their own prompts (`agent/chat.ts:7,109`), and `agent/commit.ts:123` writes `memory_inbox` through a service-role client; `runtime/waldo-worker` is a second per-user Durable Object keyed by a client-sent `userId` (`src/index.ts:20-22`). No app screen reaches them. This breaks the one-brain rule if any of it is deployed; removal needs the owner's go (alignment session).
- **App copy that now contradicts the build.** Settings still says invites, export and account deletion are unavailable and that connection controls are missing (app `settings.tsx:20-21`); Home's Brief row says the Brief is not shown in the app yet (`TodaySummary.tsx:54`), which is true; the device build checklist and `Docs/APP_INTEGRATION_GUIDE.md` say the app cannot redeem an invite and that #54/#55 are unmerged. The legacy Supabase `oauth-google` function still redirects to `waldo://connector-callback`, a route the app no longer has (`supabase/functions/oauth-google/index.ts:85`), so an old-path return goes nowhere [verified at app `d20322ca`].
- **Streaming.** The runtime has no model streaming, and replies pass post-model guards whole.
- **`channel.unlink`** is accepted by the contract and always 400 (`app-controls.ts:62`); `channel.link_start` does not exist.

## 13. Handover readiness for Suyash (11 October)

What Suyash can build to and exercise on his own iPhone and Watch, per promise, at the pins. "App" means it belongs in the app and is reachable there today; "console only" is approved web-only or not yet in the app; "later" means a later surface or wave.

| Item | Home | State for Suyash | Missing before he can rely on it |
|---|---|---|---|
| Device build (app #50, merged) | app | Buildable from source on the Simulator; no device, signing or fresh-clone run reported; the guide says the app cannot redeem an invite and cites `c69188bb`, both stale since #56 and the deploy | A device run by L4; the guide's invite, staging SHA and screen list corrected; deletion and re-sign-up steps added |
| In-app sign-up (O1) | app | Backend deployed (`81c4f892`); sign-in screen with the invite field on app main (`agent-sign-in.tsx:52`); unauthenticated path checked by L2; no invited address has signed up from the app | A dedicated invite for his test account; one sign-up run with the owner's go (the owner enters the emailed code) |
| Delete account, recreate with the same email | app (approved parity item 1) | Backend deployed; Account screen with the typed `DELETE` confirmation on app main; its only Simulator run hit an older Worker and showed "not available on this version"; rejoin proven in pgTAP only | One delete-then-rejoin run from the app on a test account against `81c4f892`; L1's deletion gaps (auth identity, invite email, R2, RunLoopDO root) |
| Proactive jobs (P3a) | app | Reminders reach the app in tests; cards and heartbeat arm only indirectly; nothing proven on staging; arming at sign-in has no timezone to use (§2) | The owner's timezone choice; an arming path at app sign-in; a staging run showing a Brief in the app transcript; the `cards[].latest` shape |
| Push (S7) | app | No code on either side; APNs entitlement only; a free personal team cannot sign it | Register route, sender, APNs key, device token in the app, paid team signing |
| Approvals screen | app (#54, merged) | Simulator list read; decisions against fixtures | One real decision on staging |
| Connections screen and Google connect | app (#55, merged) | Simulator read path; connect, Google consent and the OAuth return not run | A live connect on a test account (needs the owner's go, Google); a per-surface "connected" notice |
| Scores screen and Home summary | app (#53, #57, merged) | Simulator read of Recovery, Form (`stale_inputs`), Weight (`calendar_demand_unavailable`); Weight copy corrected to match `demand: null` | A device run with real HealthKit data; background delivery for a live Form |
| Memory controls | app (approved parity item 2) | None: no contract, no host, no screen; Spots is a placeholder | Contract view and actions (L3), host, screen |
| Health agreements, Schedule, Main chat, Full history | app | Real server data on main; Simulator-proven | A device run |
| Activity log | app (Patrol screen) | Route served; screen is a placeholder | Screen; reasons and "left alone" from the backend |
| Threads, quick replies, charts, thumbs, voice | app | Contract only or Telegram only | Producers and screens; later waves |
| Invite admin, admin overview | console only (approved) | Console | — |
| Constellations (memory graph) | app (D11) | Console today; app renderer in app #60 (open), no served view | `view=constellation` (L3, second in the queue); app re-pin and controller |
| WhatsApp, iMessage | later (Ashish) | Static "coming soon" copy in onboarding by ruling | — |
| Watch | later | Placeholder with no data path | A data path (WatchConnectivity or direct) |

## 14. Ranked gaps (11 October, delta pass 12:45Z)

**A. Against website promises (in scope under ruling 1), most blocking first.**
1. No proactive message is proven to reach the app, and push has no code. The Brief, Heads-Up, Close, Prep and Patrol are Telegram-proven only; cards arm for app-only owners only through `timezone.set` or a console visit.
2. Delete-and-recreate from the app is unproven: backend deployed and app screens merged, but no run against `81c4f892` on a test account has been reported, and deletion still leaves the auth identity, invite email, R2 and the RunLoopDO root.
3. Health on a real device is unproven: foreground-only upload makes Form stale, Weight is always unavailable, sleep debt is computed and discarded, quiet flags and Training have no output, history has no route.
4. The approvals, connections and scores screens (#53–#55) are merged but Simulator read-only; no approval has been decided from the app on staging, Google connect from the app has never run, and the "connected" notice goes to Telegram.
5. Memory controls and Constellations do not exist in the app as a contract (D11 moves Constellations into the app; L3 queue); Patterns and Spots are placeholders.
6. Talk surface: threads are contract only; quick replies, charts and thumbs have no producer for the app; machine prompts render as the owner's own bubbles.
7. Rules: the three levels are an enum with no consumer; the activity log has no reasons; the console deletion copy overclaims.
8. Fifteen published promises have no ledger row at all (§6a), and one rendered privacy claim says less than the backend does (§6b); both wait on the owner.

**B. Parity ideas beyond published copy (new scope; enter lanes only by owner ruling).** From the 11 October competitor refresh (`docs/planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md`, separate PR).
1. Per-scope allow/ask/deny rules with a "show details" full-input review before approval (Vellum, Muse state this); Waldo has exact-payload approvals but no rules layer.
2. A memory dashboard with search, forget and corrections-that-replace (Folk, Vellum Memory v3); Waldo has `replaces_id` in chat and console spot actions only.
3. A delivery receipt for every scheduled job (Vellum's open bugs show "ok" without delivery); Waldo's app sink acks with a fake `message_id: 1`.
