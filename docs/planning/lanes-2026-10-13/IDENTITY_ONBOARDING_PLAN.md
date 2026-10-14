# Identity and onboarding plan: reset, invites, Google profile, first conversation

Read-only planning lane. Tree: `beta-mvp` @ `929fd79c` (14 Oct 2026). This is a candidate plan, not authority. Each merge, migration, deploy and deletion needs the owner's go.
Tags: **[v]** read in source at 929fd79c · **[s]** staging fact from the orchestrator · **[i]** inference · **[p]** proposal.
Path keys: `R/`=packages/runtime/src · `M/`=supabase/migrations · `T/`=supabase/tests · `C/`=packages/contracts/src · `D/`=packages/dashboard-app/src · `E/`=supabase/functions/connector-proxy

## 0. Answer first
- **Why "who am I" fails.** No name is stored [s], and no account identity reaches the model.
  - The composer's identity line is `Authenticated owner ${principal}` (`R/context-composer/owner-turn.ts:83`), where the principal is an opaque `prn_<uuid>` (`R/channels/app-api.ts:220`) [v].
  - The profile block shows only owner-grounded claims that came from the owner (`R/memory/claims.ts:19-21`) [v].
- **Blockers found:**
  - The admin's invite cap is a lifetime count of five, and the reset does not lower it (§3).
  - No model tool can set the time zone (§1.6).
  - Proactive work never goes to iMessage (§2, rows 5 and 7).
  - Google sign-in is not built (§1.3).
- **Recommended order:** (vi-a) forwarded-command guard → (iv) admin cap → (i) `profile` scope → (ii) first conversation → (vi) console-link tool, trace ids, proactive iMessage → reset and re-invite → whoever still wants Telegram relinks → (v) Telegram link freeze → (iii) Google sign-in. The first open decision is **D1: which account is the owner's daily Waldo** (§6).

## 1. Today's flow, as built
### 1.1 Invite, sign-in, owner row, do_name, owner object

| Step | What happens | Evidence |
|---|---|---|
| Invite issued | The admin uses `invite.create`, which calls `admin_invite`. A member uses `invite.member`, which calls `issue_member_invite`. The code is 20 characters, stored as SHA-256 only, bound to the recipient's email, and expires in 14 days. The link is `/console/signup#email&invite`, a console URL, not an app deep link. Waldo emails nobody. | `R/identity/invite-code.ts:1-11`; `M/20260928190000_waldo_invite_chain.sql:67-110`; `R/channels/console.ts:136` [v] |
| No in-app invite issuance | The app's control actions are only timezone, proactivity, `channel.unlink`, `google.connect` and `account.delete`. | `C/app/controls.ts:26` [v] |
| Code request | `POST /app/v1/auth/code` calls `signin_allowed`, which admits an existing member or the exact live invite. Supabase `/auth/v1/otp` then runs with `create_user:true`. Unknown addresses get the same answer. | `R/channels/app-api.ts:109-120`; `R/identity/console-auth.ts:128-137`; `M/…invite_chain.sql:13-23` [v] |
| Verify | `POST /app/v1/auth/verify` calls Supabase `/auth/v1/verify`. `owner_for_auth` resolves an existing member first; otherwise `signup_owner_for_auth` rechecks the confirmed Auth email, spends the invite, and inserts the owner with `do_name='owner-'+gen_random_uuid()` plus a default `owner_settings` row. Otherwise the answer is `needs_invite`. | `R/identity/console-auth.ts:105-122`; `M/20261002170021_waldo_optional_phone_signup.sql:28-58`; `R/channels/app-api.ts:122-138` [v] |
| Console verify | Console verify admits existing members only; new console members use `/console/signup`. | `R/identity/console-auth.ts:21-24,138` [v] |
| Session | A server-side session row is signed as an app bearer, which is never accepted as a console cookie. | `R/identity/console-auth.ts:78-86,170` [v] |
| Owner object | The Worker forwards to `OWNER_DO.idFromName(do_name)` with the header `x-waldo-do-name`, on the pseudo-host `telegram-owner`. Inside the object, app turns run through the Telegram-shaped pipeline with the numeric subject `appSubjectFor(do_name)` (7e12 + FNV-1a). | `R/channels/app-api.ts:178-183,222-228` [v] |
| Owner row | `waldo.owners` has id, auth_user_id, do_name, email, state and created_at (later: phone, is_admin, state_version). It has **no name column**. | `M/20260924120000_waldo_owners.sql:5-12`; `M/20260924150000_waldo_admin.sql:2` [v] |

### 1.2 Supported auth methods
- **Email OTP** through Supabase, for both app and console [v, above].
- **Telegram link code** (`/start CODE` or `/link CODE`). It creates a presence, not an account (`R/channels/telegram-link-command.ts:9-11`) [v].
- **Telegram `/console` ticket** for console access (`R/channels/harness.ts:28`; `R/identity/console-ticket.ts:7-10`; `R/index.ts:136-142`) [v].
- **iMessage pairing** binds a presence to an owner who already exists (§4.3).
- `supabase/config.toml` defines no external provider (lines 1-25). It is local config; the staging Auth dashboard was not inspected [i].

### 1.3 Google sign-in or linking: NOT built
- Searching for `GOOGLE_SIGNIN`, `grant_type=id_token` and `signInWithIdToken` finds nothing in `packages/` or `supabase/` [v].
- The O2-A design from 11 Oct exists only in planning notes: backend OIDC with `openid email profile`, PKCE plus nonce, and Supabase `grant_type=id_token`; auto-link on a matching verified email only; `needs_invite` otherwise; behind `GOOGLE_SIGNIN_ENABLED`; one handoff-table migration.

### 1.4 Google scopes: where and which (the connector, not sign-in)
- **Where:** the runtime builds the consent URL with PKCE S256, `access_type=offline` and `prompt='consent select_account'` (`R/connectors/google.ts:89-96`) [v].
- **Which:** `openid email`, calendar.events, calendar.events.freebusy, calendar.calendarlist.readonly, gmail.readonly/send/compose, tasks, drive.readonly, documents/spreadsheets/presentations.readonly, contacts.readonly and contacts.other.readonly. **No `profile`** (`google.ts:8-23,87`) [v].
- **The app is unverified, so only listed test users can connect** (`google.ts:5`) [v].
- **The code exchange runs at the edge on proxy deployments.**
  - The object calls `vault.exchange` (`R/channels/owner-do.ts:2191-2193`).
  - `E/index.ts:89-91` calls the runtime's `exchangeGoogleCode`. That function decodes only `email` from the ID token (`google.ts:126-131`).
  - The proxy replies with `{id,email,scopes}` only (`E/index.ts:40-42`) [v].
  - Names are read today only for contact search (`google.ts:294`) [s].

### 1.5 Where the time zone gets confirmed
- `owner_settings.timezone` defaults to 'UTC' (`M/…waldo_owners.sql:27`) [v].
- Only the `timezone.set` owner control confirms a zone, from the app or the console. It saves the settings, sets the object's `timezone_confirmed` to true, then runs `armOwnJobs(value, now, true)` and rebuilds the runtimes (`R/channels/owner-do.ts:3134-3141`) [v].
- **Arming gate:** `armable` is true when `channel !== 'app'` or the zone is confirmed (`owner-do.ts:2367-2372`). App-channel `ready` arms only once the zone is confirmed; iMessage `ready` arms nothing (`2375-2378`). At fire time, app jobs are held, and event briefs dropped, until a zone is confirmed (`1604`) [v].
- The brief sweep (`armBriefSweep`, `2370`) is gated with the rest. Per [s], it is what registers the Gmail push watch.
- The app reads `timezone_confirmed` (`C/app/controls.ts:70-72`) [v].

### 1.6 Tools the model already has
- `remember`, `read_memory` and `forget_memory` (`R/tools/live/memory.ts:50,76,88`). `remember` needs a verbatim quote from the owner.
- `set_proactivity` and `set_schedule_preference` (`C/tools/permissions.ts:71-72`, allowed on `user_message` at `214,256-257`) [v].
- **No time-zone tool exists** [v]. **No live pin tool exists**: pins are curated by the nightly pass (`R/memory/claims.ts:1103-1109,1115`; `grep pin tools/live/memory.ts` finds nothing) [v].

## 2. Telegram couplings
Classes: **(a)** keep until iMessage is stable · **(b)** freeze now (new links) · **(c)** remove later.

| # | Coupling | Evidence | Class |
|---|---|---|---|
| 1 | Legacy single-owner fallback: `deployOwner` keyed by `WALDO_OWNER_TELEGRAM_ID`, whose do_name is the Telegram id; env fallbacks for the owner id and the console route | `R/identity/owner-directory.ts:37-45`; `R/channels/owner-do.ts:222-233`; `R/index.ts:136-138,208-215` [v] | c, once the legacy numeric owner is gone |
| 2 | Link issuance: `issue_link_code` hard-codes provider 'telegram' and a 10-minute expiry; console button and actions | `M/20260924130000_waldo_console_auth.sql:37-48`; `R/channels/console.ts:220`; `owner-do.ts:1320-1321,1382,1457` [v] | b |
| 3 | Link redemption: `/start` or `/link` → `telegram-webhook.ts:103` → `redeemHashed('telegram')` → `redeem_link_code`, which unlinks the prior presence and inserts the new one | `R/channels/telegram-link-controller.ts:21`; `M/…waldo_owners.sql:80-95` [v] | b |
| 4 | Inbound routing by presence (`route_presence`) and the webhook, polling and listener | `M/…waldo_owners.sql:111-121`; `R/channels/telegram-*.ts` [v] | a |
| 5 | Binding precedence (Telegram before app) and the alarm channel: Telegram if bound, else app. **No iMessage branch.** | `R/identity/owner-binding.ts:14-22`; `owner-do.ts:1508-1516` [v] | a, then c |
| 6 | The app runs on the Telegram-shaped pipeline: numeric `appSubjectFor`, `telegram-owner` host, `telegram-final-outbox` types, `telegram_*` alarm keys | `R/channels/app-api.ts:92,178,222-228`; `R/channels/delivery-routes.ts:1`; `R/scheduler/multiplexer.ts:14`; `R/scheduler/alarm-slot.ts:31` [v] | a. These are names, not behaviour; rename (c) only with the owner-principal work |
| 7 | Proactive delivery: to the app with a plain Telegram copy when both are bound, Telegram-only otherwise; iMessage gets none | `owner-do.ts:1573-1597,2375` [v] | a (see D6) |
| 8 | Slash commands: `/start` and `/link` (row 3); `/console`, which is the only audited delete route for a Telegram-only owner (§4); `/stop` | `R/channels/harness.ts:28`; `owner-do.ts:406,413,489` [v] | /start, /link: b · /console, /stop: a |
| 9 | Console: `telegram.link`/`telegram.unlink` actions, `unlinkTelegram`, and the sign-out text "Send /console … on Telegram" | `R/channels/console.ts:107`; `R/identity/console-auth.ts:162`; `owner-do.ts:1400-1404,1424` [v] | link b · unlink a · copy c |
| 10 | Consent-return surface 'telegram'; native approval buttons on telegram and app | `google.ts:57`; `R/channels/telegram-turn.ts:16` [v] | a |
| 11 | The presence recheck types only telegram and whatsapp | `R/identity/console-auth.ts:58-66`; `owner-directory.ts:14-16` [v] | a |
| 12 | The app contract exposes `telegram:{linked,unlinkAvailable}`; `channel.link_start` is rejected by the schema | `C/app/controls.ts:87`; `C/app/controls.test.ts:20` [v] | a. app.v1 is additive-only, so removal is contract drift (c via L3) |
| 13 | Memory and traces: Telegram inbox enrichment only on the Telegram channel; memory has a comment only | `owner-do.ts:1928-1930`; `R/memory/claims.ts:1316` [v] | a |

## 3. The invite cap
- **SQL:**
  - `admin_invite` requires `is_admin` and refuses at `v_count >= 5` (`M/…invite_chain.sql:100,104-105`).
  - `issue_member_invite` has the same cap (`80-81`).
  - Both refuse an email that has an active owner or a live invite (`81-82,105-106`) [v].
- **The count is lifetime:** `count(*) … where issued_by = v_owner` includes used, revoked and expired invites (`104`) [v].
  - Deleting an owner deletes the invites *that owner issued* (`issued_by … on delete cascade`, `:5`). The admin's own count therefore never drops [v].
  - If the admin has already issued two or more, four re-invites cannot all go through [i]. Check the count in the Admin page's issued counter.
- **TypeScript and UI:**
  - The admin page's `quota()` hard-codes 5 and disables the form (`D/admin-model.ts:23`; `D/Admin.tsx:14,27-29`).
  - The member page's `limit: 5` is unaffected (`R/channels/dashboard-owner-controls.ts:31,76`; `D/OwnerControls.tsx:7,28`; `R/channels/console-invites.ts:11`).
  - Admin paths: `R/channels/dashboard-admin.ts:21-24` and `owner-do.ts:1389-1391`, both to `admin_invite` (`console-auth.ts:150-154`) [v].
  - No schema in `packages/contracts` pins 5 [v].
- **[p] Smallest safe change:**
  - Add a migration that runs `create or replace waldo.admin_invite`, with the same signature and grants, deleting only the `v_count >= 5` clause.
  - Keep the `is_admin` row lock, the email advisory lock, the active-owner refusal and the live-invite refusal.
  - Make `quota()` return "no limit" for the admin page.
  - The member cap stays.
  - Rejected: editing or deleting invite rows on staging. It destroys attribution and is a hand mutation.

## 4. The reset runbook
### 4.1 The audited delete path (each owner deletes their own account; no admin RPC deletes another owner)
- **Entry points:**
  - App: `POST /app/v1/actions` `account.delete` with `confirmation:'DELETE'` (`C/app/controls.ts:26,38-40`), via `R/channels/app-controls.ts:80-86`, into `ownerControlsAction` (`R/channels/dashboard-owner-controls.ts:51-115`).
  - Console: the dashboard account view (same function), or the classic console (`owner-do.ts:1413-1418`).
  - The admin RPCs are only overview, invite and revoke (`M/20260924150000_waldo_admin.sql:4-29`; `dashboard-admin.ts:21`) [v].
- **Order** [v]:
  1. Purge the R2 prefixes `artifacts/by-owner/<doId>/`, `artifacts/exports/by-owner/<doId>/` and `workspace/v1/<env>/<ns>/<ownerId>/`. A failure stops here with nothing deleted (`R/channels/owner-files-purge.ts:13-44`; `dashboard-owner-controls.ts:90-98`).
  2. Call `delete_owner` (`99-107`).
  3. Run the object's `storage.deleteAll()` (`108-115`).
- **What `delete_owner` removes** (latest is `M/20261011230000_delete_owner_identity.sql:10-44`) [v]:
  - Vault secrets for Google connections and push devices (`20-26`).
  - Connections, connect and console sessions (including app bearers) and health logs (`27-30`).
  - The email on the invite the owner redeemed (`31`).
  - `public.health_context_daily`, `public.users`, Auth refresh tokens and sessions (`32-37`).
  - The owner row (`38`), which cascades to:
    - presences, settings and link codes (`M/…waldo_owners.sql:16,26,48`);
    - push devices (`M/20261010040000_app_push_custody.sql:4,23`);
    - devices (`M/20261008000100_waldo_device_bridge.sql:4,13`);
    - health-plane tables (`M/20261011000000_health_plane.sql:8-82`);
    - iMessage invitations and bridges (`M/20261012000000_waldo_imessage_connector.sql:15,27`);
    - invites the owner issued.
  - `auth.users`, with a readback (`39-42`).
- **What it does NOT remove:**
  - The Auth audit log and `workspace_owner_mappings` (`…delete_owner_identity.sql:8-9`) [v].
  - The grant at Google: no revoke call exists (`grep oauth2…/revoke` finds nothing) [v].
  - The Gmail watch: there is a watch call but no stop call (`R/connectors/google-push.ts:98`) [v]. Google expires it on its own schedule [i].
  - iMessage and device-bridge object storage. These fail closed on an authority recheck (`R/channels/imessage/console.ts:82`; `R/devices/device-bridge-do.ts:206`) [i].
  - Staging Langfuse text and Worker logs, and R2 keys outside the three prefixes [not checked].
  - The receipt itself says purge of every copy is not verified (`dashboard-owner-controls.ts:111`) [v].

### 4.2 Steps on staging. Each step needs its own owner go. Destructive and irreversible.

| # | Step | Detail and guard |
|---|---|---|
| P0 | Inventory the 5 non-admin owners: for each, record how its holder signs in (email OTP to a mailbox someone controls, or Telegram `/console`) | An owner with no working route cannot use the audited path (D3) |
| P1 | Decide D1, D3, D4 | D1 decides the iMessage and Google moves (§4.3) |
| P2 | Land (iv), or check the admin's issued count is at most 1 | The re-invite fails otherwise (§3) |
| P3 | Add every re-invited Google account to the Google test-user list | `google.ts:5`; an owner step in the Google Cloud console |
| P4 | Confirm staging DB backups or PITR | Covers DB rows, including Vault secrets, which are rows in `vault.secrets` [i, verify]. **Object storage and R2 are not restorable** [i] |
| 1 | For each of the 5 non-admin owners, one at a time: the account holder signs in (app or console OTP; a Telegram-only owner sends `/console` on Telegram) and runs Delete account with DELETE | Expect `recorded` (200). `incomplete` (503) means the directory row and Auth user are gone but object storage is unconfirmed: **stop and report, do not retry**. The do_name no longer resolves and the holder is signed out (`dashboard-owner-controls.ts:112-113`). `rejected` (503) means the files were unconfirmed and nothing was deleted; retry (`dashboard-owner-controls.ts:90-115`) |
| 2 | The admin's page confirms the owner is gone; the admin's iMessage bridge still shows active | Read-only checks: Admin page, `/console/imessage` |
| 3 | Optional: each person revokes Waldo at their Google account permissions page | Closes the grant still held at Google [i] |
| 4 | The admin revokes any pending invite to the four addresses, then issues four invites | Live-invite refusal (`invite_chain.sql:105-106`). Share the codes out of band |
| 5 | Each person signs in to the app with email, OTP and invite code, confirms the time zone, and connects Google once (i) has landed. If D1 = admin, the admin reconnects Google too | `needs_invite` means a code or email mismatch (`app-api.ts:133`) |
| 6 | Whoever still wants Telegram relinks it, then land (v) | Landing (v) earlier blocks those relinks (§2 rows 2-3; D7) |

- **Blast radius:**
  - The 5 owners' memory, conversations, schedules, files, connections and settings are gone. No export exists.
  - An `incomplete` delete leaves object storage behind that nothing can address again. This cannot be undone.
  - The admin is untouched: every cascade is keyed to one owner_id.
  - Telegram presences of deleted owners are gone; with (v) on, they cannot relink.
- **Keeping the admin:**
  - Never run Delete account in the admin's session.
  - After each step, check that `is_admin` is still true (the Admin page loads) and that its bridge is active.
- **Legacy numeric owner** (no auth user, no email) [s]:
  - The only audited route is a Telegram `/console` session, which needs that Telegram account and an active presence.
  - If that is unavailable: **[blocked]**, see D3.
  - A hand-signed `delete_owner` call would skip the R2 purge and the object `deleteAll`, so it is not the audited path.

### 4.3 iMessage (what Ashish redoes)
- **If the admin keeps the bridge (D1 = admin): nothing.** Bridges cascade per owner only (`imessage_connector.sql:27`).
- **If the personal account becomes daily (D1 = personal):**
  1. The admin revokes the bridge in `/console/imessage`. Revocation unlinks the presence (`R/channels/imessage/console.ts:74-83`; `…imessage_connector.sql:233-251`).
  2. The new owner runs `imessage.pair`, which issues a one-use `wim…` code for the Mac host (`console.ts:60-63`).
  3. The host redeems the code, which leaves a pending bridge.
  4. The new owner runs `imessage.verify` with the exact sender and chat, which issues a `wic…` challenge to send from that sender (`64-69`).
  5. The new owner runs `imessage.activate` (`70-73`).
  - Activation refuses a sender that is already active for *any* owner, and allows one active bridge per owner (`…imessage_connector.sql:222-223,60`) [v].
- **Ashish and Suyash** need the same pairing if they want iMessage.
  - Ask Ashish whether one Mac host can serve several owners' bridges. This repo's relay is fixture-only (`packages/imessage-relay/README.md:3,23`) [i].

## 5. Build slices (the sequence is under "Order rationale" below the table)

| Slice | Files | Size | Tests | Risks | Review |
|---|---|---|---|---|---|
| **(iv) Admin unlimited invites** | new migration (`admin_invite` without the cap); `D/admin-model.ts:23`; `D/Admin.tsx:27-29` | S | pgTAP in `T/waldo_admin.sql`: the admin's 6th-Nth invites succeed; a non-admin is still refused; the duplicate and active-owner refusals still hold; the member's sixth still fails (`T/waldo_invite_chain.sql:47`) | A stolen admin session mints unlimited codes. Mitigated by one use, recipient binding and 14 days (`invite_chain.sql:83-84`; `optional_phone_signup.sql:43-46`) | Security review (admission). The migration apply is an owner step. No contract change |
| **(v) Freeze Telegram links** | [p] Option A: a migration making `issue_link_code` return false (deterministic for every caller); console copy and button (`console.ts:220`); receipts at `owner-do.ts:1320-1321,1457` | S | pgTAP: issue returns false. Runtime: a frozen receipt. Existing presences still route | Outstanding codes live 10 minutes, so redemption closes within 10 minutes. Nobody can relink after a lost presence | Owner go. Rollback: restore the old function |
| **(i) `profile` scope and profile read at connect** | `google.ts:87` (add `profile`); `google.ts:126-131` (parse `name` and `given_name` from the ID token into `GoogleTokens.profile`); `E/index.ts:40-42,89-91` (pass through, no edge storage); `R/connectors/connections.ts:53` (parse); `owner-do.ts:2194-2195` (persist after `google.keep`). Persist as object KV `google_profile` (M1) or, for a table, a reservation in `packages/runtime/do-migration-reservations.json`. Prompt: wire the unused `ownerProfile` seam (`R/context-composer/owner-turn.ts:21,77-83`) and the tail of the live prompt (`R/channels/owner-turn.ts:523`) as a fenced, length-capped "from Google, unconfirmed" fact | M | Zod-style claim parsing, valid and invalid (missing, oversize, control characters); proxy reply schema; persistence; prompt contains the fenced line; the `oauth_exchange` log carries no name (`owner-do.ts:2206,2209`) | Existing grants need a reconnect (consent prompt already forced, `google.ts:93`). Trusting ID-token claims without a signature check rests on TLS from the token endpoint (OIDC Core §3.1.3.7) [i, verify]. The name enters staging Langfuse text under the 10 Oct ruling. The edge-function deploy is an owner step | Bounded persistence review (new provider-asserted identity attribute). No app.v1 change unless the app shows the name (then additive, through L3) |
| **(ii) First-conversation signal and tools** | A state-derived host-fact line built like `unconnectedLine` (`R/prompt/messaging-behavior.ts:131-134`), added to the tail at `R/channels/owner-turn.ts:523` with a `system_sections` entry, on `user_message` only. Facts: count of owner-grounded profile claims, zone confirmed or not, the unconfirmed Google name, linked surfaces. A short behaviour line says the model chooses what to ask and saves answers with `remember`. Tool T1 [p]: `set_timezone` (`C/tools/permissions.ts` ToolName and `user_message`), reusing the `timezone.set` path (`owner-do.ts:3134-3141`) on the owner's explicit statement | M | Scenario evals (model judgment, no regex): a new owner gets an intro; a returning owner does not; an answer is saved through `remember` with a verbatim quote; proactive triggers carry no signal; Zod valid and invalid for `set_timezone`; a trace assertion | Both app and iMessage reach the same responder (`owner-do.ts:574`), so one signal covers both. **Pin caveat:** once anything is pinned, a new name shows only after nightly pins it (`claims.ts:1056-1062`), and nightly arms only on a confirmed zone (`owner-do.ts:2367-2369`) | Agent-tool contract (`C/tools`); T1 amends the ruling that only `timezone.set` confirms (D5); `/run-eval` |
| **(iii) Google sign-in and linking** | Built to O2-A (§1.3): new `/app/v1/auth/google/*` routes in `app-api.ts`; a `resolveOwner` variant in `console-auth.ts`; one handoff migration; additive `C/app/core.ts` schemas | L | Verified email match links; mismatch gives `needs_invite`; unverified email refused; ticket replay refused; a new owner still needs an invite | Auth flow (escalation per the security checklist); Google client redirect URIs and the staging Auth provider are owner steps; keep the sign-in grant separate from the offline connector grant | Auth ADR/security review; L3 for app.v1 additions |

- **Order rationale:**
  - (iv) unblocks the re-invite.
  - (v) comes after the re-invite and any Telegram relinks. Landing it first would remove Telegram by side effect, which the owner ruled out for now.
  - (i) lands before the reset, so each person connects Google once and gets the name.
  - (iii) can follow, because email OTP works meanwhile.
  - (vi-a) is a security fix and goes first. The rest of (vi) follows (ii) and lands before the reset if Ashish's part is ready (§8).
  - **Option:** reset right after (iv) if clean accounts matter sooner. People then reconnect Google after (i).

## 6. Open decisions (owner or lead)
- **D1. Which account is the owner's daily Waldo:** the admin, or the re-invited personal account?
  - Personal means revoking and re-pairing iMessage (§4.3) and moving Google.
  - It also leaves the admin's memory behind, since no export exists.
  - The same Google account on two owners is allowed (`M/20260924170000_waldo_connections.sql:16` is per owner), but `gmail_push_route` returns every match (`M/20261013150000_gmail_push_route.sql:8-9`). Disconnect it from the admin.
- **D2. Where the Google name lives:**
  - M1 [p, recommended]: a provider fact in object KV, fenced in the prompt. The owner's own confirmation becomes the owner-grounded claim through `remember`.
  - M2: a memory claim with a new provenance. It widens `profileEligible` (`claims.ts:19-21`) and needs a memory ADR.
- **D3. Any owner whose holder cannot sign in** (the legacy numeric owner is the known case; P0 finds others):
  - Delete through the holder's own session (email OTP, or Telegram `/console` for the legacy owner) if reachable.
  - Otherwise leave it dormant: with no admission the alarm stops (`owner-do.ts:1517-1521`).
  - Or explicitly authorise a non-audited operator delete that skips R2 and object purge.
- **D4. The owner's Apple account:** a plain email invite works today. Sign in with Apple stays out for the beta (12 Oct ruling).
- **D5. Time zone:**
  - Option T1: the model may set it from the owner's explicit statement, which amends the 12 Oct "only `timezone.set` confirms" design.
  - Option T2: the app control only. Then an owner who never opens the app arms nothing.
  - Also decide whether the primary calendar's zone (`google.ts:503-509`) may be *suggested*.
- **D6. iMessage proactive delivery:** today none. The alarm picks Telegram or the app; iMessage `ready` arms nothing (`owner-do.ts:1508-1516,2375`). Is it part of the onboarding promise?
- **D7. Freeze mechanism and timing:** SQL (deterministic, recommended) or a runtime flag; land it after the re-invite and relinks. Trade-off: earlier closes new Telegram links sooner but strands anyone who still needs one until a revert. Are exceptions allowed?
- **D8. Profile fields:**
  - [p] `name` and `given_name` only.
  - Leave `picture` out: it puts an external URL in prompts.
  - Optionally add the verified account email as a host fact.
  - Birthday and gender need sensitive scopes. Rejected.
- **D9. Backups:** is staging PITR in place before step 1? This is an owner or dashboard check.

## 7. Evidence and gaps
- **Observed:** every [v] path and line above, read at `929fd79c` in a detached worktree. I made no edits, ran no network calls to staging and read no secrets.
- **Not verified:**
  - the staging Auth dashboard and environment variables;
  - the admin's current issued count;
  - the legacy owner's Telegram presence state;
  - Langfuse retention;
  - whether a pending object alarm survives `deleteAll()`;
  - which ID-token claims Google currently includes for `profile`;
  - whether one iMessage host serves several bridges.

## 8. Slice (vi): commands off Telegram, console link on every surface, trace ids, proactive iMessage
### 8.1 Today [v]
- **Console link (works on Telegram, not iMessage):**
  1. The Telegram text `/console` is parsed by `parseHarnessCommand` (`R/channels/harness.ts:28`), but only when `!nativeSurface(channel) && fromOwner` (`R/channels/owner-do.ts:1784-1785`). `fromOwner` means `from.id === owner && chat.id === owner` (`:1774`).
  2. `mintLink` stores one grant, `console:link`, with an expiry of now + 10 minutes, in the owner object. It signs a ticket that names the issuing object (`R/channels/console.ts:19,55-60`; `R/identity/console-ticket.ts:7-10`). Redemption deletes the grant, so the link is single-use (`console.ts:61-65`).
  3. The server sends "Console (link works once, for 10 minutes): <origin>/console?t=<ticket>" with Telegram `sendMessage` (`owner-do.ts:1796-1804`). The Worker routes `?t=` to the issuing object (`R/index.ts:136-142`).
  - The command bypasses the model, but a later reply to that message carries its text into the turn (`R/channels/telegram-polling.ts:141-148`), so the link can reach a prompt [i]. It stays in Telegram history. Invocation logs are off because they carry full URLs (`packages/runtime/wrangler.jsonc:5-10`).
  - **Why iMessage fails:** app and iMessage are native surfaces, so no slash command is parsed on them (`owner-do.ts:245,1779,1784-1785`). The text goes to the model, and the model has no console-link tool (no such ToolName in `C/tools/permissions.ts`).
- **Forwarded content runs commands:** `fromOwner` has no forward or quote check (`owner-do.ts:1774`). Forward detection exists only for reply context (`R/channels/telegram-polling.ts:49-58`). This matches the #1209 review.
- **Trace tags and ids:**
  - Tags are `channel:<runtime channel>` plus `feature:*` (`R/observability/otlp-turns.ts:52-55`).
  - `userId` is `${channel}:${n}` and `sessionId` is `${channel}-dm:${n}` (`owner-do.ts:1909-1912`). `n` is the Telegram id on Telegram and the FNV hash of the do_name on app and iMessage (`owner-do.ts:582-583`; `app-api.ts:224-228`).
  - Owner UUID and email are attached only to `tg-` traces (`R/observability/owner-trace-identity.ts:23-35`; `owner-do.ts:1925-1930`).
- **The iMessage outbox is reply-only:** each record is keyed `reply:<inbound id>` and carries that inbound message's bridge, command id and binding digest (`R/channels/imessage/final-outbox.ts:16-20,28-29`; queued from the turn at `owner-do.ts:2592-2597`).

### 8.2 Telegram slash commands
- **Who may run them:** every command except /start and /link needs `fromOwner` on the Telegram channel; the inbox drain treats them as direct (`owner-do.ts:489`).
- **App or iMessage:** none can be reached, because of the native-surface guard. The app has its own cancel route (`app-api.ts:152`).

| Command | What it does | Evidence | Generalized design [p] |
|---|---|---|---|
| `/start CODE`, `/link CODE` | Redeems a 10-minute code into a Telegram presence. Anyone in a private chat with a valid code may run it. A bare `/start` is not parsed as a command (`:9` needs two parts) [i] | `R/channels/telegram-link-command.ts:7-12`; `telegram-webhook.ts:103` | Identity leaves Telegram: freeze with (v), later link from the app (contract via L3), then remove |
| `/console` | Mints and sends a console link (8.1) | `owner-do.ts:1796-1804` | Model tool `send_console_link`, because spotting the request is a judgment call. The server mints and sends; the model gets only `{sent}`. Remove the text command afterwards |
| `/stop` | While a turn runs, the running turn's control absorbs the message (`1775-1777`). When idle, it replies "Nothing is running right now." | `owner-do.ts:1779-1783` | **Open decision:** keep an exact-token `/stop` (a kill switch that does not depend on the model), or use the app's cancel route plus a model-handled stop on chat surfaces. Either way, accept only the owner's own typed, non-forwarded message |
| `/ledger` | Sends the prompt ledger plus health-log lines | `owner-do.ts:1785,1819,2327` | A model read tool or an app/console view; delete the command |
| `/fire <card:brief\|card:midday\|card:close\|fetch\|briefs\|nightly>` | Runs a job immediately by calling its executor directly, outside the arming gates | `harness.ts:8,22-25`; `owner-do.ts:1859-1872` | An operator-only, staging-only console action behind `is_admin`; never in chat |
| `/trace [f]`, `/e2e`, `/usage`, `/langfuse`, `/heldrows [t] [from]` | Diagnostics: trace rows, E2E checklist, usage, Langfuse check, held-row shapes | `harness.ts:26-34`; `owner-do.ts:1850-1858` | Console diagnostics views. `/usage` may also become a model read tool. Delete the commands |

### 8.3 Design [p]
1. **(vi-a) Command guard.** This is a hard security boundary, so it is deterministic.
   - A command runs only when the owner typed it: no `forward_origin`, no `forward_*`, no `is_automatic_forward`, no `external_reply` and no `quote` on the update, and the first entity is a `bot_command` at offset 0 [i: Bot API fields, verify].
   - Tests: forwarded and quoted `/fire`, `/stop` and `/ledger` each reach the model as plain text. Size S.
2. **Console-link tool.** A new ToolName, `send_console_link`, for `user_message` only, with no arguments.
   - The host resolves the turn's verified surface binding: the Telegram presence, the active iMessage bridge or the app session.
   - It mints with the existing `mintLink` (10 minutes, single-use).
   - It delivers by a server send:
     - Telegram: `sendMessage`;
     - iMessage: a server-originated outbox record, `console:<inbound id>`, on the same bridge;
     - app: an authenticated `/app/v1` endpoint that hands the link to the app, never into chat.
   - The model gets `{sent:true,surface}` or `{sent:false,reason}`. The log hop `console_link` records only ok and surface.
   - Record the message id of every send that carries a credential, and mask its text in reply context. That masking is deterministic, because it is a credential boundary.
   - [p] Move the ticket from `?t=` into the URL fragment, as invite links already do (`R/identity/invite-code.ts:6-11`), and have the page post it.
   - Tests: the link appears in no prompt, model output, trace text, log or transcript; a second redemption fails; it expires at 10 minutes. Size M.
3. **Trace ids.**
   - `userId` becomes `prn_<owner uuid>` (`app-api.ts:220`), from the directory authority each runtime already resolves.
   - `sessionId` becomes the conversation chain ref.
   - Tags: `surface:<ingress surface or job>`, plus `delivery:<surface>` on copies. Keep `channel:` for one release.
   - Drop the Telegram id. Also [p] drop `owner_email` from the trace fields (`owner-trace-identity.ts:23-27`).
   - Tests: an exporter fixture per surface. Size S.
4. **Proactive delivery to iMessage, smallest form.**
   - Keep the app as the canonical home, and keep arming as it is: the alarm runs `app` for app-admitted owners, and the zone gate stays.
   - Add `copiedToIMessage(deliver)` beside `copiedToTelegram` (`owner-do.ts:734-738`; `R/channels/delivery-routes.ts:41`). Use it when the directory shows an active bridge for this owner.
   - It freezes a server-originated outbox record keyed by the schedule occurrence (intent before I/O, one retry owner) and drains through the existing iMessage outbox.
   - Owner ruling, 13 Oct: proactive messages go to iMessage, with health handled as on Telegram. The proactive gate and quiet hours run before delivery [i].
   - Size M, plus Ashish's part.

| Part | Owner |
|---|---|
| Guard, tool, trace ids, route choice, `copiedToIMessage`, the new outbox record kind, tests | Backend lane |
| Bridge object and Mac host: accept a server-originated send to the bound chat (no inbound reply ref, no reply max-age), real host send, quarantine on an uncertain send | Ashish |
| `imessage/wire.ts` changes, any app.v1 console-link endpoint, the new ToolName | Contract review (L3) |

- **Risks:**
  - A console link stays in Telegram or Apple chat history until it is used or expires [i].
  - A server-originated iMessage send widens what the host may send; limit it to the owner-bound chat.
- **Not verified:** whether Telegram's `call` wrapper logs request bodies; Bot API entity semantics; whether the bridge can send twice for one inbound message; whether `replyTo.text` reaches the model prompt.
