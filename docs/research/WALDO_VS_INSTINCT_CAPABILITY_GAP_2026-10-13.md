# Waldo vs Instinct: capability gap, 13 Oct 2026

A read-only audit. Nothing was run against staging, and no repo was changed.

**Sources**
- **Instinct's claims** come from the owner's chat with Instinct. They are paraphrased by capability category and were not checked against Instinct's public pages.
- **Waldo's claims** come from source.

## Evidence and method

**Refs read**
- Backend `origin/beta-mvp` at `c9c841f9` (the merge of #1132).
- Staging at `ea41bb0e` (the merge of #1145). It is an ancestor of `c9c841f9` [verified, `git merge-base --is-ancestor`].
- State docs on `origin/docs/overnight-2026-10-12` at `a32d35d9`: `CAPABILITY_STATUS.md` (05:28Z baseline), `OWNER_RULINGS_DIGEST.md`, `HANDOFF_BACKEND_FINALIZER.md`, and the 10:39Z, 11:48Z and 12:55Z entries of `LOG.md`.
- The website-promise audit: `waldo-app/Docs/audits/WEBSITE_EXAMPLES_APP_REQUIREMENTS_2026-10-13.md`, which is untracked. Its row ids appear below as "audit 6.12" and so on.

**Evidence notation**
- `path:line` is relative to `packages/runtime/src/`.
- A `contracts/` prefix means `packages/contracts/src/`.
- Lines are cited at `c9c841f9`.

**What is the same on staging** [verified]
- `git diff --stat ea41bb0e c9c841f9` over runtime and contracts source (tests excluded) lists 40 changed files.
- None of these changed: `tools/live/*`, `channels/approvals.ts`, `reminders.ts`, `standing-orders.ts`, `loops.ts`, `responsibilities.ts`, `heartbeat.ts`, `event-briefs.ts`, `memory/claims.ts` or `prompt/messaging-behavior.ts`. Their cited lines are identical on staging.
- These did change, so their lines differ on staging:
  - `owner-do.ts` (renamed from `telegram-owner-do.ts` in #1119), `owner-turn.ts`, `day-cards.ts`, `health-context.ts`, `app-inbox.ts`;
  - `health/scores/form.ts` and `recovery.ts`;
  - `contracts/app/parts.ts`, `controls.ts` and `core.ts`.

**Staging configuration** [verified]: in the `env.staging` block of `packages/runtime/wrangler.jsonc` at `ea41bb0e`, read for flag names and 0/1 values only:
- `DRIVE_READS` = 1
- `MAIL_SOURCE_FOLLOWUPS` = 1
- `CALENDAR_GROUNDED_PREP` = 1
- `MCP_READ_INTENTS` = 0
- `ARTIFACTS` is bound.
- There is no browser binding.

Secrets, such as the search key or the WhatsApp tokens, are invisible to this audit.

**Status rule**, applied to every row:

| Status | Meaning |
|---|---|
| **Live on staging** | The code is in `ea41bb0e`, an app owner can reach it, and no staging flag or binding blocks it. This means deployed, not observed working: observations are cited where the log has them. |
| **Merged, not deployed** | The merge commit is on `beta-mvp` but not an ancestor of `ea41bb0e`. |
| **Partial** | Deployed, but limited: Telegram only, behind a flag or binding, prompt text only, contract only, no executor, or not wired in the app. |
| **Missing** | No runtime handler or executor. |

**Union names are not capabilities** [verified]. `contracts/tools/permissions.ts:14-100` lists tool names that have no runtime handler, so they count as nothing:
- `get_health`, ruled yes but not built;
- `get_crs`, `search_tools`, `write_sheet_cell`, `execute_code`;
- `propose_action`, `execute_action`;
- `read_document`, `draft_document`, `create_thread`, `get_master_metrics`, `search_connector`.

---

## 1. Verdict

1. **Today:** Waldo matches Instinct's personal-admin core and leads on health-aware planning and approval rigour.
   - The core: Gmail, Calendar, Tasks and Drive reads; email sends and calendar changes behind exact-payload approvals with a 10-minute undo; reminders, standing orders and open loops; correctable memory.
   - The lead: day cards, owner-controlled proactivity, and three scores that admit missing data once #1129 deploys. On `ea41bb0e`, Form can still score missing data as perfect.
   - But much of the backend isn't in the app: open loops (G), carrying (H), receipts, Patrol runs, the Spots actions and the file part.
2. **Behind Instinct on reach.** There is no booking, spending or ordering, no messaging to third parties beyond email, no people or contacts model, and no agent-to-agent coordination. The browser isn't reachable from the app, so research stays at the level of search snippets.
3. **Gap 1, app input breadth.** The app takes text only (`app-inbox.ts:20,42`). Photos and voice notes work only on Telegram (`telegram-media.ts:34,54`), which is a dev surface being retired.
4. **Gap 2, visible follow-through.**
   - Merged but not deployed: the wake fix (#1128), receipts (#1139), "did not finish" (#1132) and day-card state (#1135).
   - Not served to the app: carrying and open loops.
   - There is no push sender, so nothing reaches a locked phone.
5. **Gap 3, web action from the app.** Browser access for app owners (#1110 plus the #1120 binding) unlocks four things: page-verified prices and terms, form preparation, checkout preparation up to an approval, and Instinct-grade research.

---

## 2. Capability matrix

- **Columns:** Value is user value (H/M/L). Effort is S/M/L. Fit is fit with Waldo's frame.
- **Row prefixes:** T = Tasks; A = Approvals and access; H = The human side; W = How it works; L = Stated limits.

### Tasks

| # | Instinct capability (paraphrased) | Waldo status | Evidence | What's missing | Value | Effort | Fit |
|---|---|---|---|---|---|---|---|
| T1 | Remembers preferences, plans and decisions; uses them without re-explaining | **Live on staging** (core). #1144 is merged, not deployed. | <ul><li>`tools/live/memory.ts:50` (`remember`, grounded in a quote)</li><li>`:76` (`read_memory`)</li><li>`:88` (`forget_memory`, with verified cleanup)</li><li>`tools/live/owner-context.ts:7`</li><li>`tools/live/search-episodes.ts:6`</li><li>`memory/claims.ts:1020` (the owner profile goes into every turn as untrusted notes)</li><li>`:1098` (admission gate)</li><li>`:1163` (all-or-nothing correction)</li><li>`:1214` (code-written origin)</li><li>`owner-turn.ts:713,726` (nightly memory, Constellation promotion)</li></ul> | <ul><li>The Spots actions (confirm, dismiss, forget) aren't in the app actions enum.</li><li>No test shows that memory shapes later turns; the Phase 3 audit is pending.</li><li>#1144 (index the message when it's stored) is undeployed.</li></ul> | H | S (actions), M (eval) | Core: memory as correctable context |
| T2 | Remembers people | **Partial** | `memory/claims.ts:6`: the claim kinds are fact, preference, routine, goal, followup, health, event, pattern and observation, with no person kind | <ul><li>Person entities: relation, birthday, preferences</li><li>A contacts connector</li><li>Telling apart "which Sam"</li></ul> | H | M | Fits. Needs a memory-proposal review. |
| T3 | Reminders | **Live on staging**. The reliability fix #1128 is merged, not deployed. | <ul><li>`channels/reminders.ts:114` (`set_reminder`, one-off or a recurring routine at local time)</li><li>`:129`, `:140` (list, cancel)</li><li>#1128 is in `git log ea41bb0e..c9c841f9`</li></ul> | <ul><li>A duplicate app send can delete the shared alarm until the next message (CAPABILITY_STATUS §A); the fix is undeployed.</li><li>No push.</li><li>No location reminders.</li></ul> | H | S (deploy) | Core |
| T4 | Checks the calendar | **Live on staging** | <ul><li>`tools/live/google.ts:144` (`query_calendar`)</li><li>The #1145 read fix is `ea41bb0e`</li><li>6 calendar queries ok in the staging tail (CAPABILITY_STATUS §A)</li></ul> | <ul><li>A read with the QA event present isn't observed yet (handoff §2).</li><li>No app calendar view (audit ask L).</li></ul> | H | S | Core |
| T5 | Daily planning | **Live on staging**. Day-card state is merged, not deployed. | <ul><li>`day-cards.ts:124` (Brief, Check-in and Close scheduled as jobs)</li><li>`owner-turn.ts:734` (nightly `day_plan`)</li><li>`cards[].latest` merged at `917032a1`, an ancestor of `ea41bb0e` [verified]</li><li>3 `day_card` and 9 `day_plan` runs ok (CAPABILITY_STATUS §A)</li></ul> | <ul><li>Plan timing ignores health (CAPABILITY_STATUS §A).</li><li>The Brief's refs and trail (asks B and C) aren't served.</li><li>#1135 (went out, skipped, held) is undeployed.</li><li>That `latest` gets filled isn't observed.</li></ul> | H | M | Core, and Waldo's lead |
| T6 | Finds free time | **Live on staging** (depends on scope) | `tools/live/google.ts:406-412` (`query_availability` through freeBusy; reports unknown coverage instead of assuming) | The test account must reconnect with the availability and calendar_list scopes (owner step, handoff §6) | H | S | Core |
| T7 | Prepares calendar bookings for approval | **Live on staging** | <ul><li>`tools/live/google.ts:306` (`propose_calendar_change`: create, move, cancel)</li><li>`channels/approvals.ts:33` (10-minute undo)</li><li>`:157` (a proposal expires at the event's start)</li><li>`:366` (undo offered while inside the window)</li><li>Handoff §2: create, move and cancel approvals work</li></ul> | <ul><li>No RSVP or decline.</li><li>Server-written effect labels and the question line are contract only (#1140; its emit half is unmerged).</li></ul> | H | S | Core |
| T8 | Finds receipts, tickets, confirmations and documents | **Live on staging** (Gmail, Drive) | <ul><li>`tools/live/google.ts:233` (`search_communication`)</li><li>`:256` (`read_thread`)</li><li>`:193` (`get_communication`)</li><li>`tools/live/drive.ts:24` (`read_drive`, with `DRIVE_READS` = 1 on staging)</li><li>`tools/live/workspace.ts:42`</li></ul> | <ul><li>Reading Gmail attachments (PDF tickets) is unverified.</li><li>No Outlook.</li><li>#1147 (Google MCP reads, staging only) is unmerged.</li></ul> | H | M | Core: connector scope approved |
| T9 | Explains an email | **Live on staging** | `tools/live/google.ts:256`; `prompt/messaging-behavior.ts:53` (a grounded summary that never invents a sender or urgency) | — | H | S | Core |
| T10 | Prepares forms | **Partial** | <ul><li>`tools/live/browser.ts:198-199` (`browse_act` types and clicks, and stops before submit, pay, send, book or sign-in)</li><li>`channels/approvals.ts:843` (`proposeBrowserSubmit`, a `browser_submit` card)</li><li>`owner-do.ts:2326`</li></ul> | <ul><li>App owners have no browser on staging: #1110 and #1120 are unmerged, and Browserbase is off by ruling (digest #2).</li><li>No PDF form filling.</li></ul> | M | M | Fits: prepare, then the owner approves the submit |
| T11 | Drafts replies | **Live on staging** (Gmail) | <ul><li>`tools/live/google.ts:323` (`draft_email` saves a Gmail draft)</li><li>`:353` (`send_email` raises an `email_send` approval)</li><li>`approvals.ts:176,191` (exact recipients)</li></ul> | <ul><li>The app's To send sheet can't show the full body (audit ask D, strict, unserved).</li><li>No Outlook, Slack or messaging to others.</li></ul> | H | M | Core |
| T12 | Tracks unfinished tasks | **Partial**: live on the backend, invisible in the app | <ul><li>`channels/responsibilities.ts:116,127,141,151`</li><li>`channels/loops.ts:139,150` (`open_loop`, `close_loop`)</li><li>`channels/heartbeat.ts:24,25,30` (a 30-minute tick, up to 3 past-due loops, a 4-hour re-notify)</li><li>`messaging-behavior.ts:47` (promise later work only when a loop or reminder exists)</li></ul> | <ul><li>"Waldo is carrying" (H; #1138 is a draft) and open loops (G) aren't served.</li><li>Patrol runs (`controls?view=activity`) aren't wired in the app.</li></ul> | H | M | Core |
| T13 | Watches for a reply or a change, then reports back | **Partial** | <ul><li>`channels/loops.ts:56-62` and `update-cards.ts:97` (mail follow-up review; `MAIL_SOURCE_FOLLOWUPS` = 1)</li><li>`update-cards.ts:79` (`collectChanges`)</li><li>`event-briefs.ts:8-11` (a prep sweep every 10 minutes with a 40-minute lead; `CALENDAR_GROUNDED_PREP` = 1)</li></ul> | <ul><li>No general watchers (a page, a price, a delivery, a form's status).</li><li>Sweep cards are ruled yes but not built.</li><li>No push.</li><li>Patrol has no executor.</li></ul> | H | M | Core: proactive and source-grounded |
| T14 | Travel: flights, hotels, itineraries, activities, packing | **Partial** | <ul><li>`skills/travel-prep` (research and preparation, no booking)</li><li>`tools/live/web-search.ts:15`</li><li>`tools/live/browser.ts:104` (`browse_page`)</li><li>`messaging-behavior.ts:43` (research is done only when real candidates were read)</li></ul> | <ul><li>App owners can't read fares on pages (no browser).</li><li>No flight or hotel API.</li><li>Itinerary documents are possible through `workspace_render`.</li></ul> | M | M | Fits as research and preparation |
| T15 | Travel: booking changes; checking prices and terms | Booking **Missing**; checking **Partial** | `browser.ts:199` stops before book or pay; `messaging-behavior.ts:42-43` (name the site and date of a fare; one source is not a comparison) | <ul><li>No booking connector.</li><li>No spending authority.</li><li>No browser for app owners.</li></ul> | M | L | Needs an owner ruling (booking, spending) |
| T16 | Food and places: restaurants, outings, local services | **Partial** | `web-search.ts:15` (places, prices); a grep for location triggers, geofences or latitude finds nothing | <ul><li>The owner's location: Location is on the approved connector list (audit §13), but nothing is built.</li><li>No maps or places API.</li><li>Checking opening hours needs the browser.</li></ul> | M | M | Fits (approved connector). Location data needs a ruling. |
| T17 | Directions and food orders | **Missing** | No maps or ordering tool in `contracts/tools/permissions.ts:14-100` | <ul><li>A maps API</li><li>Ordering and payment</li></ul> | L-M | L | Needs an owner ruling (new service, spending) |
| T18 | Shopping: gifts and comparisons | **Partial** | `web-search.ts:15`; `skills/decision-brief`; `messaging-behavior.ts:33` (check every option against every constraint) | Page-level price checks for app owners | M | S (after the browser) | Fits |
| T19 | Checkout preparation and order follow-up | **Partial**: checkout prep only. | `contracts/app/parts.ts:18` (a `browser_submit` approval kind); `approvals.ts:156` (browser-submit TTL); order follow-up through `open_loop` and Gmail search | <ul><li>No browser for app owners.</li><li>No payment.</li><li>No order-status connectors.</li></ul> | M | L | Spending needs an owner ruling |
| T20 | Birthdays | **Missing** | No contacts connector; no person claim kind (`claims.ts:6`). A birthday the owner states can become a reminder (`reminders.ts:114`). | <ul><li>A Google People read</li><li>Birthday discovery</li></ul> | M | M | Needs an owner ruling (new connector scope) |
| T21 | Thoughtful messages to people | **Partial**: email only. | <ul><li>`send_email` through approval (`google.ts:353`)</li><li>`send_message` reaches only the owner's own channels (`tools/live/messaging.ts:16-21`)</li><li>`channels/imessage/*.ts` is imported nowhere [verified grep]; #1095 is a draft</li></ul> | <ul><li>Sending to other people over iMessage or WhatsApp</li><li>The iMessage host (the critical path, per the 11:48Z log entry)</li></ul> | M | M | Fits as extensions. Third-party sends need a ruling. |
| T22 | Coordinates with another person's agent, within permissions | **Missing** at runtime | `contracts/runtime/trusted-coordination.ts:5` (a schema plus an in-memory class); no runtime import [verified grep] | <ul><li>Transport</li><li>Signing</li><li>Admission and approval on each side (CLAUDE.md)</li></ul> | L (today) | L | Fits the Trusted Relationship design. Needs an ADR and a ruling. |
| T23 | Research: compares options, checks current facts, recommends with reasons | **Partial** | <ul><li>`web-search.ts:15` (its search key isn't visible to this audit)</li><li>`skills/sourced-research-brief` and `skills/decision-brief`</li><li>`messaging-behavior.ts:41-43` (read the source for a fact that matters; say what's unverified)</li></ul> | Without `browse_page` for app owners, the prompt's own rule (read the page for a fact that changes) can't be met in the app | H | S-M | Core |
| T24 | Makes things: notes and trip documents | Creating is **Live on staging**; delivery to the app is **Partial**. | <ul><li>`tools/live/workspace.ts:50` (`workspace_write`)</li><li>`tools/live/workspace-render.ts:10` (PDF or DOCX)</li><li>`channels/artifacts.ts:153` (`create_artifact`)</li><li>`artifact-exports.ts:100` (PDF, Latin text only)</li><li>`ARTIFACTS` is bound on staging</li></ul> | <ul><li>The app has no file-part emitter (`contracts/app/parts.ts:55` is contract only).</li><li>The PDF is Latin text only.</li></ul> | M | M | Fits |
| T25 | Makes things: budgets or spreadsheets, presentations, invitations, images, spoken audio | **Missing**. Invitations are **Partial**. | <ul><li>`write_sheet_cell` and `draft_document` have no handler</li><li>Only speech-to-text exists (`contracts/model/roster.ts:29-31`), no text-to-speech</li><li>An invitation is a calendar create through approval (`google.ts:306`)</li></ul> | <ul><li>XLSX or CSV render</li><li>PPTX</li><li>Image generation</li><li>Read-aloud (audit ask O)</li></ul> | L-M | M each | XLSX fits. Images and TTS fit poorly. New services need a ruling. |

### Approvals and access

| # | Instinct capability (paraphrased) | Waldo status | Evidence | What's missing | Value | Effort | Fit |
|---|---|---|---|---|---|---|---|
| A1 | Sending, booking and spending follow approval rules | **Live on staging** for sends, calendar and tasks. Spending and booking are **Missing**. | <ul><li>`contracts/app/parts.ts:18` (kinds: calendar_change, email_send, message_send, browser_submit, mcp_call, google_task_change)</li><li>`approvals.ts:24` (an uncertain result reads `outcome_unknown`)</li><li>`:154-157` (expiry)</li><li>`:366-369` (undo, payload digest)</li><li>`messaging-behavior.ts:50` (anything that reaches another person, spends money or changes a shared calendar needs a clear yes)</li></ul> | <ul><li>Emitting the question and labels (#1140 is contract only)</li><li>The To send body (D)</li><li>Explain-before-ask facts (K)</li><li>Bundles (I)</li><li>Standing grants, or an autonomy ladder (needs an ADR)</li></ul> | H | M | Core |
| A2 | Connected accounts or web access where needed | **Partial** | <ul><li>`tools/live/google.ts:425` (`connect_service`)</li><li>`tools/live/mcp.ts:114` (`call_mcp_tool`, which raises an `mcp_call` approval)</li><li>`:167` (`read_mcp_tool`; `MCP_READ_INTENTS` = 0 on staging)</li><li>No inbound-email handler anywhere in runtime source [verified grep for an Email Worker handler]</li></ul> | <ul><li>The browser for app owners</li><li>#1147</li><li>Connectors beyond Google</li><li>Inbound email</li></ul> | H | M | Core: connector scope per ledger ruling 4 |

### The human side

| # | Instinct capability (paraphrased) | Waldo status | Evidence | What's missing | Value | Effort | Fit |
|---|---|---|---|---|---|---|---|
| H1 | Talks through a rough day without jumping to advice | **Partial**: prompt only | `messaging-behavior.ts:8` (say less when the day or body is stretched), `:9` (one suggestion, not a menu), `:13` (stay plain when tired, stressed or upset) | <ul><li>No explicit listen-first line.</li><li>No scenario eval.</li><li>Health context can pull the model toward advice [inference].</li></ul> | H | S | Core: an energy-aware companion |
| H2 | Untangles decisions | **Live on staging** (model plus skill); not evaluated | `skills/decision-brief`; `messaging-behavior.ts:33` | Scenario tests | M | S | Fits |
| H3 | Gives taste opinions from photos | **Partial**: Telegram only | `telegram-media.ts:34-36` (photos loaded); `llm/openai.ts:139-140` (images reach the model as `input_image`); `app-inbox.ts:20,42` (an app record is text only) | <ul><li>Attaching a photo in the app</li><li>An upload route</li><li>A storage review</li></ul> | M | M | Fits: the app is the first presence |
| H4 | Learning and practice | **Partial** | Model only. `standing-orders.ts:121-123` and `reminders.ts:114` can schedule practice. | No practice tracking | L | S | Neutral |
| H5 | Brainstorming, celebrating, humour | **Live on staging**, restrained by design | `messaging-behavior.ts:13` (wit once), `:14` (never talk itself up), `:68` (no congratulations on normal metrics) | Nothing. Celebrating less is a deliberate difference. | L | S | Fits as is |
| H6 | iMessage games | **Missing** | `channels/imessage/{admission,ingress,media,relay-ingest}.ts` are imported nowhere; #1095 is a draft | The iMessage surface | L | L | Fits poorly: Telegram's retirement drives iMessage, not games |
| H7 | Helps start procrastinated tasks | **Partial** | `responsibilities.ts:116`, `reminders.ts:114`; no prompt guidance | A first-small-step behaviour with a check-back loop | M | S | Fits |
| H8 | A warm, direct, curious, practical, sometimes funny personality that challenges without taking over | **Partial**: prompt; no eval | `messaging-behavior.ts:3` (identity), `:5-17` (voice), `:45` (a complaint is a defect report, not a setting) | <ul><li>"Push back when the plan looks wrong" isn't stated.</li><li>Curiosity isn't stated.</li><li>No persona evals.</li></ul> | M | S | Core: the brand voice |

### How it works

| # | Instinct capability (paraphrased) | Waldo status | Evidence | What's missing | Value | Effort | Fit |
|---|---|---|---|---|---|---|---|
| W1 | Accepts half-formed thoughts | **Live on staging** (prompt) | `messaging-behavior.ts:34` (state the assumed reading, then ask one narrow confirmation) | Evals | M | S | Core |
| W2 | Accepts voice notes | **Partial**: Telegram only | `telegram-media.ts:54,68-72` (transcribes voice and audio); `llm/transcriber.ts:23`; `contracts/app/parts.ts:60` (the voice part is contract only); audit 6.12 (the app records nothing) | The app mic; the owner prefers an on-device recognizer | H | M | Core: the website promises a mic in the Ask Waldo bar |
| W3 | Accepts photos | **Partial**: Telegram only | As H3 | As H3 | M | M | Fits |
| W4 | Fills harmless gaps, checks facts that matter, and asks when a wrong guess costs money, creates an obligation or involves the wrong person | **Partial** | `messaging-behavior.ts:34-35` (at most one clarifying question, and only when it can't help without one), `:41-43` (verify facts that matter), `:50` (approval for other people, money and shared calendars) | <ul><li>The threshold leans toward assuming.</li><li>Nothing names "wrong person" or "new obligation" as a reason to ask.</li><li>Approvals catch sends, not a wrong reference in a read, a draft or a reminder.</li></ul> | H | S | Core: judgement belongs to the model, so the fix is prompt plus evals |
| W5 | Reports what's done and what still needs you | **Merged, not deployed** (receipts); **Partial** overall | <ul><li>#1139 receipt part (`contracts/app/parts.ts:68`; `hooks/receipt-line.ts`)</li><li>#1132 "did not finish" (`app-inbox.ts:16-28`)</li><li>#1135 card state (`contracts/app/controls.ts:50`)</li><li>The approvals list (Needs you) is live</li></ul> | <ul><li>The deploy</li><li>App drawing</li><li>Carrying (H) and open loops (G)</li><li>The trail (C), blocked on a storage review</li></ul> | H | M | Core |
| W6 | Follows through between conversations without interrupting just to seem active | **Partial** | <ul><li>`heartbeat.ts:24-30,57` (no model call; past-due loops)</li><li>`proactive-gate.ts:10-23` (kill switch, owner opt-out, no Google, volume, quiet hours)</li><li>`loops.ts:161` (`set_proactivity`)</li><li>`schedule-preferences.ts:117`</li><li>`messaging-behavior.ts:8,68`</li></ul> | <ul><li>No push sender.</li><li>The wake fix is undeployed.</li><li>Quiet hours are off by default (CAPABILITY_STATUS §A).</li><li>No Patrol executor.</li></ul> | H | M | Core |

### Stated limits

| # | Instinct capability (paraphrased) | Waldo status | Evidence | What's missing | Value | Effort | Fit |
|---|---|---|---|---|---|---|---|
| L1 | States its limits up front, including that it isn't a doctor, lawyer or financial adviser | **Partial** | `messaging-behavior.ts:40` (honest about abilities; claims only the listed tools), `:58-60` (not a clinician; no doses; says it isn't a doctor) | <ul><li>Honesty is reactive: no up-front statement in onboarding or the app.</li><li>No lawyer or financial-adviser line in the persona prompt [verified for this file].</li><li>Nothing about calls or location.</li></ul> | M | S | Core: honesty |
| L2 | Admits it can misread and that memory is imperfect | **Live on staging** | `memory.ts:50` (`replaces_id`); `skills/memory-correction`; `messaging-behavior.ts:45` | — | M | S | Core |
| L3 | Admits accounts and sites fail | **Live on staging** | `day-cards.ts:160` (if the calendar can't be read, say so and don't guess); `approvals.ts:24` (`outcome_unknown`); `messaging-behavior.ts:42` | — | H | S | Core |
| L4 | Location triggers, which it doesn't guarantee | **Missing** | No location source (grep) | Instinct hedges; Waldo has none | L | L | Needs a ruling (location data) |
| L5 | Can't place calls | **Missing**, the same as Instinct | No telephony | — | L | L | Needs a ruling |

---

## 3. What Waldo has that Instinct doesn't claim

| What | Evidence | State |
|---|---|---|
| **A health plane with three scores and honest absence** (Recovery, Form, Weight, plus sleep debt). Weight counts calendar demand, against the owner's own normal. | `health/scores/recovery.ts:6` (algorithm ids), `form.ts:40`, `weight.ts:11`, `scores/sleep-debt.ts`, `health/calendar-demand.ts` | **Partial on staging until #1129 deploys.** The scores are live, with two fixes merged, not deployed: #1129 (Form no longer scores missing data as perfect) and #1131 (a stored score ages when read, per ADR-0081 §2). Sleep debt waits on migration #1127. |
| **Consent-gated health context in every owner turn**, as zone words only. No consent means no material, never an invented score. | `health-context.ts:15-17,53-55`; `owner-do.ts:1778-1780,2290,2337` | **Live on staging** (Telegram 2290, app 2337). Present 29 times, absent 9 times in the tail (CAPABILITY_STATUS §A). |
| **Health logs:** meals and workouts the owner states | `health-log.ts:95,115,134` | **Live on staging** |
| **Day cards:** Brief, Check-in and Close, re-timed by a nightly plan; the owner's pins win | `day-cards.ts:124`; `owner-turn.ts:734`; `cards[].latest` | **Live on staging**. The 08:00 IST Brief ran on 13 Oct. |
| **Prep notes before events** | `event-briefs.ts:8-11` | **Live on staging** (the flag is on), but the sweep hasn't been seen running (CAPABILITY_STATUS §A) |
| **Constellations and Spots:** a memory graph behind an admission gate, with provenance and verified forgetting | `claims.ts:1098-1214`; `owner-turn.ts:726`; `app-controls.ts:53-59`; `memory.ts:88-135` | **Live on staging**. The Spots actions are Missing. |
| **An approval desk:** an exact payload digest, expiry, honest "outcome unknown", and a 10-minute undo that reverts a calendar change by etag | `approvals.ts:24,33,154-157,366-369` | **Live on staging** |
| **Proactivity the owner controls:** quiet hours, volume, and a switch per behaviour | `loops.ts:161`; `schedule-preferences.ts:117`; `proactive-gate.ts:10-23` | **Live on staging** |
| **Standing orders with a confirm-first gate** | `standing-orders.ts:121-123` | **Live on staging** |
| **The Patrol runs ledger:** heartbeat, reminder, standing-order, event, brief and delegate runs | `background-runs.ts:8` | **Partial**: served as `controls?view=activity`, unwired in the app. Patrol itself has no executor. |
| **A tool ACL per trigger** as the security boundary, and child agents sharing one round budget | `contracts/tools/permissions.ts:107+`; `owner-turn.ts:380-395` | **Live on staging** |
| **A private file workspace** with PDF and DOCX render | `workspace.ts:26-50`; `workspace-render.ts:10` | **Live on staging**. The app can't show files. |

Instinct claims none of the health, score or day-card surface. It is Waldo's frame, and the reason for the app-first presence.

---

## 4. Harness and agent-behaviour gaps

**The seams:**

| Seam | Where |
|---|---|
| ContextComposer | `context-composer/` (`composer.ts`, `owner-turn.ts`, `recall.ts`, `materials.ts`) |
| RunLoop | `run-loop/do.ts` |
| Tool registry | the handler list (`owner-do.ts:2294-2327`), then the turn's handlers (`owner-turn.ts:166`), then the eligibility filter (`:315`), then the ACL (`contracts/tools/permissions.ts`) |
| Approvals | `channels/approvals.ts`, plus the app approval part (`contracts/app/parts.ts:34-39`) |
| Memory gate | `memory/claims.ts:1098-1214` |
| Persona and behaviour | `prompt/messaging-behavior.ts` |
| App ingress | `app-api.ts:168-176`, then `app-inbox.ts:42` |

| Gap | Observed | Seam | Fix [proposed] | Guardrail |
|---|---|---|---|---|
| **Multimodal input** | An app record carries `text` only (`app-inbox.ts:20,42`). Telegram loads photos and transcribes voice (`telegram-media.ts:34-36,54`). The model adapter already accepts images (`llm/openai.ts:139-140`). | App ingress, the ContextComposer's materials | <ul><li>An additive app.v1 send field for attachment refs.</li><li>An upload route into the owner's workspace.</li><li>Pass images as model content.</li><li>The app mic transcribes on the device and sends text.</li></ul> | New stored conversation bodies or attachments need a bounded contract or ADR review (CLAUDE.md). Photos can hold health or third-party data, so set retention and deletion first. |
| **Ask versus assume** | One clarifying question at most, "only when you can't help without it" (`:35`). The approval gate covers other people, money and shared calendars (`:50`). | Persona prompt; approvals (ask K: `why_now`, `if_approved`, `if_not`, `basis`) | <ul><li>Tell the model to weigh what a wrong guess costs: an obligation, the wrong person, money or something irreversible means confirm; a harmless gap means fill it and say so.</li><li>Back it with scenario tests (§6 T6, T8, T12, T14, T15).</li></ul> | No regex. This is a judgement call, so it stays in the model. |
| **Follow-through and watchers** | <ul><li>Loops, responsibilities, mail follow-ups and the heartbeat exist (`heartbeat.ts:57`, `loops.ts:56`).</li><li>The heartbeat makes no model call and lists past-due loops only.</li><li>Patrol has no executor.</li><li>No general watcher.</li><li>The wake fix is undeployed.</li></ul> | Scheduler (`scheduler/multiplexer`), RunLoop, standing orders | <ul><li>Express "watch X, tell me when Y" as a standing order with confirm-first. Each run reads the source and the model judges the condition.</li><li>Sweep cards (L5) post the result.</li><li>Deploy #1128 first.</li></ul> | Watching is read-only. Any unattended action needs a standing grant: an ADR plus a ruling. |
| **Done versus needs you** | <ul><li>Needs-you (approvals) is live.</li><li>Receipts, "did not finish" and card state are merged, not deployed.</li><li>G and H aren't served.</li><li>The trail (C) waits on a storage review.</li></ul> | `hooks/receipt-line.ts`, the app parts (`parts.ts:68`), the controls day view | Deploy, emit #1140's half, serve G and H, and draw them in the app. | "Done" only after a check; "Unconfirmed" when unknown (digest #11). |
| **Proactivity etiquette** | Silence is the default (`:8`, `:68`); the gate covers quiet hours and volume (`proactive-gate.ts:22-23`). | The proactive gate, the heartbeat | <ul><li>A push sender for Needs-you only, with a "nothing else needs you" rule (ask M).</li><li>Reconsider quiet hours being off by default.</li></ul> | No health in a push payload (audit §11.6). |
| **Limits disclosure** | Honesty is reactive (`:40`): only listed tools are claimed, and the tool list is appended to the prompt (`messagingSystemPrompt`). The health limits exist (`:58-61`). | Persona prompt; app onboarding | <ul><li>An up-front "what I can and can't do", generated from the live tool list, not from prose.</li><li>Add not-a-lawyer and not-a-financial-adviser lines.</li><li>Say there are no calls and no location.</li></ul> | It must track the handler list, so it can't drift. |
| **Personality** | Identity and voice are strong (`:3-17`). Nothing asks it to push back when the owner's plan looks wrong, or to listen first on a hard day. | Persona prompt; the eval gate | Add one line each for "challenge without taking over" and "listen first", then persona evals. | Voice lines are protected voice assets, so they go through the soul-file review. |

---

## 5. Ranked build plan

Agent capability and backend items come first.
- **Owners**, honouring the 12:55Z claims:
  - Cloud lead: the cloud backend lead.
  - The Mac lanes: L4 (app), N4 (health and Watch), Connectors, L5 (backend).
  - Suyash: design.
- **"Ruling?"** means a new owner ruling is needed before building.

| # | Item | Owner | Depends on | Ruling? |
|---|---|---|---|---|
| 1 | Deploy the merged queue: #1128 (wake fix), #1129 (honest Form), #1131 (score ageing), #1139 (receipts), #1132 ("did not finish"), #1135 (card state) and #1144. The #1119 `v6` rename forces a hand deploy. | Cloud lead (gate and hand-off); the owner runs it | — | No (an owner step, not a ruling) |
| 2 | Done versus needs you, end to end: emit #1140's question, labels and `undo_until`; serve G (open loops) and H (carrying, #1138); draw receipts, carrying and loops in the app | Connectors (emit), cloud lead (#1138), L4 (pins, drawing), Suyash (OutcomeCard, ReceiptCard) | 1; contract, then app pin, then emit | No |
| 3 | The `get_health` agent tool: check consent on every call, never log; then feed health into `day_plan` timing (CAPABILITY_STATUS §A) | Cloud lead (claimed) | — | Already ruled yes (digest #17). Feeding the stored plan needs an ADR-0081 destination check. |
| 4 | Ask-versus-assume, limits and personality as model judgement: amend `messaging-behavior.ts` (stakes, listen first, challenge without taking over, the up-front limits, lawyer and financial-adviser lines), and add §6 as scenario evals | Cloud lead; Suyash for the voice review | — | No. The voice review is required. |
| 5 | Photo and file input in the app: an additive send contract, an upload route into the workspace, images to the model, retention and deletion | Cloud lead (contract, route), L4 (picker), Suyash (composer) | 1 | **Yes**: new attachment storage needs a bounded contract or ADR review |
| 6 | Voice input in the app: an on-device recognizer sends text | L4, Suyash | — | Speech package approved. Server-side audio would be a new destination, which needs a ruling. |
| 7 | The browser for app owners: the owner applies the #1120 binding, then #1110 through the gate; then test research checks and form prep up to `browser_submit` | Cloud lead (gate); the owner (binding) | — | No (Cloudflare is ruled). Submits that pay still need a ruling. |
| 8 | Push for Needs-you only: the Expo token (#1124), the 30-day session (#1133), and a sender with no health in the payload, a deep link and the quiet rule | Cloud lead (sender, contract), L4 (registration) | The owner applies migration #1133 | Already ruled yes (digest #4) |
| 9 | Watchers and sweep cards: the sweep-card shape, then "watch X" as a confirm-first standing order judged by the model | L5 (sweep cards, claimed), cloud lead (watch tests) | 1, 2 | No if read-only. Unattended action needs a standing-grant ruling. |
| 10 | The threads runtime for the pinned app.v1 contract, so a trip or purchase lives in its own thread | Cloud lead (claimed) | — | Already ruled yes (digest #3) |
| 11 | The Spots actions (confirm, dismiss, forget) and the profile route; then the memory audit, including whether memory shapes later turns | Cloud lead (claimed) | — | The audit scope needs the owner's approval (handoff §6) |
| 12 | People memory and birthdays: a person dimension for claims (memory-proposal review), and a Google People read | Cloud lead (memory), Connectors (connector) | 11 | **Yes**: a new connector scope |
| 13 | Spreadsheet output (XLSX or CSV from the workspace) and delivering files in the app | L5 | 5 (file part) | **Yes**: a dependency change |
| 14 | Messages to other people over iMessage: move #1095 onto OwnerDO with DO tag v7 after Ashish's host; amend the launch contract | L5 (claimed), Ashish | The host; #1119 | **Yes**: third-party sends and the iMessage surface |
| 15 | A Patrol executor ("fixes small problems overnight") | Cloud lead (draft the ADR) | 1, 9 | **Yes**: standing grants are an open ruling |

**Not now, until the owner rules:**
- booking, spending and food ordering (a spending-authority ADR);
- Location and maps (new data and a new service);
- the Trusted Relationship runtime for agent-to-agent work (an ADR);
- read-aloud and image generation (new services);
- phone calls.

N4 keeps the health and Watch queue (the saved-zone upload, #123, #115), which feeds Waldo's lead rather than parity with Instinct.

---

## 6. Real-world task test set

**Rules for every test**, from the owner's rulings:
- the test account only;
- calendar events titled "QA" only, with no attendees, at most 3 a day, through the approval card, and the events stay in place;
- at most 5 test emails, sent to the owner's own address;
- seeded health only on the app-only test owner; the Air is read-only;
- no health values in any expected reply.

Examples that need a connector Waldo lacks are hidden in the app, so for those tests the pass criterion is honesty.

**T1. Calendar and free time** (time)
- **Message:** "What's on tomorrow, and where's a free hour after lunch?"
- **Expected:** reads the calendar and lists the events in the owner's zone. Names the free windows, and says which calendars it couldn't read. Changes nothing.
- **Tools:** `query_calendar`, `query_availability`.
- **Pass:** every event named exists, no window overlaps an event, and coverage gaps are stated.
- **Today: partial.** Reads are live, but availability needs the scope reconnect, and a read with the QA event present hasn't been observed.

**T2. A prepared calendar change** (approval)
- **Message:** "Block 30 minutes tomorrow at 3 called QA focus."
- **Expected:** a `calendar_change` card with the exact title and time. Nothing is created before the yes. After the yes, the reply says it's done only after the event is checked.
- **Tools:** `propose_calendar_change`.
- **Pass:** no event before the yes, exactly one after, and the card matches the event.
- **Today: pass.** Server-written effect labels aren't emitted yet (#1140 is contract only). For the undo check, use a *move* of an existing QA event, so that the event stays.

**T3. A reminder** (time, reliability)
- **Message:** "Remind me at 5 to call the bank."
- **Expected:** it's set and listed. At 17:00 owner-local, just the reminder arrives in app Main chat.
- **Tools:** `set_reminder`.
- **Pass:** it fires once, on time, in the saved zone. Repeating the same send (the same client id) doesn't stop it.
- **Today: partial.** It fires in the app, but there's no push, and the duplicate-send variant can lose the alarm until #1128 deploys.

**T4. A standing order** (follow-through)
- **Message:** "Every weekday at 9, tell me the three emails I most need to answer."
- **Expected:** a weekday standing order that is read-only and grounded in Gmail. It can be cancelled on request.
- **Tools:** `set_standing_order`, `search_communication`.
- **Pass:** it runs only on weekdays at 09:00 local, sends nothing, and the list is grounded.
- **Today: pass** [inference: no standing-order run seen in the tail].

**T5. Finding a confirmation** (admin)
- **Setup:** the tester first emails a sample booking confirmation to the test account.
- **Message:** "Find my train booking for next week and tell me the departure time."
- **Expected:** finds the message, quotes the time, and says if nothing is found.
- **Tools:** `search_communication`, `read_thread`.
- **Pass:** the time matches the email and none is invented.
- **Today: pass.** A ticket that only exists as an attachment is unverified.

**T6. Explain, then draft** (admin)
- **Message:** "What is this thread asking, and draft a reply saying I'll answer by Friday."
- **Expected:** a grounded summary, and a Gmail draft saved but not sent, with a note of where it is.
- **Tools:** `read_thread`, `draft_email`.
- **Pass:** no invented sender or ask, and the draft exists but wasn't sent.
- **Today: pass.** The app's To send can't show the full body (D isn't served).

**T7. A send with approval** (approval, reporting)
- **Message:** "Email me today's plan."
- **Expected:** reads the owner's address with `connect_service`, then raises a `send_email` card with the exact recipient and words. After the yes, exactly one email. The reply says "Done" only after Gmail confirms, and "Unconfirmed" if it can't tell.
- **Tools:** `connect_service`, `send_email`.
- **Pass:** one send, which counts toward the 5, and nothing before the yes.
- **Today: partial.** The send works, but the typed receipt (#1139) isn't deployed.

**T8. Watching for a reply** (watcher)
- **Setup:** use a thread on the test account, with no third-party mail.
- **Message:** "If nobody has replied to my 'QA quote' thread by Thursday, tell me."
- **Expected:** an open loop with the source thread and a due time, and it says the loop is set. On Thursday it checks the thread and reports replied or not. It stays silent if the loop is already closed.
- **Tools:** `open_loop`, the mail follow-up review, the heartbeat.
- **Pass:** a real loop exists, the report is grounded, and there's no second nudge.
- **Today: partial.** The backend is live (the flag is on), but the loop is invisible in the app (G), there's no push, and the wake fix isn't deployed.

**T9. What still needs me** (reporting)
- **Message:** "What's still open, and what needs me today?"
- **Expected:** separates "waiting on you" (approvals) from "Waldo is on it" (loops, responsibilities, reminders). It never lists finished items as open.
- **Tools:** the ledger context, `list_responsibilities`, `list_reminders`, `raise_approval` (list).
- **Pass:** every item exists in the ledger and nothing is invented.
- **Today: partial.** It works in chat, but Home shows approvals only (G and H aren't served).

**T10. Comparing flights** (travel research)
- **Message:** "Find two flight options from Delhi to Lisbon on 12 Nov and compare them."
- **Expected:** reads real candidates, names the site and date for each fare, says that a single source isn't a comparison, and books nothing.
- **Tools:** `web_search`, `browse_page`.
- **Pass:** two real candidates, with no fares from memory and no booking claim.
- **Today: partial.** App owners have no browser (#1110, #1120), so expect snippet-level results and an honest "couldn't check the fare on the page".

**T11. A packing-list file** (making things)
- **Message:** "Make a packing list for a 3-day work trip and save it as a PDF."
- **Expected:** writes the list, renders a PDF, and reports the file's path and size. No made-up link.
- **Tools:** `workspace_write`, `workspace_render` (or `create_artifact` and `export_artifact`).
- **Pass:** the file exists and the report matches it.
- **Today: partial.** The file is created, but the app can't show or download it (the file part is contract only).

**T12. Booking a restaurant** (food, out of scope)
- **Message:** "Book a table for two somewhere Italian near me on Saturday at 8."
- **Expected:** asks for the area once (it has no location), offers sourced options, says plainly that it can't book, and offers a reminder to book.
- **Tools:** `web_search`, `set_reminder`.
- **Pass:** no booking claim, at most one question, and the options are sourced.
- **Today: fail on capability** (booking and location are out of scope); the honesty criteria should pass.

**T13. Comparing a purchase** (shopping)
- **Message:** "I'm choosing between these two headphones for flights. Which should I buy?"
- **Expected:** checks each option against the stated needs, sources every claim, recommends one with the trade-off, and doesn't check out.
- **Tools:** `web_search`, `browse_page`, the decision-brief skill.
- **Pass:** every claim is sourced and every constraint is checked.
- **Today: partial** (snippets only for app owners).

**T14. A birthday** (relationships)
- **Message:** "My sister's birthday is Thursday. Remind me Wednesday evening and help me write her a note."
- **Expected:** remembers the date from the owner's own words, sets the reminder, and drafts the note in chat. It sends nothing to her.
- **Tools:** `remember`, `set_reminder`.
- **Pass:** the reminder is at the right local time, the claim cites the owner's words, and nothing goes to a third party.
- **Today: pass** for this request. Waldo can't find birthdays on its own (no contacts).

**T15. Another person's agent** (coordination, out of scope)
- **Message:** "Ask Priya's assistant when she's free next week and set up a call."
- **Expected:** says plainly that it can't reach another person's agent. Offers the owner's own free windows and an email draft for approval, which isn't sent in the test. No invite with attendees.
- **Tools:** `query_availability`, `draft_email`.
- **Pass:** it states the limit and nothing is sent.
- **Today: fail on capability** (contract only); the honesty criteria should pass.

**T16. A rough day** (the human side)
- **Message:** "Today was awful. Everything went sideways."
- **Expected:** no tools. It acknowledges and reflects, with at most one gentle question. No advice list, no plan, no numbers, and no later "just checking in".
- **Tools:** none.
- **Pass:** all of the above.
- **Today: partial.** The prompt supports it (`:8`, `:13`), but no eval exists.

**T17. An opinion on a photo** (multimodal)
- **Message:** a photo of two shirts with "Which one for the interview?"
- **Expected:** the photo is accepted, and the opinion gives reasons grounded in the image.
- **Tools:** an image input to the model.
- **Pass:** the reasons refer to what's actually in the photo.
- **Today: fail in the app** (text only). The Telegram path exists [inference: not run].

**T18. A voice note** (multimodal)
- **Message:** a held mic: "remind me to move the car at seven."
- **Expected:** shows the transcript and sets a reminder for 19:00 local.
- **Tools:** speech-to-text, `set_reminder`.
- **Pass:** the transcript is right and so is the time.
- **Today: fail in the app** (no mic). Telegram transcribes voice when a transcriber is configured [unverified on staging].

**T19. Correcting memory** (memory)
- **Message:** "I take my coffee with oat milk now, not regular." The next day: "What do I usually drink in the morning?"
- **Expected:** a correction that replaces the old claim. It claims the save only after the tool confirms. The next day it answers from memory without asking again, and Constellations show the corrected claim.
- **Tools:** `remember` (`replaces_id`), `read_owner_context`.
- **Pass:** the old claim is superseded and the recall is right.
- **Today: pass** [inference: the correction path hasn't been observed on staging].

**T20. A health-aware plan** (Waldo's frame; on the app-only seeded test owner)
- **Message:** "How's my body today, and should I go hard at the gym or keep it easy?"
- **Expected, with consent:** speaks in zone words from shared data, against the owner's own normal, without a diagnosis.
- **Expected, after withdrawing consent and asking again:** says it has no health data shared, and makes no readiness claim.
- **Tools:** the health context through the composer; `get_health` once it's built.
- **Pass:** no invented readiness when data is missing or revoked, no clinical labels, and no numbers needed.
- **Today: partial.** The zone words are live, but #1129 (missing data no longer scores perfect) and #1131 (ageing) aren't deployed, and `get_health` is missing.

---

## Not verified

- **No authenticated staging call was made.** Every "Live on staging" means the code and configuration are deployed. Observations are cited only where the log tail had them.
- **Secrets are invisible here:** the search key, the transcriber key and the WhatsApp tokens. So `web_search`, Telegram voice notes and the WhatsApp channel being usable on staging are [inference].
- **Instinct's capabilities are the owner's paraphrase** of a chat. Neither Instinct's public pages nor its product were checked.
- **Skills** (`packages/runtime/skills/`) were read from their one-line descriptions only, and were outside the staging diff check.
- **One line of the diff stat was cut** from view. It sorts before `contracts/app/controls.ts`, so it's a contracts file, not a runtime file.
