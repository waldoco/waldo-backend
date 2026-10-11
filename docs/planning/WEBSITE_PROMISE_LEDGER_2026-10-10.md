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

**Pins.** Integration branch `beta-mvp` @ `957a2cbb` (#999 merged 10 Oct 10:20Z; CI `verify` green). Rows were audited at `a13c1fb5`; #999 changed only the app sign-in, chat, inbox and controls paths. Open PR heads read: #998 @ `fc4c2b9d` (native + health checkpoint, base `1206d7a8`), #919 @ `032c78a0` (Gmail/Calendar journeys), #932 @ `5506de85` (standing grant contract), #915 @ `2bc64346` (core loop spec, slices S0, A–L). Website copy from `Pin4sf/waldo-landing` `origin/main` @ `830bfc2`. App refs `1980a9d1` (the #16 native-line draft, now superseded and being ported in slices) and `a7a560d1` (#999-pinned line). Rows that cite `1980a9d1` describe that draft, not shipped app state: app main (`waldoco/waldo-app` @ `8d5b4357`, 10 October night) has chat, sign-in and session, sign-out and the native health read module, and its other screens show a placeholder. Re-pin before relying on any row.

## 1. The binding constraint is landing, not building

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

| Defect | Evidence (`beta-mvp`) |
|---|---|
| The owner runtime defaults to Telegram, so every alarm-driven proactive job delivers to Telegram | `channels/telegram-owner-do.ts:1353` (`setup(channel = 'telegram')`), alarm path `:1089` |
| Calendar Prep exits on any non-Telegram channel | `telegram-owner-do.ts:2171` |
| The app sink drops everything except `sendMessage`: cards, buttons and approvals never reach the app | `channels/app-api.ts:173-176` |
| App send is text only, with no attachments and no parent/anchor | `app-api.ts:162-170`; `telegram-owner-do.ts:1753-1754` |
| Email and message approvals "stay in chat"; the console approves calendar only; app approve throws | `channels/dashboard-waiting.ts:6-7`; `console.ts:265`; app `src/work/canonicalWork.ts` @ `1980a9d1` |
| Skills load on Telegram only | `skills/curated-host.ts:41-48`; `telegram-owner-do.ts:1841,1876` |
| Ratings exist only on Telegram Fetch cards | `telegram-owner-do.ts:2262` |
| No file is sent into any chat; delivery is a console link | no `sendDocument`; `workspace-delivery.ts:6-19` |
| No APNs sender | no APNs code on `beta-mvp` |

#915 slice C's single loop has landed: Telegram, WhatsApp and app turns all reach one responder through `this.turn`, and proactive jobs use `responder.prompt`. Its surface-adapter part (C-3) has not: `channels/surfaces/whatsapp.ts` is never imported and the final outbox is keyed by Telegram `chat_id` (`telegram-final-outbox.ts:195`). App history also lives in a separate canonical store from the main transcript. The output half is one surface-neutral reply contract (text, card, approval, quick replies, chart series, file, artifact, UI part) that the loop produces and each surface adapter renders to its capability. That is Wave 1.

## 3. Status vocabulary

- **LIVE**: merged and traced on staging on a real provider.
- **ON-BETA**: merged on `beta-mvp`, not traced on staging or flagged off in production.
- **PR #n**: source exists on an open PR.
- **SPEC**: designed in #915 (slice letter given), not implemented.
- **NOTHING**: no source and no accepted design.

‡ marks rows whose build can be delegated to Instinct under the delegation rule.

## 4. Feature ledger (37 promises)

### Health (scores and panels)

| Promise | Site label | Now | Lands via | Notes |
|---|---|---|---|---|
| Recovery (sleep + HRV + resting state) | present tense | ON-BETA consumer only: no producer; reader drops rows without Form (`channels/health-context.ts:107-147`); `recovery.v1` schema only. PR #998: `recovery.candidate.v1`, independently reviewed formula, ingest | #998 health slice, consent, device proof | ADR-0081 registry entry; activation stays `candidate_unaccepted` until the owner accepts formula and privacy references |
| Form (circadian, motion, stress) | present tense | NOTHING on beta. PR #998 `form.candidate.v1` uses explicit self-reported stress | after Recovery | Ruling: add an HR/HRV stress component with workout attribution (§7) |
| Weight (meetings, messages, tasks, load) | present tense | CONTRACT-ONLY on beta. PR #998 `weight.candidate.v1` + `health/demand-collector.ts` | after all-calendar reads and task estimates | Primary-calendar-only reads (`connectors/google.ts:327`) undercount |
| Sleep debt | Working today | NOTHING on beta. PR #998 `sleep-debt.candidate.v1` (14 weighted nights, coverage-aware) | #998 health slice | — |
| Quiet flags (SpO2, breathing rate, wrist temp) | Working today | NOTHING. App reads SpO2 and respiratory rate, not wrist temperature (`HealthKitManager.swift` @ `1980a9d1`) | after ingest | Add the HealthKit type; the deviation from the owner's usual is measurement, whether to mention it is model judgment; non-diagnostic copy |
| Training (workouts with meetings; run vs desk heart rate) | Working today | Manual `log_workout` only (`channels/health-log.ts:115`). App reads workouts | after ingest | Same stress component as Form |
| Weather and daylight ‡ | Working today | NOTHING for weather/location. Daylight: app reads it; #998 uses it in Form | new weather tool | Provider and coarse-location consent (§10) |
| Your history (7/30/90 dots, tap a day) | Working today | NOTHING on beta. PR #998 `/health/history` (28 days); app `1980a9d1` reads it; no dots | #998 + app | "What Waldo did that day" needs the activity read model |
| Bring your past (Apple Health import) | Working today | App backfill exists, switched off (`historyAdmissionAvailable: () => false`). PR #998 ingest with receipt-before-cursor | #998 + device run | Real-iPhone backfill and background delivery proof |

### Day to day (six moments and six panels)

| Promise | Site label | Now | Lands via | Notes |
|---|---|---|---|---|
| The Brief | present tense | ON-BETA `card:brief` 08:00, Telegram only, health as zone words, propose-only (`prompt/day-cards.ts:14,52`; `tools/live/google.ts:248-258`) | Waves 1–3 | Wake-time trigger needs health; delivery needs app push |
| The Window (block sharpest stretch) | present tense | NOTHING | Wave 4 | Ruling: computed from Form and predicted readiness; blocks time under a calendar `auto` grant, otherwise proposes |
| Prep (35 min before) | present tense | ON-BETA, grounded path on staging only (`CALENDAR_GROUNDED_PREP` 0 prod / 1 staging); "last time's open items" absent | Wave 0 flag + Wave 2 | Telegram-only exit (§2) |
| The Heads-Up | present tense | 14:00 check-in card only | Wave 4 | Patterns + grants |
| The Close | present tense | ON-BETA `card:close` 21:30 | Wave 1 | "Moved / protected" counts need Waldo's own moves |
| The Adjustment (weekly) | present tense | NOTHING | Wave 2 | Weekly card + grants |
| Your best hours | Coming next | NOTHING | Wave 4 | Needs weeks of intraday signal, or backfill |
| The right task, at the right time | Working today | NOTHING. `get_tasks` default list, read-only (`google.ts:235-246`) | Wave 2 + Wave 5 task writes | Energy input from Wave 3 |
| Fewer pings | Coming next | NOTHING. No Slack | #915 K + research on interruption judgment | Ruling: Gmail delivery is not held; Waldo decides what to surface now, batch or keep quiet, and when to escalate |
| Fixed first, mentioned after (The Patrol) | Working today | NOTHING. Heartbeat lists past-due loops, no model call, no autonomous effect (`channels/heartbeat.ts:97-125`). PR #932: grant contract only | #915 I + J, overlap detector | Push wakes only if the sweep is too slow (ruling 7) |
| Patterns (Spots → named pattern) | Coming next | Conversation constellation only, health excluded (`memory/claims.ts:378-400`; `owner-turn.ts:601`) | Wave 4 | Ruling: numeric health deltas allowed (§7 says where they live) |
| The Slope (six measures vs four weeks) | Coming next | NOTHING on beta; prompt vocabulary only. [verify] #998's serving matrix lists Slope among versioned producers, but its source shows only labels (`console.ts:203-204`, `messaging-behavior.ts:27` @ #998) | Wave 4 | The Stack, Signal Pressure and Task Pileup signals do not exist yet |

### Talk to Waldo

| Promise | Site label | Now | Lands via | Notes |
|---|---|---|---|---|
| Threads | Working today | CONTRACT-ONLY on beta (`contracts/src/tools/schemas/threading.ts:59`, no handlers). PR #998 `threads.v1` routes; app `1980a9d1` wired | #998 threads slice | App and console only; messaging surfaces keep one main chat |
| Follow up on anything ("Tell me more") | Coming next | Telegram reply-quote only (`owner-turn.ts:480-499`); decision reason stored, not exposed (`approvals.ts:611-620`) | Wave 1 anchor + Wave 2 provenance | Provenance recorded at action time |
| Quick replies | Working today | NOTHING (capability flag only, `contracts/src/adapters/channel.ts:35,68`) | Wave 1 | — |
| Charts in replies | Working today | NOTHING | Wave 1 part + Wave 3 data | Health series only on the owner's own surfaces |
| Full history | Working today | ON-BETA code (`app-api.ts:120-151`), not on staging; offset cursor shifts; scheduled prompts saved as `role:'user'` (`owner-turn.ts:532`) | #999 + Wave 1 | Reasons beside each move need provenance |
| Thumbs up / down | Working today | Telegram Fetch cards only; never reaches Briefs | Wave 1 part + Wave 4 | A rating changes style and notification choices, never truth or authority |

### Your rules

| Promise | Site label | Now | Lands via | Notes |
|---|---|---|---|---|
| Three levels, per area | Working today | NOTHING enforced. L0–L3 contract pinned to L0 (`contracts/src/runtime/loop-policy.ts:101`). PR #932 contract only | #915 I | Dispatch needs the C-2 effect ledger seam |
| Always comes back to you | Working today | ON-BETA on Telegram + console only: exact-payload approvals (`approvals.ts:39-50,292`). Fails §2: app approve throws; email and message approvals stay in chat | Wave 1 | Publish the protected-action list |
| The activity log | Working today | Console partial: trace hops and a ledger string, no reason, no "left alone" (`dashboard-controls.ts:61-69`) | Wave 2 | — |
| Say it once | Working today | ON-BETA remember/forget; no edit (`update_memory` has no handler); forget-by-id clears saved wording only (`tools/live/memory.ts:130-135`); app view switched off | #915 B + Wave 1 | Forget lineage across episodes, R2, traces |
| Your schedule (+ quiet hours) | Working today | ON-BETA console + chat tool; one switch covers Brief, check-in and Close (`schedule-preferences.ts:17-45`); quiet hours already exist in the DO | Wave 1 app settings | Per-card toggles missing; site understates quiet hours |
| Yours, always (export, delete) | Working today (body: under review) | Delete ON-BETA, misses R2, RunLoopDO and Langfuse [inference]; console text overclaims (`telegram-owner-do.ts:1008`). Export NOTHING on beta. PR #998 `rights/export.ts`, `identity-erasure.ts` | #998 rights slice | Retention policy and DPDP/App Store gate (`HEALTH_PLANE_AMENDMENT.md:4,26-27`) |

### Coming later

| Promise | Site label | Now | Lands via | Notes |
|---|---|---|---|---|
| Voice | Planned | Voice in on Telegram/WhatsApp (`telegram-media.ts:52-75`; `llm/transcriber.ts`); no TTS; app records locally only | Wave 6 | Spoken approval never commits sends or spend |
| Your own routines | Planned | ON-BETA: cron standing orders and reminders, each a full model turn (`standing-orders.ts:44-60`; `reminders.ts:79-81`); report freeze fixes unmerged | Wave 2 | Site understates this one |
| Tomorrow, today | Planned | The Close previews tomorrow's calendar only (`day-cards.ts:124-129`) | Wave 4 | Forecast calibration, non-medical |
| Other agents ask Waldo | Planned | CONTRACT-ONLY (`contracts/src/runtime/trusted-coordination.ts`, no importer) | Wave 6 | Disclosure rule: answer availability without exposing health reasons |

**Count against the labels.** 19 panels say "Working today". Under the §2 bar, 0 are accepted. On `beta-mvp`: 1 works on Telegram plus console only (Always comes back to you), 6 are partial (Say it once, Your schedule, Full history, Thumbs, Activity log, Yours always), 12 have nothing. 4 of those 12 have source on #998 (Sleep debt, Your history, Bring your past, Threads), as do the Recovery, Form and Weight scores.

## 5. Connector ledger

### This push (ruling 4)

| Connector | Site label | Now | Missing |
|---|---|---|---|
| Google Calendar ‡ | today | ON-BETA read + approved create/move/cancel with undo and readback | Calendar list, all calendars, attendees/location; writes primary only (`connectors/google.ts:327,382-384`) |
| Gmail ‡ | today | ON-BETA read (Primary category), search, thread, draft, approved send with Message-ID readback; PR #919 account-bound journeys | Triage actions (archive/label), attachments on send, multi-account fan-out per call |
| Google Tasks ‡ | today | ON-BETA read, default list only | All lists, `write_task`/`update_task` (no handler) |
| Google Drive ‡ | planned (site understates) | ON-BETA read (staging on, prod off), 8 KB docs | Writes, Sheets/Slides content |
| Apple Watch | today | ON-BETA reads app-written zones; nothing writes them; console says "Not built yet" (`console.ts:235`) | Ingest (PR #998) and app upload switched on |
| Galaxy Watch | next | App has `SamsungHealthManager.kt`; backend has no Samsung source in contracts and no ingest | Health source enum, ingest, device proof. Samsung Health SDK may need partner approval for production [verify] |
| Health Connect | today | Kotlin manager not compiled; no Android client | Covered by the Samsung path for now (ruling 9) |
| Codex, Claude Code, Cursor, OpenCode, Pi (via Kennel) | today | Backend handoff NOTHING: docs, contracts and a test fake (`run-loop/work-unit-execution.ts:236-251`) | Backend → Kennel → same owner conversation; Kennel side is Ashish's |
| Weather, Location ‡ | today | NOTHING | Provider and consent (§10) |
| Telegram | today | LIVE (development surface) | — |

### Later (after this push)

| Group | Site label | Now |
|---|---|---|
| Oura, WHOOP, Garmin, Fitbit | next | CONTRACT-ONLY enums (Fitbit not even that); vendor developer/partner approval per vendor [verify] |
| Outlook, Microsoft To Do, Slack, Todoist, Linear, Notion | next | CONTRACT-ONLY or NOTHING |
| WhatsApp | next | Webhook wired, secrets not in config; Ashish's adapter. Platform eligibility and template rules for business-initiated messages [verify] |
| Spotify | next | NOTHING; needs a stated job before work |
| iMessage (homepage) | — | Fixture-only relay (`packages/imessage-relay/README.md`) |
| GitHub | planned | Inbound push/PR notifications only, behind `WALDO_EVENT_SOURCES` |
| Strava, Apple Calendar, Zoom, Calendly, Discord, Asana, Trello, ClickUp, Airtable, Dropbox, Jira, Vercel, Supabase, Figma, HubSpot, Salesforce, Zendesk, Intercom, Stripe, QuickBooks, Shopify, Granola | planned | NOTHING. Generic path: per-owner MCP with third-party OAuth (today one deploy-wide server list with static-token or Google auth, `tools/live/mcp.ts:21-33,82-86`). Money-moving connectors get their own authority review |

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
| D10 | Cohort, spend ceiling, launch gate | Cohort 5 to 10, at most 50, and $25 per user per month (ruling 18); #915 L builds the ceiling. The launch gate and browser purchase limits are still the owner's to set |

## 11. Not website scope: the Instinct-parity bar

Booking, payments, logged-in browser errands, parallel workers, rich file outputs and person-to-person agent coordination came from the Instinct comparison. They set the quality bar for Waves 1–2 (claim verification, receipts, recovery, parallel workers) and stay separate from the website commitment.

## 12. Status, lanes and next slices (11 October, morning)

This section replaces the 10 October night status. The lane plan is `docs/planning/lanes-2026-10-11/README.md`. That plan assigns the work, and this section records its state. #1029 is folded in here as C11–C13.

### Lanes
| Lane | Owns | Queue |
|---|---|---|
| L1: health plane and staging deploys | Health ingest backend (H4 to H6), staging deploys from the Mac, reviews Instinct briefs 01 and 02 | One staging deploy of the `beta-mvp` tip; H4 Recovery producer and its per-day read migration |
| L2: owner identity and delivery router | Proactive delivery routing, the app delivery sink, push registration (S7), `telegram-owner-do.ts` setup and alarm | #1034 (routing per ruling 20), then slices 1 and 2 |
| L3: approvals, app contracts, Google connect, ledger | Piece A, sole editor of `packages/contracts/src/app/*`, the "deliver to" contract, Google connect from the app (G1), threads contract, this ledger, reviews Instinct brief 03 | Piece A round 4 PR; G1; "deliver to"; threads |
| L4: app, TestFlight build | waldo-app `src/agent/**` and the six-file contract pin | Device build (app #42); re-pins only from merged SHAs |
| Browser and computer (bounded) | Browser drafts audit (#1032), the errand set, the in-app browser experience | #987, then B1 |
| Instinct | Delegated, disjoint slices under `docs/app/codex-handover/OWNERSHIP_BOUNDARY.md`, reviewed before merge | Briefs 01 (L1 reviews), 02 (L1 reviews), 03 (L3 reviews) |
| Ashish | Kennel, WhatsApp and iMessage adapters (#1017), device bridge (#1006) | #1017 renumbers its migration before it can apply |

### Rules between lanes
- **Hot files.** Announce before touching these on #116. Whoever merges second rebases.
  - `channels/approvals.ts`: L3 (piece A).
  - `channels/telegram-owner-do.ts`: every lane. Keep diffs small and local; L2 owns `setup()` and `alarm()`.
  - `channels/app-api.ts`: L2 (`appSinkCaller`) and L3.
  - `channels/owner-turn.ts` and `context-composer/*`: the context track.
- **App contracts.** Only L3 edits `packages/contracts/src/app/*`.
  - The app pins six files byte for byte: approvals, controls, core, health-ingest, parts and surfaces. L3 posts SHA-256 hashes, not git blob ids.
  - Changes stay additive, and the app hears about a new enum value before it ships.
  - The chat reader drops a part it cannot parse and keeps the row's `text`, so every row carrying a new part must have readable `text`.
  - A new value in a row-level or page-level field fails the app closed. Such a value needs a version bump, or an app re-pin first.
  - The cheapest additive path is a new view or route the pinned app never requests.
- **Migration timestamps.** The staging apply (`scripts/staging-migration-preflight.mjs`) needs the hosted history to be a prefix of the sorted local list, and it applies every pending file in order. So a lower timestamp that lands after a higher one is applied is stranded.
  - Applied on staging (10 October, about 19:00Z):
    - `20261010060000` (#1013, owner runtime authority);
    - `20261011000000` (#1022, health plane).
  - These sort below the applied ones and must renumber before they can apply:
    - `20261010120000` (#1017, draft);
    - `20261010050000` (rights) and `20261010070000` (channels), held by unlanded #998 work.
  - Reserved:
    - `20261011200000`: L3, G1, allowing connect channel `app` (merged in #1052; staging apply owed);
    - H4 landed as #1044 with `20261011020000` and `20261011030000`;
    - S7 push token RPC: `20261012xxxxxx` (L2).
- **Merges, deploys and migrations.** Each needs the owner's go, given in the session that runs it. A message relayed from another session is not a go. Merged is not deployed.
- **Messages between sessions.** Peer messages can be dropped. Anything another lane must know goes on #116 or in a PR.

### Staging
- **Worker.** The app lane read `/healthz` at 07:16Z on 11 October as `625214cc`. That is the unmerged tip of #1034, not a `beta-mvp` commit. The merged #1022, #1024, #1028, #1030 and #1031 are not all deployed. The next deploy is one deploy of the `beta-mvp` tip (L1).
- **Database.** `20261010060000` and `20261011000000` are applied, and `health_context_daily` has no rows. No device upload or live `/app/v1/health` call has run yet.
- **Edge Functions.** The legacy `health-sync` Edge Function was deleted from staging project `togdshayyxycitzckpqv` on 10 October, with the owner's go. To restore it, redeploy `waldo-app/supabase/functions/health-sync`.

### PRs
| PR | What | State |
|---|---|---|
| #1013 | Owner runtime authority without a messaging surface (`20261010060000`) | merged; applied on staging |
| #1015, #1016, #1018 to #1021, #1023 | Tasks approvals, Weight, health design and H1 contract, calendar list, dispatcher fix, Recovery-first reader | merged |
| #1022 | H2 health plane (`20261011000000`) | merged as `bf477a4e`; applied on staging |
| #1024 | Stable prompt prefix; tools the owner can use (C1, C2) | merged as `a7b80436`; deploy owed |
| #1028 | Health contract: withdrawing model use alone keeps the data (ruling 11) | merged as `1757beb2`; the app pin is one revision behind on `health-ingest.ts` |
| #1031 | H3 health routes | merged as `12bca625` (11 October, 07:12Z); deploy owed |
| #1034 | App-only owners' reminders delivered in the app (L2) | merged as `07689f0a` |
| #1041 | Purge deletes an owner's derived health rows (L1, `20261011010000`) | merged as `e3c191a0` |
| #1049 | Owner DO name bound only from a name that addresses it (L2) | merged as `98b3960d` |
| #1044 | H4a per-day health series read and stale-write fence (L1, `20261011020000`, `20261011030000`) | merged as `e24ab95f` |
| #1040, #1047 | Daily score math; H4b scores after each committed ingest | merged as `b3a43013` and `c69188bb` |
| #1048 | Piece A: approvals from any surface, round 4 (L3) | merged as `3839e9d4` (head `6b4784ad`, `beta-mvp` merged in rather than rebased; CI green including pgTAP); final contract hashes on #116 |
| #1052 | G1: Google connect from the app (L3, `20261011200000`) | merged as `f6a7d2a0` (CI green including pgTAP); staging apply (L1) and deploy owed; the app re-pins `controls.ts` |
| #987 | Browser retained-session upload | open (browser lane) |
| #1032 | Browser lane audit and any-surface design | draft; design until the owner approves |
| #1033 | Owner-ingress test isolation | open; rebase and merge, or close |
| #1029 | App requirements traceability | closed with the owner's go; C11–C13 folded here |
| #1017, #1006 | iMessage connector; device bridge (Ashish) | draft |

### Findings that set the order
- **Health.** There are no `health_context_daily` rows, so health replies say that no health was shared. That holds until a device uploads and the H4 producer writes rows. The upload shape is the merged H1 contract.
- **C13: `google_task_change` in the strict approvals page.**
  - Piece A adds `google_task_change` to `kind`. That field sits inside every item of the strict `GET /app/v1/approvals` page, so an app pinned before the value fails the whole list.
  - It is safe only by ordering. waldo-app main has no caller of the approvals routes, and the approval UI stays hidden until staging serves it.
  - L4 re-pins `approvals.ts` and `parts.ts` from piece A's merged SHA, `3839e9d4`, before the app calls the route. The hashes are on #116.
  - L4 decides whether the approvals page reader drops an item it cannot parse, so that the next new kind does not repeat C13.
- **Streaming.** The runtime has no model streaming, and replies pass post-model guards whole.

### Next for L3, one at a time
0. **Console-to-app parity (owner approved, 11 October).** The app is home, and the console is a web extension. Everything a member does in the console comes to the app, in this order: (1) sign-up with an invite plus account deletion; (2) memory controls; (3) proactive jobs and push (L2); (4) connections parity; (5) files, devices and browser trial. Admin and the memory graph stay web-only. The map is on #116. Found while mapping: `channel.unlink` in `app/controls.ts` is accepted by the contract but never handled, so it always returns 400.
1. G1 (#1052) is merged as `f6a7d2a0`: Google connect from the app (`/c/<ticket>` with surface `app`; migration `20261011200000`, which L1 applies on staging). It is visible on TestFlight; today's workaround is connecting Google in the console. Then G2 with L4, retiring the app's legacy `oauth-google` path. G4 is closed: the owner confirmed one OAuth client, the backend's `GOOGLE_CLIENT_ID`, which the app also uses. G2 then needs no reconnect, as long as the legacy secret `GOOGLE_OAUTH_CLIENT_ID` holds that same client ID. The digest check was UNAVAILABLE to L3. Packet C1 of 24 September deletes the legacy `oauth-google` function and secret on staging; whether it ran is unchecked. Redirect URIs to keep until the legacy path is retired are on #116.
2. The "deliver to" control (ruling 20). The shape is proposed on #116, and L2's router reads it. It comes after G1 because an app-only owner already gets proactive messages in the app.
3. The threads contract, app and console only (ruling 21), re-cut from #998.
