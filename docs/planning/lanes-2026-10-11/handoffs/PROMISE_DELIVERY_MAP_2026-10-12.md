# Promise delivery map, 12 October 2026

Draft for the overnight orchestrator. A read-only synthesis of six research reports and tonight's overnight files. No code, ledger, PR or issue was changed.

Tags:
- **[verified]**: read or observed by the cited source tonight.
- **[inference]**: concluded, not observed.
- **[lane report]**: a lane said so, and nobody re-checked it.

## 1. Sources, SHAs and summary

### Pins

| What | SHA or version | Evidence |
|---|---|---|
| `beta-mvp` tip | `889efa27` (#1075 merge, 22:30:43Z) | Log 22:30Z; `git log origin/beta-mvp` in this worktree |
| Staging | Release `889efa27`, Worker version `3f059c04`, deployed 22:39Z. Rollback is `65a07f13` | `/healthz` read by the orchestrator at 22:54:45Z. Signed-out `/app/v1/session` and `/app/v1/chat/main` answer 401 [lane report: L1, #116 comment 6114694380] |
| App `main` | `c2ccd5d0` (#77, the `defer` re-pin) | Log 21:40Z; report 06 |
| Capability read | Backend source at `4bb040f5` (report 05). `889efa27` adds only #1075: `canonical-owner-store.ts`, `telegram-owner-do.ts` and two tests. So 05's rows hold, except the strict-load failure on send and scheduled delivery, which #1075 replaces | `git diff --stat 4bb040f5 889efa27` |
| Website | heywaldo.in = `waldo-landing` `main` `830bfc2`. Landing #18 is open at `598e94b0` | Report 01 (live fetch at 21:41Z) |
| Ledger | #1057 at `dec91152`. The Audit lane is its only writer | Report 01 |

### Inputs

**Research reports** (copied into [`research-2026-10-12/`](research-2026-10-12/); each labels its claims verified or inference):
- 01: the 120 website promises, with `WP-` IDs.
- 02: competitors and open-source agents.
- 03: the design system, G1–G22.
- 04: harness context.
- 05: 70 ledger rows. 05's IDs are `HP`, `DD`, `TW`, `YR`, `CL`, `CN`, `CX` and `UC`.
- 06: the app at `c2ccd5d0`.

**Tonight's files, in this folder:** `OVERNIGHT_LOG`, `OVERNIGHT_DECISIONS` (D1–D9), `OVERNIGHT_BOARD`, `README.md`, and the L1–L4 handoffs.

**Probe state:** per the orchestrator's brief for this map, the app send probe on `889efa27` is NOT RUN. It waits for the owner's morning send.

### Conflicts between inputs

I read source twice, only to settle these two conflicts:
1. **Typed approvals.** 02 says Waldo has no typed-text approval path.
   - At `4bb040f5`, which #1075 does not change, `whatsapp-api.ts:132-134` turns a WhatsApp text matching `[aseu]:<id>` into a decision callback. That is what 01 and 05 say.
   - A free-text "yes" still settles nothing.
2. **"Waldo reads all of it."** 05 §E8 maps this homepage line to Gmail.
   - The live text in 01's evidence (`live-text/home.txt:19`) is about health data.
   - WP-090 follows 01.

Other conflicts, not re-checked:
- **Media input.** 01 quotes the ledger's "speech in only". 05 §I.9 found that Telegram ingests photos and documents, and WhatsApp ingests images (WP-013).
- **Owner bubbles.** 01 quotes the ledger: app machine prompts render as the owner's bubbles. 05 §I.1 refutes this for app reminders, by test assertion (WP-010).
- **Reminder push row.** L3's handoff drafts it with `agent_invocable: true`. The log (21:51Z) says L3's local branch uses `false`, by an owner ruling in L3's session. This map uses the later record (WP-113).
- **Staging and #1066.** 05 and 06 describe staging at `4bb040f5` and #1066 at `e1ab2881`. The log supersedes both.

### Summary

1. **120 promises:** verified live 0; deployed, unprobed 6 (4 are website or Kennel rows); merged, not deployed 7; open PR 3 (all landing #18); partial 50; missing 33; copy decision 21.
2. **Golden path, 14 rows:** verified live 0; deployed, unprobed 3 (history, send, reminder); merged, not deployed 3; open PR 1 ("Not now", #1076); partial 3; missing 4 (Google sign-in, 18+ box, continuity, push).
3. **Risk 1, trust claims ahead of the product:** Gmail still called read-only (fix waits on landing #18); export "Working today" with no export; one-tap undo for calendar only; disconnect doesn't forget; deletion leaves two DOs' data.
4. **Risk 2, twelve "Working today" labels with no code:** Threads, Quick replies, Charts, Three levels, Your history, Weather, Location, five coding agents; and "five wearables all work" with only Apple Watch built.
5. **Risk 3, the app as Waldo's presence is unproven:** no proactive message has reached the app, there is no push, Telegram and the app keep separate transcripts, and the send fix is deployed but unprobed.
6. **Tonight:** #1075 merged (`889efa27`) and deployed (`3f059c04`, 22:39Z), unprobed; #1066 held (review FAIL + health HOLD); #1076 held (DO ALTER); app #78 open without the D6 row; S7 APNs spike passed; L3's push contract local only.

## 2. Golden path

The README's "done" checks, one row per step. Sign-in, Main chat and approvals are split into sub-rows because their parts differ in status.

**Before any probe:**
- **Build.** Build app `main` `c2ccd5d0` with L4's Release recipe (staging origin; L4 handoff §6).
- **Sign in first.** Sessions end 12 hours after sign-in, with no refresh. The owner types every emailed code.
- **Accounts.**
  - Main chat runs on the owner's account and on a fresh account (README).
  - Approvals and deletion run on a dedicated test account, never on real approvals.
- **L1's tail.** Tail falsifiers need L1 running, with its tail re-armed. The tail is live-only. L1's standing deploy go ends when the owner returns to L1's session.

| Step | App surface (file) | Backend capability (file/route) | Lane | Status | Probe that proves it | Gap / next action |
|---|---|---|---|---|---|---|
| 1a. Sign-in: email + invite | `app/(auth)/agent-sign-in.tsx` → `appRoutesClient.ts` | `POST /app/v1/auth/code`, `/auth/verify` (`app-api.ts:108-137`; `verifyOrJoin`, #1055) | L2, L4 | merged, not deployed | Q1, test account with a fresh invite. Sign in; the owner types the code. Pass: Home loads, and a wrong invite answers `needs_invite` | The session is absolute: 12 h, no refresh (`app-api.ts:81-82`). There is no first-run flow after sign-in (06 §1) |
| 1b. Sign-in: Google | none | none: no route in `app-api.ts` | L2 (O2), L3, L4 | missing | None possible | Owner ruling: O2-A plus profile. Needs a contract (L3), a route and a security review (L2), and a button (L4). Comes after S7 in the owner's order |
| 1c. Sign-in: 18+ checkbox | None at sign-up. The only control is a switch in `HealthConsent.tsx:93` | No field: the sign-up schemas are strict | L4 (D7 gate), L3, L2 | missing | After L4's gate: "Email me a code" stays disabled until the box is ticked | D7: the app gate comes first. A server record needs an additive `app.v1` field plus storage (morning) |
| 2. Google connect | `/(app)/connectors` → `ConnectionsList.tsx`; return via `app/oauth/complete.tsx` | `POST /app/v1/actions` `google.connect` → `/c/<ticket>` → `waldo://oauth/complete` (`app-controls.ts:83`) | L3, L4; the owner owns the Google consent screen | merged, not deployed | Q5, test account plus a test Google account. Connections › Connect Google › consent › return. Pass: the account shows "Calendar, Mail, Tasks". Note where any "connected" message lands | The finish runs through the Telegram runtime: it needs Telegram secrets and arms every job as a side effect [inference, 05 §C]. The "connected" notice is lost for app-only owners. No contract offers disconnect or a read/write split |
| 3. Health consent, ingest, scores | `HealthConsent.tsx` (reachable from Settings only); `useHealthIngest` (foreground only); Home rings; `HealthScores.tsx`. The iOS permission is asked only in `connect-healthkit.tsx` | `/app/v1/health/consents`, `/withdraw`, `/ingest`, `/scores` (`app-health.ts`); the producer writes Recovery, Form and Weight | L1, L4 | partial | Q8, test account, on a physical iPhone with Health data (or a Simulator with app #29's seed). Body › Manage Apple Health access; Settings › Health agreements (18+, storing, model use); foreground the app; open Body. Pass: Recovery shows a zone or a reason, and Weight says "not calculated yet". Record reason codes only | C1: without the iOS permission the app sends nothing, yet says "Last sent…" (L4 item 2). Weight is always unavailable. Form goes stale after 6 h, because upload is foreground only |
| 4a. Main chat: history loads | `ChatPane`, `useChat.ts:16-27` | `GET /app/v1/chat/main` (`readForDisplay`; #1075 rewrote this reader) | L2, L4 | deployed, unprobed | Owner's account, then a fresh account. Sign in; open Main chat. Pass: history shows, with no "status 503". On the owner's account, L1's re-armed tail shows a skip line naming `input_origin`, count 1 | The app shows a bare "status 503", with no retry and an enabled composer (L4 item 3) |
| 4b. Main chat: send works | `ChatPane` composer; receipt polling in `appRuntime.ts:79-92` | `POST /app/v1/chat/main/messages` → `appSend`/`drainApp` → turn. #1075 (`889efa27`) replaced the strict `load()` with skip plus re-link | L2, L1 | deployed, unprobed | Both accounts. Send "Reply with one short sentence confirming you got this." Pass: the reply appears under the message, with receipt `completed`. Falsifiers for L1's tail are listed below this table | NOT RUN on `889efa27`. If the second send logs no skip line, the old `commit()` path overwrote the row. Log that; it is not an emergency |
| 5a. Approve, "Don't do this" | `/(app)/approvals` (`ApprovalsList`); chat `ApprovalCard` | `GET /app/v1/approvals`, `POST …/decisions` (`app-approvals.ts:31-57`) | L3, L4 | merged, not deployed | Q6, test account with Google. Ask Waldo to move a test event; Approvals › "Make the change". Pass: `recorded`, the event moved, Undo offered for 10 min. On a second proposal tap "Don't do this". Pass: `skipped`, event unchanged | Never decided from the app on staging. "Change it" doesn't open the composer. No approval push |
| 5b. "Not now" | Label ready since app #77; shown only when the server offers `defer` | `defer` is refused with 409 (`app-approvals.ts:45-46`). The desk branch is #1076 (draft, held) | L2, L3 | open PR | After #1076 deploys, tap "Not now". Pass: the item stays `open` and leaves the default list | The owner rules on the DO ALTER, what "raises it again" means, and Telegram's "Not now" (O11). L3 answers how a deferred item shows on the chat card |
| 6. A reminder fires | A Main chat row, seen on open, refresh or foreground; no unread signal | Reminders go to the app sink (`fire` → `appDeliveryFor`; its strict load is fixed in `889efa27`) | L2, L4 | deployed, unprobed | Owner's account, which has sent an app message [inference: the 21:41Z send got 202, and `appSend` writes `app_subject` before answering, 05 §C]. Say "Remind me in two minutes to stretch."; wait 3 min; pull to refresh. Pass: a Waldo reminder row, and the tail shows no `reminder failed` | An account that never sent an app message gets nothing (`app_subject`, 05 §C). No push. No live refresh (L4 item 4). Quiet hours don't hold reminders |
| 7. Continuity, Telegram ↔ app | A channel label on each row (`ChatPane.tsx:453,467`) | The app writes the canonical store; Telegram and WhatsApp write the legacy `conv:*` rows; episodes and nightly read only the legacy store (05 §D) | L2 | missing | Owner's account. On Telegram, send "My test word is lantern"; open Main chat. Today it is absent. Ask the app "What is my test word?": a right answer comes from search or memory, not a shared transcript. Then run it in reverse | Needs Telegram on the canonical store (owner principal P, slice 2), and the canonical transcript in search and nightly with a typed speaker (`speakerOf`) |
| 8. Proactive delivery in the app | Main chat rows; Home day cards (name, time, sent); a Brief card placeholder; `latest` is not rendered | Cards arm through `timezone.set` → nightly at 03:00 local. Delivery needs `app_subject`. #1066 (draft; review FAIL + HOLD) arms on a confirmed zone | L2, L4, L3 | partial | Fresh app-only test account. Send one message; then Settings › Your schedule › "Use this device's time zone". Next day after 08:00: a Brief row, and Home's card reads "Sent today". A same-morning route through Google connect's arming side effect is [inference] (05 §C) | Telegram-linked owners get cards on Telegram; only reminders move to the app. Prep and update cards can't reach the app. #1066 needs fixes 1–3 and O10. App #78 lacks the D6 row |
| 9. Push (S7) | None: `expo-notifications` is unused; no plugin, no background mode | `/app/v1/devices*` answer 404; no APNs sender; contract `devices.ts` only | L2, L3, L4; the owner supplies the APNs key | missing | None until S7 W2. Acceptance: a reminder push arrives on a physical iPhone from the APNs sandbox | The spike passed: a throwaway Worker reached the sandbox and got 403 `MissingProviderToken`. L3's reminder contract is local. The device row is tied to the 12 h session (06 C2) |
| 10. Deletion | `/(app)/account` (`AccountPanel`, typed `DELETE`) | `account.delete` (`app-controls.ts:76-81`): files go first (503 `rejected` on failure), then `delete_owner`, then DO `deleteAll` | L1, L3, L4 | partial | Q10, throwaway test account (the owner signs it up). Connect Google; send a message; Account › Delete › DELETE. Pass: a `signed_out` receipt; the next call answers 401; L1's read-only counts are zero (auth user, tokens, sessions, Vault push secret, R2 keys); a re-invite gives an empty owner | RunLoopDO and DeviceBridgeDO data survive. The console's delete copy overclaims. There is no export |

**Step 4b falsifiers** (the board's list, read on L1's re-armed tail):
1. `/healthz` shows `889efa27`.
2. The first send logs `app_history_load` with `input_origin`, count 1, unwitnessed 0, orphans 0 and leaf true.
3. No `app_turn` `history_conflict`.
4. A second send still logs a skip line.

**Evidence so far for step 4** (on `4bb040f5`):
- The app's `GET /app/v1/chat/main` answered 200 at 21:39:37Z. The skip line read `input_origin`, count 1, unwitnessed 0.
- The send at 21:41:36Z failed with `canonical history entry invalid`, and the receipt read `effects_unconfirmed`.
- #1075 rewrote the reader both paths use. Neither result carries to `889efa27`.

## 3. Full promise table

### Status rule

A row's status follows the surface its promise names. App-first rows take the weaker of their two halves:
- Backend code in `889efa27` is deployed.
- App code on `c2ccd5d0` is merged, because the app ships only as a from-source build.

What that means row by row:
- A row that needs an app screen nobody ran tonight is `merged, not deployed`, even when its backend half is deployed.
- The Main chat screen ran against staging tonight (21:39–21:41Z), so chat-only rows are judged on the backend.
- Nothing on `889efa27` was probed, so no row is `verified live`.
- `partial` and `missing` are judged by code read, against the promise's full wording.
- `open PR` means an open PR would close the gap.
- `copy decision` means the wording conflicts with an owner ruling or decision, or only the owner can settle it.
- Four website and Kennel rows (WP-077, WP-105, WP-106, WP-120) use `deployed, unprobed` to mean "published, not probed by this map".

### Columns

- **Ledger:** 05's ID; a ledger section where 05 has no ID; or `not in ledger` (01 §4).
- **Probe:**
  - `P:"name"` is the Audit probe of that name (`WEBSITE_PROMISE_PROBES_2026-10-11.md` at `dec91152`);
  - Q1–Q10 are that file's post-503 queue;
  - GP n is a step in section 2.
- **Lane:** L1 health and deploys; L2 identity, router, proactive and runtime; L3 approvals, contracts and Google; L4 the app. "Proposed" lanes come from ledger §6a and §12, and stay unassigned until the owner approves them.

### A. Onboarding and sign-in

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-001 | not in ledger (near CN-5) | Nothing to set up; context follows you into other tools | Connections; no first-run flow | G1 connect; no outbound context (CN-9 fake) | L4, Kennel/Ashish | partial | Q5 | No guided first run; "into every tool" has no code |
| WP-002 | not in ledger (near §13 O1) | Setup needs no config, API key or JSON | `agent-sign-in.tsx` | `/auth/code`, `/auth/verify` | L2 | merged, not deployed | Q1 | An invite is required (invite-only ruling); 12 h session |
| WP-003 | not in ledger (near CN-5) | Connect tools once; Waldo reads each one | Connections | `google.connect` only; HealthKit via app | L3 | partial | Q5 | Only Google connects; app-only owners lose the "connected" notice |
| WP-004 | not in ledger | You approve every tool; nothing connects itself | Connections → Google consent | Google OAuth consent; no auto-connect | L3 | merged, not deployed | Q5 | Holds for Google [inference]; the drawn "Connect Oura?" prompt has no code |

### B. Chat

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-005 | not in ledger (near TW-5) | Ask anything any time; Waldo also speaks first | Main chat | Send fixed by #1075 (`889efa27`); proactive per GP 8 | L2 | partial | GP 4b, GP 8 | Send unprobed (failed at 21:41Z on `4bb040f5`); "speaks first" is partial |
| WP-006 | TW-1 | Separate threads, each with its own context | `chats.tsx` local drafts | Contract only (#1067); `/threads*` 404 | L2 (W3), L3, L4 | missing | P:"Threads" | Labelled "Working today"; ledger's "no app route" is stale (05 §I.5) |
| WP-007 | TW-2 | "Tell me more" on any Brief or Fetch | No anchor in send | Telegram reply-quote only; app send is strict | L2 (W3), L3 | partial | P:"Follow up" | App anchor field and consumer; the Fetch itself is missing (WP-031) |
| WP-008 | TW-3 | One-tap suggested replies | none | Contract only; no producer | L2, L4 | missing | P:"Quick replies" | Labelled "Working today" |
| WP-009 | TW-4 | Small charts inside answers | none | Contract only; no producer or series | L2, L1, L4 | missing | P:"Charts" | Labelled "Working today" |
| WP-010 | TW-5 | Full scrollable history, with the reason for each move | Main chat, "Load earlier" | `GET /chat/main`, `before:` cursor, 20 a page | L2, L4 | partial | P:"Full history" | No reasons; Telegram rows absent; no `created_at`; 05 §I.1 refutes ledger's owner-bubble note |
| WP-011 | TW-6 | Rate any message; ratings shape later messages | none | Telegram update cards only; app rating answers 405 | L2 (W4), L4 | partial | P:"Thumbs" | Labelled "Working today"; the ratings store needs a DO migration |
| WP-012 | UC-3 | Shows what it read and each fact's source | none (G15) | Effect receipts only; `source_ref` withheld from app | unowned (proposed L3 G6, L2, L4) | partial | — | Per-fact provenance part |
| WP-013 | UC-5 | Photos, voice, clips, screenshots, slides as inputs | Mic and attach disabled | Telegram photo, document, voice; WhatsApp image, audio; no video | unowned (ADR first) | partial | — | Ledger says speech in only; 05 found photo and document ingest |
| WP-014 | CL-1, UC-15 | Speak and hear replies | none | Speech in on Telegram and WhatsApp; no TTS | unowned (voice deferred) | partial | P:"Voice" | Site labels it "Planned" |

### C. Memory and continuity

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-015 | YR-4 | Say it once; everything listed and editable | `spots.tsx` stub | `remember`, `replaces_id`, `forget_memory` in chat; console controls | L3, L2, L4 | partial | P:"Say it once" | No app list, correct or forget; memory-controls scope is the owner's |
| WP-016 | not in ledger | Remembers across every chat and surface | Channel label per row | Claims shared; transcripts split; app chat not indexed | L2 | partial | GP 7 | Two transcripts (05 §D) |
| WP-017 | DD-11 | Recurring Spots join into named constellations | `constellations.tsx` stub; renderer unreachable | Nightly promotion; `view=constellation` served | L3, L4, L1 | partial | P:"Patterns", Q9 | App not wired; no numeric deltas (§7); nightly can't see app chat |
| WP-018 | §6c (→ DD-11, YR-4) | Months in, it knows you better than you do | As WP-017 | As WP-015 and WP-017 | L2 | partial | — | Weak promise (ledger §6c) |
| WP-019 | UC-13 | Spots from caffeine, meals, screen time, tool switches | none | Manual `log_meal` only | unowned (owner scope) | missing | — | These inputs don't exist |
| WP-020 | not in ledger | Blog calls the constellation "next year's problem" | — | Contradicts D11 and WP-017 | Website/owner | copy decision | — | Change the blog line |
| WP-021 | not in ledger | Learns from every correction, mostly in week one | none | `replaces_id` corrections in chat | L2, L3 | partial | P:"Say it once" | App can't correct; no first-week mechanism [inference] |
| WP-022 | UC-11 | An honest record over days, months, years | none | No range route; derived rows kept 733 days | unowned (proposed L3 G16, L1) | missing | — | Retention limits how far back it reaches |

### D. Proactive: the Brief, day moments, the Patrol, nightly

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-023 | DD-1 | Morning Brief that has already adjusted your day | Main chat row; Brief card placeholder | `card:brief` at 08:00; Telegram-tested; app untested | L2, L4, L3 | partial | P:"The Brief" | #1066 held; needs a first chat; no autonomous moves; health reaches the prompt (05 §I.2) |
| WP-024 | UC-2 | One brief that updates all day; outbox held | Home cards, no `latest` | Three fixed cards; `latest` unproduced | unowned (proposed L2, L4) | missing | — | `latest` waits on L2's day-plan record (DO ALTER held) |
| WP-025 | §6c (→ DD-10, YR-1) | Overnight replanning with real moves | none | The Patrol lists only; no grants | L2 | missing | — | Needs standing grants (#915 I) |
| WP-026 | DD-2 | Blocks your sharpest stretch | none | Vocabulary only | unowned (proposed L2, L4) | missing | P:"The Window" | §7: blocks only under a calendar grant |
| WP-027 | DD-3 | Prep 35 minutes before a big meeting | none | Telegram only on staging; app exits; off in production | L2 | partial | P:"Prep" | Fires 30–40 min ahead; no open items; #1066 keeps it held on the app |
| WP-028 | DD-4 | Pattern-driven heads-up that moves a meeting | Main chat row | 14:00 check-in card, may skip | L2 | partial | P:"The Heads-Up" | Not pattern-driven; makes no moves |
| WP-029 | DD-5 | Evening wrap with counts and tomorrow | Main chat row | `card:close` at 21:30, Telegram-tested | L2 | partial | P:"The Close" | No "moved / protected" counts |
| WP-030 | DD-6 | Weekly rebalancing of meetings | none | No weekly kind; `adjustments` table has no writer | unowned (proposed L2, L4) | missing | P:"The Adjustment" | — |
| WP-031 | UC-1 | The Fetch as its own moment and switch | none | No Fetch key or card | unowned (proposed L3, L2, L4) | missing | — | §7 brings it back as a launch moment; design goes to Suyash |
| WP-032 | DD-10 | The Patrol fixes things around the clock | `patrol.tsx` stub | Heartbeat lists up to 3 past-due loops; no model call; no grants | L2 | partial | P:"Fixed first" | Heartbeat unarmed via `timezone.set`; #932 unmerged |
| WP-033 | §6c, §14 A1 | Handles what it can overnight | none | As WP-032 | L2 | missing | — | Nothing acts on its own |
| WP-034 | DD-7 | Learns and protects your sharpest hours | none | No source | unowned (proposed L1, L2, L4) | missing | P:"Your best hours" | "Coming next", but the scenes show it working |
| WP-035 | DD-9 | Batches email into two blocks; Slack to Focus | none | Fixed quiet-hour and volume gates | Website/owner, L2 | copy decision | P:"Fewer pings" | Ruling 5: no mail holding; Slack not a connector; judgment (#915 K) unbuilt |
| WP-036 | CL-3 | Tomorrow's outlook the night before | Main chat row | The Close's calendar preview | unowned (proposed L2, L4) | partial | P:"Tomorrow, today" | No forecast; site says "Planned" |
| WP-037 | UC-10 | Works toward an outcome; reports when done | Main chat row | `open_loop`, `close_loop`; responsibilities unregistered | L2, L4 | partial | — | App delivery untested |
| WP-038 | not in ledger (D19) | Afternoon stress nudge | none | No health-driven nudges | L1 (H5), L2 | missing | — | D19: the owner confirms scope and grant |
| WP-039 | not in ledger (near D3) | Quiet by default; speaks only when there's news | none | Cap of 6 a day, 30-min cooldown; three daily cards | L2 | partial | — | Model-decided silence (#915 K) unbuilt |

### E. Reminders, routines and schedule

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-040 | YR-5 | Pick when it speaks and which messages | Schedule screen | Effective app actions: `timezone.set`, `proactivity.set` | L2, L3, L4 | partial | P:"Your schedule", Q3, Q4 | No per-message switches in the app; quiet hours skip reminders; #78 open |
| WP-041 | CL-2 | Recurring routines in your own words | Main chat rows only | Reminders and standing orders; app sink in `889efa27` | L2, L4 | partial | P:"Your own routines" | Standing orders on the app untested; no routines UI |
| WP-042 | UC-8 | Profession presets of tools and 27 routines | none | Generic standing orders only | unowned (proposed L2) | missing | — | 8 of 27 deliver via Telegram; owner scope |
| WP-043 | UC-4 | Watch-battery charge reminder | none | No battery signal | unowned | missing | — | The ledger proposes dropping it (owner) |

### F. Approvals, actions and autonomy

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-044 | YR-2 | Protected list always asks first, whatever the level | Approvals; chat `ApprovalCard` | Approval routes, six kinds; `defer` refused with 409 | L3, L2, L4 | partial | P:"Always comes back", Q6 | No protected-action list or levels; no app decision on staging; "Not now" waits on #1076 |
| WP-045 | YR-2, CN-2 | Drafts held; you see recipient and every word | Approvals review (up to 32,000 chars) | `email_send` approval, digest, Message-ID readback | L3, L4 | merged, not deployed | P:"Always comes back" | Never decided from the app on staging |
| WP-046 | YR-1 | Tell me / Ask me / Just do it, per area | none | Enum only; every policy L0 | L2, L3, L4 | missing | P:"Three levels" | Labelled "Working today" |
| WP-047 | UC-9 | Autonomy grows: asks, then moves, then quiet | none | As WP-046 | unowned (proposed L2, L3, L4) | missing | — | — |
| WP-048 | YR-3 | Every move logged with its reason and what was left | `patrol.tsx` stub | `view=activity` served; no reasons | L4, L2, L3 | partial | P:"The activity log" | No reasons, no "left alone" rows |
| WP-049 | §6, §7 (no 05 ID) | One tap takes any move back | "Undo" on done approvals | Undo for calendar changes only (10 min) | Website/owner, L3 | copy decision | Q6 | §7 chose per-action reversibility; two blog posts disclaim it (WP-104) |
| WP-050 | not in ledger | Books a car | none | No booking; no purchases until spend limits exist | Browser lane, owner | missing | — | Ruling 14 and D10; no browser binding on staging |
| WP-051 | UC-4 | Messages a third party for you | none | `send_message` reaches only the owner | Kennel/Ashish | missing | — | WhatsApp is Ashish's (D7) |

### G. Gmail

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-052 | CN-2 | Gmail works today | Main chat | Read, search, threads, draft, approved send | L3 review; Instinct brief 03 | deployed, unprobed | P:"Gmail" | No archive, label or attachments; mail follow-ups are Telegram-only |
| WP-053 | §6b, DD-9 | Batches your inbox; flags what needs you | none | No batching | Website/owner | copy decision | — | Ruling 5; #18 leaves the line |
| WP-054 | §6b, D16 (CN-2) | Gmail shown as read-only | — | Reads bodies up to 32,000 chars; approved sends | Website/owner | open PR | — | Landing #18 (`598e94b0`) makes beat 1 and the Gmail tag "read and send" |
| WP-055 | §6b, D16 (CN-2) | Blog: metadata only, not message contents | — | As WP-054 | Website/owner | open PR | — | #18 rewrites the paragraph |
| WP-056 | §6b (CN-2) | Email access depends on what you grant | Connections (access shown) | Google OAuth scopes gate reads and sends | L3 | merged, not deployed | Q5 | Calendar, Mail and Tasks are asked in one consent |
| WP-057 | UC-7 | Several accounts per tool, with work and personal rules | Connections lists accounts | No multi-account fan-out; no per-account rules | Website/owner, L3 | copy decision | — | Rules conflict with ruling 5; owner decides copy vs rule |
| WP-058 | CN-2 | Follow-up drafted in Gmail before you hang up | Main chat | `draft_email` | L3 review; Instinct brief 03 | partial | P:"Gmail" | The call inputs (Granola, HubSpot) don't exist |

### H. Calendar

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-059 | CN-1 | Reads meetings; moves, blocks and protects time | Main chat; Approvals | Reads any calendar; approved writes to primary; 10-min undo | L3 review; Instinct brief 04 | partial | P:"Google Calendar", Q6 | Nothing protects time on its own; primary calendar only; no invites |
| WP-060 | §6b (CN-1, CN-3) | Calendar starts read-only; writes need a grant | — | `calendar.events` and `tasks` requested up front | Website/owner, L3 | copy decision | — | #18 keeps the "read only" tags (README decision 10) |
| WP-061 | UC-14 | Weather moves your run before the heat | none | No `get_weather` (#1043 unregistered) | unowned; Instinct brief 02 | missing | — | Also needs autonomous moves |
| WP-062 | CX-2, CX-7 | Outlook next; Apple Calendar, Calendly planned | none | Enum only (`outlook_graph`) | owner (scope) | missing | — | §12: the owner decides scope first |

### I. Tasks

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-063 | CN-3, UC-14 | Reorders by deadline and energy; breaks tasks down | Main chat; Approvals | Reads lists; approved create, edit, complete, reopen | L3 | partial | P:"Google Tasks" | No energy ordering; no delete; dead `write_task`, `update_task` names |
| WP-064 | DD-8 | Hardest task goes to your sharpest hour | Main chat | As WP-063 | L3, L2 | partial | P:"The right task" | No right-time ordering or energy input; labelled "Working today" |
| WP-065 | CX-2, CX-7 | Todoist, To Do, Linear next; Asana planned | none | none | owner (scope) | missing | — | — |

### J. Other connectors and agents

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-066 | CN-6 | Apple Watch works today | Home, Body (HealthKit via iPhone) | `apple` ingest → scores | L1, L4 | partial | P:"Apple Watch" | The Watch app has no data path; console says "Not built yet" |
| WP-067 | CN-8 | Health Connect works today | none (no Android app) | `health_connect` ingest accepted | L4, owner (Android cut) | partial | — | Backend only (ruling 9) |
| WP-068 | CN-7 | Galaxy Watch next | `wear-debug` (dev only) | `samsung` source, untested | L4, owner | partial | — | No Android client; no Samsung ingest test |
| WP-069 | CX-1 | Apple Watch, Oura, WHOOP, Garmin, Fitbit all work | — | Apple only; others are enums; Fitbit has nothing | Website/owner, L1 | copy decision | — | The site says "all work", "are coming" and "are next" |
| WP-070 | CN-10 | Weather and Location work today, no setup | none | No `get_weather`; #1043 unregistered | unowned; Instinct brief 02; L2 | missing | P:"Weather and Location" | Labelled "Working today"; D5 location needs an OS prompt |
| WP-071 | CN-9 | Five coding agents work today through Kennel | none | Fake executor; no Kennel client | Kennel/Ashish | missing | P:"Kennel" | Labelled "Working today"; the backend seam is unassigned |
| WP-072 | §6 (no 05 ID) | Runs every model and agent; one outcome | — | Chat runs on one OpenAI model; Kennel is fake | Website/owner | copy decision | — | Ledger §6: state tested coverage |
| WP-073 | §6 (no 05 ID) | Growing to 200+ tools in 27 categories | — | 13 listed "today" | Website/owner | missing | — | Roadmap count; no lane |
| WP-074 | CN-4, CX-2, CX-7 | Reads documents you point it to | Main chat | `read_drive` on staging only, 8,192 bytes; off in production | L3, owner (`DRIVE_READS`) | partial | P:"Google Drive" | Site understates Drive ("planned"); Notion, Dropbox, Granola have nothing |
| WP-075 | CX-5, CX-2, CX-7 | Reviews and pipeline batched into focus time | none | GitHub push and PR events in; notices via the Telegram runtime | unowned | partial | — | `WALDO_EVENT_SOURCES` not in vars; app-only owners get nothing |
| WP-076 | CN-1..11, CX-1..7 | 13 tools today, 13 next, 24 planned | — | Calendar, Gmail, Tasks end to end; 7 "today" have no code | Audit ledger, Website/owner | partial | — | Weather, Location, 5 agents missing; Health Connect has no client; Telegram is test-only |
| WP-077 | not in ledger | Most-requested connectors get built first | — | Website form sends to Loops | Website/owner | deployed, unprobed | — | Website behaviour; the privacy page names only the waitlist going to Loops |
| WP-078 | not in ledger | Scenes read HubSpot, Linear, Oura and others as connected | — | GitHub inbound only | Website/owner | copy decision | — | The site's own list marks them next or planned |
| WP-079 | CL-4 | Other agents ask Waldo how you're doing | none | Contract only | Kennel/Ashish, L2 | missing | P:"Other agents ask Waldo" | Labelled "Planned" |

### K. Health: consent, ingest, scores

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-080 | HP-1 | Morning Recovery from sleep, HRV, resting state | Home rings; Body list | Producer → `recovery.candidate.v1`; `GET /scores` | L1, L4 | merged, not deployed | P:"Recovery", Q8 | Set when the app opens (foreground upload); C1 silent break |
| WP-081 | HP-2 | Form, live all day | Home, Body | Form with a 6 h freshness fence | L1, L4 | partial | P:"Form" | `stale_inputs` without background delivery; yesterday's Form gets overwritten |
| WP-082 | HP-3 | A live day-load Weight score | Body: "not calculated yet" | The producer passes `demand: null` | L1, L2 | partial | P:"Weight" | Always `calendar_demand_unavailable` |
| WP-083 | HP-4 | 14-day weighted sleep debt shapes plans | none | Computed, then dropped | L1 | partial | P:"Sleep debt" | Not stored, served or prompted; labelled "Working today" |
| WP-084 | HP-5 | Gentle flags when SpO2, breathing, temperature drift | none | SpO2 and breathing rate stored, unused; no temperature | L1 | partial | P:"Quiet flags" | No deviation logic; labelled "Working today" |
| WP-085 | HP-6 | Plans workouts; tells exercise from stress | none | Workouts only exclude Form stress hours | L1 | partial | P:"Training" | Both outputs missing; manual logs are never read |
| WP-086 | HP-7 | Heat, UV, air and daylight in the plan | none | Daylight is a hidden Form input; no weather | L1; Instinct brief 02 | partial | P:"Weather and daylight" | — |
| WP-087 | HP-8 | Look back 7, 30 or 90 days | `health/[metric]` stub | Single-day scores; no range route | unowned (proposed L3 G16, L1, L4) | missing | P:"Your history" | Labelled "Working today" |
| WP-088 | HP-9 | Import Apple Health history; usual known from day one | Ingest runner (30-day backfill) | 90-day window; chained anchors | L1, L4 | merged, not deployed | P:"Bring your past" | Never run on a physical iPhone; the app sends 30 of 90 days |
| WP-089 | DD-12 | The Slope: today against four weeks ago | none | Labels only | unowned (proposed L1, L3, L4) | missing | — | Labelled "Coming next" |
| WP-090 | §6c | Reads all your health data every day | As WP-080 | Foreground uploads; the producer uses a subset | L1, L4 | partial | — | 05 §E8 maps this line to Gmail; the live text is about health (checked) |
| WP-091 | §6c (→ HP-1..3) | Tells a rough day from an easy one | Home, Body | Recovery and Form are candidates; Weight unavailable | L1 | partial | — | Weak promise |
| WP-092 | §7 (no 05 ID) | Not a medical device; never diagnoses | Main chat replies | The prompt gets zone words and trend, never numbers | L1, L2 | deployed, unprobed | — | The constraint lives in replies; no general ledger row |
| WP-093 | not in ledger (near HP-6) | Suggests an easier run from sleep and recovery | Main chat | Health in chat needs both consents | L1, L2 | partial | — | The scene reads WHOOP (no code); `model_processing` is off on the owner's staging account |

### L. Privacy, deletion and data

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-094 | YR-6 | Export everything; delete your account | Account (typed `DELETE`) | `account.delete` deployed; no export | L1, L3, L4 | partial | P:"Yours, always", P:"Export", Q10 | Never run from the app on staging; RunLoopDO and DeviceBridgeDO data survive (05 §I.10); no export |
| WP-095 | UC-12 | Disconnecting removes what Waldo learned | none (no app disconnect) | Console disconnect revokes; nothing is purged | unowned (proposed L3, L2, L1) | missing | — | §7: lineage purge, in the rights work |
| WP-096 | §6b (no 05 ID) | Read only, unless you say so | Approvals | Every write is approval-gated | L3 | merged, not deployed | Q6 | — |
| WP-097 | §6b (no 05 ID) | App data details are still under review | — | — | Website/owner | copy decision | — | The final policy must name Gmail reading, processors, trace capture and retention |
| WP-098 | §6b (no 05 ID) | Example processors: Supabase, Anthropic, Telegram | — | Chat runs on OpenAI | Website/owner | copy decision | — | #18 drops Telegram and keeps Anthropic |
| WP-099 | §6c (→ YR-3, UC-3) | Nothing hidden | — | Activity view without reasons; no sources | L4, L2, L3 | partial | — | Weak promise |
| WP-100 | not in ledger | Shows access and actions; lets you revoke | Connections (access shown) | No app disconnect; activity without reasons | L3, L4 | partial | — | — |
| WP-101 | §6b (no 05 ID) | Not a final policy; don't connect personal accounts | — | Alpha testers connect Google | Website/owner | copy decision | — | Restricted Google scopes need a published policy (ruling 6) |
| WP-102 | not in ledger | Launch and accounts wait for final terms | — | The alpha cohort is getting accounts | Website/owner | copy decision | — | — |
| WP-103 | not in ledger | No verified support contact yet | — | — | Website/owner | copy decision | — | The waitlist says "write to us" |
| WP-104 | not in ledger | No encryption, training or universal-undo guarantee | — | — | Website/owner | copy decision | — | Contradicts WP-049 |
| WP-105 | not in ledger | No tracking cookies | — | Website only | Website/owner | deployed, unprobed | — | Website behaviour; 01 found no common analytics script; cookies not inspected |
| WP-106 | not in ledger | Waitlist email goes to Loops; unsubscribe every time | — | Website only | Website/owner | deployed, unprobed | — | Website behaviour; the unsubscribe link wasn't checked in a real email |

### M. Channels: app, Telegram, WhatsApp, iMessage, email

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-107 | §6, §6b, D20; CN-11 | Talk on Telegram and web today; WhatsApp next | — | Telegram works, but is test-only (ruling 12) | Website/owner | open PR | — | #18's "app or web; WhatsApp later" conflicts with the FAQ and Connectors |
| WP-108 | CN-11; §6b, D20 | Telegram listed "Working today"; 8 routines use it | — | As WP-107 | Website/owner, Suyash | copy decision | — | #18 defers these to an illustration follow-up |
| WP-109 | CX-3 | WhatsApp coming next | none | Ingress and shim tested; adapter unwired | Kennel/Ashish, L2 | partial | — | Linking impossible: the issuer hard-codes `'telegram'` (05 §I.12); legacy transcript |
| WP-110 | CX-4 | Talk to Waldo in iMessage | none | Modules unreachable; #1017 draft | Kennel/Ashish, L2 | partial | — | Its presence migration must sort above `20261011230000` |
| WP-111 | UC-6 | Terminal, Watch, Figma, Slack as places to talk | none | The device bridge only answers state queries | unowned (owner) | missing | — | — |
| WP-112 | not in ledger | Kennel page: Waldo for iPhone "coming soon" | — | — | Website/owner, Kennel/Ashish | copy decision | — | Conflicts with "Working today" app features and with #18 |

### N. Push notifications

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-113 | §6c, §13 S7 (no 05 ID) | One 6:30 notification for the decision needing you | none (`expo-notifications` unused) | No `/devices` routes, no APNs sender, no release rule | L2 (S7), L3, L4, owner | missing | — | Spike passed; reminder contract is local; the wake-time rule is open with Suyash |
| WP-114 | not in ledger | All six day moments arrive on the lock screen | none | No push | Website/owner, Suyash | copy decision | — | Design system: the Brief never pushes, and push is capped at 3 a day |

### O. Pricing and access

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-115 | not in ledger | Let in a few at a time, earlier joiners first | — | The owner issues invites | Website/owner | copy decision | — | Ruling 18 sets a cohort of 5–10; waitlist order is not recorded |
| WP-116 | §6 (no 05 ID) | Only Kennel is usable now; iPhone next | — | — | Website/owner | copy decision | — | Conflicts with WP-107 and #18 |
| WP-117 | not in ledger | Android follows iPhone | none | The backend accepts Health Connect | owner (launch cut), L4 | missing | — | No Android client |
| WP-118 | not in ledger | Free in beta; no charge without a plan | — | No billing code [inference] | Website/owner | copy decision | — | Holds today; the owner confirms, and Audit adds a row |

### P. Kennel (the Waldo-related claims)

| WP | Ledger | Promise | App surface | Backend capability | Lane | Status | Probe | Gap |
|---|---|---|---|---|---|---|---|---|
| WP-119 | CN-9 (partial) | Waldo shapes outcomes and supervises agent contracts | none | Fake executor | Kennel/Ashish | missing | P:"Kennel" | Needs the K0 handoff seam, a query handler and a delivery route |
| WP-120 | not in ledger | Kennel is open source, free, local-first, open beta | — | Outside the backend | Kennel/Ashish | deployed, unprobed | — | Ashish's product claim; no input assesses it |

## 4. Lane priorities for the morning

Each lane's next three items, in order, derived from the map.

### L1: health plane and staging deploys

1. **Record the owner's morning probe on `889efa27`.** Re-arm the tail first. Cover history and send on both accounts, the step 4b falsifiers, and a #116 post (GP 4a, 4b; WP-005, WP-010).
2. **Deploy the morning merges through the gate, once the owner rules.**
   - #1066 with L2's fixes (GP 8; WP-023, WP-027–WP-029, WP-032).
   - #1076, after its DO ALTER go (GP 5b; WP-044).
   - The classifier denied a board-triggered deploy cron, so each deploy needs a message or the owner.
3. **Prove deletion (Q10)** on the owner's throwaway account, with read-only counts. Then find an owner for the RunLoopDO and DeviceBridgeDO residue fix (GP 10; WP-094).

After these:
- Weight's demand input and sleep-debt storage (WP-082, WP-083).
- A physical-iPhone health run with L4 (WP-080, WP-088).

### L2: identity, router, proactive, runtime

1. **#1066.**
   - Make review fixes 1–3, wait for the owner's ruling on O10, then merge.
   - Decide with L4 how an owner who has never chatted gets delivery (`app_subject`).
   - Decide how a header-written zone gets confirmed (D6).
   - GP 8; WP-023, WP-027–WP-029, WP-032, WP-041.
2. **#1076, "Not now".** Get the owner's three answers (O11), then merge (GP 5b; WP-044).
3. **S7 W2, next in the owner's 11 Oct order.**
   - Device routes, and the APNs sender behind the gate. Both come after L3's reminder contract and the owner's key.
   - Settle how push relates to the 12-hour session (06 C2).
   - GP 9; WP-113.

After these: continuity. Put Telegram on the canonical store, and the canonical transcript in search and nightly (GP 7; WP-016, WP-017).

### L3: approvals, app contracts, Google connect

1. **Open the reminder-push contract PR**, with its wall result, plus the one-line ADR-0068 correction. Both need the owner's go in L3's session. S7 W2 waits on this (GP 9; WP-113).
2. **Approvals.**
   - Answer the deferred-item question before #1076 ships. A deferred item leaves the default list, so the chat card says "no longer available".
   - Compare the NeedsYouCard fields with `approvals.ts`.
   - GP 5b; WP-044, WP-045.
3. **Google connect readiness for the owner's Q5.**
   - The lost "connected" notice for app-only owners.
   - The connect link minted for `'telegram'` inside app turns.
   - The Calendar and Tasks scope question (O2).
   - GP 2; WP-003, WP-056, WP-060.

After these:
- The 18+ attestation as an additive `app.v1` field (GP 1c).
- The Brief `latest` reader (WP-024).
- An app disconnect contract (WP-095, WP-100).

### L4: waldo-app

0. **First, the owner answers L4's pending question.** It stalls L4's whole queue (log 23:18Z).
1. **Time zone.** Finish app #78 and add the D6 "Confirm" row. Then the orchestrator's CI-equivalent run and review (GP 8; WP-040, WP-023).
2. **Health honesty (06 C1).** Chain the agreements, then the iOS permission, then the first upload. Show the count sent, never values (GP 3; WP-080, WP-088, WP-090).
3. **The 18+ checkbox gate on sign-up (D7)** (GP 1c). A missing golden-path step outranks failure UX.

After these:
- The Main chat failure state (GP 4a; WP-005).
- Refresh while the chat is visible, and an unread signal on Home (GP 6; WP-041).
- The S7 app side, once `/devices` is served (GP 9).

## 5. Owner decisions the map surfaces

The owner's rule is that every heywaldo.in promise ships, and copy changes only by owner decision. So each recommendation keeps the promise unless an existing ruling already chose against it; that ruling is named in the option. Every relabel proposed here is temporary, and its probe restores the label.

### O1. Landing #18

- **Header:** Landing #18
- **Promises:** WP-054, WP-055, WP-107
- **Question:** How should landing #18 (head `598e94b0`) ship, given that it fixes the Gmail copy but adds two new contradictions?
- **Options:**
  1. **Fix conflicts, then merge (Recommended).** Make WhatsApp "next" everywhere, and make "Talk to it in the Waldo app" match the FAQ, before merging. This carries out D16 and D20.
  2. **Merge now, fix later.** The Gmail copy is right at once; the site contradicts itself until a follow-up lands.
  3. **Hold #18.** The site keeps calling Gmail read-only, while Waldo reads message bodies and sends after approval.

### O2. Calendar and Tasks scopes

- **Header:** Cal scopes
- **Promise:** WP-060
- **Question:** Should Google connect ask only for read access to Calendar and Tasks, and request write access at the first approved change, so the "read only" tags stay true?
- **Options:**
  1. **Read first, write on use (Recommended).** L3 changes the scopes; Google asks once more at the first change [inference: Google supports incremental consent].
  2. **Change the copy instead.** The tags read "read and change, with your approval", as D16 did for Gmail.
  3. **Leave both.** The tags keep understating Waldo's access.

### O3. Export and delete

- **Header:** Export
- **Promise:** WP-094
- **Question:** What should back the "Working today" label on export and delete?
- **Options:**
  1. **Build export, prove delete (Recommended).** Run Q10 on a throwaway account, fix the RunLoopDO and DeviceBridgeDO residue, and build an owner data export. The label stays.
  2. **Relabel export temporarily.** Export reads "Coming next" until its probe passes. Delete keeps "Working today" once Q10 passes.
  3. **Leave as is.** The panel says "Working today" while its body says "Under review".

### O4. Undo copy

- **Header:** Undo copy
- **Promises:** WP-049, WP-104
- **Question:** Should "Undo it in one tap" become per-action wording, as the §7 rule change already decided?
- **Options:**
  1. **Per-action wording, per §7 (Recommended).** Receipts say what can be undone and for how long, and undo extends to task changes. This matches the two blog posts.
  2. **Build more undo, keep copy.** Still false for sent email, which can't be recalled.
  3. **Leave as is.** The homepage and two blog posts keep contradicting each other.

### O5. Wearables

- **Header:** Wearables
- **Promises:** WP-069, WP-066–WP-068
- **Question:** How should the site's three wearable statements be reconciled, given that only Apple Watch has code?
- **Options:**
  1. **Build four, relabel meanwhile (Recommended).** L1 builds Oura, WHOOP, Garmin and Fitbit. Every page says "next" until each passes its probe, then the label returns.
  2. **Align the copy only.** Every page says "Apple Watch today; Oura, WHOOP and Garmin next", and Fitbit is dropped.
  3. **Leave all three versions.** "All work", "are coming" and "are next" stay side by side.

### O6. Telegram copy

- **Header:** Telegram
- **Promises:** WP-107, WP-108, WP-042
- **Question:** Should Connectors stop listing Telegram as "Working today", and should the 8 Telegram routines be redrawn in the app, per ruling 12 and D20?
- **Options:**
  1. **Follow ruling 12 (Recommended).** A follow-up landing PR after #18, with Suyash redrawing the 8 routines in the app.
  2. **Keep Telegram for the beta.** This reverses ruling 12 for the beta cohort.
  3. **Wait for the illustrations.** The status list stays until the redraw.

### O7. Beta pricing and admission

- **Header:** Beta pricing
- **Promises:** WP-118, WP-115
- **Question:** Do you confirm "Free while it's in beta, nothing charged without choosing a plan" and "earlier joiners first" as commitments?
- **Options:**
  1. **Confirm both (Recommended).** True today, since there is no billing code [inference]. Audit adds rows, no billing ships in the beta, and invites follow waitlist order.
  2. **Confirm pricing only.** Drop "earlier joiners first", because the alpha cohort is hand-picked.
  3. **Rewrite the FAQ.** Change both lines.

### O8. Legal pages

- **Header:** Legal pages
- **Promises:** WP-101, WP-102, WP-103, WP-097, WP-098
- **Question:** Should final terms, a privacy policy and a support address be published before outside testers join?
- **Options:**
  1. **Publish all three (Recommended).** Name OpenAI as the processor, plus Gmail reading, approved sends, the staging trace opt-in and retention. Google's restricted-scope verification needs this anyway.
  2. **Amend the terms line.** Allow an invited alpha under draft terms. Google verification still needs the policy URL.
  3. **Leave as is.** The terms say accounts wait for final terms, but testers already have accounts.

### O9. Push at 6:30

- **Header:** Push at 6:30
- **Promises:** WP-113, WP-114
- **Question:** Should an overnight Needs You be released as one push at wake time, with the six lock-screen moments redrawn inside the app?
- **Options:**
  1. **Wake-time Needs You (Recommended).** Hold an overnight Needs You and push it once at wake time (S7 W2, with Suyash). Redraw the six moments in the app, per the design-system cap (at most 3 pushes a day; the Brief never pushes).
  2. **Push all six moments.** Keeps WP-114, but breaks the design-system cap and the hold on Brief pushes.
  3. **Drop the 6:30 line.** A copy change; no push rule is needed.

### O10. #1066 health hold

- **Header:** #1066 health
- **Promises:** WP-023, WP-027–WP-029
- **Question:** May #1066 merge once the day-card prompt it saves to `conv:*` and the episodes index no longer carries health-log lines ("~N kcal, estimate", "N min")?
- **Options:**
  1. **Strip, then merge (Recommended).** Save the prompt without health-log lines, since CLAUDE.md forbids numeric health values in transcripts. The same change fixes Telegram owners [inference].
  2. **Merge as is.** This extends an existing Telegram-only leak to app-only owners.
  3. **Drop day-card arming.** The Brief stays out of reach for app-only owners.

### O11. "Not now"

- **Header:** Not now
- **Promise:** WP-044 (GP 5b)
- **Question:** Do you approve #1076's guarded DO ALTER, with L2's meanings for "raises it again" and Telegram's "Not now"?
- **Options:**
  1. **Approve L2's proposal (Recommended).** Add `ledger.deferred_at`. "Raises it again" means it is presented again on any surface when the model re-raises it. Telegram's "Not now" becomes defer.
  2. **Approve, without re-raise.** Deferred items stay hidden until they expire.
  3. **Hold #1076.** "Not now" keeps answering 409.

### O12. "Working today" labels with no implementation

- **Header:** Labels
- **Promises:** WP-006, WP-008, WP-009, WP-046, WP-087, WP-070, WP-071
- **Question:** Should the twelve "Working today" labels with no implementation read "Coming next" until each passes its probe, while all twelve are built?
- **Options:**
  1. **Build all, relabel meanwhile (Recommended).** Each label returns when its probe passes. The builds:
     - Threads: L2 W3;
     - Quick replies and Charts: L2 and L4;
     - Three levels: #915 I;
     - Your history: L3 G16 and L1;
     - Weather and Location: #1043 plus coarse location;
     - the five coding agents: Ashish.
  2. **Build, keep the labels.** The labels stay false until each ships.
  3. **Relabel, no schedule.** Copy change only.

### O13. Android

- **Header:** Android
- **Promises:** WP-067, WP-068, WP-117
- **Question:** Is Android (Health Connect, Galaxy Watch) in the launch cut?
- **Options:**
  1. **Yes, after iOS (Recommended).** L4 builds an Android Health Connect client once the iOS golden path passes; ruling 9 says build it when a promise needs it. Health Connect reads "Coming next" until then.
  2. **Not in this launch.** Relabel Health Connect "Coming next"; "Android follows" stays.
  3. **Leave the labels.** "Working today" stays false.

### O14. Mail holding

- **Header:** Mail holding
- **Promises:** WP-035, WP-053, WP-057
- **Question:** Should the site's inbox batching and per-account mail rules be rewritten to match ruling 5 (no mail holding)?
- **Options:**
  1. **Rewrite per ruling 5 (Recommended).** "Waldo surfaces what needs you and stays quiet otherwise." The judgment ships with #915 K.
  2. **Reverse ruling 5.** Build batching and per-account holds, at the risk of hiding urgent mail.
  3. **Leave as is.** The copy keeps promising holds the product won't do.

### Smaller copy questions

Lower urgency. Each still needs the owner.

| Header | Promises | Question | Options (first is recommended) |
|---|---|---|---|
| Blog line | WP-020 | Should the blog line calling the constellation "next year's problem" change, since D11 builds it now? | Change the blog line; keep it |
| Battery | WP-043 | Should the watch-battery scene go, as the ledger proposes, since no input names a battery source? | Drop it per the ledger; find a source first |
| Booked car | WP-050 | Should spend limits be set so booking can ship under ruling 14, or the scene be redrawn? | Set limits, then build; redraw the scene |
| Model claims | WP-072, WP-073 | Should "works with all models / agents" and "200+ tools" state tested coverage, as ledger §6 proposes? | State tested coverage; keep the copy |
| Odd inputs | WP-019 | Should caffeine and meal spots be built from HealthKit and the meal log, with screen time and tool switches relabelled? | Build two, relabel two; build none and relabel all |
| Talk places | WP-111 | Should terminal and Watch stay drawn as places to talk (later surfaces), with Figma and Slack redrawn? | Keep two, redraw two; keep all four |
| Availability | WP-112, WP-116 | Should one app-first availability statement replace the four versions on Home, Waitlist, How it works and Kennel (ledger §6)? | One statement; keep the four |

## 6. For the Audit lane

Audit is the only writer of the ledger. This section lists material for it; nothing here edits the ledger.

### 6.1 The 26 live promises not in the ledger (from 01 §4)

| WP | Promise | Page | Suggested ledger home |
|---|---|---|---|
| WP-001 | Nothing to set up; context carried into other tools | Home FAQ | §5 G1, plus a Kennel line |
| WP-002 | No config file, API key or JSON | Blog "What a CLI agent actually is" | §13 O1 |
| WP-003 | Connect once; Waldo reads each tool | Connectors hero | §5 G1 |
| WP-004 | You approve every tool | Connectors key window | §5 G1 |
| WP-005 | Ask anything, any time; Waldo speaks first | How it works | New §4 Talk row: Main chat send |
| WP-016 | Remembers across everything | Home carousel | §2 rule 3 (continuity) |
| WP-020 | Blog: the constellation is next year's problem | Blog "stuck in a loop" | §6 contradictions (vs D11) |
| WP-021 | Learns from every correction | Home FAQ | §4 Say it once |
| WP-038 | Afternoon stress nudge | Blog "mirror" | D19, then a §4 Day row |
| WP-039 | Quiet by default | Two blogs | §4 Fewer pings and D3 |
| WP-050 | Books a car | Home "Different hats" | §11, with ruling 14 |
| WP-077 | Requests drive the roadmap; the form goes to Loops | Connectors | Website-only; privacy disclosure |
| WP-078 | Scenes read nine unbuilt tools as connected | Home "Different hats" | §6 contradictions |
| WP-093 | Easier run from sleep and recovery | Home See card "Plan" | §4 Training |
| WP-100 | Shows access and actions; take access back | Home carousel | §4 Activity log, §5 G1 |
| WP-102 | Launch and accounts wait for final terms | Terms | New legal section |
| WP-103 | No verified support contact | Support | New legal section |
| WP-104 | No encryption, training or universal-undo guarantee | Blog "What we actually do with your data" | §6 contradictions (undo) |
| WP-105 | No tracking cookies | All pages | Website-only |
| WP-106 | Waitlist email goes to Loops; unsubscribe link | Waitlist, Privacy | Website-only |
| WP-112 | Kennel page: Waldo for iPhone coming soon | Kennel | §6 availability |
| WP-114 | Six day moments on the lock screen | How it works | §13 push |
| WP-115 | A few at a time, earlier joiners first | Waitlist FAQ | New access section |
| WP-117 | Android follows | Waitlist FAQ | §12 Android |
| WP-118 | Free in beta; no charge without a plan | Waitlist FAQ | New pricing section |
| WP-120 | Kennel is open source, free, in open beta | Home, Kennel | Kennel (outside the backend) |

### 6.2 Stale or wrong ledger evidence

**Pins and tonight's state:**
- **#18 pin.** The ledger records "open at `4fcc6f20`, 14 files". The head is `598e94b0`, with 16 files; its second commit is the D20 Telegram change, which §6b records only as [reported] (01 §7).
- **The main-chat 503 note (§2, §13)** says the cause is unidentified. It is `history_invalid`: one witnessed `input_origin` leaf, written by a build outside `beta-mvp` (D5).
  - #1074 (`f74a2e38`, 21:08Z) fixed the GET. It went live in `4bb040f5` (version `65a07f13`, about 21:30Z).
  - At 21:39:37Z the GET answered 200. At 21:41:36Z the send failed (`effects_unconfirmed`).
  - #1075 (`889efa27`) fixes send and scheduled delivery. It was deployed at 22:39Z as `3f059c04`. The send probe is NOT RUN.
- **#1066.** It was open at `e1ab2881` with CI 6/6. Its review is now FAIL plus a health HOLD. L2 pushed a resolution as `83edcc2f` and set it back to draft [lane report].
- **"Not now".** #1076 is a new draft desk branch for `defer`, held on a DO ALTER [lane report].
- **App `main`** is `c2ccd5d0` (#77, the `defer` re-pin), not `46e9e669`.
- **waldo-brain#36** (ADR-0068, reminder push) merged as `23c4f992` at 21:30Z.
- **L3's reminder-push contract** is local only (`2a762747`).
- **The S7 keyless spike** passed on a throwaway Worker, not on staging [lane report].
- **Line numbers.** The ledger's citations were read at `81c4f892`. 05 re-anchored the DO lines at `4bb040f5` (shifts of +2 to +35), and #1075 moves `telegram-owner-do.ts` again.

**05 §I corrections:**
1. **§4 Full history.** "Machine prompts render as the owner's bubbles" is refuted for app reminders.
2. **§4 The Brief.** "Health is not in the card prompt" is imprecise: the composer adds health when both consents are on.
3. **Arming paths.** Google consent completion arms everything [inference]. `timezone.set` arms nightly only. Delivery needs `app_subject`.
4. **§4 Patterns.** `view=constellation` is a served, tested contract.
5. **§4 Threads and §13.** A route contract exists. Threads and devices answer 404, cancel answers 404, and rating answers 405.
6. **§4 Always comes back.** `defer` is in the contract but refused with 409. The WhatsApp handling is at `whatsapp-api.ts:132-135`.
7. **§4 Your schedule.** The contract has five actions; two are effective.
8. **§2 "Sign out everywhere".** Fixed in source by #1060; not exercised on staging.
9. **§6a #5.** Not "speech in only": Telegram ingests photos and documents, and WhatsApp ingests images.
10. **Deletion residue.** DeviceBridgeDO storage survives too, not only RunLoopDO.
11. **§8.** The deploy command passes no `LANGFUSE_CAPTURE_TEXT`. Capture comes from `wrangler.jsonc:84`.
12. **§5 WhatsApp.** An issuer exists, but it hard-codes `'telegram'`, so WhatsApp linking cannot complete.
13. **§5 iMessage.** Its migration must sort above `20261011230000`.
14. **Health citations.** Four line references are wrong: the Recovery trigger, Form stress, the chat-health consent lines, and the `samsung_health` check.

**Ledger structure (01 §6, §7; 05 §E8):**
- Ruling 15 is titled "Zone bands (D7)", but D7 is WhatsApp. The §10 table runs out of order.
- Ruling 10, D1 and §6's "no landing edits" are superseded in part by D16, D20 and #18. The ledger keeps both.
- The §6c heading says ten weak promises but lists nine.
- §14 A-list item 8 counts 15 promises without a row. 01 finds 26 more (6.1 above).
- The ledger never cites `/waitlist` (beyond the shared FAQ line), `/terms`, `/support`, `/kennel`, or four of the six blog posts.
- `security-section.tsx` is unrendered. #18 edits it, and the ledger never mentions it.

## 7. Competitor and harness notes that change priorities

1. **One transcript is the competitive default.**
   - OpenClaw shares one session across DMs (`dmScope: main` plus `identityLinks`), and Letta routes chats to one default conversation. Hermes keys sessions per chat, despite its README (02).
   - This supports putting continuity (GP 7, WP-016) right after S7 on L2's list, and tagging each turn with its channel.
2. **App chat is invisible to `search_episodes` and nightly, and `speakerOf` would label `app-` turns as system** (04 finding 3).
   - WP-016, WP-017, WP-018 and WP-021 depend on a canonical `EpisodeIndex` adapter with a typed speaker, not on more memory features.
3. **Earlier turns' tool results reach the reply model on neither path** (04 finding 1).
   - "Did you send it?" and approval follow-ups (WP-037, WP-044) rest on reply prose. Run 04's falsifying test before building option C.
4. **History is cut silently in three places** (04 finding 2). Competitors leave a count and a search pointer (02, "useful tonight" item 1).
   - A one-line out-of-view note is small and reversible, and it protects "every conversation is kept" (WP-010).
5. **Waldo's approvals already exceed what Muse and OpenClaw document:** button-only authority, cross-surface clearing, `outcome_unknown` and a 10-minute undo (02).
   - Finish "Not now" (#1076) rather than rebuild approvals, and add 02's three guard tests.
   - Guard (a) must cover WhatsApp, where a typed `[aseu]:<id>` text counts as a decision today (section 1).
6. **Delivery honesty is where shipped agents fail.** Vellum logs notifications as sent that never arrived (02).
   - S7 and proactive delivery need ACK-settled receipts. L2's handoff notes that `appCaller` acknowledges sends even when nothing was delivered (WP-113, WP-023).
7. **A silent time-zone fallback is a known failure.** Hermes ran on server time with a bad zone (#111725) and drifts after DST (#119969) (02).
   - The `'UTC'` placeholder must never reach the model as the owner's zone.
   - Add DST tests for reminders and day cards (WP-040, WP-041, WP-023; #78, #1066, D6).
8. **HealthKit hides denied read access, so missing data is ambiguous** (02, OpenClaw's HealthKit page).
   - This is the root of C1 (06). The app must say "nothing sent", not "Last sent…", and the prompt must read missing data as "no data", never as low (WP-080, WP-088, WP-090).
9. **Model-decided silence is the norm for proactive runs, and failures always surface** (02: OpenClaw `NO_REPLY`, Hermes `[SILENT]`, Muse "meaningfully new").
   - That is the shape for WP-039, "quiet by default", and for WP-035's interruption judgment (#915 K), within ruling 5.
10. **No competitor documents health-aware planning** (02). OpenClaw's HealthKit gives today-only aggregates that "may remain in chat history".
    - Health-aware planning stays Waldo's differentiator.
    - The same warning backs O10: health-log lines must not persist in transcripts.
