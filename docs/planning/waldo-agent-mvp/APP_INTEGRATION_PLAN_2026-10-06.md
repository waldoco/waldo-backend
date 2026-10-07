# Waldo app ↔ owner agent integration plan (2026-10-06)

Status: **plan only**. Candidate roadmap, not authority (see `CLAUDE.md`). Nothing here authorizes code, migrations, deployment or secrets.

Pins: backend `a43a4152` (waldoco/waldo-backend; the local remote still says Pin4sf/waldo-backend, which GitHub redirects; worktree `claude/waldo-agent-app-integration-61c8cb`); app `895ed6e4` (Pin4sf/waldo-app local `main`, plus untracked `.agents/` and one WIP migration); device-bridge PRs #771 `b7d1cdfd` and #772 `3e7a750c` (both draft); bridge contract in waldoco/Waldo-Kennel `docs/contracts/waldo-device-bridge-v0.2.3.md` @ `1699e764`.

Labels: **SOURCE** = read in source at the pins above (✓ = re-read by the plan author; others read by a research subagent with file:line cited). **UNVERIFIED** = not observed. **CI** and **STAGING**: no claim in this document carries either label. No test, build or staging request was run for this plan.

---

## (a) Current state

### Corrections to the prompt's premises

| Prompt premise | Finding | Label |
|---|---|---|
| The app's fabricated chat success is still present | Fixed at app HEAD. App PR #12 (`bdb0b856`) removed `onError`/`prototypeReply`. `src/chat/useChat.ts:65-68` now shows "Waldo couldn't confirm a reply…". | SOURCE |
| Legacy chat reads a caller-supplied thread with no owner check | Fixed at app HEAD. `supabase/functions/agent/chat.ts:66-74` checks `id`+`user_id` and returns 404 `thread_unavailable`. History and updates are owner-scoped (`:100-107`, `:163-170`). The handler still uses the service-role client (`_shared/http.ts:28-35`), and RLS is SELECT-only (`0003_chat_and_memory.sql:90-98`), so the code check is the only guard. | SOURCE |
| There is "the owner Durable Object" | There are **two** owner systems. **System A**: `TelegramOwnerDO`, keyed by `waldo.owners.do_name`. It holds the live Telegram/WhatsApp/console agent, conversation tree, claims memory and approvals ledger. **System B**: `RunLoopDO` + `WaldoCoordinator`, keyed `owner-root:sha256(…)` (`runtime/src/index.ts:252-259`), reached by the bearer responsibility API. A and B share no conversation, memory or DO state. | SOURCE |

### Backend (waldo-backend @ a43a4152)

- **Identity, System A.**
  - Presences live in `waldo.presences` with a unique active `(provider, subject)` (`supabase/migrations/20260924120000_waldo_owners.sql:14-23`). The provider CHECK already allows `'ios'` (`:17,49`), but the runtime `PresenceLookupProvider` excludes it (`identity/owner-directory.ts:15-16`).
  - `redeem_link_code` unlinks the owner's prior active presence **per provider** before inserting (`…waldo_owners.sql:80-95`). A second presence for the same provider therefore displaces the first. SOURCE.
- **Console auth.**
  - Supabase email OTP → `owner_for_auth(auth_user_id, …)` → `do_name` ✓ (`20260925130000_waldo_open_signup.sql:32-70`).
  - Two cookies, both `HttpOnly; SameSite=Strict; Path=/console`, 12 h (`channels/console-signin.ts:291-295`). `waldo_owner` is HMAC-signed and its TTL is enforced server-side (`identity/console-auth.ts:126-149`).
  - Cookie-only. JSON views exist "for the future app client" but are cookie-gated (`channels/console.ts:218-219`). SOURCE.
- **Owner provisioning.**
  - `owner_for_auth` returns an existing active owner by `auth_user_id` ✓.
  - New owners need the invite path, a confirmed email and a code hash (`20261002170021_waldo_optional_phone_signup.sql:21-39`) ✓.
  - An app user who signs in with Apple/Google and has no invite has **no owner row**. SOURCE ✓.
- **Bearer auth precedent, System B only.**
  - Calls Supabase `/auth/v1/user` plus a session RPC. It decodes the JWT payload **without** local signature verification and rejects tokens with more than 2 h TTL (`responsibility/supabase-authority.ts:32-86,123-148`).
  - Gated by `RESPONSIBILITY_PUBLIC_API_ENABLED`, which is absent from the `wrangler.jsonc` vars. Whether it is set as a secret is UNVERIFIED.
  - No JWKS verifier exists. `mint-agent-jwt` is undeployed with no consumers. SOURCE.
- **Worker routes** (`runtime/src/index.ts:128-205`): `/telegram/webhook`, `/whatsapp/webhook`, `/console*`, `/c/<ticket>`, OAuth callback, `/public/responsibilities*` (versioned `application/vnd.waldo.responsibility.v0.N+json`, otherwise 406). There is no `/app/*` route and no SSE endpoint anywhere. SOURCE.
- **Turn serialization in the owner DO.**
  - `serial()` is an in-memory promise chain (`telegram-owner-do.ts:237,1100-1104`). It wraps alarm work (which drains the Telegram inbox), console actions/controls and WhatsApp turns. SOURCE.
  - The Telegram durable inbox (`channels/telegram-owner-inbox.ts`) is Telegram-shaped:
    - Record id is `${bot}:telegram:${updateId}`.
    - `admit` writes `telegram_subject` and throws on a different subject (`:35-49`) ✓.
    - An app lane cannot reuse it without generalization. SOURCE ✓.
  - Telegram callback-query approvals are drained through that inbox under `serial()` (`telegram-owner-do.ts:440-441`) ✓. WhatsApp has no durable inbox (`:590-609`).
  - Conversation: one tree per DO in flat `conv:` keys. Each entry carries `surface`, which already admits `'app'` (`contracts/src/runtime/conversation-entry.ts:12-25`), and `chatId = ${surface}-${chatId}` (`channels/telegram-turn.ts:13`). Parents chain only within one ref. SOURCE.
- **Channel seams.**
  - `ChannelAdapter` (`contracts/src/adapters/channel.ts:167-171`, literals include `apns` and `in_app`) and `DeliverySink` (`contracts/src/runtime/sink.ts:21-24`) have **no live runtime implementation**. Only fakes and `FailClosedSink` exist.
  - Telegram sends through bespoke `TelegramOwnerApi` plus `TelegramFinalOutbox` (`pending|attempting|delivered|quarantined|blocked` + reason; `attempting` is persisted before I/O; on restart → `quarantined/restart_during_send`). SOURCE.
  - There is no APNs/Expo sender anywhere. `public.user_devices` exists (`0005_integrations.sql:7-24`), but it references legacy `users(id)` and only `service_role` may write it. The runtime holds no service-role key (ADR-0052 pattern), so the runtime cannot use this table. SOURCE ✓.
- **Approvals desk** (`channels/approvals.ts`), a SQLite `ledger` in the owner DO.
  - The Telegram card carries `callback_data a:|e:|s:|u:<id>`.
  - Decide does a **read check** (`entry.status !== expected` → "Already handled.", `:187`) ✓.
  - Only `task_sources` and `browser_submit` do an atomic `UPDATE … WHERE status='open'` + `changes()==1` before the external await (`:203-204`, `:218-220`) ✓.
  - Email relies on Message-ID Sent-folder reconciliation, calendar on etag, message_send on an idempotency key.
  - The console can approve only full-review `calendar_change`; email/message can only be dismissed (`console.ts:242-244`).
  - `task_sources`, a read-scope change, is also an approval kind. SOURCE.
- **Memory/forget.**
  - Claims live in owner-DO SQLite, scoped by the DO. Forget is barrier-first and purge-ordered (`memory/claims.ts:549-570`).
  - A model-proposed forget applies only when the owner's text matches the `FORGET_INTENT` **regex** (`claims.ts:81-88`). This conflicts with the no-regex-judgment rule → `post-mvp-cleanup`. It is not on this plan's critical path. SOURCE.
- **Health.**
  - `waldo.health_context_read(do_name)` joins `waldo.owners.auth_user_id` to `public.health_context_daily.user_id` and returns `c.freshness` as stored ✓ (`20260928160000_waldo_health_context.sql:12-51`).
  - The migration file contains no consent predicate ✓.
  - The prompt sees zones/descriptors only. Digits and URLs are stripped from drivers/tags (`channels/health-context.ts:73,97-201`).
  - Meal/workout `health_logs`, including calorie estimates, are rendered into ledger/prompt text (`channels/health-log.ts:71-86`). Whether that complies with ADR-0081 is UNVERIFIED.
  - The backend has no HealthKit ingest endpoint. SOURCE.
- **Observability.**
  - `TurnLogEntry` fields include trace, hop, owner, owner_id, owner_identity, code and guard.
  - Trace keys are `tg-<update_id>` and `console-<uuid>`.
  - Langfuse OTLP carries environment, release (`WALDO_RELEASE`), channel, `userId=${channel}:${owner}`, `sessionId`.
  - Production forces text capture off (`observability/trace-privacy.ts:64-65`). SOURCE.
- **Other in-flight work:** `packages/imessage-relay` (commits `837edb51`, `e701e3c3`, "gated owner admission"). Owned by another engineer; this plan does not touch it. SOURCE ✓.

### Device bridge PRs #771/#772 (draft, author Developerr86, base `beta-mvp`)

- **Contract status.** The contract is "presented for owner sign-off"; the backend lane has not accepted it.
- **Pairing.** Codes are minted from a console session + CSRF. Redeem `POST /devices/redeem` is signed by a new device Ed25519 key and creates a `waldo.devices` row (backend `device_id`, `owner_id`).
- **Connect and presence.** `GET /devices/connect` is signed and opens a hibernatable **WebSocket** on a per-device `DeviceBridgeDO`. A 30 s heartbeat is required; a device counts as online for 90 s after a heartbeat.
- **Revoke** = DB delete + DO fence + 1008 close. Queued commands become `cancelled`. Sent/acked commands are not reconciled.
- **Mac-specific parts.** Capabilities (`machine_state_query`, `notify_local`) and `contract_version='0.2.3'` are pinned by DB `CHECK`. There is no RunLoop/agent tie.
- Source for the above: PR diffs. The PR bodies themselves mark hibernation, Kennel TLS, pgTAP and staging as unverified.

### App (waldo-app @ 895ed6e4)

- **Agent calls.**
  - `src/agent/agentClient.ts:74-116` calls only the app's own Supabase functions `agent`/`calendar`.
  - KAIROS (`src/kairos/kairosClient.ts:23-31`) posts to the app's legacy `runtime/waldo-worker`. That worker routes by the **caller-supplied** `userId` via `idFromName` (`runtime/waldo-worker/src/index.ts:20-23`): an isolation defect. It is inert because no `EXPO_PUBLIC_KAIROS_URL` is configured. SOURCE.
- **Auth.**
  - Supabase Auth with PKCE. The session is in SecureStore (`src/supabase/storage.ts`). Owner = `auth.users.id`.
  - Project `togdshayyxycitzckpqv` is hardcoded (`src/supabase/client.ts:7-8`) ✓.
  - `signOut` purges nothing: Zustand, query cache, global SQLCipher DB and SecureStore prefs all remain (`src/supabase/auth.ts:83-85`). There is no route guard on `app/(app)/_layout.tsx`. SOURCE.
- **Health.**
  - Sync is launch/mount-driven (`src/modules/health/useHealthMetrics.ts:18-29`).
  - Sync defaults on (`src/health/sync/syncPrefs.ts:13,15`).
  - The server **auto-grants consent** (`supabase/functions/health-sync/index.ts:143-150`) and hardcodes `freshness:'fresh'` (`:159`).
  - Legacy chat sends "Form 76…" numeric context to OpenAI (`agent/chat.ts:21-29,127-134`).
  - On device: raw IBI in SQLCipher (global DB, not per account). Daily aggregates are uploaded. SOURCE.
- **Push.** `expo-notifications ~0.32.17` is installed but used only for `requestPermissionsAsync`. No token registration exists. SOURCE.
- **Approvals UI.** `HandoffCard` is inert and behind `flags.handoff=false`. There is no Activity screen, offline handling or streaming. SOURCE.
- **WIP migration.** The untracked `supabase/migrations/20260928182541_health_context_daily_only.sql` is **byte-identical** to the backend's committed migration of the same name ✓.

### What I could not verify

- **UNVERIFIED: whether the staging Worker's Supabase project is the app's project.**
  - The backend `SUPABASE_URL` is a secret, not in `wrangler.jsonc`.
  - Indirect evidence suggests the app and backend share one Supabase schema: `health_context_read` joins app-written `health_context_daily` to `waldo.owners.auth_user_id`, and the identical migration file exists in both repos.
  - Not observed.
- **UNVERIFIED:**
  - Whether the project signs JWTs with asymmetric keys (JWKS) or the legacy HS256 secret.
  - Staging state of any route, flag or table.
  - Whether `RESPONSIBILITY_PUBLIC_API_ENABLED` is set.
  - Live APNs behavior.
  - Bridge hibernation behavior.

---

## (b) Recommended architecture (one page)

**Principle: the app is another surface of the System A owner DO.** Telegram's conversation tree, claims memory, approvals ledger and health context are there. Routing the app to System B (`RunLoopDO`), which today has the only bearer API, would create exactly the second agent this work exists to prevent. This conflicts with the `CLAUDE.md` line "Keep WaldoCoordinator, the trusted RunLoop…". The owner must rule on it (decision D1). The plan borrows System B's bearer-verification *idea*, not its DO routing.

```
iPhone app ── HTTPS (Bearer Supabase access token, X-Waldo-Install, X-Waldo-App-Version)
   │
   ▼
Worker /app/v1/*                         (new route family, versioned media type)
   1. verify Supabase JWT (JWKS locally if asymmetric; else /auth/v1/user)
   2. signed RPC app_owner_for_auth(auth_user_id, install_id, session_id)
        → do_name only if owner active AND install active (never provisions, never trusts body)
   3. forward to TELEGRAM_OWNER_DO.idFromName(do_name) with x-waldo-do-name, install, trace
   ▼
Owner DO (System A)
   • app turns admitted to a durable, surface-generic owner inbox lane → same serial() drain
     as Telegram → same owner-turn → same claims/approvals/conversation tree (surface='app')
   • reply recorded in the existing conversation store (surface=app) that the app reads; the record IS the answer (a separate event cursor only after contract review)
   • push = hint only: AppPushOutbox → APNs (states mirror TelegramFinalOutbox)
   • approvals: same desk; app decision enqueued into serial() like a Telegram callback
```

- **Identity.** The Supabase account session is the owner credential, the same subject the console resolves. A per-install row (`waldo.app_installs`, signed-RPC writer only) carries `install_id`, the bound Supabase `session_id`, state, generation and the push token. Revoke is per install. The app does **not** reuse device-bridge pairing.
- **Transport.** Plain HTTP commands with client idempotency keys, plus cursor reads: `GET /app/v1/events?after=` with short long-poll. SSE comes later and is additive. No WebSocket. Push wakes the app; the cursor read is the truth.
- **Legacy.** Server-side enforced cut-over: the legacy `agent` chat function refuses migrated owners. A client flag alone cannot stop old builds.
- **Health.** User-stated energy/context through chat comes first: it is already a memory/claims path. HealthKit-derived context reaches the agent only after explicit, purpose-scoped, revocable consent. Freshness is computed server-side, and the existing `health_context_read` is gated on that consent.
- **Plug-in seam for other channels.** The app is the *second* real adapter for two things: (1) a surface-generic durable owner inbox lane, (2) a per-surface final outbox with honest terminal states. Once both Telegram and app run through them, extract them as the contract WhatsApp/iMessage owners implement. Per `language.md`, two adapters make a seam real.

---

## (c) Answers

**1. Identity.**
- **Binding.**
  1. The app holds a Supabase session (same `auth_user_id` the console resolves).
  2. On first launch after sign-in it registers an install: `POST /app/v1/installs` with a client-generated install UUID kept in SecureStore.
  3. The Worker verifies the JWT, then calls a signed RPC. The RPC binds `install_id → owner_id` only if `waldo.owners` has an active row for that `auth_user_id`.
  4. No owner row (Apple/Google sign-up, no invite) → typed `403 owner_not_provisioned`. The app shows a truthful "not activated yet" state.
- **Why not reuse pairing.** Do not reuse the console/Telegram cookie or the device-bridge pairing:
  - The app already holds a strong owner credential, so a console-minted 43-character code would be worse UX and add no authority.
  - The bridge presence model (30 s socket heartbeat, 90 s online window) is wrong for iOS backgrounding.
  - Its capabilities and version are pinned to Mac semantics by DB `CHECK`.
  - It is pre-sign-off.
  - Ed25519 keys cannot live in the Secure Enclave.
  - Reuse its *patterns*: hashed single-use codes, generic 401, generation fences.
  - The iOS platform facts above (background socket suspension; Secure Enclave is P-256 only) were not checked in this pass: UNVERIFIED.
- **Why not `waldo.presences` with provider `'ios'`.** `redeem_link_code` keeps one active presence per provider (SOURCE), so a second phone would displace the first. A separate install table avoids changing that Telegram/WhatsApp semantics. Whether multiple phones are allowed is decision D3.
- **Revocation.**
  - Console/app "sign out this device" or "sign out everywhere" → signed RPC sets the install to `revoked` and bumps `owners.admission_revision`; an existing trigger already does this for presences (`20261002120000_…:34-65`).
  - The Worker rejects any request whose install is not active or whose JWT `session_id` differs from the bound one.
  - Account sign-out on the device also calls Supabase `signOut` and purges local stores.
- **Queued work on revoke.**
  - App-lane inbox rows not yet claimed → `quarantined/owner_binding`. This mirrors the Telegram drain, so the behavior already exists for that surface (SOURCE).
  - A running app-originated turn completes or fences under the existing `RunEffectScope` commit.
  - Pending push rows → `blocked/install_revoked`, never sent.
  - Approvals are owner-level, not install-level. They stay open and remain answerable from Telegram/console.
  - Proposed tests: revoke mid-turn; revoke with a queued push; revoked install replaying an old token.

**2. Transport.**
- **Commands.** `POST /app/v1/turns {client_message_id, text}` → `202 {turn_ref, cursor}` once durably admitted. Before that, the app shows "sending" and never a reply.
- **Reads.** `GET /app/v1/events?after=<cursor>` (long-poll ≤25 s) returns published replies, turn status changes and approval cards. `GET /app/v1/snapshot` covers a cold start or an expired cursor (resnapshot, never replay arbitrary chunks).
- **Why not sockets or SSE first.** iOS suspends background sockets (UNVERIFIED platform fact), and the bridge already shows the socket presence model failing there. SSE is an additive v1.1 once the cursor contract holds.
- **Where sessions end.** Auth and owner resolution happen in the Worker, as the console does today. The DO re-checks install state and generation inside `serial()` before admitting a turn or decision; this is defense in depth against revoke races.
- **Serialization.** App turns enter the same durable inbox ordering and `serial()` drain as Telegram turns. Sequence order across surfaces is the admit order. `/stop` from any surface targets the active run.
- **Prerequisite.** The current inbox is Telegram-shaped (`admit` pins `telegram_subject`; SOURCE ✓), so a surface-generic lane is a prerequisite. That is the riskiest edit in the plan; see slice B1.

**3. One agent: minimal path and cut-over.**
- **Minimal path.**
  1. Worker `/app/v1/turns`.
  2. Owner resolution through the existing `owner_for_auth` mapping (read-only variant).
  3. System A DO app lane.
  4. Existing `owner-turn` (same ContextComposer, claims, approvals desk) with `surface='app'`.
  5. Reply recorded in the existing conversation store (`conv:<seq10>`, `surface='app'`) and read back by the app. B1 builds no new event log.
- **Cut-over order** (one command path at a time):
  1. **Chat** (read/converse) for one staging owner.
  2. **Approvals** (answer existing cards).
  3. **Push.**
  4. **Calendar timeline read** (replace `calendar` function reads with an owner-DO projection).
  5. **Propose/commit**, which the legacy `agent` function did. This retires last, because the DO's calendar change is already an approvals-desk kind.
- **Enforcement.**
  - Per step, the backend owns an allow-list (`owner_settings.app_surface_v1`, staging only).
  - The legacy `agent` function refuses chat for allow-listed owners (`409 migrated_surface`), so one owner never has both engines.
  - The app chooses its path from the server-returned capability list, not a local flag.
- **Rollback.** Flip the allow-list entry off. The legacy function resumes for that owner; the DO path returns `409 surface_not_enabled`. No data migrates between engines in either direction: legacy `chat_threads` stay where they are, and the app UI shows an "earlier conversation" divider instead of merging them. Legacy deletion only happens after parity evidence (app plan `WALDO_APP_BACKEND_INTEGRATION_PLAN.md:35,47-49`, SOURCE).

**4. Approvals.**
- **Rendering.**
  - The app renders cards from the same owner-DO ledger projection the console uses: `GET /app/v1/approvals` and `approval` events on the cursor.
  - Each card shows kind, summary, review text and the allowed actions computed **server-side**.
- **Answering.** `POST /app/v1/approvals/{id}/decision {action, client_decision_id}`. The decision enters `serial()` and calls the same `decide()`.
- **One decision, no double apply.**
  1. **Prerequisite (slice B3).** Every kind gets the atomic compare-and-set before any external await. It reuses the existing `uncertain` status as the claim, exactly as `browser_submit` does (SOURCE ✓), so no new status leaks into console/dashboard projections. Undo (`u`, expected `done`) gets the same claim.
     - Today email/calendar rely on the read check plus `serial()` ordering. That holds within one live DO instance (UNVERIFIED). After a crash mid-await the row is still `open`, which falls back to reconciliation (Message-ID / etag) instead of a fence.
  2. **The losing surface gets "Already handled".**
     - When the app decides, the DO best-effort edits the Telegram card's inline keyboard to empty (existing `editMessageReplyMarkup` call).
     - A late Telegram tap gets "Already handled." (existing).
     - A late app tap gets `409 already_decided {status}`.
  3. `client_decision_id` deduplicates app retries.
- **Parity.** Start the app at **console parity**: approve full-review calendar changes, and dismiss email/message sends. Approving sends from the app is a later slice after B3, because sends are irreversible.

**5. Notifications.**
- **What is pushed:** only events that need the owner — a new approval card, an agent reply while backgrounded, a terminal failure of something they asked for. Each push passes the existing delivery gate (`computeAdmission` caps, cooldown and budget; `degrade` already strips `apns`; SOURCE).
- **Lock-screen text:** fixed, content-free presets, e.g. "Waldo has a reply" / "Waldo needs your decision".
  - No names, health, amounts or email subjects.
  - `mutable-content` is off.
  - The payload carries only an opaque `event_ref`; the app fetches content after unlock with auth.
- **Ledger states** (`AppPushOutbox`, mirroring `TelegramFinalOutbox`): `pending → attempting (persisted before I/O) → provider_accepted | quarantined(send_unknown | restart_during_send | provider_rejected_terminal) | blocked(install_revoked | no_token | gate_held | notifications_disabled)`.
  - APNs 200 = **provider accepted**, never "delivered" or "seen".
  - 410/`Unregistered` → token invalidated, row `blocked/token_invalid`.
  - APNs status semantics are UNVERIFIED in this pass; confirm against Apple's current docs in B5.
  - "Seen" exists only when the app later reads the event cursor.
  - The Activity view renders these words literally.
- **Registration:** `expo-notifications` `getDevicePushTokenAsync` (native APNs token, no Expo push service). The API name is UNVERIFIED: `node_modules` is not installed in the app checkout. It is stored per install along with its APNs environment (sandbox or production).
- **Owner-supplied:** the APNs `.p8` signing key, Key ID and Team ID are owner-supplied secrets. This plan does not handle them.

**6. Health.**
- **First value without HealthKit.** The owner states energy, sleep feel and constraints in chat. This already flows through owner-turn → claims memory as correctable context, and the agent plans with it. Nothing new is needed beyond honest copy.
- **Before any HealthKit-derived data reaches the agent:**
  1. The app defaults sync **off** (`syncPrefs.ts:13,15` flip).
  2. Remove server auto-consent (`health-sync/index.ts:143-150`). Consent is an explicit owner act with purpose `agent_context`, a consent epoch and revoke.
     - **One consent store.** Legacy `public.user_consents` already exists (`0001_identity.sql:64-72`, SOURCE ✓) and the app's `health-sync` writes it. Extend it with one named writer, or replace it under ADR review. Never add a second consent table.
  3. Gate `waldo.health_context_read` on an active consent row for that purpose (SOURCE ✓: no gate today, and the Telegram agent already reads this table).
  4. Compute freshness server-side from `day`, `updated_at` and the owner timezone. Ignore the app's hardcoded `'fresh'`. Stale or missing → absence, never invented readiness.
  5. Retire the legacy numeric-context-to-OpenAI path with the legacy chat cut-over (Q3).
  6. Revoke = stop ingest + hide existing rows from the read path immediately + purge per ADR-0081/0082. Destination rules are in ADRs not present in this repo, so the exact purge rule is UNVERIFIED.
- **Stays on device:** raw HealthKit samples, IBI/HR intraday (SQLCipher), the raw values behind computed pillars and per-sample timestamps. Only daily derived context crosses, after consent.
- **New on device:** a per-account DB namespace, or purge on account switch, because today's SQLCipher DB is global (SOURCE).
- **Open question:** `health_logs` calorie estimates in prompt/ledger text need an ADR-0081 compliance check (UNVERIFIED).

**7. Isolation tests (two owners, A and B; all proposed, red first).**
- **Worker**
  - A's JWT with any body/header naming B's owner, `do_name`, thread or install → still routes to A, or is rejected. The owner comes from the token only.
  - A's JWT with B's `install_id` → 403. A revoked install → 401. A JWT whose `session_id` ≠ the install's bound session → 401.
  - A JWT for an auth user with no owner row → `403 owner_not_provisioned`; no DO is created (assert no `idFromName` call).
- **Events and approvals**
  - A's cursor or `snapshot_id` used by B → 404/empty, never A's events.
  - B's request for A's approval id → 404. The response is identical to an absent id.
  - A decides and B replays the same `client_decision_id` → no effect on A's ledger.
- **Memory**
  - "Forget X" from A's app removes A's claim; B's identical claim is untouched.
  - A memory read through `/app/v1` never returns `conv:` entries of another DO. This is structural, but asserted.
- **Health:** A consented and B not → B's turn has no health material even though B has `health_context_daily` rows.
- **Device**
  - Sign out A, sign in B on the same phone → no A threads, query cache, SQLCipher rows or push token remain bound to A. A push for A arriving after the switch is dropped by the app.
  - The legacy `agent` chat with A's JWT and B's `thread_id` → 404 (regression test for the app PR #12 fix).
- **Kept from earlier finding:** KAIROS `idFromName(payload.userId)` stays frozen and unreachable. Test that no build config sets `EXPO_PUBLIC_KAIROS_URL`.

**8. Offline and background.**
- **States are app-local and named honestly:** `Not sent (offline)`, `Sending…`, `Waldo received it` (202), `Waldo is working` (turn status event), `Reply`, `Waldo couldn't finish — nothing was changed` / `outcome unknown — check Activity` (terminal status from server).
- **No synthesized reply text, ever.** The existing app fix stays.
- **Unreachable after admission:** the app keeps polling with backoff. On reconnect it reads the cursor; the server, not the client timer, decides the outcome.
- **Unsent drafts:** kept locally, re-sent with the same `client_message_id` (idempotent at admit).
- **Background:** nothing is processed on the phone. The push hint makes the app read the cursor when the owner opens it. HealthKit background delivery is out of scope until consent ships, and later it is a separate slice.

**9. Observability (per app turn, staging).**
- **Trace key:** `app-<client_message_id>` (UUID), the same pattern as `console-<uuid>`.
- **Propagation path:** Worker log → DO `TurnLogEntry.trace` → inbox record → `owner-turn` hops → `AppPushOutbox` row → APNs `apns-id` (stored, never a metric label).
- **Fields:**
  - `channel='app'`, `surface='app'`
  - `owner` / `owner_identity` (existing redaction drops email)
  - `install_ref` (hash of install_id)
  - `release=WALDO_RELEASE`
  - `app_version` / `app_build` and `contract_version` (from request headers)
  - `inbox_sequence`, `run_id`, `outbox_state`, `gate_verdict`
  - `push_state`
- **Langfuse:** `userId=app:<owner>`, `sessionId=app:<owner>`. Production text capture stays forced off.
- **Metric labels** only from bounded enums (`channel`, `outbox_state`, `gate_verdict`, `contract_version`); ids never.
- **Staging trace acceptance:** one query by trace key shows admit → claim → model → reply-published → push state, with no gap.

**10. Slicing.** See (d).

**11. Top five risks and the cheapest experiment for each.**

| # | Risk | Cheapest experiment |
|---|---|---|
| 1 | The app's Supabase project differs from the backend's, or app users have no `waldo.owners` row. Q1 then changes completely (token exchange instead of shared subject). | The owner compares the staging Worker's `SUPABASE_URL` secret project ref with `togdshayyxycitzckpqv`, then runs `owner_for_auth` for one staging test account that signed in via the app. Read-only, about 10 min. |
| 2 | Authority conflict: `CLAUDE.md` says keep Coordinator/RunLoop, but the live agent is System A. Building the app on A deepens the A/B split; building on B forks the agent. | A 30-minute owner ruling (D1) plus a grep of System B production callers. No code. |
| 3 | Generalizing the Telegram-shaped inbox in a 2,376-line `telegram-owner-do.ts` regresses Telegram ordering, recovery or quarantine. | A local spike branch that only adds `surface` to `InboxRecord`/id, then runs the existing inbox/drain tests unchanged. If more than a handful break, design a separate app inbox that feeds the same `serial()` instead. |
| 4 | Supabase JWT verification mode is unknown. HS256 would force a per-request `/auth/v1/user` network hop, adding latency and a dependency. | The owner checks the Auth "JWT signing keys" setting on the staging project. If asymmetric, a local JWKS verify unit test against a staging-issued token. |
| 5 | Cross-surface double apply on email/calendar after a crash mid-await. Today only `serial()` plus reconciliation protects it. | A red unit test: decide(email) with a fake sender that hangs, a simulated restart, then a second decide from another surface. Assert one send attempt. This test is slice B3's first commit. |

Also watched, but not in the top five:
- APNs sandbox vs production token mismatch on TestFlight. Experiment: one physical-device sandbox push on staging.
- The `FORGET_INTENT` regex (post-mvp-cleanup).
- `health_logs` numbers in prompt text (ADR-0081 check).

---

## (d) Slices

Ownership rule:
- **One integration owner** holds `packages/runtime/src/channels/telegram-owner-do.ts`, `packages/contracts/**` and `supabase/migrations/**`. Slices touching them merge in the listed order.
- App slices touch only waldo-app.
- Every slice runs `git diff --check`, `pnpm@10.34.4 verify:guards` and the full `verify` wall.
- Staging evidence is recorded as PASS/FAIL/NOT RUN at an exact SHA.

| Slice | Owner | Files (primary) | Red tests first | Acceptance | Staging trace | Parallel with |
|---|---|---|---|---|---|---|
| **A0 App containment remainder** | App eng | `src/health/sync/syncPrefs.ts`, `supabase/functions/health-sync/index.ts` (drop auto-consent), `src/supabase/auth.ts` (purge on sign-out), `app/(app)/_layout.tsx` (guard), KAIROS freeze | Default pref → false; ingest without consent row → 403; sign-out clears stores, query cache and SQLCipher namespace; unauthenticated deep link → sign-in | No health upload without explicit opt-in; account switch leaves no residue (physical device) | `health-sync` 403 without consent | All backend slices |
| **B0 App v1 contract** | Integration owner | `packages/contracts/src/public/app-v1/*` (turn, events, snapshot, approvals, install, push, error codes) + fixtures | Zod valid/invalid pairs per DTO; error shape has no internals | Released, versioned media type `application/vnd.waldo.app.v1+json`; generated client buildable | n/a | A0, B3, B6 |
| **B1 App ingress tracer bullet ★ first deliverable** | Integration owner | `runtime/src/index.ts` (route), new `identity/app-auth.ts`, new `channels/app-ingress.ts`, app inbox lane (generalized `telegram-owner-inbox.ts`; **default if the Risk 3 spike breaks Telegram tests:** a separate app inbox feeding the same `serial()`), migration `app_owner_for_auth` (read-only, never provisions). The reply is read from the existing conversation store's monotonic `conv:<seq10>`/`conv-count` filtered to `surface='app'`; **no new event log in B1** | No/expired/forged token → 401; owner from token only; unprovisioned → 403 without DO creation; duplicate `client_message_id` → one turn; Telegram + app turns interleave in admit order; existing Telegram inbox tests unchanged | On staging behind `APP_INGRESS_ENABLED` + per-owner allow-list, a curl with a staging test account's token sends a turn and reads the reply. The reply cites a memory claim created earlier via Telegram, which proves one memory. The staging deploy needs its own explicit authorization | Trace `app-<uuid>`: admit → claim → turn hops → reply in conv store | A0, B3, B6. **Before B2/B4/B5**
| **B2 Install registry + revoke** | Integration owner | migration `waldo.app_installs` + signed RPCs (register, revoke, revoke-all, touch), `app-auth.ts` install check, console device list/revoke action | **Contract/ADR gate first** (new store `waldo.app_installs`, signed-RPC writer). Revoked install → 401; session_id mismatch → 401; a fresh sign-in on the same active install re-binds the session (deliberate rebind, not a lockout); revoke mid-turn → turn fences, queued app rows quarantined `owner_binding`; pgTAP: anon cannot read/write rows | Owner revokes a phone from the console; the next app request fails; Telegram is unaffected | `install_revoked` event in trace | B3, B6 (after B1) |
| **B3 Approval CAS for all kinds** | Backend eng | `channels/approvals.ts` (+ its tests) only | Hung-send + restart + second decide → one effect (Risk 5); concurrent decides on calendar/email/message → one effect | Every kind, including undo, claims via the existing `uncertain` status atomically before external I/O (no new status) | n/a (unit + Workers pool) | B0, B1, B6, A0 |
| **B4 App approvals API + card sync** | Integration owner | `app-ingress.ts`, `telegram-owner-do.ts` (enqueue decision into `serial()`), approvals projection reuse | App decide then Telegram tap → "Already handled"; and the reverse; replayed `client_decision_id` → idempotent; B's id from A → 404 | Console parity in the app; the Telegram card keyboard is cleared after an app decision | Decision trace spans both surfaces | B5 (after B1+B3) |
| **B5 APNs push sink** | Backend eng + integration owner for the DO hook | new `channels/apns-*.ts`, `AppPushOutbox`, delivery-gate wiring, token registration RPC (B2 table) | 200 → `provider_accepted` (not delivered); 410 → `token_invalid`; restart mid-send → `quarantined/restart_during_send`; revoked install → `blocked`; payload contains no content strings | A physical-device staging push for a new approval with preset text; the ledger shows the honest state | `push_state` on trace | B4 (after B2). Needs owner-supplied .p8 and a **contract gate** for `AppPushOutbox` as a new DO aggregate |
| **B6 Health consent gate + freshness** | Backend eng | **ADR/contract gate first** (consent store, writer and purpose under ADR-0081/0082). Migration extends `user_consents` (no new table) + gated `health_context_read`; `channels/health-context.ts` freshness from timestamps | No consent → no health material even with rows; stale day → absence; revoke → next turn has none | Telegram and app turns see health context only for a consenting owner | `health:absent_no_consent` hop code | B0, B1, B3, A0 |
| **A1 App chat on /app/v1** | App eng | generated client, `src/agent/*` replacement for chat, `src/chat/*` states (Q8) | Offline → "Not sent"; 202 then timeout → "Waldo received it", no reply text; idempotent resend | A physical device chats with the same owner agent as Telegram on staging | `app_version` on trace | A2–A4 once their backend slice lands |
| **C1 Legacy chat refusal** | Integration owner + app eng | legacy `agent` function allow-list check, `owner_settings.app_surface_v1`. This is a cross-repo coupling: an app-repo edge function reading a backend-owned table works only on a shared project (D2) | Allow-listed owner → legacy chat 409; flag off → legacy resumes | **Lands before the first owner is allow-listed**, so old TestFlight builds can't keep a second engine alive; rollback rehearsed on staging for one owner | Both directions traced | Ships with B1's allow-list, before A1 reaches TestFlight |
| **A2 App approvals UI / A3 push registration + Activity / A4 health consent UI** | App eng | `HandoffCard` replacement, Activity screen, `expo-notifications` token, consent screen | Per Q4/Q5/Q6 | Physical device | per slice | each after B4/B5/B6 |
| **B7 Extract channel plug-in seam** | Integration owner | contracts: owner inbox lane + per-surface final outbox interface; docs for WhatsApp/iMessage owners | Telegram + app both pass one conformance suite | A third surface can be added without editing `telegram-owner-do.ts` | n/a | After B1+B5 |

**Day-0 gates (owner actions, no code):** the D1 ruling, the D2 / Risk 1 project check, the Risk 4 JWT-mode check, and the Risk 3 local spike. B1 starts only after all four.

Critical path: **gates → B1 + C1 → (B2, B4) → B5 → A2/A3**.
- **First deliverable, under a week:** B1 alone, curl-driven, staging only, behind a flag.
- **Parallel lanes that share no files with B1:** A0 (app repo), B3 (`approvals.ts` only), B6 (health migration + `health-context.ts`).
- **Ordering constraints:** B0 should land in the first two days so A1 can start. B1's inbox generalization is the one high-risk edit; run Risk 3's spike before committing to it.

The v1 event cursor (`/app/v1/events` in Q2) would be a new DO aggregate. It goes through contract review only after B1 shows the conversation store isn't enough (approval and status events). It is not built speculatively.

Out of scope: payments, automatic spending, plan changes, HealthKit background delivery, SSE, WhatsApp/iMessage implementation, device-bridge changes, the `FORGET_INTENT` regex replacement.

---

## (e) Open decisions for the owner

- **D1:** Should the app attach to the live System A owner DO (`TelegramOwnerDO`), with System A/B convergence handled as a separate track, despite the `CLAUDE.md` "keep Coordinator/RunLoop" line?
- **D2:** Is the staging Worker on Supabase project `togdshayyxycitzckpqv`? If not, which project is the identity root for app users?
- **D3:** May an owner have more than one active phone install at once?
- **D4:** Should Apple/Google sign-in users without an invite get a "not activated" app state, or should app sign-in become an invite-redeem path?
- **D5:** Should the app conversation show Telegram history (one cross-surface thread), or keep surfaces separate with shared memory only?
- **D6:** May the app approve email/message sends in v1, or start at console parity (calendar approve, sends dismiss-only)?
- **D7:** Which exact lock-screen preset strings are approved for push?
- **D8:** Who supplies the APNs `.p8` key, and is TestFlight on the sandbox or production APNs environment for staging?
- **D9:** Does the device bridge stay Mac-only, with no app reuse? This needs a note to the bridge author so its contract doesn't grow an iOS branch.
- **D10:** Should calorie numbers in `health_logs` prompt text be kept, banded or removed under ADR-0081?
- **D12:** `task_sources` is an approval kind today, but it is a read-scope change. Should it stay, given the rule that approvals are only for writes, sends and spend?
- **D11:** Who is the single integration owner for `telegram-owner-do.ts`, contracts and migrations during this work?
