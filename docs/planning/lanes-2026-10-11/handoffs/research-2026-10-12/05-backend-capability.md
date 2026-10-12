# 05. Backend capability per website promise, at beta-mvp 4bb040f5

Read-only research for the overnight orchestrator, 12 Oct 2026. Source and tests decide capability; planning prose and lane claims are leads only.

## Scope, pins and rules of evidence

- **Checkout:** `docs/overnight-2026-10-12`. Its HEAD moved during the run, through the orchestrator's docs-only commits: `35b7c21b` → … → `9fa16202` at handback. `git diff --stat 4bb040f5 HEAD -- packages supabase` is empty at `9fa16202`, so the source still equals `4bb040f5` [verified]. `origin/beta-mvp` was still `4bb040f5` at handback (fetched) [verified]. Every `file:line` below holds at `4bb040f5`.
- **Staging:** `/healthz` reported `4bb040f5` at 21:40Z (orchestrator log). [reported; I made no network calls.]
- **Ledger:** `WEBSITE_PROMISE_LEDGER_2026-10-10.md` at `origin/audit/ledger-takeover-20261011` `dec91152` (#1057). Its citations were read at `81c4f892`, so its `DO:NNNN` numbers have moved. Below they are re-anchored at `4bb040f5`.
- **Path shorthand:**
  - `DO` = `packages/runtime/src/channels/telegram-owner-do.ts`;
  - `rt/` = `packages/runtime/src/`;
  - `ct/` = `packages/contracts/src/`;
  - `test/` = `packages/runtime/test/`.
- **Tags:**
  - **[verified]**: I read the code at this checkout.
  - **[verified-sub]**: a read-only subagent cited it and I spot-checked a sample.
  - **[inference]**: concluded, not observed.
- **Status vocabulary:**
  - `implemented+tested`: code exists and a test exercises it.
  - `implemented, untested`
  - `partial`
  - `flagged off on staging`
  - `missing`
  - None of these means "works on staging". Nothing here was run.

### Row IDs

The ledger has no row IDs: its rows are keyed by promise name. This report assigns stable IDs by ledger section and keeps the promise name in each row. The prefixes avoid the ledger's own `D1`–`D20` decisions, the lane names `L1`–`L4` and `S7` push.

| Prefix | Ledger section |
|---|---|
| `HP-1..9` | §4 Health |
| `DD-1..12` | §4 Day to day |
| `TW-1..6` | §4 Talk to Waldo |
| `YR-1..6` | §4 Your rules |
| `CL-1..4` | §4 Coming later |
| `CN-1..11` | §5 This push |
| `CX-1..7` | §5 Later |
| `UC-1..15` | §6a, in table order |

---

## A. Every `/app/v1` route the Worker serves

**Entry.** `rt/index.ts:168` calls `handleApp` (`rt/channels/app-api.ts:102`) before any other routing.

**Paths outside `/app/v1`.** `handleApp` returns null for them (`app-api.ts:104`). Without the directory or the owner DO binding, every app path answers 404 (`:106`).

**Pre-authentication errors** all share one body, `{error:'unavailable'}` (`:22`).

**The authentication chain** [verified]:
1. **Worker.** The bearer credential is read by `auth.readAppCredential` in `authenticate` (`app-api.ts:53-60`). It answers 401 when the credential is missing or unknown and 503 when the directory is unavailable (`:139-141`). The rate limiter binding is required, or the route answers 503 (`:142`).
2. **Per-owner buckets** (`:148-149`):
   - `app-read`: every non-POST;
   - `app-approval-decision`;
   - `app-chat-send`: every other POST;
   - `app-health`: health only, its own bucket (`:144-145`).
3. **Owner DO.** `appRoute` (`DO:620-677`) re-checks that:
   - the DO name addresses this object (`:623`);
   - the stored `do_name` does not change (`:624-625`);
   - the session authority holds: `appSessionAuthority`, `rt/identity/app-session-authority.ts:10-24`, which checks `expires_at` at `:21` (`DO:628`);
   - the principal does not change (`DO:629-630`).
4. **Controls and approvals** also require the session row to exist in the directory's session list (`DO:646-647`).

### Served routes

| # | Method and path | Handler, file:line | Auth | Tests (seam) |
|---|---|---|---|---|
| 1 | POST `/app/v1/auth/code` | `app-api.ts:108-119`. Schema `appCodeRequestSchema`; edge and durable throttle in `admit` (`:62-73`). The same `{ok:true}` for any address. | none (rate-limited) | `test/app-api.test.ts` "answers a code request the same…", "rate limits sign-in attempts" (Worker); `app-invite-signup.test.ts` (Worker) |
| 2 | POST `/app/v1/auth/verify` | `app-api.ts:121-137`. `verifyOrJoin`, then credential and `sessionView`, or `{state:'needs_invite'}`. | none (rate-limited) | `app-api.test.ts`, `app-invite-signup.test.ts`, `app-basic-serving.test.ts` (Worker) |
| 3 | GET/POST `/app/v1/health/consents` | `app-api.ts:144-146` → `app-health.ts:142` (GET list) and `:138` (POST grant) | bearer | `test/app-health.test.ts` (Worker handler) |
| 4 | POST `/app/v1/health/consents/withdraw` | `app-health.ts:139` | bearer | `app-health.test.ts` |
| 5 | POST `/app/v1/health/ingest` | `app-health.ts:140,150-153`. Zone check; signed RPC; then `recompute` defers the score producer (`:124-132`). | bearer | `app-health.test.ts`, `app-health-producer.test.ts` |
| 6 | GET `/app/v1/health/scores?day=` | `app-health.ts:93-120,143` | bearer | `app-health.test.ts`, `health-scores.test.ts` |
| 7 | GET `/app/v1/session` | `app-api.ts:151-154`. `sessionView` has a 12 h absolute expiry from `created_at` and no refresh route (`:75-83`). | bearer | `app-api.test.ts` "requires valid fresh inventory…", `app-basic-serving.test.ts` |
| 8 | POST `/app/v1/auth/signout` | `app-api.ts:156-163`. DO fence, `app_push_revoke_session` RPC, revoke, verify gone, fence again. | bearer | `app-api.test.ts` (three signout and fence cases), `app-basic-serving.test.ts` |
| 9 | POST `/app/v1/chat/main/messages` | Forwarded at `app-api.ts:165-179`; `DO:633` → `appSend` `DO:739-748` (202 accepted, then `drainApp` `DO:749-767`) | bearer + DO session authority | `app-api.test.ts` (forwarding, send rate limit), `app-basic-serving.test.ts`, `app-owner-scheduled-work.test.ts`, `app-chat-journey.test.ts` (DO) |
| 10 | GET `/app/v1/chat/main/messages/{client_message_id}` | `DO:634-639`: `appInbox.receipt` (`rt/channels/app-inbox.ts:32-35`) | bearer + DO | `app-basic-serving.test.ts` "lost ACK restart readback", `app-inbox.test.ts` |
| 11 | GET `/app/v1/chat/main?cursor&limit` | `DO:663-675`: `readForDisplay` (#1074), then `appTranscriptPage` (`app-api.ts:191-206`) | bearer + DO | `app-read-failure-code.test.ts` (5 skip and fatal cases), `app-api.test.ts` (paging), `app-basic-serving.test.ts`, `app-owner-scheduled-work.test.ts` |
| 12 | GET `/app/v1/controls?view=day\|connections\|activity` | `DO:640-661` → `appControlsRequest` `rt/channels/app-controls.ts:47-70` → `projectControls` (`rt/channels/dashboard-controls.ts:33-73`) | bearer + DO + session row | `app-basic-serving.test.ts` (day), `app-google-connect.test.ts` (connections), `app-account-delete.test.ts` (day), `dashboard-controls.test.ts` (projection) |
| 13 | GET `/app/v1/controls?view=account` | `app-controls.ts:60-64` → `ownerControlsRead('account')` | as #12 | `app-account-delete.test.ts` |
| 14 | GET `/app/v1/controls?view=constellation&…` | `app-controls.ts:51-58`: read-only memory graph pager | as #12 | `app-constellation.test.ts` (handler-direct, fake host) |
| 15 | POST `/app/v1/actions` | `app-controls.ts:71-91`. `account.delete` (`:76-81`); otherwise only view `day` (`timezone.set`, `proactivity.set`) or `connections` + `google.connect` (`:83`), through `controlAction`. | as #12 | `app-basic-serving.test.ts` (`timezone.set`), `app-google-connect.test.ts`, `app-account-delete.test.ts` (DO) |
| 16 | GET `/app/v1/actions/{request_id}` | `app-controls.ts:30-40`: receipt readback | as #12 | `app-basic-serving.test.ts`, `app-account-delete.test.ts`, `app-api.test.ts` |
| 17 | GET `/app/v1/approvals?state=` | `DO:640-659` → `appApprovalsRequest` `rt/channels/app-approvals.ts:24-30` | as #12 | `app-approvals.test.ts` (handler), `app-approvals-do.test.ts` (DO), `app-api.test.ts` (forwarding) |
| 18 | POST `/app/v1/approvals/decisions` | `app-approvals.ts:31-57`: digest check, idempotent receipt book, `desk.decide(…, 'app:approval', {surface:'app'})` (`:51`) | as #12 | same three files |

### Declared in `ct/app/*` but not served [verified]

These routes come from the C1 contract (#1067).

| Route | What this Worker answers | Where |
|---|---|---|
| POST `/app/v1/chat/main/messages/{id}/cancel` | Forwarded to the DO, then **404** | Forwarded at `app-api.ts:165-167`; falls to `DO:676`, because only GET is handled at `DO:634` |
| PUT `/app/v1/chat/main/messages/{id}/rating` | **405**, not 404 | `app-api.ts:167`: only GET and POST are allowed |
| `/app/v1/threads*` (11 routes, `ct/app/threads.ts:46-58`) | **404** after authentication; 401 without a credential | `app-api.ts:180` |
| `/app/v1/devices*` (3 routes, `ct/app/devices.ts:19-23`) | **404** after authentication; 401 without a credential | `app-api.ts:180` |

**Drift in these routes:**
- The contract comments say "A Worker without this route answers 404" (`ct/app/core.ts:77`, `devices.ts:5`), but rating gets 405.
- Cancel spends the `app-chat-send` bucket, and rating spends `app-read`, before failing.
- This is minor contract drift. The app must treat 404, 405 and 401 as "not available".

### Contract fields with no producer [verified]

**`day.cards[].latest` and `day.timezone_confirmed`** (`ct/app/controls.ts:49-56`). The `day` projection emits neither (`dashboard-controls.ts:33-39`).
- #1066 adds `timezone_confirmed`.
- No branch I read adds `latest`.

**Approval action `defer`** ("Not now", #1070, `ct/app/approvals.ts:17-19`). The handler refuses it, at `app-approvals.ts:45-46`:
- The comment says the desk "has no defer path yet, so it never offers defer".
- A defer answers 409 `no_longer_eligible`.
- `rt/channels/approvals.ts` contains no `defer` at all.

**`connections.channels`.** Optional and not emitted (`dashboard-controls.ts:40-47`).

**`channel.unlink`.** Accepted by the schema (`ct/app/controls.ts:26`). It is rejected for the `connections` view at `app-controls.ts:83`, and the `day` allow-list has no `channel.unlink` (`dashboard-control-actions.ts:19`).

**Message `created_at` and `visibility`.** Optional and never emitted (`app-api.ts:203`).

**Quick-reply, chart, file and voice parts.** In the union (`ct/app/core.ts:42-47`). History emits only `text` and `approval` parts (`app-api.ts:203`).

---

## B. Main chat: history read vs send vs scheduled app delivery

**Finding [verified]:**
- #1074 relaxed only the display read.
- App sends and scheduled app deliveries still call the strict canonical `load()`, which throws on any shape-invalid row.
- A send then fails silently:
  - the client gets 202;
  - the receipt reads `interrupted` with `effects_unconfirmed: true`;
  - nothing is written to history;
  - the only code logged is `unknown`.

### The store

`canonicalOwnerConversationStore` (`rt/conversation/canonical-owner-store.ts:43-135`) has one reader, `read(skipShapeFaults)` (`:59-88`), used two ways.

**`load()`** = `read(false)` (`:90`):
- throws `canonical history entry invalid` at `:68` on any `shapeFault` (`:27-39`): id, chat, surface, payload, parent, anchor, projection, role, input_origin;
- also throws on owner mismatch (`:66`), witness mismatch (`:70,80-81`) and leaf mismatch (`:85`).

**`readForDisplay()`** = `read(true)` (`:91`):
- a shape-faulted row whose witness matches, or has no witness, is skipped and tallied (`:72-78`);
- a skipped leaf returns `leafId: null` (`:87`);
- a witness that differs, an owner mismatch, a duplicate id, and a shape-valid row without its exact witness stay fatal (`:56-58`).

### The three paths

| Path | Call chain (file:line) | Read used | Effect of one shape-invalid row |
|---|---|---|---|
| **GET history** | `DO:663-675`: `appContext` (`:668`), then `canonicalOwnerConversationStore(...).readForDisplay()` (`:670`), then logs `history_rows_skipped` with `check`, `count`, `unwitnessed` (`:671`), then `appTranscriptPage` (`:673`) | `readForDisplay` | Row skipped and logged; page answers 200 [verified, `test/app-read-failure-code.test.ts:73,93,108`] |
| **Send** | `appSend` `DO:739-748` (202) → `drainApp` `DO:749-767` → `this.turn(…,'app',true,scope)` `DO:761` → listener → `respond` builds a scoped responder whose `conversationStore` is canonical (`owner-turn.ts:609-616`, `:123`, history factory `DO:2140`) → `await restored()` `owner-turn.ts:622` → `conversationStore.load()` `owner-turn.ts:556-557` | **strict `load()`** | Throws before `persistOwnerInput` (`owner-turn.ts:581`), so neither the owner's message nor a reply is stored.<br>• The listener logs the `respond` and `turn` hops as failed with `code: 'unknown'` (`telegram-listener.ts:102,172`), because `turnFailureCode` (`turn-failure-code.ts:6-16`) has no canonical-history class. The error text survives only where text capture is on, which it is on staging (`wrangler.jsonc:84`).<br>• It rethrows to `DO:763`, which logs only `app execution outcome unconfirmed`.<br>• `appInbox.settle(record,false)` sets `state:'interrupted'`, `closedReason:'interrupted'`, `effectsUnconfirmed:true` (`app-inbox.ts:105-113`), which the receipt route returns (`app-inbox.ts:32-35`). |
| **Scheduled app delivery** | Alarm, app-only owner admitted (`DO:1281-1282`) or app-bound Telegram owner's reminders (`DO:1339-1347`) → `appDeliveryFor` `DO:574-596` → `store.load()` `DO:590` → `store.save(...)` `DO:592-593` | **strict `load()`** | Throws inside `appCaller` (`rt/channels/surfaces/app.ts:17-24`: "a failed write throws so the job fails"). The job fails, and the reminder's `fire` logs `reminder failed` (`DO:2227-2231`). |

**Staging evidence** [reported: L1 on #116 comments 6114086292 and 6114134139, relayed in the orchestrator log at `9fa16202`; not re-probed here]. It matches this analysis exactly:
- `4bb040f5` was deployed as Worker version `65a07f13`.
- `GET /app/v1/chat/main` answered 200, with the skip line `check=input_origin`, `count=1`, `unwitnessed=0`.
- `POST …/messages` answered 202. The DO then logged `respond` and `turn` `ok:false` with `code: unknown` and the error `canonical history entry invalid`, followed by `app execution outcome unconfirmed`. The app showed `effects_unconfirmed`, and the message was not stored.
- L2's strict-load follow-up is reported as #1075, open. It was not reviewed here.

**The second trap is real** [verified]. If `load()` simply skipped faulted rows, a child of a skipped row would still throw `conversation parent not found` at `ConversationTree.append` (`ct/runtime/conversation-entry.ts:98`). `restored()` appends every loaded entry (`owner-turn.ts:557`). So L2's planned fix must re-link children or resolve to the nearest loadable ancestor, as it says it will (overnight log, 21:40Z).

**Tests:**
- No test covers a send or a scheduled delivery over a shape-invalid row. `app-read-failure-code.test.ts` covers only the GET.
- The send path's happy case is covered by:
  - `app-basic-serving.test.ts`;
  - `app-owner-scheduled-work.test.ts` "sees the reminder in its history and continues the same transcript" (`:186-215`).

  Both are DO-level.

**Line drift from the overnight log.** L2's report cites `owner-turn.ts:622` (matches) and `DO:766` for the log line. At `4bb040f5` the log line is `DO:763`.

---

## C. Proactive arming for an app-only owner

### Today at 4bb040f5 [verified]

**1. App sign-in arms nothing.**
- The app runtime's `ready` is `this.browserReady` only (`DO:2027`).
- The Telegram runtime's `ready` arms `armNightly`, `armBriefSweep`, `armDayCards` and `armHeartbeat`, and backfills episodes (`DO:2027-2034`).

**2. App `timezone.set`** (`POST /app/v1/actions`, view `day`):
- It reaches `runtime.act` (`DO:650,655-657`), which writes the zone (`DO:2650-2653`).
- It then arms only nightly, if that preference is on (`DO:2654`).
- Nightly fires at 03:00 local (`rt/channels/episodes.ts:89-103`). After consolidation and promotion it calls `armDayCards` (`DO:2335`) and `planToday` (`DO:2336`).
- So the Brief, Heads-Up and Close arm only at the first 03:00 local after the zone is set; the first Brief can come that morning [inference from the arming code]. The heartbeat and the event-brief sweep (Prep) are never armed by this path.

**3. `proactivity.set`** (quiet hours and volume) arms nothing (`DO:2644-2649`).

**4. Other arming paths:**
- **The chat tool `set_schedule_preference`** calls `applySchedulePreferences` (`rt/channels/schedule-preferences.ts:54-66`), but only for the kind named. The app action enum has no `schedule.*` (`ct/app/controls.ts:26`).
- **A console visit** runs `this.setup()`, the Telegram runtime, and awaits `ready` (`DO:1083`, `DO:1151`). That arms everything.
- **Google consent completion** forwards every consent, including one started from the app, to `GOOGLE_FINISH_PATH` (`rt/channels/google-oauth.ts:83`), then `DO:696-697`, then `finishGoogle`, then `this.setup()` (`DO:1254`). That builds the Telegram runtime, whose `ready` promise arms all four jobs eagerly (`DO:2027`). So connecting Google arms everything as a side effect. This needs `TELEGRAM_BOT_TOKEN` (`DO:1592`), which staging has [route verified; arming as a side effect is an inference, and no test covers it].
  - In that runtime the owner resolves to 0 for an app-only owner (`resolveOwnerTelegramId`, `DO:200-208`), so the "Google is connected" notice is blocked as `owner_unbound` (`DO:1658`).
- **Startup reconcile** (`schedule-preferences.ts:70-78`) cancels only; it never arms. It runs only from the Telegram runtime's `ready` (`DO:2029`).
- **Quiet hours.** Cards held for quiet hours are released only by the heartbeat (`rt/channels/heartbeat.ts:76-86`). An owner armed only through `timezone.set` has no heartbeat, so a held card is never released [code verified; consequence inferred].

**5. Arming is not delivery.**
- The alarm runs an app-only owner on the app channel only when `appOwnerLookup` is admitted (`DO:1281-1282`).
- That requires `appBound()` (`DO:554-557`, used at `:563`), which needs `kv.app_subject`.
- `app_subject` is written in exactly one place: `appSend`, the owner's first chat message (`DO:742`; grep shows no other writer).
- So an app-only owner who has never sent a chat message is dormant: the alarm re-arms and returns (`DO:1283-1287`), and nothing is dispatched.
- The app runtime for such an owner also has `owner = 0` (`DO:1588-1590`). That means:
  - no listener (`DO:2154`);
  - every send is blocked at the egress gate as `owner_unbound` (`DO:1658`).

**6. Per job, for an admitted app-only owner.** The alarm dispatches every kind on `setup('app')` (`DO:1290,1352`).

| Job | Executor | Delivery to the app | Test |
|---|---|---|---|
| Reminders | `fire` | `api.sendMessage` on the app channel (`DO:2212-2222`), then `appCaller`, then `appDeliveryFor` | **tested**: `test/app-owner-scheduled-work.test.ts:112-215` (reminder kinds only) |
| Day cards | `cards` | `api.sendMessage` (`DO:2565-2567`) | none [inference that it reaches the app] |
| Standing orders | `fireOrder` | (`DO:2237+`) | none [inference] |
| Heartbeat | `beat` | Enqueues to `TelegramFinalOutbox` (`DO:2287-2300`). It reaches canonical only if the outbox drain runs `call('sendMessage')` while `scheduledAppDelivery` is set in the same alarm unit. | none [inference, untested] |
| Prep (`pre_activity_spot`) | `briefs` | **None on staging.** With `CALENDAR_GROUNDED_PREP=1` (`wrangler.jsonc:84`), `briefs` returns for any non-Telegram channel (`DO:2419-2420`). | Telegram tests only |
| Update cards and mail follow-ups | `updateCheck` | **None.** The return at `DO:2420` also skips `updateCheck` (`DO:2484`). Even with the flag off, the update card's "Useful / Not useful" `callback_data` keyboard (`DO:2517`) makes `appCaller` return `undefined`, so `sentOrThrow` throws. | none [verified code] |

**Routing for a Telegram-linked owner who also uses the app** [verified]:
- Only reminders move to the app (`DO:1335-1348`).
- Cards, heartbeat, Prep, update cards and standing orders stay on Telegram.
- Ruling 20 ("proactive messages go to the chosen surface, otherwise the app") is met only for reminders.

### #1066 (`l2/p3a-app-proactive`)

**Heads.**
- Analysed at head `0bab0a41`, based on `726ad0e7`.
- At handback the head was `e1ab2881`: a merge of `origin/beta-mvp` `4bb040f5` into the branch. Its merge base is now `4bb040f5`.
- Its own diff is unchanged: the same 8 files, +237/−15 (`git diff origin/beta-mvp...origin/l2/p3a-app-proactive --stat`) [verified].

What it changes, from the key hunks [verified]:

1. **`timezone.set` confirms the zone and arms everything else.** It writes `timezone_confirmed=true` and calls `armOwnJobs(value, now, replanCards=true)`:
   - nightly, day cards (replanned to the new zone, keeping today's times and pins via the new `replanDayCards`) and heartbeat;
   - not event briefs on the app.

   It then rebuilds runtimes.
2. **The app runtime's `ready` arms when the zone is confirmed.** It is no longer `browserReady` only. When `armable('nightly')`, i.e. `timezone_confirmed === true`, it backfills episodes, runs `armOwnJobs`, then reconciles.
3. **An alarm `held(kind)` predicate on the app channel:**
   - `event_briefs` is always held;
   - every other schedule kind is held until `timezone_confirmed`;
   - reminders have no schedule kind, so they always fire;
   - a held occurrence is skipped without cancelling, so recurring entries stay armed.
4. **The `day` projection emits `timezone_confirmed`.**
5. **`proactivity.set` no longer saves the fallback zone** to the directory.
6. **`set_schedule_preference` and `schedule.set` respect `armable`.**
7. **A new test,** `test/app-owner-proactive.test.ts`, with 7 cases, including "with a confirmed zone, a due day card reaches the app chat and nothing goes to Telegram". Its fixture writes `app_subject` straight into storage (diff line 247). So it does **not** prove delivery for an owner who has never sent a chat message.

**What #1066 still leaves open** [inference from the diff plus the code above]:
- The `appBound()` gate in item 5 above still blocks delivery until the first chat message.
- `day.cards[].latest` still has no producer.
- Prep and update cards stay off on the app by design.
- Owners whose zone was set before #1066 have no `timezone_confirmed`, so their app-channel jobs would be held until they set the zone again.
- The base question is closed: `e1ab2881` already contains `4bb040f5`. Merge readiness (CI, review) was not checked here.
- The orchestrator log reports that L2 moved #1066 back to draft. It conflicts with #1075 on one `logAppReadFailure` line, and L2 will push the resolution after #1075 merges [reported].

---

## D. Continuity: one canonical transcript?

**Finding [verified]:** no. There are two transcripts.

| Surface | Store and key prefix | Wiring | In episodes? |
|---|---|---|---|
| App turns | Canonical: `canonical-owner-v1:<principal>:<tenant>:conv:*` plus a witness per row | `history: context => canonicalOwnerConversationStore(...)` for `channel==='app'` only (`DO:2132-2140`). `owner-turn.ts:123` selects it only for the scoped responder `respond()` builds (`owner-turn.ts:609-616`). | **No** (not wrapped) |
| Scheduled app deliveries | Canonical, the assistant row only (`DO:589-593`) | | **No** |
| Telegram turns | Legacy kv `conv:*` (`rt/channels/conversation-store.ts:19-54`, built at `DO:1964`) | The Telegram runtime passes only `{skillHost}` (`DO:2080`; `telegram-turn.ts:28`), so `history` is undefined and the store is `indexedConversationStore(kv, episodes)` (`DO:2042`) | Yes |
| WhatsApp turns | Legacy kv `conv:*` | Same wiring as Telegram | Yes |
| Scheduled machine turns on any channel (`remind`, `prompt`) | Legacy kv | The base responder has no `context`, so `owner-turn.ts:123` falls back to `store` | Yes, prompt and reply |

### Consequences

1. **The app's Main chat never shows Telegram or WhatsApp messages.**
   - GET reads canonical only (`DO:670`).
   - Telegram never writes there; no Telegram-path call to `canonicalOwnerConversationStore` exists (grep: `DO:589,670,2140` only).
   - Ruling 21, one main conversation, is not met.
2. **Model context is split.**
   - An app turn reasons over canonical history only.
   - A Telegram turn reasons over kv history only (`owner-turn.ts:556-557`).
3. **Scheduled work never sees app chat.**
   - App-channel jobs reason over the kv transcript: reminders through `remind` `owner-turn.ts:642-646`, cards and standing orders through `prompt` `:647-668`.
   - They save their machine prompt and reply into kv and episodes. Only the delivered text reaches canonical, via `appCaller`.
   - The day card's "today" context is `transcript(episodes.since(midnight))` (`DO:2562`). So the Brief, Heads-Up and Close for an app-only owner are composed without the owner's app chat.
   - This is consistent with the test at `app-owner-scheduled-work.test.ts:209` (assertion; `:214` checks the next app turn sees the reminder): the canonical page shows the reminder as one assistant row and no machine-prompt user row. So the ledger's "machine prompts render as the owner's bubbles" (§4 Full history) does not hold for app-channel reminders [verified by test assertion].
4. **Episodes index and nightly consolidation.**
   - `search_episodes` (`DO:2051`) and nightly (`DO:2317`, `episodes.since`) read only the FTS index.
   - The index is fed only by `indexedConversationStore.save` (`rt/channels/episodes.ts:66-75`) over the legacy store.
   - So app chat is invisible to both. This confirms the ledger at `81c4f892`, still true at `4bb040f5`.
5. **Owner speakers are classified by id prefix.**
   - `speakerOf` treats only ids starting with `tg-` as `owner` (`episodes.ts:21`).
   - App and WhatsApp turn ids are `app-<n>` and `whatsapp-<n>` (`ownerTurnTrace`, `rt/channels/owner-turn-envelope.ts:57`; app ids `app-inbox.ts:53`; WhatsApp listener `surface: channel`, `DO:2155`).
   - `consolidationDay` drops `system` (`episodes.ts:87`).
   - So, [verified]:
     - WhatsApp owner messages are indexed but excluded from nightly consolidation today.
     - Wrapping the canonical store in the index would still not let nightly learn from app chat until `speakerOf` learns the `app-` prefix.
6. **What crosses surfaces today:**
   - **Claims memory.** One DO SQLite `claimStore` (`DO:1966`), with memory tools registered for every channel (`DO:2051`). Recall from an app turn reaches Telegram only if the model called `remember` in that turn.
   - **Telegram content reached from the app.** Only through `search_episodes`, by model judgment.
   - **The reverse.** Nothing reaches app chat from Telegram except written claims.
7. **WhatsApp and iMessage readiness.**
   - Both would land in the legacy kv path.
   - The handoff README's acceptance item is "the same canonical transcript". That needs the WhatsApp runtime to get a `history` factory, plus the `speakerOf` fix.
   - WhatsApp linking also cannot complete today: no link-code issuer produces a `'whatsapp'` code (CX-3) [verified].

**Test coverage of continuity:** none crosses surfaces. `app-owner-scheduled-work.test.ts:186-215` proves continuity within the app only: app turn, then reminder, then app turn.

---

## E. Promise rows

**How these rows were built.**
- Four read-only subagents swept the areas: health; daily moments; talk, rules and later; connectors and channels. All four returned. I spot-checked 3 to 6 claims from each sweep and all held. I verified directly every claim in sections A–D. Test columns list test files that exercise the capability; a few E6 entries are files that reference the tool by name.
- Rows are [verified-sub] unless tagged otherwise.
- Paths:
  - `health/` = `rt/health/`;
  - `sql/` = `supabase/migrations/`;
  - `pg/` = `supabase/tests/` (pgTAP; it runs in PR CI, not on this Mac).

**Staging column.** No health feature flag exists. Every `/app/v1/health/*` route needs the `RESPONSIBILITY_RATE_LIMITER` binding (`app-api.ts:142-145`; `wrangler.jsonc:98-104`). Whether the signed-RPC Supabase secrets are set cannot be known from source.

### E1. Health (§4)

| ID | Promise | Backend capability (file:line) | Tests | Staging | Status | Gap |
|---|---|---|---|---|---|---|
| HP-1 | Recovery | `health/scores/recovery.ts:27-59` (needs 14 prior days, `scores/stats.ts:1`), labelled `recovery.candidate.v1` / `candidate_unaccepted` (`scores/index.ts:44-50`). The producer (`health/producer.ts:127-150`) runs after each committed, non-empty, non-replayed ingest (`app-health.ts:124-132,152`; wired `app-api.ts:146`) and writes via `health_context_write` (`sql/20261011030000:7-85`). App read: GET scores (`app-health.ts:93-120`) → `health_scores_read`, which needs storage consent only (`sql/20261011000000_health_plane.sql:486`) [verified the consent split] | `test/health-scores.test.ts`, `health-scores.property.test.ts`, `health-producer.test.ts`, `app-health-producer.test.ts`, `app-health.test.ts`; `pg/waldo_health_plane.sql` | no flag | implemented+tested | Candidate formula only: nothing ever emits `accepted`. Recompute happens only on ingest. Sleep need is always the owner's own average. |
| HP-2 | Form | `scores/form.ts:36-74`. Stress is heart rate over at least 8 awake, non-workout hours plus HRV (RMSSD) (`:18-31,62-69`). The 6 h fence (`:11,40-43`) is measured against the series read time (`producer.ts:138`). The producer rescores yesterday and today with the same `asOf` (`:137-138`), so a recompute after 06:00 local rewrites yesterday's Form as `stale_inputs` [verified-sub, code trace; no test asserts yesterday] | `health-scores.test.ts` (components, workout exclusion, no data, `stale_inputs`) | no flag | implemented+tested | Live Form needs uploads under 6 h old, and the app uploads only in the foreground. Yesterday's Form gets wiped, which makes the chat trend `insufficient`. |
| HP-3 | Weight | Math in `scores/weight.ts:11-29`. The producer always passes `demand: null` (`producer.ts:95`) [verified], so every result is `calendar_demand_unavailable` (`weight.ts:13`). | Math: `health-scores.test.ts`. `health-producer.test.ts:155` pins `demand` null. | no flag | partial | No calendar, task, message or load demand collector. |
| HP-4 | Sleep debt | Computed (`scores/sleep-debt.ts:12-33`, called `scores/index.ts:53`). Dropped: `rowOf` keeps only recovery, form and weight (`producer.ts:103-105`) [verified]. The write fence excludes it (`sql/20261011030000:21`). No contract field, not served (`app-health.ts:112-115`), not in the prompt (`rt/context-composer/prompt.ts:169-188`). | Math only (`health-scores.test.ts`). `health-producer.test.ts` pins the written keys. | no flag | partial | Store, serve and prompt. Owner-confirmed sleep need. |
| HP-5 | Quiet flags (SpO2, breathing rate, wrist temperature) | SpO2 and respiratory rate are accepted and stored (`ct/app/health-ingest.ts:132-133`; `sql/20261011020000:59`). Unused by the producer (`producer.ts:16`). No wrist-temperature signal in the contract (`health-ingest.ts:140-143`) or the SQL. No deviation logic. | Contract parsing only (`ct/app/health-ingest.test.ts`) | no flag | partial (ingest only) | Wrist temperature end to end, a deviation-from-usual producer, store, route, prompt, and non-diagnostic copy. |
| HP-6 | Training (workouts against meetings; run vs desk heart rate) | Workout samples only exclude hours from Form stress (`form.ts:22`; `producer.ts:95`). The manual `log_workout` (`rt/channels/health-log.ts:114-132`, registered `DO:2043`) writes `waldo.health_logs` (`sql/20260927000000:23`), which the producer never reads. No workouts-against-meetings or run-vs-desk code. | `health-scores.test.ts`, `health-log.test.ts`; `pg/waldo_health_logs.sql` | no flag | partial | Both outputs missing. Manual logs never reach scores, and `health_log_add` and `health_log_recent` check no consent. |
| HP-7 | Weather and daylight | Daylight: `daylight_duration` is ingested (`health-ingest.ts:127`) and is a hidden Form input weighted 0.1 (`form.ts:6,56-58`). Weather: no `get_weather` in source. `origin/instinct/weather-daylight-tool` (#1043, now `2e2283cf`) is unmerged and does not touch the owner DO's tool list. | Daylight: `health-scores.test.ts`, `health-producer.test.ts`. Weather: none. | no weather var or binding | daylight partial; weather missing | Weather provider, coarse-location consent, registration. Daylight is never shown on its own. |
| HP-8 | Your history (7/30/90 days) | The scores query takes one optional `day` (`health-ingest.ts:191`) [verified]. The SQL returns a single row (`health_plane.sql:484-487`). The producer writes yesterday and today only (`producer.ts:137`). The series read is capped at 31 days (`sql/20261011020000:143`). `get_crs` with `range_days` is a RunLoopDO stub that always returns 'derived steady' (`rt/run-loop/do.ts:5925-5942`) and is not in the owner tool list. | `app-health.test.ts` (route table equals the contract); `health-producer.test.ts` (yesterday and today only) | no flag | missing | Range route, range read, past-day scores from backfill, app screen. |
| HP-9 | Bring your past (Apple Health import) | 90-day window (`health-ingest.ts:12`) [verified]. Readings over 90 days old are ignored (`sql/20261011020000:76`). Chained anchors and `anchor_conflict` (`:49-52`). At most 128 changes and 98,304 bytes per request (`health-ingest.ts:10-11`). Health has its own rate bucket (`app-api.ts:145`). | `pg/waldo_health_backfill.sql` (30 days, 3,000 readings in chained 128-reading requests); `pg/waldo_health_plane.sql` (stale anchor refused) | no flag | implemented+tested | Backfill yields scores for yesterday and today only. Days 31–90 are stored but nothing reads them. Background delivery is app-side. |

**Health cross-cutting rows:**

| ID | Item | Capability | Tests | Status | Gap |
|---|---|---|---|---|---|
| HP-x1 | Health consent (ruling 11) | Per-source, per-purpose grants (`health_plane.sql:6-39`). `model_processing` needs live storage (`:172-174`). Withdrawing model use deletes nothing (`:211-218`). Withdrawing storage withdraws both purposes and purges that source's samples plus all derived rows (`:219-233`). `health_purge` (`:349-371`) has no runtime caller. | `pg/waldo_health_plane.sql`, `waldo_health_context_fence.sql`, `waldo_health_series.sql`; `app-health.test.ts` | implemented+tested | Derived rows are not rebuilt after one source's withdrawal until the next ingest. |
| HP-x2 | Health in chat | `health_context_read` needs `health_basis_live(…, true)`, i.e. both grants (`health_plane.sql:541,548`) [verified], wired for Telegram, scheduled prompts (`DO:1644-1647,2079`) and app turns (`DO:2136-2137`). The prompt shows zone words, trend and freshness only: no numbers, version names or activation label (`context-composer/prompt.ts:169-188`). The Brief prompt does carry the health section (`test/health-reaches-reply.test.ts:91-96`) [verified]. | `health-context.test.ts`, `health-reaches-reply.test.ts`; `pg/waldo_health_plane.sql` | implemented+tested | The model can't tell candidate scores from accepted ones. The Form trend is effectively always `insufficient` (HP-2). On the owner's staging account `model_processing` is off [reported in the ledger], so chat sees no health while scores show. |
| HP-x3 | Retention | `scheduled` → `sweepHealthRetention` (`rt/index.ts:248-251`; `health/retention-sweep.ts:12-27`) → `sql/20261011220000:33-63`. Raw readings and receipts go after 90 days, derived rows after 733. | `health-retention-cron.test.ts`, `health-retention-sweep.test.ts`; `pg/waldo_health_retention*.sql` | implemented+tested | Cron on staging only (`wrangler.jsonc:76`). `waldo.health_logs` has no retention. |
| HP-x4 | Freshness on the app | The producer hardcodes `fresh` (`producer.ts:116`). GET scores without `day` returns the newest row however old it is (`health_plane.sql:484-487`). | — | partial | The app must age scores from `compiled_at`. |

### E2. Day to day (§4) and two "Coming later" moments

**Common to every card row [verified]:**
- **Arming and delivery** for an app-only owner are in section C. Delivery needs a first chat message and arming needs `timezone.set`, a console visit or a Google connect.
- **Telegram-linked owners** get every card on Telegram, even when bound to the app (`DO:1335-1348`).
- **No structured card part exists** in the contract (`ct/app/parts.ts:26-52`). The app gets plain text rows.
- **`day.cards[].latest`** is not produced (`dashboard-controls.ts:34-39`).
- **The card's "today" context** is `episodes.since(midnight)` (`DO:2562`), which excludes app chat.
- **Health** reaches the card's system prompt when both grants are live (`test/health-reaches-reply.test.ts:91-96`).

| ID | Promise | Backend capability (file:line) | Tests | Staging flag | Status | Gap |
|---|---|---|---|---|---|---|
| DD-1 | The Brief | `card:brief` at 08:00 (`rt/prompt/day-cards.ts:14`). Composed from calendar, ledger, today and updates (`rt/channels/day-cards.ts:167-199`; `DO:2558-2563`); sent at `DO:2567`. | `test/day-cards-do.test.ts`, `card-pins.test.ts`, `blocked-send-settlement-do.test.ts` (Telegram), `update-cards-do.test.ts` (quiet hold), `health-reaches-reply.test.ts` (responder) | none (`daily_brief` on by default) | implemented, untested (app path); implemented+tested on Telegram | App arming and delivery (C); `latest`; app chat missing from "today"; no push. |
| DD-2 | The Window | Vocabulary only (`rt/prompt/messaging-behavior.ts:26`). `propose_calendar_change` (`rt/tools/live/google.ts:299`) is generic and approval-gated. | none | — | missing | Form-driven block under a calendar grant. |
| DD-3 | Prep (35 min before) | 10-minute sweep, 40-minute lead (`rt/channels/event-briefs.ts:9-10`) [verified]. Primary calendar only (`event-briefs.ts:73`; `DO:2403`). Grounded path exits for any non-Telegram channel (`DO:2390,2420,2445,2451`) [verified :2420]. | `calendar-prep-owner-do.test.ts`, `calendar-prep-source.test.ts`, `calendar-prep-review-cancelled-history-proof.test.ts`, `event-briefs-do.test.ts` (all Telegram) | `CALENDAR_GROUNDED_PREP` `"1"` on staging (`wrangler.jsonc:84`), `"0"` in production (`:20`) | **partial** (implemented+tested on Telegram only; none for app-only owners on staging) | App path. "Open items from last time". The site says 35 min; the code fires about 30–40. No health on the grounded path (`owner-turn.ts:656-665`). |
| DD-4 | The Heads-Up | `card:midday` "Check-in" at 14:00, may return SKIP (`prompt/day-cards.ts:23-29`) | as DD-1 | none | partial (Telegram-tested check-in card) | Not pattern-driven. App gaps as DD-1. |
| DD-5 | The Close | `card:close` at 21:30 with tomorrow's calendar (`prompt/day-cards.ts:31-37`; `day-cards.ts:124-129`) | `day-cards-do.test.ts` | none | partial (Telegram-tested) | No "moved / protected" counts, because Waldo makes no moves of its own. App gaps as DD-1. |
| DD-6 | The Adjustment (weekly) | No weekly kind (`ct/tools/schemas/loops.ts:27`). The `adjustments` table has a schema (`rt/do-schema.ts:245+`) and no writer [verified]. | none | — | missing | Everything. |
| DD-7 | Your best hours | No source | none | — | missing | Everything. |
| DD-8 | The right task, at the right time | `get_tasks` (`tools/live/google.ts:263-297`). `propose_google_task_change` for create, edit, complete and reopen, with no delete (`tools/live/tasks.ts:12`) [verified]. App-approvable kind `google_task_change` (`ct/app/parts.ts:18`; `approvals.ts:77,105`). `write_task` and `update_task` have no handler (`hooks/tool-replay-class.ts:48`) [verified]. | `google-task-writes.test.ts`, `google-task-propose-dispatch.test.ts`, `approvals.test.ts`, `app-approvals.test.ts` | none | **partial** (reads and approved writes implemented+tested) | Right-time ordering; Form or energy input; delete; dead tool names. |
| DD-9 | Fewer pings | Fixed gates only:<br>• quiet hours (`loops.ts:96-102`);<br>• low volume (`heartbeat.ts:89-92`; `DO:1321,1329,2420,2505`).<br>`computeAdmission` is used only for grounded Prep in the owner DO (`DO:2450-2454`). `proactiveGate` has no caller (`proactive-gate.ts:16-25`). Reminders and standing orders are not quiet- or volume-gated (`DO:2186-2268`) [verified]. | `proactive-gate.test.ts`, `delivery-gate*.test.ts`, `heartbeat.test.ts`, `proactivity-heartbeat.test.ts` | none | partial | Interruption judgment (now / batch / silent); low volume doesn't hold cards. |
| DD-10 | Fixed first, mentioned after (the Patrol) | The heartbeat runs every 30 min and lists up to 3 past-due open loops, with no model call and no effect (`heartbeat.ts:8-10,24-39,97-126`) [verified :24,:122]. No standing-grant code. All 7 loop policies are `L0` (`ct/runtime/loop-policy.ts:127-205`) and nothing in `rt/` reads `autonomy_level` [verified]. | `heartbeat.test.ts`, `heartbeat-outbox.test.ts`, `heartbeat-owner-delivery.test.ts`, `proactivity-heartbeat.test.ts` (Telegram) | none | partial (list only) | Grants and autonomous fixes; app delivery untested; heartbeat unarmed for owners armed only by `timezone.set`. |
| DD-11 | Patterns (Spots to named pattern) | Constellation tables (`memory/claims.ts:378-400`). Nightly promotion (`DO:2331-2334` → `owner-turn.ts:684-693` → `claims.ts:1291-1337`). A node needs owner-origin observation or pattern claims from different dates (`claims.ts:1300-1302`) [verified]. Read-only app view `view=constellation` (`app-controls.ts:51-58`). | `claims.test.ts`, `nightly-source.test.ts`, `app-constellation.test.ts` (handler-direct) | none | **partial** (qualitative promotion implemented+tested) | Named patterns with numeric health deltas (§7 ruling). Nightly never sees app chat (D). No app memory controls. |
| DD-12 | The Slope | Labels only (`messaging-behavior.ts:27`; `console.ts:203-204`) | none | — | missing | Producer and every signal. |
| CL-2 | Your own routines | Reminders: once, daily, weekdays, weekly, cron (`rt/channels/reminders.ts:100-115`). Standing orders (`standing-orders.ts:43-75`). Fired at `DO:2186-2233` and `DO:2237-2268`. An app-only owner's reminders go to the app sink (`DO:2222`), and so do an app-bound Telegram owner's (`DO:1339-1347`). Standing orders reach the app for app-only owners only [inference]. Neither is held by quiet hours [verified]. | `reminders.test.ts`, `reminders-do.test.ts`, `standing-orders.test.ts`, `app-owner-scheduled-work.test.ts:111-218` (reminders only) | none | **partial** (reminders implemented+tested, including the app sink; standing orders on the app untested) | Routines UI; quiet hours don't apply; no staging app delivery shown; reminder push missing (no APNs). |
| CL-3 | Tomorrow, today | The Close's tomorrow window (`prompt/day-cards.ts:31,34`; `day-cards.ts:124-129`) | `day-cards-do.test.ts` | none | partial | Forecast and predicted readiness. |

### E3. Talk to Waldo (§4)

| ID | Promise | Backend capability (file:line) | Tests | Staging | Status | Gap |
|---|---|---|---|---|---|---|
| TW-1 | Threads | Tool schemas exist (`ct/tools/schemas/threading.ts:59,75,78,81,88`). Every one is `NO_HANDLER` (`hooks/tool-replay-class.ts:50-51`) [verified]. The C1 route contract (`ct/app/threads.ts:46-58`, 11 routes) is imported by no runtime code. Every `/app/v1/threads*` answers 404 after authentication (`app-api.ts:180`) [verified]. | `ct/app/threads.test.ts` (schema only). No runtime test. | rate limiter | missing (contract only) | Handlers, per-thread transcript, routes, app screen. |
| TW-2 | Follow up on anything ("Tell me more") | **Telegram:** `reply_to_message` becomes `replyTo` (`telegram-polling.ts:141-150`) [verified]. The quote is guarded as external (`owner-turn.ts:531-554`). **App:** send is strict `{client_message_id,text}` (`ct/app/core.ts:34-36`); any extra field fails `parseAppSend` and gets 403 (`app-api.ts:219-224`; `DO:740-741`). `anchor_entry_id` in `ct/runtime/reply-parts.ts:32` has no consumer. | `telegram-polling.test.ts`, `owner-do-ingress-isolation.test.ts` | Telegram secrets: unknowable | partial (Telegram only) | App anchor field and consumer; provenance on every kind. |
| TW-3 | Quick replies | Schema `ct/app/parts.ts:32-37`, in the message union (`core.ts:46`). No runtime producer (grep) [verified]. History emits `text` and live `approval` parts only (`app-api.ts:203`). | Contract tests only | — | missing (contract only) | Producer. |
| TW-4 | Charts in replies | Schema `ct/app/parts.ts:38-45`. No producer and no series data [verified]. | Contract tests only | — | missing (contract only) | Producer and series data. |
| TW-5 | Full history | GET `/app/v1/chat/main` (A #11): canonical `readForDisplay`, `before:<id>` cursor, 20 per page by default and 50 at most (`app-api.ts:191-206`) [verified]. | `app-api.test.ts`, `app-read-failure-code.test.ts`, `app-basic-serving.test.ts`, `app-owner-scheduled-work.test.ts` | rate limiter | partial (route implemented+tested) | App-surface rows only: Telegram and WhatsApp are absent (D). Sends are still strict (B). `created_at` is never emitted. |
| TW-6 | Thumbs up / down | **Telegram:** update cards carry `fb:<id>:u\|n` (`DO:2517`), handled at `DO:1497-1502` → `update-cards.ts:54-60`. Ratings shape only the next update card. **App sink:** the keyboard returns `undefined`, so the card throws (C). **App:** `PUT …/rating` answers 405 (`app-api.ts:167`) with no handler [verified]. | `loops.test.ts` (book level). The DO `fb:` callback is untested. | Needs Google (`DO:2487-2488`) | partial (Telegram only) | App ratings; ratings on the Brief and replies. Ratings are not in owner-DO SQLite (D14 plan). |

### E4. Your rules (§4)

| ID | Promise | Backend capability (file:line) | Tests | Staging | Status | Gap |
|---|---|---|---|---|---|---|
| YR-1 | Three levels, per area | `autonomyLevelSchema` (`ct/runtime/loop-policy.ts:73`). All 7 policies are `L0` (`:127-205`). No runtime consumer [verified]. | `ct/runtime/loop-policy.test.ts` | — | missing (enum only) | Everything beyond the enum (#915 I). |
| YR-2 | Always comes back to you | **Kinds:** six (`ct/app/parts.ts:18`) [verified]. **App:** list and decide (A #17-18; `app-approvals.ts:17-58`); digest-checked; idempotent receipts. **Review size:** app cards up to `APP_REVIEW_MAX_CHARS` (`approvals.ts:162`) [verified]; Telegram up to 3,800 (`approvals.ts:120`) [verified]. Over budget, Telegram offers only "Not now" (= skip `s:<id>`) plus an app link (`approvals.ts:110-113,288-295`) [verified]. **Console:** approves `calendar_change` only (`console.ts:265`) [verified]. **WhatsApp:** `a/s/e/u:<id>` text (`whatsapp-api.ts:132-135`) [verified]. **Defer:** in the contract, refused with 409 (`app-approvals.ts:45-46`) [verified]. **`secretKeys`** is never set (`approvals.ts:49,138`). | `approvals.test.ts`, `app-approvals.test.ts` (incl. `:101` "refuses Not now until the desk can defer") [verified], `app-approvals-do.test.ts`, `app-api.test.ts`, `console.test.ts`, `whatsapp-ingress.test.ts`, `telegram-approval.test.ts` | `browser_submit` cannot arise (no browser binding, `wrangler.jsonc:78`); `MCP_READ_INTENTS=0` | **partial** (routes implemented+tested; the golden path's "Not now" is refused) | "Not now" (defer) is refused. Telegram's "Not now" means skip. The console approves calendar changes only. No real decision from the app on staging [reported in the ledger]. |
| YR-3 | The activity log | `view=activity` projection (`dashboard-controls.ts:59-66`) served to the app (`app-controls.ts:44,65-69`) [verified]. Trace `summary` carries free-text hop notes (`harness.ts:82-83`). | `dashboard-controls.test.ts` (projection). No test fetches it through `/app/v1`. | rate limiter | partial | Structured reasons; "left alone"; app screen. |
| YR-4 | Say it once | `remember` with `replaces_id` (`tools/live/memory.ts:50-70`) [verified]. `forget_memory` by id clears saved wording only (`:88-136`). Redaction reaches canonical rows and witnesses (`conversation-store.ts:139-197`) [verified]. `update_memory` is `NO_HANDLER` (`tool-replay-class.ts:48`) [verified]. Console `spot.*` and `node.forget` (`dashboard-control-actions.ts:19`). App: read-only `constellation` (`app-controls.ts:51-58`). No memory actions in the app enum (`ct/app/controls.ts:26,41`) [verified]. | `live-memory.test.ts`, `memory-forget-do-provider.test.ts`, `app-constellation.test.ts` | — | partial (chat and console; app read-only) | App correct and forget (contract, host, screen); forget lineage across copies. |
| YR-5 | Your schedule (+ quiet hours) | App `day` view (`dashboard-controls.ts:33-39`). App actions are effectively `timezone.set` and `proactivity.set` (`app-controls.ts:83`; `dashboard-control-actions.ts:19`) [verified]. `schedule.*` and `card.*` are console and chat-tool only. One `daily_brief` switch covers three cards (`schedule-preferences.ts:17-23`). Quiet hours hold cards, Prep, update cards, heartbeat and outbox follow-ups, but not reminders or standing orders (`DO:2186-2268`) [verified]. | `app-basic-serving.test.ts` (`timezone.set`), `dashboard-controls.test.ts`, `schedule-preferences.test.ts`, `heartbeat-outbox.test.ts` | — | partial | Per-card and schedule switches in the app; quiet hours for reminders and standing orders; `timezone_confirmed` and `latest` unproduced. |
| YR-6 | Yours, always (export, delete) | **App delete:** `account.delete` (`app-controls.ts:76-81`) → `dashboard-owner-controls.ts:51-114`: typed `DELETE` (`:56`); files purged first, 503 `rejected` on failure (`:90-98`); `deleteOwner` (`:99-107`); `eraseOwnerStorage` = DO `deleteAll` (`:108-114`; `DO:652`) [verified]. `delete_owner` SQL (`sql/20261011230000_delete_owner_identity.sql:10-44`) removes Vault secrets, connections, sessions, health, invite email, Auth user and tokens; it deliberately leaves the Auth audit log and `workspace_owner_mappings` (`:7-9`). **Residue:** `RunLoopDO` (`run-loop/do.ts:344`) and `DeviceBridgeDO` storage are touched by no delete path [verified: no delete path references `RUN_LOOP_DO` or `DEVICE_BRIDGE_DO`]. **Export:** `export_artifact` only, one artifact at a time (`artifact-exports.ts:99-103`). | `app-account-delete.test.ts`, `owner-files-purge.test.ts`; `pg/waldo_delete_owner_identity.sql`, `waldo_delete_owner.sql`, `waldo_delete_then_rejoin.sql` | `ARTIFACTS` R2 (`wrangler.jsonc:95-97`) | **partial** (delete implemented+tested; export missing) | Data export; RunLoopDO and DeviceBridgeDO residue; the legacy console delete copy overclaims (`DO:1199-1204`). No deletion has run from the app on staging [reported in the ledger]. |

### E5. Coming later (§4), the rows not covered above

| ID | Promise | Backend capability (file:line) | Tests | Staging | Status | Gap |
|---|---|---|---|---|---|---|
| CL-1 | Voice | **Speech in:** Telegram voice and audio (`telegram-polling.ts:127-130`; `telegram-media.ts:52-75`); WhatsApp audio (`whatsapp-api.ts:99-107`); transcriber wired at `DO:2043`. **Speech out:** no TTS in `rt/`; `replyVoicePartV1Schema` (`ct/app/parts.ts:51-53`) has no producer [verified]. **App:** text only; the app download throws (`DO:1991-1992`) [verified]. | `telegram-media.test.ts`, `telegram-polling.test.ts`, `whatsapp-ingress.test.ts` | STT provider and key: unknowable | partial (speech in on Telegram and WhatsApp) | Speech out; app voice in. |
| CL-4 | Other agents ask Waldo | `ct/runtime/trusted-coordination.ts`, exported at `ct/index.ts:193` [verified], with no runtime consumer [verified] | `ct/runtime/trusted-coordination.test.ts` | — | missing (contract only) | Everything. |

### E6. Connectors (§5)

| ID | Connector | Backend capability (file:line) | Tests | Staging | Status | Gap |
|---|---|---|---|---|---|---|
| CN-1 | Google Calendar | `query_calendar` (`rt/tools/live/google.ts:144`). `propose_calendar_change` (`:299`). Writes are hard-wired to `calendars/primary` (`rt/connectors/google.ts:504,618`) [verified]. Approval-gated, with a 10-minute undo (`approvals.ts:31,330,618`) and readback (`approvals.ts:606,627`) [verified]. | `google.test.ts`, `connector-backed-handlers.test.ts`, `populated-google-reads.test.ts`, `calendar-coverage.test.ts`, `google-recovery-journey.test.ts`, `approvals.test.ts` | Google client secrets: unknowable | implemented+tested | Writes to other calendars; attendee emails; inviting attendees. |
| CN-2 | Gmail | `get_communication` (`google.ts:186`), `search_communication` (`:226`), `read_thread` (`:249`), `draft_email` (`:316`), `send_email` (`:346`) [verified]. Bodies are capped at 32,000 characters (`rt/connectors/google.ts:315,336`) [verified]. Approved send with Message-ID readback (`approvals.ts:521`; `connectors/google.ts:706-708`) [verified]. No archive, label or attachment tool. | `google.test.ts`, `google-context-pagination.test.ts`, `gmail-query-recovery.test.ts`, `mail-follow-up*.test.ts`, `approvals.test.ts` | `MAIL_SOURCE_FOLLOWUPS=1` on staging (`wrangler.jsonc:84`), but follow-ups are Telegram-only (C) | implemented+tested | Triage actions; attachments; multi-account fan-out. Mail follow-ups never reach the app. |
| CN-3 | Google Tasks | `get_tasks` (`google.ts:263-297`). `propose_google_task_change` for create, edit, complete and reopen, with no delete (`rt/tools/live/tasks.ts:12`) [verified]. Dead names `write_task` and `update_task` (`tool-replay-class.ts:48`). | `google-task-writes.test.ts`, `google-task-propose-dispatch.test.ts`, `approval-task-integration-review.test.ts` | — | implemented+tested | Delete; retire the dead names. |
| CN-4 | Google Drive | `read_drive` (`rt/tools/live/drive.ts:24`): read-only, text/plain and Google Docs only, at most 8,192 bytes (`drive.ts:44`; `rt/connectors/drive-rest.ts:114,119`) [verified]. Registered at `DO:2051`. | `read-drive.test.ts`, `drive-rest*.test.ts`, `drive-content.test.ts`, `owner-do-drive-read-gate.test.ts` | `DRIVE_READS` `"1"` on staging, `"0"` in production (`wrangler.jsonc:84,20`) [verified] | implemented+tested; flagged off in production | Writes; Sheets and Slides content; production switch. |
| CN-5 | Google connect from the app (G1) | `google.connect` on the `connections` view (`ct/app/controls.ts:26,34`; `app-controls.ts:83`) → `googleConnectReceipt(runtime.googleConnectUrl(value,'app'))` (`DO:655-656`). The ticket records `connect_channel` (`DO:1852,1858`) and begins on the app runtime (`DO:703-704`). The return page deep link is `waldo://oauth/complete` (`rt/channels/google-oauth.ts:12`) [verified]. The "Google is connected" notice goes through the Telegram runtime, where an app-only owner resolves to 0, so it is blocked (`DO:1253-1259`; `DO:200-208`) [verified]. Completion also arms every job as a side effect (C) [inference]. | `app-google-connect.test.ts:61,84,104` (issue for app, begin, state surface `app`, deep link on the page). No test drives the callback or finish for an app-issued ticket [verified-sub]. | Needs `GOOGLE_CLIENT_*`; `TELEGRAM_WEBHOOK_SECRET`, which signs the state (`DO:1721`), without which the callback answers 404 (`google-oauth.ts:73-74`); and `TELEGRAM_BOT_TOKEN`, without which `finishGoogle`'s `setup()` throws (`DO:1592`). All unknowable. | **partial** | Completion depends on Telegram secrets. The "connected" notice is lost for app-only owners. Live connect never run on staging [reported in the ledger]. Connect offered inside an app turn is dropped, and its link is minted for the `'telegram'` channel (G). |
| CN-6 | Apple Watch (HealthKit through the app) | Source `apple`, read API `healthkit` (`health-ingest.ts:15,63`; SQL checks source only). The full ingest → producer → scores path is HP-1. The console says "Not built yet" (`console.ts:235`). | `app-health*.test.ts`, `health-producer.test.ts`; `pg/waldo_health_*.sql` | no flag | implemented+tested | Device proof (app-side); console copy. |
| CN-7 | Galaxy Watch | Source `samsung`; `samsung_health` is checked by the contract only (`health-ingest.ts:63`). Generic ingest. | Consent cases only (`ct/app/health-ingest.test.ts`; `pg/waldo_health_plane.sql`). No Samsung ingest test. | no flag | implemented, untested | Android client; Samsung ingest test. |
| CN-8 | Health Connect | Source `health_connect` (`health-ingest.ts:63`) | `pg/waldo_health_plane.sql` (a Health Connect ingest is accepted); `health-producer.test.ts` | no flag | implemented+tested | Android client. |
| CN-9 | Codex, Claude Code, Cursor, OpenCode, Pi via Kennel | `DeterministicFakeExecutionEnvironment` only (`rt/run-loop/work-unit-execution.ts:21-23`) [verified]. Device bridge routes `/devices/redeem` and `/devices/connect` (`rt/index.ts:171-172`), with `DEVICE_BRIDGE_DO` bound (`wrangler.jsonc:28,92`), but only console actions reach a device. No Kennel client (grep) [verified]. | `execution-environment-*.test.ts` (fake); `devices-*.test.ts` (bridge) | DO bound | missing (fake executor) | Backend → Kennel handoff into the same owner conversation. |
| CN-10 | Weather, Location | No `get_weather` in this tree [verified]. #1043 is unmerged. | none | — | missing | Provider, coarse-location consent, registration. |
| CN-11 | Telegram (development surface) | Webhook (`rt/index.ts:176-178`); default runtime (`DO:1576`); writes the legacy kv transcript (D) [verified] | many `telegram-*.test.ts` | `WALDO_OWNER_TELEGRAM_ID` set on staging (`wrangler.jsonc:84`); bot token: unknowable | implemented+tested | Shares no transcript with the app (D). |
| CX-1 | Oura, WHOOP, Garmin, Fitbit | `healthSourceSchema` lists oura, whoop and garmin (`ct/adapters/health.ts:12-19`). Live ingest accepts only apple, samsung and health_connect (`ct/app/health-ingest.ts:15`). Fitbit appears nowhere. No vendor client. [verified-sub] | — | — | missing (enums only) | Provider adapters; partner approvals. |
| CX-2 | Outlook, Microsoft To Do, Slack, Todoist, Linear, Notion | Enums only: `outlook_graph` (`ct/adapters/email.ts:5`), `notion` (`ct/adapters/doc.ts:9`), the `slack` channel name (`ct/adapters/channel.ts:13`). Nothing for To Do, Todoist or Linear. [verified-sub] | — | — | missing | Owner scope first. |
| CX-3 | WhatsApp | Webhook routed (`rt/index.ts:179-181`) → `whatsappTurn` (`DO:777-789`) via `whatsappTelegramShim` (`DO:1650-1651`). Approvals by `a/s/e/u:<id>` text (`whatsapp-api.ts:132-135`). Speech and image in (`whatsapp-api.ts:99-121`). `surfaces/whatsapp.ts` is imported only by its test. `setup('whatsapp')` throws without its secrets (`DO:1591`). It writes the legacy kv transcript, and `speakerOf` classifies its owner text as `system` (D) [verified]. | `whatsapp-*.test.ts` (10 files). Redemption is tested only against a fixture directory. `pg/waldo_whatsapp.sql:9` inserts a WhatsApp code directly. | WhatsApp secrets: unknowable | partial (ingress and shim implemented+tested; adapter unwired) | **Linking cannot complete.** The only link-code issuer `waldo.issue_link_code` hard-codes provider `'telegram'` (`sql/20260924130000_waldo_console_auth.sql:47`) [verified]. Redemption requires a provider match (`sql/20260924120000_waldo_owners.sql:85`) [verified]. The WhatsApp migration only widens the CHECKs (`sql/20260925110000:3-6`) [verified]. Also needs the canonical transcript, the `speakerOf` fix, and Ashish's adapter (ruling 8). |
| CX-4 | iMessage | `rt/channels/imessage/*` (4 files) has no importer in `rt/` [verified]. Tested in isolation (`imessage-admission.test.ts`, `imessage-ingress.test.ts`). #1017 is a draft. | module tests only | — | **partial** (modules tested in isolation; unreachable at runtime) | Routing, a presence migration (the presences CHECK has no `imessage`), live relay, canonical transcript. |
| CX-5 | GitHub | Inbound push and PR events (`rt/index.ts:182-184`; `rt/channels/event-ingress.ts:33,77,110`), gated by `WALDO_EVENT_SOURCES`, which is set in no wrangler `vars` block [verified] | `event-ingress.test.ts`, `event-owner-egress.test.ts`, `event-admission.test.ts` | Value unknowable from source. When absent, every `/events/*` answers 404. | implemented+tested (inbound only) | Notices go through `this.setup()`, the Telegram runtime (`DO:913,919`) [verified], so an app-only owner gets nothing. No outbound actions. |
| CX-6 | Spotify | None (the only mention is a negative test fixture, `ct/tools/handler.test.ts:74`) [verified] | — | — | missing | Needs a stated job (D8). |
| CX-7 | Strava…Granola via a generic MCP | One deploy-wide server list `WALDO_MCP_SERVERS` (`DO:1957,2076`). `read_mcp_tool` intents are off on staging (`MCP_READ_INTENTS=0`, `wrangler.jsonc:84`). `call_mcp_tool` is approval-gated (`DO:2076`). | `mcp*.test.ts`, `read-mcp-tool.test.ts`, `owner-do-mcp-read-gate.test.ts` | Server list: unknowable | partial | Per-owner MCP with third-party OAuth. |

### E7. Ledger §6a promises with no §4 row

| ID | Promise | Backend capability | Status | Gap |
|---|---|---|---|---|
| UC-1 | The Fetch as its own moment and switch | No fetch key in `schedules` (`ct/app/controls.ts:55`; `ct/tools/schemas/loops.ts:27`). Cards are brief, midday and close only (`prompt/day-cards.ts:14,23,31`). | missing | Card, switch, contract key. |
| UC-2 | A brief that changes through the day; outbox held until you send | Three fixed cards. Update cards are Telegram-only (C). Held sends exist only as approval-desk proposals. `latest` is unproduced. | missing | Evolving brief; held-outbox view. |
| UC-3 | Answers show what he read and where each fact came from | Effect receipts on owner replies (`hooks/receipt-line.ts:12-25`; `owner-turn.ts:593-594`) list effects, not sources. The memory `source_ref` is withheld from the app (`ct/app/controls.ts:89`). | partial | Per-fact source part (G6). |
| UC-4 | Text a third party on WhatsApp; watch-battery reminder | `send_message` has only `channel` and `content` (`ct/tools/schemas/writes.ts:39-43`) [verified]: it reaches the owner's own channel, never a third party. No battery signal. | missing | Third-party addressing (Ashish/D7); battery data has no source. |
| UC-5 | Photos, voice notes, clips, screenshots, recordings and slides as inputs | Telegram: photo, document (pdf, txt, doc/docx, ppt/pptx), voice, audio (`telegram-polling.ts:10,120-130`; `telegram-media.ts:8-12,33-66`). WhatsApp: image and audio. No video, clip or screen-recording type. App: text only. | partial (Telegram and WhatsApp) | App attachments (ADR first, per APP_CHAT_PLAN C3); video. |
| UC-6 | Terminal, Apple Watch, Figma and Slack as places to talk | Talk surfaces are app, Telegram, WhatsApp and console. `DeviceBridgeDO` does only `machine_state_query` and `notify_local` (`rt/devices/contract.ts:2`). | missing | Kennel and Watch surfaces; Figma and Slack are not connectors. |
| UC-7 | Per-account mail rules | none | missing | Conflicts with ruling 5. |
| UC-8 | Routines by profession | No presets; generic standing orders only (`DO:2237`) | missing | Presets (owner scope call). |
| UC-9 | Autonomy that grows week by week | As YR-1 | missing | Level consumer and progression. |
| UC-10 | Works toward an outcome and comes back when done | `open_loop` and `close_loop` (`loops.ts:139-158`; `DO:2076`). The heartbeat lists past-due loops (DD-10). `responsibilityHandlers` are never registered (only `test/responsibilities.test.ts`). | partial | Autonomous follow-through; completion report; app delivery untested. |
| UC-11 | An honest record across days, months and years | No range route (HP-8) | missing | History range (G16) and retention limits. |
| UC-12 | Read-only shown per tool; disconnecting removes what he learned | Connections view shows calendar, mail and tasks booleans (`ct/app/controls.ts:63`), with no read-only toggles. `google.disconnect` is console-only (`console.ts:106`); it revokes and drops the account (`DO:1822-1830`) with no memory purge. | missing | Per-tool scope switch; lineage purge on disconnect. |
| UC-13 | Spots from caffeine, meals, screen time and tool switches | Manual `log_meal` only (`health-log.ts:95`). No caffeine or screen-time input. | missing | Inputs do not exist. |
| UC-14 | Weather moving an event; mail batched for 11:30; "breaks big tasks down" | No `get_weather` in this tree. No mail batching. Task breakdown is model behaviour through the approval-gated task tool [inference]. | missing | #1043 registration; mail batching conflicts with ruling 5. |
| UC-15 | A speak button on every reply | No TTS; the voice part has no producer | missing | App-side on-device speech (L4) or backend TTS. |

### E8. Ledger §6c "ten most prominent weak promises", mapped to the rows above

| Home-page line (ledger §6c) | Maps to | Backend state |
|---|---|---|
| "nothing hidden" | YR-3 activity log, UC-3 provenance | partial: no structured reasons or sources |
| "Waldo reads all of it" | CN-2 Gmail | Reads subjects, snippets and bodies up to 32,000 characters (`connectors/google.ts:315,336`). No attachments. |
| "tells a rough day from an easy one" | HP-1, HP-2, HP-3 | Recovery and Form are candidates; Weight is always unavailable |
| "One brief that follows your day" | UC-2, DD-1 | missing (three fixed cards; no evolving brief) |
| "where each fact came from" | UC-3 | partial (effect receipts only) |
| "At 6:30 you get one notification" | push gap (F gap 4) | missing: no register route, no APNs sender, no wake-time release rule |
| "Months in, Waldo gets to know you" | DD-11, YR-4, D | partial: claims and constellations exist, but nightly never sees app chat |
| "Apple Watch, Oura, WHOOP, Garmin and Fitbit all work" | CN-6, CX-1 | Apple implemented+tested (backend only); the others missing |
| "Done before you're up" | DD-10, YR-1 | missing autonomy: the Patrol is a list; no grants |
| (the ledger heading says ten; it lists nine lines) | — | — |

---

## F. Counts and the biggest gaps

### Counts by status (70 rows)

**Classification rule.** Each row is classed by the backend capability for the app-first promise.
- `implemented+tested`: the whole capability exists and tests exercise it.
- `partial`: some of it exists, or it exists only on Telegram or WhatsApp, or the code exists but cannot be reached at runtime.
- `missing`: nothing exists beyond a contract or enum.

| Section | implemented+tested | implemented, untested | partial | flagged off on staging | missing |
|---|---|---|---|---|---|
| §4 promises (37) | 3 (HP-1, HP-2, HP-9) | 1 (DD-1, app path) | 23 | 0 | 10 (HP-8, DD-2, DD-6, DD-7, DD-12, TW-1, TW-3, TW-4, YR-1, CL-4) |
| §5 connectors (18) | 8 (CN-1–4, CN-6, CN-8, CN-11, CX-5) | 1 (CN-7) | 4 (CN-5, CX-3, CX-4, CX-7) | 0 | 5 (CN-9, CN-10, CX-1, CX-2, CX-6) |
| §6a extras (15) | 0 | 0 | 3 (UC-3, UC-5, UC-10) | 0 | 12 |
| **Total** | **11** | **2** | **30** | **0** | **27** |

**Flags.**
- No promise row is wholly flagged off on staging.
- Partly off on staging: MCP read intents (`MCP_READ_INTENTS=0`) and the Browser Rendering binding (absent).
- On staging but off in production: Drive reads and grounded Prep.
- On staging, grounded Prep's flag removes Prep, update cards and mail follow-ups for app-only owners (C).

### The 10 biggest gaps against the promises

Ranked by how much of the app-first promise set each one blocks.

1. **Main chat fails for any owner whose canonical history holds one shape-invalid row (TW-5 and every Talk row).**
   - Sends and scheduled app deliveries still use the strict `load()` (B). The send gets 202, then `interrupted` with `effects_unconfirmed`, and nothing is stored.
   - The owner's staging account has such a row: one witnessed `input_origin` leaf. L1's staging send reproduced the failure exactly (B) [reported].
   - On a clean account the send path is tested and passes (`app-basic-serving`, `app-owner-scheduled-work`).
   - L2's fix must also handle `conversation parent not found`.
2. **No proactive moment reliably reaches an app-only owner** (DD-1, DD-4, DD-5, DD-10, CL-2 standing orders, DD-3).
   - Nothing arms at sign-in.
   - `timezone.set` arms only nightly.
   - Prep, update cards and mail follow-ups are Telegram-only on staging.
   - Held cards need the heartbeat to be released.
   - #1066 (head `e1ab2881`, now containing `4bb040f5`) fixes arming in a confirmed zone.
   - **The `appBound` gate.** Delivery also needs `app_subject`, which is written only by the first chat message. This contradicts D12's "arm at first app use". It does not block a tester who chats before expecting a Brief. #1066 does not change it, and its test writes `app_subject` by hand.
3. **Two transcripts, no continuity** (ruling 21; TW-5, DD-11, the D15 "sessions share memory" decision).
   - App and Telegram/WhatsApp write different stores.
   - Episodes and nightly consolidation never see app chat.
   - `speakerOf` drops app and WhatsApp owner text.
   - Scheduled cards are composed without app chat.
4. **No push at all** (CL-2 reminders that may push, the §6c "6:30 notification", the ledger's Brief row).
   - No device register route (404), no APNs sender.
   - The `apns` channel in the delivery gate has no transport.
5. **The approval round trip in the app is incomplete** (YR-2).
   - "Not now" (`defer`) is refused with 409.
   - Telegram's "Not now" means skip.
   - The console approves calendar changes only.
   - The golden path's "Not now" step fails today.
6. **Talk-surface affordances exist only as contracts** (TW-1, TW-3, TW-4, TW-6, and `cancel`).
   - Threads, cancel and devices answer 404, and rating answers 405.
   - No quick-reply, chart, file or voice producer.
   - `day.cards[].latest` is unproduced.
7. **Health scores are thin** (HP-2–HP-8).
   - Weight is always unavailable.
   - Form goes stale and yesterday's Form is wiped.
   - Sleep debt is computed and dropped.
   - No quiet flags, no Training output, no history range.
   - Scores are candidates only.
   - Chat health needs `model_processing`, which is off on the owner's staging account.
8. **The autonomy layer is absent** (YR-1, DD-10, UC-9, UC-10).
   - The levels enum has no consumer.
   - The Patrol is a list.
   - There are no standing grants.
   - Responsibilities are unregistered.
9. **Rights are partial** (YR-6, UC-12).
   - No data export.
   - RunLoopDO and DeviceBridgeDO residue after deletion.
   - Google disconnect keeps what was learned.
   - The app cannot correct or forget memory (YR-4).
10. **Connector depth and surfaces** (CN-1, CN-2, CN-5, CN-9, CN-10, CX-3).
    - Calendar writes go to the primary calendar only.
    - No Gmail triage or attachments.
    - The "connected" notice is lost for app-only owners, and a connect offer made inside an app turn is dropped.
    - Kennel is a fake executor.
    - Weather is unregistered.
    - The WhatsApp adapter is unwired, and its transcript is legacy.
    - **WhatsApp linking cannot complete:** the only code issuer hard-codes `'telegram'`.

**Also blocking the golden path, though not a single promise row:** the app session ends 12 h after sign-in, with no refresh route (`app-api.ts:81`).

---

## G. Ledger §2 "Telegram-first defects", re-anchored at 4bb040f5 [verified unless tagged]

| Defect (ledger wording) | State at 4bb040f5 |
|---|---|
| The owner runtime defaults to Telegram | Still: `setup(channel: ChannelKind = 'telegram')` (`DO:1576`). The alarm runs an admitted app-only owner on `'app'` (`DO:1274-1282`). Reminders go to the app for app-bound Telegram owners (`DO:1335-1348`). The "Google is connected" notice still goes through `this.setup()`, i.e. Telegram (`DO:1253-1259`). The final outbox is still keyed by `chat_id` (`telegram-final-outbox.ts:195,222`). |
| App-only owners' jobs are never armed on sign-in | Still (`DO:2027`). #1066 is open. See C. |
| Arming at sign-in has no zone to arm in | Still. The zone falls back to `WALDO_OWNER_TIMEZONE` (set in neither wrangler `vars` block), then `'UTC'` (`DO:1630,1637`). |
| Console "sign out everywhere" leaves the app signed in | **Fixed in source** (#1060): `signOutEverywhere` calls the directory `auth.signOutAll(name)` before the local sign-out (`DO:944-945`). Not exercised on staging [reported in the ledger]. |
| The app session ends 12 h after sign-in, with no refresh | Still (`app-api.ts:81-82`). No refresh route (see A). |
| "Connect Google" during an app turn is accepted and dropped | Still:<br>• `deliverConnectLink` sends a URL button (`DO:1675-1686`).<br>• `appCaller` drops only `callback_data` keyboards, and during a turn `scheduledAppDelivery` is null, so it answers `{message_id:1}` (`surfaces/app.ts:17-24`).<br>• The offer is logged as sent.<br>**New:** for `reauth_needed`, the dropped offer also writes `google:reauth-noticed` (`DO:1708-1711`). That dedupe suppresses every later reconnect offer for the episode (`DO:1698-1704`) [verified code; impact inference].<br>**New:** the offered link is minted with the default channel `'telegram'` (`DO:1705,1716`; default at `DO:1839`) [verified]. So even a delivered link would return the owner to Telegram, not the app. |
| App chat is not in the episodes index | Still (`DO:2042` vs `DO:2140`). Worse than stated: see D, item 5 (`speakerOf`). |
| Owner-typed health numbers persist in the canonical transcript | Still. The canonical scrub is `redactSecretUrls` only (`canonical-owner-store.ts:18-21`). |
| Main-chat history returned 503 | Cause `history_invalid` [reported by L1]. #1074 fixes the GET only. Sends and scheduled app deliveries still fail (see B). |
| Calendar Prep exits on any non-Telegram channel | Still (`DO:2390`, `DO:2420`). #1066 keeps `event_briefs` unarmed and held on the app by design. |
| The app sink carries text only | Still (`surfaces/app.ts:17-24`). Approvals reach the app by their own route (A #17-18). |
| App send is text only | Still: `client_message_id` and `text` (`ct/app/core.ts:34-36`). The app runtime's download throws `app chat has no attachments` (`DO:1991-1992`). No anchor or parent. |
| Skills load on Telegram only | Still: the skill host is built only for `channel === 'telegram'` (`DO:2080`). |
| No APNs sender | Still: no register route (devices routes answer 404, see A) and no sender. The only push call is `app_push_revoke_session` at signout (`app-api.ts:161`). `delivery-gate/gate.ts:98-176` models an `apns` channel with no transport. |
| WhatsApp adapter unwired | Still: `channels/surfaces/whatsapp.ts` is imported only by `test/whatsapp-surface.test.ts`. The webhook is routed (`rt/index.ts:179-181`) into `whatsappTurn` (`DO:777-789`) through `whatsappTelegramShim` (`DO:1650-1651`). `setup('whatsapp')` throws without its secrets (`DO:1591`).<br>**New:** WhatsApp linking cannot complete. The only link-code issuer inserts provider `'telegram'` (`sql/20260924130000_waldo_console_auth.sql:47`), and redemption matches on provider (`sql/20260924120000_waldo_owners.sql:85`) [verified]. |
| iMessage | `rt/channels/imessage/*` (4 files) has no importer in `rt/`. |

---

## H. Staging Worker configuration (`packages/runtime/wrangler.jsonc`) [verified]

**Entry.** `env.staging.main` is `src/staging-browser.ts` (`:74`). It first registers the Cloudflare Playwright SDK for the staging browser paths (`rt/staging-browser.ts:1-8`), then re-exports `./index` (`:9-10`) [verified]. So staging serves the same routes as `index.ts`. Its browser paths stay closed because no browser binding is bound.

**Flag polarity** [verified]:
- `proactiveEnabled` is `flag !== '0'` (`rt/channels/proactive-gate.ts:14`). So `CALENDAR_GROUNDED_PREP` and `MAIL_SOURCE_FOLLOWUPS` are ON when unset, as in the `previews` block (`:49`).
- `WALDO_TOOL_OFFLOAD` is ON unless `'0'`.
- `DRIVE_READS` and `MCP_READ_INTENTS` are on only at exactly `'1'`.

**Deploy path.** `.github/workflows/deploy-staging.yml` is marked "DRAFT - NOT ENABLED" (`:3`) [verified]. Staging deploys run from the Mac lane (L1).

| Setting | Production (top level) | `env.staging` | Read by, and what it gates |
|---|---|---|---|
| `CALENDAR_GROUNDED_PREP` | `"0"` (`:20`) | `"1"` (`:84`) | Prep and Calendar Prep delivery gate (`DO:1329`, `proactiveEnabled`) |
| `MAIL_SOURCE_FOLLOWUPS` | `"0"` (`:20`) | `"1"` (`:84`) | Mail follow-up delivery (`DO:1329`) |
| `DRIVE_READS` | `"0"` (`:20`) | `"1"` (`:84`) | `read_drive` registration (`DO:2051`) |
| `MCP_READ_INTENTS` | `"0"` (`:20`) | `"0"` (`:84`) | `read_mcp_tool` intents (`DO:2076`) |
| `LANGFUSE_CAPTURE_TEXT` | `"false"` (`:20`) | `"true"` (`:84`) | Trace text capture (`resolveCaptureText`, `DO:1598,1602`) |
| `WALDO_EGRESS_ALLOWLIST` | `""` (fail-closed) | `"*"` | Browse-tool egress (`DO:2078`) |
| `WALDO_OWNER_TELEGRAM_ID` | `""` | `"5458446350"` | Single-owner console/probe fallback (`rt/index.ts:128-129,198`) |
| Cron | none | `"17 3 * * *"` (`:76`) | `scheduled` → `sweepHealthRetention` (`rt/index.ts:249-251`) |
| Browser Rendering | none | **absent on purpose** (`:78`) | Browser reads stay off until S0 passes |
| R2 `ARTIFACTS` | `:36-38` | `:95-97` | Artifact bodies, PDF export (`DO:1975-1980`), owner file purge on delete |
| Rate limiter `RESPONSIBILITY_RATE_LIMITER` | `:39-45` | `:98-104` | Every app route (`app-api.ts:62-73,142-149`) |
| DO bindings (5 classes) | `:22-30` | `:86-94` | `TELEGRAM_OWNER_DO` is required for every app route (`app-api.ts:105-106`) |
| `ai` (`AI`) and `vectorize` (`VECTORIZE`, `waldo-recall`) | none | `:112-115` | Staging only |

**Not set in either `vars` block:**
- `WALDO_EVENT_SOURCES`
- `RESPONSIBILITY_PUBLIC_API_ENABLED`
- `WALDO_TOOL_OFFLOAD`: offload is on unless `'0'`, per `DO:2076`
- `WALDO_OWNER_TIMEZONE`: the zone falls back to `'UTC'` (`DO:1630`)
- `WALDO_MCP_SERVERS`

The deploy wrapper passes only `--var "WALDO_RELEASE:${sha}"` (`scripts/deploy-runtime.sh:17`) [verified]. So any of these present on staging is a Worker secret set outside source. Their staging values, and the presence of the Telegram, WhatsApp, Google, OpenAI, speech-to-text, Browserbase, Brave and Supabase secrets, cannot be known from source.

---

## I. Ledger claims that are wrong or stale at 4bb040f5

The ledger's citations were read at `81c4f892`; DO lines have since moved by +2 to +35, depending on the region. The substantive corrections:

1. **§4 Full history: "machine prompts render as the owner's bubbles"** — refuted for app-channel scheduled work.
   - Machine prompts go to the legacy kv store.
   - The canonical page shows only the delivered assistant row (`test/app-owner-scheduled-work.test.ts:209`) [verified].
   - The real gap is the reverse: Telegram and WhatsApp rows never appear in the app (D).
2. **§4 The Brief: "health is not in the card prompt"** — imprecise.
   - The card body has none.
   - The scheduled prompt's composer adds the health section when both grants are live (`test/health-reaches-reply.test.ts:91-96`) [verified].
3. **"Cards arm only through `timezone.set` → nightly, a console visit or the chat tool"** — incomplete.
   - Google consent completion also builds the Telegram runtime, which arms everything [inference].
   - `timezone.set` arms nightly only, so heartbeat and Prep stay unarmed.
   - Delivery additionally needs `app_subject`, the first chat message (C) [verified].
4. **§4 Patterns: "the app view is not yet a contract"** — stale. `view=constellation` is in the contract, served and tested (`ct/app/controls.ts:8`; `app-controls.ts:51-58`; `test/app-constellation.test.ts`).
5. **§4 Threads: "no app route or view"; §13: "routes answer 404"** — partly stale.
   - A route contract exists (`ct/app/threads.ts:46-58`).
   - Threads and devices answer 404, `cancel` 404 (from the DO), and `rating` **405** (`app-api.ts:167`) (A).
6. **§4 Always comes back: approvals** — two updates.
   - `defer` is now in the contract but refused at runtime (`app-approvals.ts:45-46`).
   - WhatsApp `a:<id>` handling lives in `whatsapp-api.ts:132-135`, not `DO:748-749`.
7. **§4 Your schedule: "app actions are `timezone.set` and `proactivity.set` only (:14)"** — the contract enum now has five (`ct/app/controls.ts:26`); the effective set is still two (`app-controls.ts:83`).
8. **§2 Console "sign out everywhere" leaves the app signed in** — fixed in source by #1060 (`DO:944-945`).
9. **§6a Photos and voice: "speech in only"** — understated. Telegram also ingests photos and documents, including pdf, docx and pptx (`telegram-media.ts:8-12,33-66`), and WhatsApp ingests images.
10. **Account deletion residue** — the ledger names only `RunLoopDO`. `DeviceBridgeDO` storage is also untouched by both delete paths [verified: `DEVICE_BRIDGE_DO` is referenced only by `rt/devices/*` and the console device actions at `DO:993,999`].
11. **§8: "the deploy command also passes `--var LANGFUSE_CAPTURE_TEXT:true`"** — false at this checkout.
    - `scripts/deploy-runtime.sh:17` passes only `WALDO_RELEASE`. Staging capture comes from `wrangler.jsonc:84`, not `:82`, which is `"traces"` [verified].
    - The command quoted in the ledger appears only in `docs/ops/OBSERVABILITY.md:77` [verified-sub].
12. **§5 Later, WhatsApp: "no link-code issuer"** — sharper than stated. An issuer exists (`waldo.issue_link_code`), but it hard-codes `'telegram'`, so no `'whatsapp'` code can be issued, and redemption requires a provider match [verified] (CX-3).
13. **§5 Later, iMessage: "its migration must renumber above `20261011220000`"** — now above `20261011230000`, the newest migration file (`ls supabase/migrations`) [verified].
14. **Health rows** (corrections from the health sweep):
    - The Recovery trigger is `app-health.ts:124-132,152`, not `producer.ts:109-110`.
    - Form stress is `form.ts:62-69`.
    - The chat-health consent lines are `health_plane.sql:541,548`, not `:514`.
    - `samsung_health` is checked by the contract only, not by SQL.

## J. Lane claims checked

- **L2 (overnight log, 21:40Z): "#1074 fixes only the main-chat GET; `restored()` (`owner-turn.ts:622`) and `appDeliveryFor` still use the strict `load()`"** — **confirmed** (B). Its `DO:766` log citation is `DO:763` at `4bb040f5`.
- **L2: "second trap, `ConversationTree.append` throws `conversation parent not found` (`conversation-entry.ts:98`)"** — **confirmed** (`ct/runtime/conversation-entry.ts:98`).
- **L2 handoff §3: "`save()` re-validates the previous leaf's entry"** — true of the code (`canonical-owner-store.ts:102-103`), but **never triggered at 4bb040f5**, because every caller includes the leaf in the saved batch:
  - `persistOwnerInput`: `owner-turn.ts:581`, `canonical-owner-store.ts:132`;
  - the reply save: `owner-turn.ts:597`;
  - `appDeliveryFor`: `DO:592-593`.

  So the send failure is `load()`, not `save()`.
- **L2 handoff: "#1066 merges cleanly onto `c3b17f6a`"** — superseded. The head `e1ab2881` now merges in `4bb040f5`. The orchestrator log reports a one-line conflict with #1075 [reported].
- **L3 handoff: "a runtime guard refuses `defer` until L2's desk branch exists"** — **confirmed** (`app-approvals.ts:45-46`; test `app-approvals.test.ts:101`).
- **Handoff README: "App turns write the canonical store, and Telegram writes the legacy `conv:*` rows; the episodes index and nightly can't see app chat"** — **confirmed and widened** (D, items 3 and 5).
