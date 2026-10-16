# 06: What the Waldo app on `main` actually does, step by step along the golden path

Research agent report for the overnight orchestrator, 12 Oct 2026. Read-only.

**Basis**
- App: `waldoco/waldo-app` `origin/main` = `c2ccd5d0e98dcda6218d0cf25c538ab069fb4e28` (#77, approvals/parts re-pinned from backend `21a70277`). Fetched, then read through `git archive origin/main` into the scratchpad. Nothing was checked out, built or run in the app repo.
- Backend: worktree `35b7c21b` = `beta-mvp` `4bb040f5` plus one docs commit.
- Staging: `/healthz` answered `{"ok":true,"release":"4bb040f5"}` at 21:54Z on 11 Oct [verified, C4].

**Tags**
- **[verified]**: I read the code at those SHAs. It does not mean the code runs.
- **[inference]**: a conclusion I did not observe.
- Lane claims from the handoffs are leads, not proof.

**Owner of each gap:** **app** (L4), **backend** (L1/L2/L3), or **both**.

---

## 0. Golden path at a glance

| Step | App surface | Backend route (app.v1) | Status | Gap owner |
|---|---|---|---|---|
| Sign-in: email + invite | `app/(auth)/agent-sign-in.tsx` | `POST /app/v1/auth/code`, `POST /app/v1/auth/verify` | wired | none for the email path |
| Sign-in: Google | none | none (no route in `app-api.ts`) | **missing** | both (backend first) |
| Sign-in: 18+ checkbox | none at sign-up; it is a switch on Health agreements | `appVerifyRequestV1Schema` is strict `{email, code, invite?}`, so it has no field for this | **missing** | both (contract decision first) |
| Google connect | `/(app)/connectors`, `ConnectionsList` | `GET /app/v1/controls?view=connections`, `POST /app/v1/actions` `google.connect` → `/c/<ticket>` | wired; staging end-to-end unverified | owner: Google consent screen |
| Health consent | `/(app)/health-consent`, reachable only from Settings | `GET/POST /app/v1/health/consents`, `POST …/consents/withdraw` | wired | app (discoverability) |
| Apple Health ingest | `useHealthIngest` in the `(app)` layout | `POST /app/v1/health/ingest` | wired, foreground only; **fails silently without the iOS permission** (C1) | app |
| Three scores | Home Body card, `/(app)/health` | `GET /app/v1/health/scores` | wired | Weight copy says "not calculated yet" |
| Main chat history | `ChatPane` / `useChat` | `GET /app/v1/chat/main?limit=50[&cursor]` | wired; the backend read fix #1074 is on `beta-mvp` | backend (send path); app (failure UX) |
| Main chat send | `ChatPane` composer | `POST /app/v1/chat/main/messages` (202), `GET …/messages/{client_message_id}` | wired | backend (bad-row accounts still fail on send, per L2) |
| Approve / "Don't do this" | chat `ApprovalCard`, `/(app)/approvals` | `GET /app/v1/approvals`, `POST /app/v1/approvals/decisions` | wired | none known on the app side |
| "Not now" (`defer`) | label ready since #77 | the backend desk refuses `defer` (`app-approvals.ts:46`) | **blocked** | backend (L3) |
| Reminder fires, in app | a Main chat row only, on open, refresh or foreground | history read only | partial: no live refresh or unread signal | app (visibility) + backend (#1066) |
| Reminder push (S7) | nothing | contract `devices.ts` only, no route | **missing** | both |
| Time zone at sign-in | none; Settings has a manual row, shown only when the zones differ | `POST /app/v1/actions` `timezone.set`; `timezone_confirmed` producer exists only on unmerged #1066 (head `e1ab2881`) | **missing**; plus a stuck-unconfirmed edge case (C3) | both (#1066, then app) |
| Account deletion | `/(app)/account`, `AccountPanel` | `GET /app/v1/controls?view=account`, `POST /app/v1/actions` `account.delete` | wired; end-to-end unverified | owner (throwaway test) |
| Proactive messages in app | Main chat rows; Home lists day cards (name, time, sent) | history; `controls?view=day` | partial | app (no `latest`, no live refresh) + backend (#1066 arming) |
| Telegram continuity | rows carry a channel label; Connections shows Telegram linked or not | canonical history is wired for the `app` channel only | **missing** | backend (L2) |

---

## 1. Screen and route inventory (expo-router, `app/`, 47 files) [verified]

Each route below is marked **R** (wired to the server), **L-dev** (real, on the device only), **stub** (`UnavailableFeature` honest placeholder) or **redirect**.

### Root and auth

| Route file | What it does | Data |
|---|---|---|
| `app/_layout.tsx` | Root stack.<br>- Calls `bootstrapAppRuntime` with `EXPO_PUBLIC_WALDO_APP_API_ORIGIN` (L19) and restores the session on mount (L48).<br>- Loads the bundled SF Pro Rounded OTFs. | R |
| `app/index.tsx` | Redirects to `/(app)/home`. | redirect |
| `app/auth-callback.tsx` | Retired Supabase PKCE callback; redirects to `/`. | redirect |
| `app/oauth/complete.tsx` | Return target `waldo://oauth/complete` after Google consent; redirects to Connections, which reads the server again. | redirect |
| `app/(auth)/_layout.tsx` | `RedirectIfSignedIn` sends an active session to Home. | n/a |
| `app/(auth)/sign-in.tsx` | Redirects to `agent-sign-in`. | redirect |
| `app/(auth)/agent-sign-in.tsx` | Email, optional invite (20 chars), emailed code; sign out of agent.<br>No Google button and no 18+ checkbox. | **R** |

### Signed in (`(app)`, gated by `RequireSession`)

| Route file | What it does | Data |
|---|---|---|
| `(app)/_layout.tsx` | `RequireSession` gate, `useHealthIngest()` (L9), `SideMenu`, stack titles. | R |
| `(app)/home.tsx` + `TodaySummary` | Menu button, sign-in row when not active, and stacked cards:<br>- Brief placeholder;<br>- approvals waiting count;<br>- today's day cards;<br>- Body score rings;<br>- Patrol and Spots placeholders. | R + placeholders |
| `(app)/chat.tsx` → `ChatPane` | Main chat (history, send, receipt polling, approval cards, markdown) and local drafts for non-main threads. | **R** (main), local (drafts) |
| `(app)/chats.tsx` | Main chat entry plus memory-only local drafts. No server threads. | local |
| `(app)/settings.tsx` | Links to:<br>- agent session (sign out);<br>- schedule;<br>- Health agreements;<br>- Appearance (Light only, Dark "Coming soon");<br>- Connections;<br>- an honest "not available yet" box. | R links |
| `(app)/schedule.tsx` → `ScheduleSettings` | Time zone (manual "Use this device's time zone"), quiet hours, volume, today's cards, read-only schedule switches. | **R** |
| `(app)/approvals.tsx` → `ApprovalsList` | Waiting and earlier approvals with exact details; decisions; Ask Waldo about one. | **R** |
| `(app)/account.tsx` → `AccountPanel` | Sign out; delete with a typed `DELETE`. | **R** |
| `(app)/connectors.tsx` → `ConnectionsList` | Google accounts, Connect Google, Telegram and channel states, signed-in sessions. | **R** |
| `(app)/health-consent.tsx` → `HealthConsent` | 18+ switch, test-build logging acknowledgement, and the storage and model agreements. | **R** |
| `(app)/health/index.tsx` → `HealthStats` + `HealthScores` | Server scores and links to on-device Apple Health. | **R** |
| `(app)/health/[metric].tsx`, `(app)/health-data.tsx` | "Health detail is unavailable". | stub |
| `(app)/wearable.tsx` | On-device HealthKit snapshot (`useHealthSnapshot`); nothing is sent to the server. | L-dev |
| `(app)/wear-debug.tsx` | Galaxy Watch IBI bridge debug; redirects unless `__DEV__`. | dev only |
| `(app)/brief.tsx` | "Brief is unavailable". | stub |
| `(app)/constellations.tsx` | Stub. The renderer exists (`src/components/constellation/*`) but is unreachable. The view is pinned in `controls.ts`; the app never requests it. | stub |
| `(app)/patrol.tsx`, `(app)/spots.tsx` | "Activity/Memory is unavailable". | stub |
| `(app)/gallery.tsx` | "Design gallery removed". | stub |

### Onboarding (`(onboarding)`, gated by `RequireSession`)

| Route file | What it does | Data |
|---|---|---|
| `(onboarding)/connect-healthkit.tsx` | iOS HealthKit read permission and a local snapshot. Reached only from Body › "Manage Apple Health access" or from `wearable`. | L-dev |
| `(onboarding)/connect-watch.tsx` | Galaxy Watch picker and Samsung Health (Android legacy). | legacy |
| 15 others (`hello`, `legal`, `name`, `notifications`, `permissions`, `wake`, …) | "Agent setup is unavailable". | stub |

**There is no first-run flow** [verified]. After verification, `RedirectIfSignedIn` drops the owner on Home (`RequireSession.tsx:32-35`). Nothing walks them through:
- Google connect;
- Health agreements;
- the iOS Health permission;
- the zone;
- notifications.

### Navigation

- **Side menu** (`sideMenuItems.ts:17-35`): Home, Body; Spots, The Patrol and Constellations dimmed; Connections, Your Chats, New Chat (dimmed, a local draft); Approvals, Account, Settings.
- **Dock** (`GlassTabBar`): Menu, Home, Body, Waldo (opens Main chat).

### Code reachability [verified, by regex import scan]

- 123 `src` files are reachable from routes and 86 are not.
- The unreachable ones are legacy:
  - Supabase client and auth;
  - `agentClient.ts`;
  - `kairos/*`, `insights/*`;
  - `health/sync/*`, the old upload;
  - `home/useHomeData` and friends;
  - `components/waldo/*`;
  - the constellation renderer;
  - others.
- So the legacy health upload is not reachable from any route at `c2ccd5d0`.

---

## 2. Golden-path steps and the other items

### 2.1 Sign-in: Google or email + invite + 18+

- **Email + invite** [verified].
  - `agent-sign-in.tsx:19-35` calls `session.requestCode`, then `session.verify`, which reach `AppRoutesClient.code()` (`POST /app/v1/auth/code`, expects 200 `{ok:true}`) and `.verify()` (`POST /app/v1/auth/verify`, 200 → `{state:'active', session_ref, account_ref, surface:'app', absolute_expires_at, credential}` or `{state:'needs_invite'}`); `appRoutesClient.ts:40-47`.
  - Pin: `core.ts` (`90e162d0` bytes, SHA-256 `62872be6…`).
  - The invite is upper-cased, checked against `^[A-HJ-NP-Z2-9]{20}$` and sent on both calls (`appSessionController.ts:13-14`, `appRoutesClient.ts:39`).
  - Backend: `app-api.ts:108-139`. `verifyOrJoin` joins an invited new member (#1054, `3e05de53`).
  - A failed verify asks for a fresh code, never the same one (`agent-sign-in.tsx:31-32`).
- **Google sign-in: missing on both sides** [verified].
  - There is no button in the app.
  - There is no `/app/v1/auth/google`, or any Google sign-in route, in `packages/runtime/src/channels/app-api.ts` (the full dispatch is `handleApp`, L102-181), and no open backend PR for it.
  - The owner's direction (Google O2-A + profile, verified-email linking) has no contract yet.
- **18+ checkbox at sign-up: missing** [verified].
  - The sign-in screen has no age control.
  - The only 18+ attestation is the "I am 18 or older" switch on Health agreements (`HealthConsent.tsx:93`). It feeds `age_attested_18_plus: true` on the consent grant (`healthConsentController.ts:46-51`).
  - Recording it at sign-up needs a contract change: `appCodeRequestSchema` and `appVerifyRequestV1Schema` are `strictObject` `{email, invite?}` and `{email, code, invite?}`, so an extra field fails validation (the backend answers 403, `app-api.ts:112,126`).
  - An app-only gate, a checkbox that enables "Email me a code" without a server record, is possible today. Whether that satisfies the ruling is a decision for the owner or L3 [inference].
- **Session lifetime** [verified, backend `app-api.ts:81-82`].
  - The app session is absolute: 12 h from creation, no renewal.
  - The app keeps the bearer in the Keychain and does nothing with `absolute_expires_at`.
  - After 12 h, any call answers 401, and the app clears the bearer and sends the owner back to the emailed-code screen (`mainChatController.ts:136` and the other controllers' `handle`).
  - In practice that means a new emailed code at least twice a day [inference].
  - A push registration is bound to the session that registered it (C2), so S7 inherits this limit.

### 2.2 Google connect (Gmail, Calendar, Tasks consent)

- **App** [verified]:
  - `ConnectionsList.tsx:22-27` reads `GET /app/v1/controls?view=connections` (pinned `controls.ts`, `aa22c68d…`, identical to backend HEAD).
  - "Connect Google" (`ConnectionsList.tsx:60-61`) calls `connectionsController.connectGoogle()` (L47-54), which sends `POST /app/v1/actions` `{view:'connections', action:'google.connect', value:'calendar', revision, request_id}`.
  - Only a `recorded` receipt whose `navigation` matches `^/c/[A-Za-z0-9_-]{22}$` is opened (L73-75), as `origin + path` via `WebBrowser.openAuthSessionAsync(url, 'waldo://oauth/complete')` (`ConnectionsList.tsx:47`). The view is then re-read (L48).
  - One consent asks for calendar, mail and tasks together; the backend decides the scopes (`connectionsController.ts:9-10`).
  - Accounts show the saved access ("Calendar, Mail, Tasks") and health ("Needs reconnecting" or "Access saved").
- **Backend**: `/controls` and `/actions` are forwarded to the owner DO (`app-api.ts:165-179`). `google.connect` → `runtime.googleConnectUrl(feature, 'app')` (`telegram-owner-do.ts:655-657`) [verified].
- **Status: wired.** End-to-end on staging is unverified by this report.
- **Gaps**:
  - No disconnect, and no read/write scope split: neither is in any contract.
  - The Google consent screen and verification are on the owner's list.
  - A retry after an uncertain answer re-POSTs the same `request_id` (L56-59).

### 2.3 Health consent, Apple Health ingest, three scores

- **Consent** [verified].
  - `HealthConsent.tsx` loads `GET /app/v1/health/consents` and takes the newest Apple v2 row per purpose (`healthConsentController.ts:28-43`).
  - Granting `POST /app/v1/health/consents` needs the 18+ switch and, on a staging build, the logging acknowledgement (`HealthConsent.tsx:78, 93-94`).
  - `model_processing` needs `storage_compute` first.
  - Withdrawing storage (`POST …/consents/withdraw`) asks for confirmation, purges the phone's watermark, and the server deletes what it holds (`HealthConsent.tsx:81-85`).
  - Pin: `health-ingest.ts` `bbe7369d…`, identical to backend HEAD.
- **Ingest** [verified].
  - `useHealthIngest` runs in the `(app)` layout. It starts when signed in, on every foreground, and with `force` when storage consent turns on (`useHealthIngest.ts:12-17`).
  - The runner (`healthIngestRunner.ts:61-141`):
    - checks consent first and before every chunk;
    - reads `readRange` in local-midnight day chunks;
    - does a 30-day backfill on first run, then resumes from the watermark minus a 24 h overlap;
    - throttles to 10 min;
    - sends `POST /app/v1/health/ingest` batches;
    - verifies each receipt's `request_id`, `anchor_after` and `consent_epoch`;
    - stores only `{account, epoch, through}` in the Keychain.
  - Foreground only: there is no HealthKit background delivery, although the entitlement is present.
- **Scores** [verified].
  - `GET /app/v1/health/scores` feeds two places:
    - Home's Body rings, in the order Form, Recovery, Weight (`TodaySummary.tsx:75-90`);
    - `/(app)/health` as a list with reason text and freshness (`HealthScores.tsx`).
  - Unavailable states say why, and nothing is computed on the phone.
  - The Weight copy says it is "not calculated yet", because of `calendar_demand_unavailable` (`scoresView.ts:27-29`).
- **Gaps (app)** [verified, except where noted]:
  1. Health agreements is reachable only from Settings (`settings.tsx:16`). Neither Home's Body card nor the Body screen links to it, although the unavailable reason says "Turn on storing and computing in Health agreements".
  2. The iOS HealthKit read permission is asked only on `connect-healthkit` (`connect-healthkit.tsx:28-40`), reached from Body › "Manage Apple Health access" (`HealthStats.tsx:17`).
     - Ingest calls `connect()` and then `readRange` (`healthIngestDeps.ts:31`), and `connect()` "does not ask iOS for access" (comment, L24-25).
     - So a granted server consent without the iOS permission is possible.
     - **C1:** the result is a silent "done, 0 sent". Health agreements says "Last sent …" and scores say `no_readings`.
  3. There is no guided sequence: consent, then the iOS permission, then the first ingest, then scores.

### 2.4 Main chat: history loads, send works

- **History** [verified].
  - `useChat.ts:16-27` reads on mount (main thread, active session) and whenever the app returns to the foreground. Pull to refresh (`ChatPane.tsx:165`) and the "Refresh" link (L252) read again.
  - `AppRoutesClient.history()` sends `GET /app/v1/chat/main?limit=50[&cursor=before:<id>]` and expects 200 (`appRoutesClient.ts:124-128`).
  - The page is parsed with a tolerant reader that keeps only declared keys and drops unknown or invalid parts (`app-routes-v1.ts:14-29`).
  - Pages are merged by id. A stale cursor refetches from the top (`mainChatController.ts:42-70`).
  - The pin is `core.ts` at `90e162d0`. The backend has since added an optional `created_at` on rows, which the tolerant reader drops, so the app can't show message times (section 3.5).
- **Send** [verified].
  - `POST /app/v1/chat/main/messages` `{client_message_id: uuid, text}` expects 202 `{accepted:true, message_id}` (`appRoutesClient.ts:129-132`).
  - The text limit is 4,000 characters, and the client also caps the wire size at 8,192 bytes against the contract's 32,768 (gap register G21).
  - The pending turn's id, but never its text, is kept in the Keychain (`secureAppStorage.ts:17-21`).
  - Then it polls `GET /app/v1/chat/main/messages/{client_message_id}`: every 2 s for the first 20 s, then every 10 s, honouring Retry-After, and giving up at 180 s as "unconfirmed" (`appRuntime.ts:79-92`).
  - Once the receipt is `completed`, it reads history until the assistant row with `parent_id` equal to the message id appears; after 8 reads it says "Use Refresh" (`mainChatController.ts:103-132`).
  - An interrupted or revoked turn gets honest copy.
- **Backend state**:
  - #1074 (the history read skips shape-invalid rows) is merged (`f74a2e38`, an ancestor of `4bb040f5`) [verified].
  - Staging serves `4bb040f5` (C4), so it serves #1074 [verified].
  - Per L2 (overnight log), turn execution and scheduled app delivery still use the strict `load()`, so **sends fail for an account with a bad stored row** until L2's follow-up [unverified, from the lane].
- **App gaps**: 503 handling, section 3.3.
  - The composer stays enabled after a failed history read (`available` ignores read failure, `useChat.ts:71`), so the owner can type into a chat that never loaded [verified].
  - Mic and attach are disabled. There is no cancel or rating, although the backend `core.ts` now names those routes (section 3.5).

### 2.5 Approval round trip: approve, "Not now", "Don't do this"

- **App** [verified]:
  - `ApprovalsList` and the chat `ApprovalCard` read `GET /app/v1/approvals` (each item strict; unreadable items are counted, not shown) and decide with `POST /app/v1/approvals/decisions` `{approval_id, action, expected_digest, request_id}` (`appRoutesClient.ts:111-123`, `approvalsController.ts:44-82`).
  - A chat card is only a pointer: it looks the approval up on the list and offers decisions only when the digest and kind match (`approvalCardView.ts:16-21`).
  - Labels (`approvalsView.ts:13-18`):
    - approve is a kind-specific verb ("Send it", "Make the change");
    - `skip` reads "Don't do this";
    - `defer` reads "Not now";
    - `edit` reads "Change it";
    - `undo` reads "Undo".
  - The pin is `approvals.ts` `1ef57a8e…` and `parts.ts` `39a9d667…`, identical to backend HEAD (#77).
- **Approve and "Don't do this": wired.**
- **"Not now": blocked on the backend** [verified].
  - `app-approvals.ts:46`: "The desk has no defer path yet, so it never offers defer and Not now is refused like any decision it does not offer". It answers 409 `no_longer_eligible`.
  - The `LETTER` and `TARGET` maps (L12-13) have no `defer`.
  - The app would show "Not now" only if the server listed `defer` in `actions`, and it never does today.
  - There is also an open contract question (contracts README): after a deferral the default list hides the item, so the chat card would say "no longer available to decide here".
- **"Change it" (`edit`)**: sends the decision, but nothing takes the owner to the chat composer to type the change. The contract says the owner edits in Main chat. A small app gap [verified].
- No approval push. An approval surfaces only when the owner opens Home, Approvals or chat.

### 2.6 Reminder firing (in app; push is S7)

- **The app has no reminder-specific surface** [verified]: grep finds no reminder code in reachable `src`.
- A reminder that fires reaches the app only as a row in the Main chat transcript, through backend app delivery.
- The app sees that row only when Main chat:
  - is opened;
  - is pulled to refresh;
  - gets "Refresh";
  - comes back to the foreground.
- There is no polling while the chat is open (only while the owner's own turn is pending), no read from Home, and no unread signal [verified, `useChat.ts:16-27`].
- **Status: partial.** "A reminder firing" is observable only by refreshing after the fire time.
- **Backend dependencies**:
  - #1066 (arming at first app use; reminders always fire) is unmerged.
  - L2 says scheduled app delivery uses the strict `load()` and fails for bad-row accounts [unverified].

### 2.7 Time zone

- **Auto-write at sign-in: not implemented** [verified].
  - Nothing reads `timezone_confirmed`. It appears only in the pinned `controls.ts:50-52`, pinned from `1ba75947`.
  - `loadDay` (`controlsController.ts:18-28`) runs from Home and Schedule and never writes.
- **Manual path** [verified].
  - Settings › Your schedule shows "Use this device's time zone" only when `deviceZone !== day.data.timezone` (`ScheduleSettings.tsx:70, 93-95`).
  - It calls `controls.setTimezone(deviceZone)`, which sends `POST /app/v1/actions` `{view:'day', action:'timezone.set', value, revision, request_id}` (`controlsController.ts:29-45`).
  - The zone is validated with `Intl.DateTimeFormat` and capped at 64 chars.
  - Retry is idempotent on `request_id`. `stale_read` re-reads.
- **Backend**:
  - The producer of `timezone_confirmed` is commit `f5182064` ("Report whether the owner confirmed the day's time zone").
  - It is only on `l2/p3a-app-proactive` (#1066, head `0bab0a41`) and is **not** an ancestor of `beta-mvp` `4bb040f5` [verified, `git merge-base`].
  - A grep of `packages/runtime/src` on HEAD finds no producer.
  - So staging cannot serve the field, and the app should treat it as absent, which means no write under ruling (a).
  - On #1066 (head now `e1ab2881`), `timezoneConfirmed` is true only after `timezone.set` (`identity.get('timezone_confirmed') === true`).
- **App work once #1066 is served** [proposed]:
  - After the first successful `loadDay` in a session, if `timezone_confirmed === false && timezone === 'UTC'`, call `setTimezone(deviceTimeZone())` once, validating the zone's structure first.
  - Write nothing when the field is `true` or absent.
  - Tests: false + UTC writes; false + another zone does not; true and absent do not.
- **Edge case (C3, verified on the #1066 branch):**
  - The Telegram webhook writes the stored zone without confirming it.
  - An owner whose phone zone matches that zone has no in-app way to confirm: the row is hidden, and rule (a) skips non-UTC zones.
  - Under #1066's hold, their app-channel day cards, heartbeat and nightly never arm.
  - **Fix:** add a "Confirm time zone" row whenever `timezone_confirmed === false` (app), or treat the Telegram header write as confirmed, or backfill (backend).

### 2.8 Account deletion

- **App** [verified]:
  - `AccountPanel` reads `GET /app/v1/controls?view=account`, which gives `{deletion_available}`.
  - When it is available, the owner must type `DELETE` before `POST /app/v1/actions` `{view:'account', action:'account.delete', confirmation:'DELETE', revision, request_id}` (`accountController.ts:26-82`).
  - A recorded or incomplete receipt with `signed_out` ends the session and shows the server's farewell on the sign-in screen (`agent-sign-in.tsx:59`).
  - A 401 on a resend reads as "signed out", never as success or failure.
  - "Unserved" (400 or 404) says not available on this version.
- **Backend**: #1056, #1064 and #1069 are merged (ancestors of HEAD) [verified]. `app-controls.ts:76` handles `account.delete`.
- **Status: wired.** The end-to-end throwaway-account test is on the owner's list and unverified.

### 2.9 Proactive messages in the app (morning brief, heartbeat, day cards, nightly)

- **Home** [verified]:
  - The Brief card is a placeholder: "The Brief is not shown in the app yet. Ask Waldo in Main chat." (`TodaySummary.tsx:53`).
  - "Today's Brief" lists `controls?view=day` cards with name, reason, time and "Sent today" or "Not sent yet" (`TodaySummary.tsx:63-73`, `schedule.ts:50-53`).
  - The `latest` delivery excerpt (pinned since #1065/#1059) is **not rendered** anywhere.
  - L3's `latest` producer reportedly needs a DO ALTER that is held (overnight log) [unverified].
- **Schedule screen**: shows the same cards and five read-only switches: daily brief, follow-ups, event briefs, nightly, heartbeat (`ScheduleSettings.tsx:127-135`).
- **The messages themselves** appear only as Main chat rows, read as in 2.6. There is no live refresh and no unread signal.
- `/(app)/brief` is a stub.
- **Backend dependency**: #1066 arms app-only owners only once the zone is confirmed. That makes the time-zone write (2.7) the arming trigger for new app-only owners [inference from #1066's title and commit].

### 2.10 Continuity with Telegram (same transcript)

- **App** [verified]:
  - Every history row shows `message.channel` as a small label (`ChatPane.tsx:453, 467`), so the UI is ready for a multi-channel transcript.
  - Connections shows Telegram linked or not linked, read-only (`ConnectionsList.tsx:68-71`).
  - There is no link flow. `channel.unlink` is pinned but never called.
- **Backend** [verified in part]:
  - The app's history reads `canonicalOwnerConversationStore(...).readForDisplay()` (`telegram-owner-do.ts:670`).
  - In the owner DO, the canonical store is passed as `history` only when `channel === 'app'` (`telegram-owner-do.ts:2132-2140`).
  - The only `store.save` in that file writes `surface: 'app'` (L592).
  - That agrees with the README and Audit's claim that Telegram writes the legacy `conv:*` rows. I did not trace Telegram's persistence path.
- **Status: missing.** It is backend-owned (L2). Nothing is needed from the app beyond the channel labels it already shows.

---

## 3. The app's API client [verified]

### 3.1 Base URL selection

- The origin comes from the build-time env `EXPO_PUBLIC_WALDO_APP_API_ORIGIN` (`app/_layout.tsx:19`).
- It must equal `REVIEWED_STAGING_ORIGIN = 'https://waldo-runtime-staging.piyushfulper3210.workers.dev'` (`bootstrap.ts:5`, `stagingTransport.ts:7`).
- If it doesn't:
  - the runtime stays `null`;
  - every screen says the agent is "not configured in this build";
  - a release build locks the signed-in routes (`access.ts:11`).
- There is no production origin and no fallback.
- The transport (`stagingTransport.ts`):
  - requires HTTPS and a bare origin;
  - only allows `/app/v1/` paths;
  - sets `redirect: 'error'` and `credentials: 'omit'`;
  - times out at 20 s;
  - requires a JSON content type and caps the response at 1 MiB;
  - never sets `cache`, because the RN polyfill's `_=` cache-buster is refused by the strict Worker.
- Release builds embed the origin. The L4 handoff gives the `xcodebuild` recipe.

### 3.2 Auth and session handling

- The credential is the opaque bearer from `verify`, stored with `expo-secure-store` (Keychain) under `waldo.app.v0.credential`. A pending sign-out credential is kept separately (`secureAppStorage.ts`).
- It is sent as `Authorization: Bearer`.
- **Cold start**: `restore()` calls `GET /app/v1/session`.
  - 401 removes the credential.
  - A network error shows "Can't reach Waldo" and keeps the credential.
  - Gates wait for the first restore (`appSessionController.ts:40-63`, `access.ts`).
- **401** on any route calls `session.expire()`, which clears the credential and resets every controller.
- **403** re-checks `GET /session` and expires only if the session is no longer valid.
- `RequestScope` aborts in-flight work when the account or session changes (`requestScope.ts`).
- **Sign-out**: `POST /app/v1/auth/signout`. It retries with exponential backoff (5 s up to a 300 s cap) until it gets 200 or 401 (`appRuntime.ts:71-76`). The backend also revokes the session's push rows on sign-out (`app-api.ts:161`).

### 3.3 Error handling, including 503 / `history_invalid` on Main chat

- **Error bodies**: for non-2xx answers the transport throws away the body, except for `/app/v1/actions`, `/approvals` and `/health/*`. For those, a JSON body of up to 4 KiB is parsed and only its `error` code is kept (`stagingTransport.ts:26-36`).
- **So `history_invalid` can never reach the app.**
  - The owner DO logs the code (`logAppReadFailure`, `telegram-owner-do.ts:214, 674`) and answers a generic 503.
  - The app raises `AppRouteError(503, 'unavailable')`.
  - `runtime.run` sets: "Agent request could not be confirmed (status 503). Retry when connected." (`appRuntime.ts:62-69`, `failureDetail` L18-21).
  - That line shows under the transcript (`ChatPane.tsx:249`) and the empty state stays visible.
- **No automatic retry** of a history read. Recovery is pull-to-refresh, "Refresh", or a return to the foreground.
- `invalid_response`, meaning the strict parse failed, shows as "reply not recognised, status N".
- Unknown enum values in declared fields (a new `role`, say) fail the whole page closed (contracts README, "Reading policy").

### 3.4 Retry behaviour

- **Reads**: none automatic.
- **Turn receipts**: polled with backoff, as in 2.4. They honour Retry-After, capped at 600 s.
- **Mutations** (send, `timezone.set`, `proactivity.set`, `google.connect`, `account.delete`, approval decisions, consent changes) keep a stable `request_id`, so "Retry" replays it idempotently.
- A message whose state is uncertain is never resent after 12 h (`MAX_RESEND_AGE_MS`).
- `AppRoutesClient.actionReceipt()` (`GET /app/v1/actions/{request_id}`) has no production caller; only tests use it (C5).

### 3.5 Contract pin against backend HEAD (`4bb040f5`) [verified, `cmp` and SHA-256]

| File | App pin | Backend HEAD | |
|---|---|---|---|
| `core.ts` | `62872be6…` (`90e162d0`) | `45bb68c1…` | **differs**, additively:<br>- optional row `created_at`;<br>- `appClientMessageIdV1Schema`;<br>- `POST …/messages/{id}/cancel`;<br>- `PUT …/messages/{message_id}/rating` |
| `controls.ts` | `aa22c68d…` | same | — |
| `approvals.ts` | `1ef57a8e…` | same | — |
| `parts.ts` | `39a9d667…` | same | — |
| `surfaces.ts` | `18dae67e…` | same | — |
| `health-ingest.ts` | `bbe7369d…` | same | — |
| `threads.ts` (C1) | not pinned | contract only | no `/app/v1/threads` dispatch in `app-api.ts` [verified] |
| `devices.ts` (push) | not pinned | contract only | no `/app/v1/devices` dispatch [verified] |

The whole `core.ts` drift is one commit, `8fea3a34`, merged in #1067 (C6). Pinning it is the C1 re-pin L3 asked to sequence.

---

## 4. Push notifications

### Present [verified]

- `expo-notifications ~0.32.17` in `package.json`.
- The `EXNotifications 0.32.17` pod in `ios/Podfile.lock`.
- `aps-environment = development` in `ios/Waldo/Waldo.entitlements`. The HealthKit and background-delivery entitlements are there too.
- `AppDelegate` is the stock `ExpoAppDelegate`.

### Absent [verified]

- No `expo-notifications` config plugin in `app.json`.
- No `UIBackgroundModes` / `remote-notification` in `Info.plist`.
- No JS usage at all: no permission prompt, no `getDevicePushTokenAsync`, no notification handler, no tap or deep-link routing.
- No Settings › Notifications.
- No installation id.

### Backend

- The `packages/contracts/src/app/devices.ts` contract has `GET /app/v1/devices`, `POST /app/v1/devices/register` and `POST /app/v1/devices/revoke`:
  - `register` takes `{operation_id, installation_id: uuid, provider: 'apns'|'fcm', environment: 'sandbox'|'production', token, expected_device_epoch}`;
  - `revoke` takes `{operation_id, installation_id, expected_device_epoch}`.
- `supabase/migrations/20261010040000_app_push_custody.sql` exists, and sign-out calls `app_push_revoke_session`.
- **`handleApp` has no `/devices` dispatch**, so these paths reach the final `fail(404)` (`app-api.ts:180`) [verified].
- No APNs sender exists yet. L2's S7 plan: direct APNs, a keyless reachability spike approved, and the owner creates the .p8 key.

### What S7 needs on the app side [proposed]

1. Pin `devices.ts` byte-for-byte once the routes are served, and add `AppRoutesClient.devices / registerDevice / revokeDevice`. Only the client names routes, as the pin tests require.
2. A per-install `installation_id` (UUID v4) in the Keychain. Keep `device_epoch` from the server answer: 0 for a new install, then the current epoch.
3. Add the `expo-notifications` plugin to `app.json`. A rebuild is needed (a native config change).
4. Take the raw APNs token from `Notifications.getDevicePushTokenAsync()`, not an Expo push token, since S7 is direct APNs. Send `environment: 'sandbox'` for development-signed builds, matching `aps-environment development`.
5. A permission request at a consented moment: the design's `PermissionPrePrompt`, for example when the owner first sets a reminder, per the ruling that a reminder the owner set may push. Never at cold start.
6. Register after sign-in and on token change. Revoke on sign-out and account deletion; the server already revokes per session on sign-out.
7. A tap handler that routes to Main chat (`waldo:///(app)/chat`) and re-reads history. A push is a hint and the history read is the truth, and the payload carries ids only, never health values.
8. A foreground presentation policy.
9. Settings › Notifications categories, as ruled.
10. Proof on a physical device, per the lane rules.

**C2 constraint.**
- A registration is tied to the 12 h session that made it.
- Register, list and revoke need a live session.
- Sign-out revokes the registration; expiry alone does not.
- So the app must re-register on every sign-in.
- The backend must decide whether the sender may push to a device whose session expired. If it may not, a morning reminder needs a sign-in within the previous 12 h.

---

## 5. Open app PRs [verified, `gh pr view`]

| PR | Head | What it changes | Assessment |
|---|---|---|---|
| #29 `app/simulator-health-seed-20261010` | `b89a45fc` | Adds `tools/simulator-health-seed/`, +567 across 4 files, no `src` change: a dev-only Swift tool that writes synthetic Watch-style HealthKit samples into an iOS Simulator from two sources. | Useful for Simulator score testing. Its warning about main's legacy upload is stale: `health/sync/*` is unreachable from routes at `c2ccd5d0`. It needs the owner's yes. |
| #27 `app/readiness-checklist-20261010` | `26987c50` | Adds one doc, `Docs/planning/APP_READINESS_CHECKLIST.md`, +164. | Stale: based on staging `421dd2ac`, from 10 Oct. Refresh or close. |
| #16 `codex/waldo-native-finalization-20261010` (draft) | `1980a9d1` | The "native canonical app" recovery checkpoint: +52,882 / −6,973 across 354 files, 10 Oct. | Predates #45–#77, which re-cut its slices, so it almost certainly conflicts with main [inference]. The owner decides. Don't merge it as is. |

---

## 6. Ranked app-side gaps (what L4 can act on) and what is blocked on the backend

### App-side, in order (each names the golden-path step it blocks)

1. **Health path linkage.** Blocks the health consent → ingest → scores step; the failure is silent (C1).
   - Health agreements is reachable only from Settings, and the iOS HealthKit permission only from Body › Manage Apple Health access. Ingest never asks for it.
   - Without the permission, ingest reports "Last sent …" with 0 sent, and scores say `no_readings`.
   - Add links from the Body card, the Body screen and the consent screen, and add a first-run sequence: consent, then the iOS permission, then ingest, then scores.
   - Word the status with the count sent.
2. **Reminder and proactive visibility.** Blocks the "reminder fires" step in the app.
   - Nothing re-reads Main chat while it is open, or from Home, and there is no unread signal.
   - Refresh on focus or on an interval while visible, add an unread signal on Home, and render the day card's `latest` excerpt (the pin is there).
3. **18+ at sign-up.** Blocks the sign-in step as defined.
   - An app-only checkbox gate can ship now.
   - Recording it on the server needs an additive `core.ts` field; the owner and L3 decide.
4. **Main chat failure UX.** Affects the Main chat step.
   - Show a generic 503 as an explicit "history could not load" state with backoff retry, distinct from an empty chat.
   - Disable or label the composer until history loads.
5. **Zone auto-write (ruling a)** once #1066 serves `timezone_confirmed`, plus a "Confirm time zone" row whenever the zone is unconfirmed (C3).
   - This gates heartbeat, day cards and nightly. Reminders fire regardless.
6. **S7 app work** (section 4), once L2 serves `/devices` and settles the session binding (C2).

Smaller items:
- route "Change it" to the composer;
- show message times after the C1 `core.ts` re-pin (`created_at`);
- pin the threads contract when its routes are served;
- Constellations wiring.

### Blocked on the backend (route these to their lanes)

- Google sign-in route and contract: L2/L3.
- Desk `defer` path (L3).
- Merge and deploy #1066, which serves `timezone_confirmed` and arms app-only owners (L2/L1).
- Send-path and app-delivery `load()` fix for bad-row accounts (L2).
- `/app/v1/devices` dispatch and the APNs sender (L2, S7).
- Telegram on the canonical store, for continuity (L2).
- `/app/v1/threads` dispatch (L3).
- Session renewal, or a push binding that outlives the session (C2). Today the session is an absolute 12 h with no renewal, and the push row is tied to it.
- A Telegram-written zone that never counts as confirmed (C3); the alternative is the app-side confirm row.
- Brief content in the app.

---

## 7. Status-changing checks (C1–C6), resolved

### C1: Apple Health ingest without the iOS permission is a silent failure

[verified code; Apple behaviour is inference]

- **What the code does.** `HealthKitManager.readRange` (`modules/health/ios/HealthKitManager.swift:248-251`) checks only two things:
  - HealthKit is available;
  - the range has the right shape.

  Nothing checks or requests authorization. `requestAuthorization` is called only from `requestPermissions()` (L48-50), which only `connect-healthkit` calls.
- **What HealthKit does.** It hides read authorization. A query for a type the app was never granted returns no samples rather than an error [inference: Apple's documented privacy model, not re-fetched in this session].
- **The result** for an owner who turns on Health agreements but never visits Body › "Manage Apple Health access":
  - `readRange` returns empty arrays;
  - `normalizeRange` builds 0 samples;
  - `planBatches` produces no batches (`src/health/normalize/batch.ts:64`), so nothing is sent;
  - the runner ends `done`;
  - Health agreements shows "Last sent \<time\>." (`HealthConsent.tsx:16`), which is misleading with 0 sent;
  - scores answer `no_readings`, so Body reads "Waldo has no readings for this day yet."
- **This is a silent golden-path break, owned by the app.** Fix: link the iOS permission into the consent flow and first run, and word the status with the count sent.

### C2: Push registration is bound to the 12 h session

[verified, `supabase/migrations/20261010040000_app_push_custody.sql`]

- **The key.** `waldo.app_push_devices` has primary key `(owner_id, installation_id)`, but each row carries the `session_hash` that registered it.
- **Register, list and revoke** each require a live session created less than 12 h ago (L50, L68, L100).
- **Revocation** happens on sign-out (`app_push_revoke_session`) and on any `console_sessions` row delete (trigger, L145-153).
- **Expiry deletes nothing.** The 12 h TTL is a `created_at > now() - interval '12 hours'` filter (`20260929030000_waldo_console_session_ttl.sql:12,32`). So the device row stays `active` after its session expires, but it can't be re-listed or changed without a new sign-in.
- **What S7 must decide** [inference]: whether the sender delivers to a device whose registering session has expired.
  - If it does not, a reminder push dies within 12 h of the last sign-in.
  - Either way, the app must re-register on every new session; the upsert moves `session_hash`.
  - Session renewal, or a device binding that outlives the session, is a backend design question for S7.

### C3: An owner can be stuck with an unconfirmed zone and no way to confirm it

[verified on the #1066 branch; the outcome is inference]

- **State of #1066.** Its head is now `e1ab2881` (OPEN, MERGEABLE, updated 21:48Z). The overnight log's `0bab0a41` is older.
- **Two ways the zone gets stored.** On that branch, `identity = this.ctx.storage.kv` (L1586).
  - Two paths write the stored zone from an `x-waldo-timezone` header **without** setting `timezone_confirmed`:
    - a router-supplied header (L394; I did not trace the sender, and it is not the app, whose forwarded requests carry no such header);
    - the Telegram webhook's `bindIdentity` (L965).
  - Only `timezone.set` sets both (L2667-2668).
  - **The fallback.** The day view reports `identity.get('timezone') ?? fallbackZone`, where `fallbackZone = WALDO_OWNER_TIMEZONE ?? 'UTC'` (L1638).
    - `WALDO_OWNER_TIMEZONE` is not among the staging `vars` in `packages/runtime/wrangler.jsonc` (L84), so a fresh app-only owner reads `'UTC'` and ruling (a) can fire [verified in repo config].
    - A secret set outside the repo could change that [unverified]. If staging ever sets a non-UTC fallback, every fresh owner in that zone falls into this trap, and rule (a) should key on `timezone_confirmed === false` rather than on `'UTC'`.
- **Who gets stuck.** An owner who has used Telegram can hold a non-UTC zone that is unconfirmed. If the phone's zone matches it:
  - the app's "Use this device's time zone" row is hidden (`ScheduleSettings.tsx:70`);
  - ruling (a) doesn't write either, because the stored zone isn't 'UTC';
  - so the owner has no way to confirm in the app.
- **The consequence.** Under #1066's hold (`held`, L1352; `armable`, L2029), that owner's app-channel day cards, heartbeat and nightly never arm. Event briefs never arm on the app channel at all.
- **Fix, both sides:**
  - **app:** a "Confirm time zone" row whenever `timezone_confirmed === false`, even when the zones match;
  - **backend:** or have the Telegram header write count as confirmed, or backfill.
  - This may be the owner's own account if it was first set up through Telegram [inference].

### C4: Staging serves `4bb040f5`

[verified] `GET https://waldo-runtime-staging.piyushfulper3210.workers.dev/healthz` answered `{"ok":true,"release":"4bb040f5"}` at 21:54Z on 11 Oct. Staging therefore serves #1074, the history read that skips invalid rows. It does not serve #1066 or any `timezone_confirmed` producer.

### C5: `actionReceipt` has no production caller

[verified] `AppRoutesClient.actionReceipt()` is called only from tests (`controls.test.ts`, `stagingLive.test.ts`). Every controller retries by re-POSTing the same `request_id`, which the backend answers with its stored receipt. The method is dead outside tests. That is harmless.

### C6: One backend commit changed `core.ts` since the pin

[verified] `git log 90e162d0..HEAD -- packages/contracts/src/app/core.ts` lists exactly one commit, `8fea3a34`: "contracts(app): C1 threads subset, cancel, ratings, message times, devices". It was merged through #1067 (`718d3485`). Re-pinning `core.ts` is a C1 re-pin and should be paired with `threads.ts`/`devices.ts` once their routes are served.

## 8. Evidence, inference, unverified

- **Observed:**
  - `git fetch` and `git archive origin/main` of the app; reads of every route file and of `src/agent/*`, the contracts and the golden-path components;
  - a regex import-reachability scan;
  - `cmp` and SHA-256 of the pins against backend HEAD;
  - backend reads of `app-api.ts`, `app-approvals.ts`, the relevant parts of `telegram-owner-do.ts`, `devices.ts`, `threads.ts` and the `core.ts` diff;
  - `git merge-base` for `f5182064` and `500c1dcb`;
  - `gh pr list` and `gh pr view` for the app.
  - For C1–C6:
    - `HealthKitManager.swift` and `batch.ts` reads;
    - the push custody migration and the session TTL migration;
    - `telegram-owner-do.ts` on `origin/l2/p3a-app-proactive` (`e1ab2881`);
    - one unauthenticated GET of staging `/healthz`;
    - `git log` on backend `core.ts`.
- **Not run:**
  - any build, test or Simulator run of the app (the L4 handoff reports `pnpm test` 569 passed at `46e9e669`; not re-run);
  - any authenticated staging call;
  - any device run.
- **Inference:** labelled inline.
