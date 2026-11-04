# Beta environment runbook, 4 November 2026

On 4 November 2026 the owner decided the first beta cohort gets its own stack instead of sharing staging. Testers use a TestFlight iOS build and a release-signed Android build pointed at it. This document says what that stack is, what must be created and in what order, what is shared with staging, and what blocks the first invite.

It authorises nothing. **No cloud resource exists for beta.** Each creation step in §10 is a separate owner yes, and a yes for one step never covers the next.

It builds on the [production alpha runbook](PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md) (22 Oct, "the alpha runbook"). Its var table (§1.2), secret table (§1.3), Supabase and edge-function tables (§1.4–1.5), stand-up steps S1–S11, deletion table (§3.2) and incident steps (§3.3) all apply to beta. They are not repeated here; only the differences are.

Source pin: `waldoco/beta-mvp` at `8455b0b9`. The companion changes are backend draft PR (this branch) and app draft PR (`waldoco/waldo-app`, branch `claude/beta-eas-profiles`).

Labels:
- **[verified]**: read in source or config at the pin, or observed by a command run on 4 Nov.
- **[recorded]**: taken from another session's record or document, not re-read here.
- **[inference]**: a conclusion from the above.
- **[proposed]**: a recommendation that needs the owner's yes.

Alignment: the strategy session ([local_57a8d293](#local_57a8d293-6970-4d22-b4ce-e6006de4b72e)) owns the beta-readiness page on telemetry, crash reporting and per-surface gaps. That page did not exist when this was written; its health-first notes did. This runbook names crash reporting and telemetry as blockers (§8) but does not design them. When the page lands, it governs those two rows.

## 0. The answer

1. **Beta is a named wrangler environment, `env.beta`, with Worker `waldo-runtime-beta` and `WALDO_ENVIRONMENT=beta`.** It is not the top-level block. Reasons:
   - The top level is the production block, and the standing rule keeps production all off.
   - Every runtime vitest config reads the top level (`wrangler: { configPath: './wrangler.jsonc' }`), so turning switches on there would change the test environment [verified].
   - `scripts/deploy-runtime.sh` with no flag deployed the top level [verified]. This branch makes it refuse everything but `--env staging`.
2. **Beta gets its own:**
   - Cloudflare Worker, and with it its own Durable Object namespaces;
   - Supabase project, with migrations applied from zero;
   - R2 bucket and rate-limit namespace;
   - Google Cloud project and OAuth clients;
   - domain.

   Nothing that holds owner data is shared with staging. Shared on purpose: the Apple developer team, the bundle id `com.heywaldo.app`, the EAS project and Expo push credentials, and the `heywaldo.in` zone.
3. **Seven things block the first external tester.** Each is in §8 with what clears it:
   - the app cannot talk to beta at all today (the app PR fixes this);
   - Google OAuth and Gmail verification;
   - TestFlight external review;
   - Android release signing;
   - no crash reporting;
   - no minimum-version path;
   - the ADR-0073 §1 floor, data export (alpha runbook P10) and the deletion gaps (P4), which apply to any external user.
4. **What this branch changes** (config, scripts and one line of runtime code; no cloud):
   - the `env.beta` block in `packages/runtime/wrangler.jsonc`;
   - guard checks that keep beta from reusing staging's bucket, limiter or identities, or capturing text;
   - `deploy-runtime.sh`, which now refuses any target but staging;
   - `scripts/beta-gate.mjs` and `scripts/beta-rollback.sh`;
   - `resolveCaptureText`, which now refuses text capture on `beta` as it already did on `production`.

## 1. Why `WALDO_ENVIRONMENT=beta`, and what that value does

`WALDO_ENVIRONMENT` names the deploy target in traces, rule names and bridge names. Code also branches on it. Every branch is listed below [verified: grep of `packages/runtime/src` at the pin].

| Code | With `beta` | Consequence |
| --- | --- | --- |
| `observability/trace-privacy.ts` `resolveCaptureText` | Before this branch, only `production` blocked text capture, so beta would have exported model text whenever `LANGFUSE_CAPTURE_TEXT` was `true`. Now `beta` is blocked too. | Beta never captures text, whatever the var says. |
| Probe route, WhatsApp debug log, runtime diagnostics, browser providers, Telegram owner admission, `browser_owner_binding` SQL (all `=== 'staging'`) | closed | The staging-only debugging surfaces stay off on beta. `scripts/beta-gate.mjs` checks the probe route answers 404. |
| `channels/agent-mail/rules.ts` `SCRIPTS` (`production`, `staging` only) | No script name, so routing is `null` | Agent mail cannot route on beta even if switched on. Add `beta: 'waldo-runtime-beta'` in the PR that turns agent mail on (§4). |
| iMessage bridge name, workspace locator, Langfuse `environment`, cost ledger | the string `beta` | Beta's objects and traces are named apart from staging's. |

The alternative was `WALDO_ENVIRONMENT=production` inside `env.beta`. It was rejected because agent-mail rules would name the wrong Worker (`waldo-runtime`), and because a later real production could not be told apart from beta in traces.

## 2. Resources to create

Every row is created by one step in §10 and not before. The names below are [proposed] and are written into the config on this branch where the config holds them.

| Resource | Exact name | Where | Shared with staging? | Step |
| --- | --- | --- | --- | --- |
| Cloudflare Worker | `waldo-runtime-beta` | The account holding the `heywaldo.in` zone, unless the zone moves (D1) | No | B7 |
| Durable Object namespaces | `RUNTIME_DO`, `RUN_LOOP_DO`, `TRACER_DO`, `OWNER_DO`, `DEVICE_BRIDGE_DO`, `IMESSAGE_BRIDGE_DO` and `TASK_WORKER_DO`, bound to classes `RuntimeProbeDO`, `RunLoopDO`, `TracerDO`, `OwnerDO`, `DeviceBridgeDO`, `IMessageBridgeDO` and `TaskWorkerDO`. Migrations v1–v7 and v9, the same list as staging. | Created by the first deploy of `waldo-runtime-beta` | No. Namespaces belong to one Worker. | B7 |
| `WALDO_OWNER_DO_NAMESPACE` | The `OWNER_DO` namespace id read after B7 | `env.beta.vars` | No. The guard refuses staging's id. | B9 |
| R2 bucket | `waldo-artifacts-beta`, bound as `ARTIFACTS` | Same account | No. The guard refuses staging's or the top level's bucket name. | B6 |
| Rate-limit namespace | `RESPONSIBILITY_RATE_LIMITER`, `namespace_id` `1003`, 120 per 60 s | Same account | No. Staging and production use `1001`, previews `1002`, and the guard refuses all three. | B7 (a binding, nothing to create) |
| Workers AI | binding `AI` (semantic recall's embedder) | Account-level | Stores nothing | B7 |
| Vectorize | none | n/a | Nothing reads it [verified: no `env.VECTORIZE` read in `src`], and the guard refuses a beta binding | n/a |
| Browser Rendering | none | n/a | Every browser path is `=== 'staging'` [verified], and the guard refuses a beta binding | n/a |
| Queues, KV, D1 | none | n/a | No such binding exists in any block [verified] | n/a |
| Cron | `17 3 * * *`: the health retention sweep, the Langfuse sweep (off) and history-archive maintenance | `env.beta.triggers` | Separate trigger | B7 |
| Custom domain | `app.heywaldo.in` (`routes`, `custom_domain: true`, `workers_dev: false`) | `heywaldo.in` zone | Separate host | B7 |
| Supabase project | `waldo-beta` | The LLP's organisation (D2) | No | B3 |
| Supabase Vault secret | `waldo_router_hmac`, a fresh value | Beta project | No | B3 |
| Edge functions | `connector-proxy` (`--no-verify-jwt`) and `oauth-proxy`. Never `mint-agent-jwt`. | Beta project | No | B5 |
| Google Cloud project | `waldo-beta` [proposed]. External, Testing at first. | The LLP's Google organisation if one exists (D4) | No | B10 |
| Google OAuth clients | Web client with one redirect, `https://app.heywaldo.in/oauth/google/callback`; an iOS client for bundle `com.heywaldo.app` (app ID-token sign-in) | `waldo-beta` | No | B10 |
| Gmail push | topic `waldo-gmail-push`; service account `waldo-gmail-push@waldo-beta.iam.gserviceaccount.com`; push subscription `waldo-gmail-push-beta` with endpoint and audience `https://app.heywaldo.in/events/gmail` | `waldo-beta` | No | B10 |
| Supabase redirect URLs | Site URL `https://app.heywaldo.in`. Add `/console/signin/google/callback` only if `CONSOLE_GOOGLE_SIGNIN` is ever turned on (it stays off). | Beta project | No | B3 |
| Auth email sender | Custom SMTP with its own API key, sender `no-reply@heywaldo.in` or a beta subdomain [proposed] | SMTP provider | Separate key | B3 |
| Model provider spend | An Anthropic workspace `waldo-beta` and an OpenAI project `waldo-beta`, each with a hard monthly limit | Providers | No | B11 |
| EAS Android keystore | EAS-managed upload key for `com.heywaldo.app` | Expo | Used by beta builds only | B12 |

**Domain [verified, public DNS on 4 Nov].**
- `app.heywaldo.in`, `api.heywaldo.in` and `beta.heywaldo.in` have no A or CNAME record.
- `staging.heywaldo.in` is proxied by Cloudflare. The apex points off Cloudflare.
- The zone's nameservers are Cloudflare's.

`app.heywaldo.in` is free. The Worker serves the console and the app API, so "app" fits. The contracts also name `api.heywaldo.com` for problem-type URIs (alpha runbook D3); that is a separate cleanup. A Worker custom domain must be in the same Cloudflare account as its zone [inference from Cloudflare's custom-domain model; check in the dashboard at B0]. The zone `17c6baaf…` serves staging today, so beta's Worker goes in that account unless the zone moves (D1).

**Worker secrets (names only).**
- The alpha runbook §1.3 table applies with "production" read as beta.
- Required: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_PROJECT_URL`, `SUPABASE_PUBLISHABLE_KEY`, `WALDO_ROUTER_HMAC_SECRET`, `WALDO_OAUTH_STATE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BRAVE_SEARCH_API_KEY`. Brave is required because `WALDO_MODEL_PROVIDER=anthropic` gives Claude turns no other search.
- Optional: `ELEVENLABS_API_KEY` or `SMALLEST_AI_API_KEY`.
- Not set at launch:
  - Telegram, WhatsApp, iMessage, WHOOP, Browserbase, the probe secrets, `WALDO_EVENT_SOURCES`, Twilio and `CLOUDFLARE_EMAIL_ROUTING_TOKEN`;
  - Langfuse (D7).
- Every value is fresh and never copied from staging. `WALDO_ROUTER_HMAC_SECRET` holds one value in three places: the Worker secret, the Vault secret `waldo_router_hmac`, and the `connector-proxy` and `oauth-proxy` function secrets.

**Two creation traps [verified in wrangler 4.135.0 source].**
- `wrangler secret put --name <worker>` on a Worker that does not exist asks to create it, and answers yes by itself without a TTY (`createDraftWorker`, `fallbackValue: true`). Putting a secret before B7 therefore creates the beta Worker. Secrets go after B7, always with `--env beta`.
- `wrangler deploy` provisions any binding whose named resource is missing ("Creating new …" in `provisionBindings`). So the first beta deploy creates the R2 bucket if B6 has not. Dry runs skip provisioning.

## 3. Shape of `env.beta`

The block on this branch carries these properties.

**Same as staging:**
- the Durable Object list and its migrations;
- the assets directory;
- observability (logs on, invocation logs off, query strings redacted, traces off);
- `limits.cpu_ms` 300000 and the cron;
- the `AI` binding.

**Different from staging:**
- Entry is `src/entry.ts`, the production entry, with no `nodejs_compat`. `scripts/tests/runtime-bundle-startup.test.mjs` asserts its startup imports.
- There is no browser, no Vectorize and no `send_email` binding.
- `workers_dev` is `false`, so the only host is `app.heywaldo.in`.

**Vars:**
- The key set equals the top level's; the guard enforces it, as it does for staging.
- Every future var PR must add the key to beta as well. This matters because `CALENDAR_GROUNDED_PREP` and `MAIL_SOURCE_FOLLOWUPS` are on when unset.

The guard (`scripts/guards/guard-wrangler-local-bindings.mjs`, with adversarial cases in `guard-wrangler-beta-regression.mjs`) refuses a beta block that:
- reuses staging's or the top level's bucket;
- reuses staging's, production's or previews' rate-limit namespace;
- copies staging's owner namespace, Telegram id, WhatsApp number, iMessage address, Photon project or Gmail push project;
- sets `LANGFUSE_CAPTURE_TEXT` or `WHATSAPP_DEBUG_LOG` to anything but `"false"`;
- binds a browser or Vectorize;
- drifts from the top level's Durable Objects.

## 4. Channels

| Channel | Shared with staging | Must be separate | Beta at launch |
| --- | --- | --- | --- |
| **App (iOS, Android)** | Bundle id `com.heywaldo.app`, Apple team `6R4AN5XP86`, EAS project and build numbers (`appVersionSource: remote`) | The API origin, which the app compiles in (`EXPO_PUBLIC_WALDO_APP_API_ORIGIN=https://app.heywaldo.in`); the EAS update channel (`beta`); the Android signing key | **On.** This is the cohort's main surface. |
| **Push (APNs, FCM through Expo)** | The Expo project, and the APNs key and FCM credentials Expo holds. Push credentials belong to the app, not the environment [inference]. | Device rows: a build registers its Expo token with the backend it talks to, so beta tokens live only in beta's `waldo.app_push_devices` [verified: register is per Supabase project]. | On. Whether FCM credentials are uploaded to EAS for Android is [unverified]. Check at B12. |
| **Console (web)** | none | Origin `https://app.heywaldo.in/console` | On (invite admin path) |
| **WhatsApp** | nothing usable. One number has one Meta webhook callback, so staging's `919226067544` cannot serve both. | A second number, its own callback to `https://app.heywaldo.in/whatsapp/webhook`, a system user, and four secrets. Or move the existing number to beta and leave staging without WhatsApp (D5). Meta business verification and the restricted-account case are open [recorded: memory of 28 Oct, case 28969487829376096]. | **Off.** `WHATSAPP_WALDO_NUMBER` is empty; the beta gate expects POST 404. |
| **iMessage** | nothing. `woof@heywaldo.in` and Photon project `0e647a94…` route to staging's Worker. | A host Mac, an Apple Account and number on iMessage, a Photon project, and `IMESSAGE_CREDENTIAL_WRAPPING_KEY` | **Off.** `IMESSAGE_CONNECTOR_ENABLED=0`. |
| **Agent mail (`mail.heywaldo.in`)** | The zone. Rule names carry the environment (`waldo-<env>-mail:<handle>`), so the sweeps never take each other's rules [verified]. | The handle namespace. Each Supabase project has its own handle directory, so `alex@mail.heywaldo.in` could be claimed in both, giving two literal routing rules for one address that point at different Workers [inference]. Fix by giving one environment its own subdomain (for example staging moves to `mail-staging.heywaldo.in` and beta takes `mail.heywaldo.in`), plus the `SCRIPTS` line in §1. | **Off.** `AGENT_MAIL_INBOUND=0`, `AGENT_MAIL_SEND=0`, no `send_email` binding. |
| **Telegram** | n/a | n/a | Off by design (internal only) |
| **Auth email (sign-in codes)** | none | Supabase's built-in mailer sends only to team members, at 2 an hour, so beta needs custom SMTP (alpha runbook §1.4) | Required at B3 |
| **Google (connect, sign-in, Gmail push)** | Sign-in client ids are hard-coded in the app to the dev project (`src/auth/googleSignIn.ts`, project `973607319337`) [verified] | Beta's own project, clients and push subscription. If beta keeps the dev project's sign-in clients instead, it also shares that project's lifetime cap of 100 Testing users (7 used on 21 Oct) [recorded]. | Google connect needs B10. App sign-in with Google on beta needs the app to read client ids per build: a follow-up app PR once B10 exists. Apple sign-in and the email code work without it. |

## 5. Switches

Beta takes the switch set the owner approved for staging on 4 Nov. `MEDICATIONS`, `OPEN_SIGNUP`, `PHONE_SMS_VERIFY`, `CONSOLE_GOOGLE_SIGNIN`, `WHATSAPP_DEBUG_LOG` and `WALDO_TOOL_SEARCH` stay off. `HISTORY_ARCHIVE` starts at `dry`. Production (the top level) stays all off under the standing rule.

The block on this branch already carries these values. A switch whose precondition is not met on beta when it is first deployed is set to `0` with `--var` at that deploy, and the reason is recorded in the B7 note.

| Switch | Staging (from the 4 Nov bundled deploy) | Beta | Precondition on beta |
| --- | --- | --- | --- |
| `WALDO_OWNER_FIRST`, `WALDO_SECOND_MESSAGE` | 1 | 1 | none beyond the deploy |
| `APPROVE_IN_CHAT` | 1 | 1 | none |
| `HEALTH_EASE_WORKOUT`, `CALENDAR_UNDO_CANCEL` | 1 | 1 | `connector-proxy` deployed from the promoted tag (B5 does this by construction) |
| `AUTONOMY_OWN_CALENDAR` | 1 | 1 | Inert until an owner can create a grant (alpha runbook §1.2) |
| `HISTORY_ARCHIVE` | `dry`, then `1` after about a day | `dry` | Flip to `1` on beta only after staging has run `1` for the soak period (§6) |
| `PLANNING_BRIEF`, `WHY_TRAIL`, `WALDO_TASK_ASK`, `WALDO_TASK_NOTES`, `GOOGLE_REALTIME_TRIAGE`, `NEXT_DUE_ALARM` | on as each PR merges | Not in the block yet: these keys do not exist at the pin | Each key's PR adds it to beta as well (the guard requires the same key set) |
| `APP_ID_TOKEN_SIGNIN` | 1 | 1 | Beta's Supabase Google and Apple providers list the client ids (B3, B10). Without them, sign-in with Apple and Google fails and the email code still works. |
| `MCP_READ_INTENTS`, `WALDO_MCP_SERVERS` (Google Workspace MCP) | 1, list | 1, list | The beta Google project joined to the Workspace Developer Preview with the MCP APIs enabled (B10), and its client marked agentic. Otherwise MCP reads fail and REST reads still work. |
| `WALDO_EGRESS_ALLOWLIST` | `*` | `*` [proposed, D6] | none. Private and internal addresses stay blocked. |
| `WALDO_COST_LEDGER_SYNC` | on | on | The per-owner ceiling counts only while this is on |
| `LANGFUSE_CAPTURE_TEXT` | true | false (guarded, and forced by code) | n/a |
| `GMAIL_PUSH_PROJECT` | `waldo-dev-492217` | `""` | Set to `waldo-beta` in a one-line PR after B10 |
| `MEDICATIONS`, `OPEN_SIGNUP`, `PHONE_SMS_VERIFY`, `CONSOLE_GOOGLE_SIGNIN`, `SCREEN_TIME` | 0 | 0 | Owner ruling (the first four); `SCREEN_TIME` is off on staging too |
| `WHATSAPP_DEBUG_LOG` / `WALDO_TOOL_SEARCH` | false / off | false / off | Owner ruling |
| Channel identities (`WHATSAPP_WALDO_NUMBER`, `IMESSAGE_*`, `PHOTON_PROJECT_ID`, `AGENT_MAIL_*`) | set | empty or 0 | §4 |

**Sign-up is invite-only [proposed].**
- `OPEN_SIGNUP` stays `0`, so the app admits only an invited address.
- Admins issue every invite from the console, and Waldo emails none of them (alpha runbook §3.1).
- One gap remains: each member can still issue five invites, and nothing caps the total (alpha runbook P13, not built [verified: no `max_active_owners` in migrations]).
- For the first batch of up to 20, ask testers not to invite, and read the owner count daily. Land P13 before widening past that.

## 6. Promotion rule

Beta runs only code that staging ran first.

1. **Candidate.**
   - The commit is a `beta-mvp` merge that the Mac gate merged with an independent PASS and green CI.
   - Staging is serving it: `/healthz` `release` equals its short SHA, and `scripts/staging-gate.mjs --expect-sha` passed at that deploy.
2. **Soak.**
   - Staging serves that exact release for at least 24 hours, and at least 48 hours when the commit carries a Supabase migration, a Durable Object migration or a switch's first turn-on.
   - During the soak there is no rollback, no open incident (alpha runbook §3.3), and no new error class in `wrangler tail` sampling.
   - The nightly `evals-live` run on that SHA is not below the last promoted baseline (`docs/evals/LIVE_BASELINE_RUNBOOK.md`).
3. **Tag.**
   - Create an annotated tag `beta-YYYYMMDD-<shortsha>` on `waldoco/waldo-backend`. Its message names the staging deploy time, the soak end and the gate verdict.
   - Pushing the tag is part of that promotion's owner yes.
4. **Deploy from the tag only.**
   - Use a clean, detached checkout of the tag and `pnpm@10.34.4` install. Run the migration preflight for beta (needs P1, §8), and apply pending migrations by the reviewed route.
   - Deploy the edge functions from the tag. Build the dashboard. Deploy the Worker:
     - with `wrangler deploy --env beta` when the commit adds a Durable Object migration;
     - otherwise with `versions upload --env beta --var WALDO_RELEASE:<sha>`, then `versions deploy <id>@100% --env beta --yes`.
   - Then run `node scripts/beta-gate.mjs --expect-sha <sha>`.
5. **Rollback.**
   - Roll back to the previous beta tag's version: `scripts/beta-rollback.sh <version-id> --confirm <version-id>`.
   - It restores code and bindings only, not Durable Object state, secrets, edge functions or migrations.
   - Migrations are forward-only. A commit whose migration cannot run under the previous Worker version is not promotable until an expand-then-contract split exists.

A beta deploy is never batched under a staging yes, and never under a previous beta yes.

## 7. Data separation and GDPR (Art. 9)

**No tester data in staging.**
- Cohort testers get beta builds only: the TestFlight external group "Beta cohort" receives only builds from the `beta-ios` profile.
- Staging's `testflight` builds go to the internal group only. The same bundle id means a device holds one Waldo at a time, and a tester added to the wrong group would put their data into staging.
- On Android, the beta build is release-signed and staging's APKs are debug-signed. They cannot install over each other, so a tester uninstalls once.
- Invites for testers are issued in beta's console only.
- A tester who used staging before starts fresh on beta. No staging account, memory or health history is carried over: no import path exists, and copying one would move Art. 9 data between environments.

**No staging data in beta.**
- Beta is never seeded from a staging dump or restore.
- Every secret and the Vault key are fresh.
- Eval fixtures and test owners use synthetic values.
- The guard refuses staging identities in the beta block.

**Privacy notice and terms.** Version 1 is published at heywaldo.in/privacy and /terms [recorded: memory of 27 Oct; not re-read here]. Before the first invite, check that the published notice covers:
- the processors beta uses (Anthropic, OpenAI, Supabase, Cloudflare, Expo, Brave, the SMTP provider, Google);
- that push may name an event (`PREP_PUSH_NAMES`, `UPDATE_PUSH_NAMES` are 1);
- the owner look-up (`OWNER_LOOKUP`, `ONBOARDING_LOOKUP` are 1);
- sleep need (`HEALTH_COACHING` is 1).

If any is missing, set that switch to `0` at B7.

**Deletion.**
- In-app account deletion exists and runs the path in alpha runbook §3.2 [verified: `channels/dashboard-owner-controls.ts`].
- Three P4 gaps are still open at the pin [verified: no erase-pending marker and no provider revoke in the delete path]:
  - a lost `delete_owner` response strands the Durable Object;
  - Google grants are not revoked at Google;
  - the device and iMessage bridge objects are not cleared (iMessage is off on beta).
- ADR-0055 requires the full cascade to be walked on a test user before any external user. B13 does that walk.

**Export.**
- No account export exists [verified: only artifact exports]. ADR-0073 §1 item 3 makes it a gate before any external user.
- Either P10 lands, or the owner records a ruling that beta testers get export on request, done by hand from the SQL editor and the owner's DO within 30 days. That is a manual process the privacy notice must describe.

**Retention.**
- The daily cron runs the health retention sweep.
- `HISTORY_ARCHIVE` starts at `dry`: it counts, and moves or deletes nothing.
- Langfuse is not configured (D7).
- Supabase PITR and Durable Object point-in-time recovery keep deleted data for their windows. The privacy notice must say so (ADR-0055 tombstone ledger, not built).

**Geography.** ADR-0073 §2 excludes EU, EEA and UK testers at beta, and the 21 Oct build direction says global-first. Until the owner amends the ADR, the invite list follows it (alpha runbook D8).

## 8. Blockers

Each blocker is stated with what clears it. None is cleared by this branch, except where a row says so.

| # | Blocker | State | What clears it |
| --- | --- | --- | --- |
| K1 | **The app cannot reach beta.** `bootstrapAppRuntime` refuses every origin but the two staging ones, so a build with the beta origin starts unconnected [verified: `src/agent/bootstrap.ts`]. | Fixed by the app PR: a separate reviewed beta origin. `talksToStaging()` stays false for it, so beta testers never see the staging capture line. | App PR merged; first `beta-ios` build reaches `/healthz` |
| K2 | **Google OAuth.** Beta needs its own project (§2). In Testing: 100 users over the project's lifetime, and refresh tokens that expire every 7 days, so every tester reconnects weekly. Beyond 100 users, Gmail read (restricted scopes) needs restricted verification plus a yearly CASA assessment by an App Defense Alliance lab. Prices are unpublished; review takes "several weeks" after brand verification [recorded: `docs/research/GOOGLE_INTEGRATION_2026-10-21.md` §3, §5]. | Not started for beta | **For the cohort (≤100):** B10 in Testing, each tester added as a test user before their invite. **Beyond 100:** brand verification on `heywaldo.in` (Search Console), a Limited Use statement, an in-app disclosure before consent, a written prompt-injection defence, CASA quotes from 2–3 labs, then submission. Scope trimming (G2 in the research doc) shrinks the review. |
| K3 | **TestFlight external review.** The first build for an external group goes through Beta App Review [inference from Apple's TestFlight process; typical turnaround about a day, not guaranteed]. | Not submitted | A `beta-ios` build. The beta app description, feedback email and privacy URL in App Store Connect. A reviewer sign-in: an invited demo owner on beta, since sign-up is invite-only, with no real health data. |
| K4 | **Android release signing.** Every APK today carries the Expo template's public debug key [verified: `android-release.yml`]. | Not created | B12: an EAS-managed keystore (`eas credentials`), used by the `beta-android` profile. Or set the four `ANDROID_KEYSTORE_*` secrets for the GitHub workflow. Losing the key strands updates, so the owner keeps a backup. If Play distribution is chosen (D11), enrol in Play App Signing. |
| K5 | **No crash reporting** on either app [verified: no Sentry, Crashlytics or Bugsnag dependency in `waldo-app/package.json`]. The backend has Workers logs only, and no error tracker in `src` [verified]. | Not built | A processor chosen (D10, with its DPA), scrubbing of PII and health values, and the SDK in the app. The design belongs to the strategy session's readiness page. |
| K6 | **No minimum-version path.** No server field or response forces an update, and the app has no "update required" screen [verified: grep of contracts and app; the ask sits in `waldo-app/Docs/planning/ECOSYSTEM_CONTRACT_REQUEST.md`]. OTA is deferred [recorded], so a breaking contract change would strand installed beta builds until testers update by hand. | Not built | An additive contract field (for example `min_app_revision` on an existing app response) plus an app screen, in both repos, landed before the first external build. Until then: `app.v1` stays additive-only [recorded rule], and beta promotes no contract break. |
| K7 | **ADR-0073 §1 floor, P4 and P10.** "Before any external user": DPIA, processor DPAs with zero retention, retention schedule, breach plan, crisis pack per geography, 18+ gate, data export, privacy copy. Deletion gaps are in §7. | Open [recorded: alpha runbook §3.5; P4/P10 re-checked at the pin] | Either each item closes, or the owner records a written ruling scoping it for the beta cohort (for example: export on request, India-only cohort, crisis line for India). This is the owner's call, not the gate's. |
| K8 | **Migration route for a second project (P1).** The preflight, apply and gate scripts accept only the staging ref [verified: `readHistory` throws `target_not_allowed`]. | Not built | P1, with the beta ref as its second constant, after B3. Until then B4 cannot run by the reviewed route. |
| K9 | **Cloudflare account and zone.** The custom domain needs the Worker in the zone's account (§2). | Decision D1 | D1 |
| K10 | **Auth email.** Without custom SMTP, invitees get no sign-in code. | Not set | B3 |

## 9. Cost and monitoring

**Estimate for a cohort of up to 50 [inference; check each price at its step].**

| Item | Monthly |
| --- | --- |
| Cloudflare Workers Paid (`cpu_ms` 300000 needs it) | USD 5 base, plus usage. Already paid if beta shares staging's account. At 50 owners, usage is expected inside the included tiers [inference]. |
| Supabase Pro, plus the compute add-on PITR needs, plus PITR (7 days) | about USD 25 + compute + about USD 100. ADR-0058 asks for PITR. |
| Model spend | The ceiling is USD 25 per owner per month, and it is where degradation starts, not a cap. Past it a turn runs on the auxiliary model, and background work is not gated (alpha runbook §3.1, P12). So 50 owners is about USD 1,250 before anyone degrades. Hard provider limits are the only true cap: [proposed] Anthropic `waldo-beta` USD 1,500 and OpenAI `waldo-beta` USD 300 (fallback, Stagehand, transcription). |
| Brave Search, SMTP, EAS builds | small, plan-dependent [unverified] |
| Google Play (only if D11 picks Play) | USD 25 once |
| CASA (only past 100 Google users) | unpublished; quotes needed |

**Ceilings and alerts (B11).**
- Provider hard limits as above, with alerts at 50% and 80%.
- `WALDO_COST_LEDGER_SYNC=on` is in the beta block, so the per-owner ceiling counts.
- Read `scripts/cost-report.mjs --ledger` against beta's ledger daily during the first two weeks.
- Cloudflare notifications on `waldo-runtime-beta` errors.
- An external uptime check on `https://app.heywaldo.in/healthz`.
- Supabase usage alerts.
- Name who is paged (D9).

**After every beta deploy.** Run `node scripts/beta-gate.mjs --expect-sha <sha>`. It checks:
- `healthz`;
- that the app answers 401 when signed out;
- that the console answers 303 when signed out;
- that the staging probe route is closed (404);
- that Telegram is off (404);
- that the WhatsApp verify is refused (403), and that WhatsApp POST and Gmail push answer 404 until each channel is set up;
- with credentials, the deployed version and that no browser is bound.

It exits 2 (INCOMPLETE) until the Supabase ref is committed and Cloudflare credentials are present.

**Evals gate.** Promotion needs the nightly `evals-live` result on the candidate SHA (§6). The live eval builds turns as staging does (`WALDO_EVAL_PROFILE=staging`). Beta's switch set equals staging's apart from channels, so that profile stands in for beta [inference]. A beta-specific profile is a follow-up if the two diverge.

## 10. Creation steps, in order

Each step is its own owner yes. "Blast radius" is what changes. "Reversible" says how to undo it.

**B0. Decide (no hosted change).**
- Owner action: answer D1–D11 (§11).
- Blast radius: none.
- Reversible: n/a.

**B1. Merge this branch and the app PR.**
- Owner action: the Mac gate reviews; merge with an independent PASS and green CI.
- Blast radius: config and scripts only. `deploy-runtime.sh` now refuses any target but staging. Staging deploys pass `--env staging` and are unaffected.
- Reversible: yes, revert the commits.

**B2. Code prerequisites (separate PRs, gated as usual).**
- P1 (migration route, after B3 gives the ref).
- K6, the minimum-version path.
- K5, crash reporting.
- P4a.
- P10, or the owner ruling of K7.
- P13 before widening past 20.
- The `SCRIPTS` line and the subdomain decision, only if agent mail is turned on.
- Blast radius: code only.
- Reversible: yes.

**B3. Create the Supabase project `waldo-beta`.**
- Owner action: alpha runbook S1, with these names:
  - region per D2, PITR on;
  - expose `waldo`;
  - Email OTP;
  - Site URL `https://app.heywaldo.in`;
  - the Magic Link template from `supabase/templates/magic_link.html`;
  - custom SMTP;
  - check `pgcrypto` and `supabase_vault`;
  - the Vault secret `waldo_router_hmac` from the dashboard;
  - Apple provider client id `com.heywaldo.app`.
- Then a one-line PR sets `BETA_SUPABASE_PROJECT` in `scripts/beta-gate.mjs`, and P1's beta constant.
- Blast radius: a new, empty project. No staging effect.
- Reversible: yes, delete the project while it holds no owner.

**B4. Apply migrations from zero (needs P1).**
- Owner action: from a clean checkout of the first promotion tag, preflight, then review the pending list (110 files at the pin [verified: `production-alpha-dryrun` from-zero count]), then apply by digest, then preflight again for 0 pending.
- Blast radius: beta's database only.
- Reversible: before any owner exists, delete and recreate the project (B3). After that, forward-only.

**B5. Edge functions.**
- Owner action: set the function secret `WALDO_ROUTER_HMAC_SECRET`. Deploy `connector-proxy --no-verify-jwt` and `oauth-proxy` from the tag. Never deploy `mint-agent-jwt`. An unsigned call answers 401.
- Blast radius: beta's functions.
- Reversible: redeploy from the previous tag.

**B6. Cloudflare resources.**
- Owner action: in the D1 account, confirm Workers Paid, then create the R2 bucket `waldo-artifacts-beta` explicitly, so the first deploy finds it rather than provisioning it.
- Blast radius: one empty bucket.
- Reversible: yes, delete the bucket while it is empty.

**B7. First beta deploy.**
- Owner action:
  - Merge a one-line PR that lets `deploy-runtime.sh` accept `--env beta`, then run it from a clean checkout of the tag.
  - Set any switch whose precondition fails to `0` with `--var`, and record it.
  - This creates the Worker `waldo-runtime-beta`, its seven Durable Object namespaces, the cron and the custom domain `app.heywaldo.in`.
- Check: `beta-gate.mjs`. `healthz` passes. App and console routes answer 401 and 303, and owner routes 503 until B8 (no directory secrets yet).
- Blast radius: a new Worker and a new hostname, with no owners.
- Reversible: before any owner exists, delete the Worker (which deletes its namespaces) and detach the domain. After that, `beta-rollback.sh` restores code only.

**B8. Worker secrets.**
- Owner action: `npx wrangler secret put <NAME> --env beta`, typing each value at the prompt, for the required names in §2. The Google pair waits for B10.
- Check: `wrangler secret list --env beta` shows exactly those names.
- Blast radius: the beta Worker's secrets.
- Reversible: `wrangler secret delete`, and rotate at the provider.

**B9. Owner namespace.**
- Owner action: read the `OWNER_DO` namespace id. Merge a one-line PR setting `env.beta.vars.WALDO_OWNER_DO_NAMESPACE`, then redeploy through the promotion path.
- Blast radius: files and workspace start answering.
- Reversible: revert the var.

**B10. Google.**
- Owner action:
  - Create project `waldo-beta` (D4). Enable the Calendar, Gmail, Tasks, People and Drive APIs, plus the MCP APIs if MCP stays on.
  - Branding: home, privacy and terms on `heywaldo.in`.
  - Create the Web client (redirect in §2) and the iOS client.
  - Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets and as `connector-proxy` secrets.
  - Add the client ids to the Supabase Google provider.
  - Create the Gmail push topic and subscription (§2), then a one-line PR sets `GMAIL_PUSH_PROJECT`.
  - Add each tester as a test user before inviting them.
- Blast radius: Google access for beta owners.
- Reversible: delete the clients; owners re-link.

**B11. Spend limits and alerting (§9).**
- Blast radius: none until a limit trips. A tripped provider limit stops every beta owner's turns on that provider.
- Reversible: raise the limit.

**B12. App builds.**
- Owner action:
  - `eas credentials` for Android creates the upload keystore. This is irreversible in effect: the package's signing identity on any store.
  - Build with `eas build --profile beta-ios` and `--profile beta-android`. Submit the iOS build to App Store Connect, assign it to the external group "Beta cohort" only, and pass Beta App Review (K3).
- Blast radius: testers' devices.
- Reversible: expire the build in TestFlight. The Android key is not reversible.

**B13. Test owner and end-to-end run.**
- Owner action: seed the first admin row by hand (alpha runbook S11), invite one test owner, and run the console and app end to end, including account deletion with a read-back of every store in alpha runbook §3.2.
- Blast radius: synthetic data only.
- Reversible: delete the test owner.

**B14. Invite in batches.**
- Owner action: invite 5, then 20, then the rest, with a day of logs, ledger and gate reads between batches.
- Blast radius: real owners' Art. 9 data from the first invite onward.
- Reversible: pause invites. Delete per owner (§7).

## 11. Owner decisions

| # | Decision | Recommendation [proposed] |
| --- | --- | --- |
| D1 | Cloudflare account for beta | The account holding the `heywaldo.in` zone, or move the zone to the LLP's account first. Durable Object data never leaves the account that created it. |
| D2 | Supabase organisation, region, plan | The LLP's organisation, a region near the cohort, PITR on |
| D3 | Beta host | `app.heywaldo.in` (free in DNS on 4 Nov) |
| D4 | Google project | Separate `waldo-beta`, in Testing for the cohort |
| D5 | WhatsApp and iMessage on beta | Off at launch. The app and console carry the cohort. Reconsider WhatsApp once Meta clears and a second number exists. |
| D6 | Egress `*` on beta | Yes, matching staging |
| D7 | Langfuse on beta | None for the first batch. If wanted later: a separate project, hashed owner ids (alpha runbook P5), and a retention period. |
| D8 | Cohort geography | Follow ADR-0073 §2 until it is amended |
| D9 | Who is paged; support address | Both founders; one support address named in the privacy notice |
| D10 | Crash-reporting processor | From the strategy session's readiness page |
| D11 | Android distribution | Play Console internal testing (release key, store updates), or direct APK from GitHub releases (no Play account, manual updates). The `beta-android` profile builds an APK either way; Play needs an AAB profile added then. |

## 12. Evidence

**Observed this session (4 Nov).**
- Read at `8455b0b9`:
  - `packages/runtime/wrangler.jsonc`;
  - `scripts/deploy-runtime.sh`, `staging-gate.mjs`, `staging-rollback.sh`, `staging-migration-preflight.mjs` and `production-alpha-dryrun.mjs`;
  - `guard-wrangler-local-bindings.mjs`;
  - the `WALDO_ENVIRONMENT` branches listed in §1;
  - `channels/whatsapp-webhook.ts:183-202`;
  - the `app_push_register` migrations;
  - `docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md` and `STAGING_DEPLOY_GATE.md`.
- Read at `waldoco/waldo-app` `3f92ae7e`: `eas.json`, `app.json`, `android-release.yml`, `src/agent/bootstrap.ts`, `buildChannel.ts`, `stagingTransport.ts`, `src/auth/googleSignIn.ts` and `package.json`.
- wrangler 4.135.0 `wrangler-dist/cli.js`: `createDraftWorker` and `provisionBindings`.
- `dig` for `app.`, `api.`, `beta.`, `staging.` and `mail.heywaldo.in`, and for the apex and NS.
- `node scripts/production-alpha-dryrun.mjs`: 9 open; 110 migrations from zero.

**Inference.**
- The zone and account constraint.
- Push credentials being per app.
- The agent-mail handle collision.
- TestFlight review time.
- All cost figures.
- The eval profile standing in for beta.

**Unverified.**
- The staging secret list and staging's SMTP and PITR state.
- Whether FCM credentials are in EAS.
- Whether the privacy notice covers every row in §7.
- The Apple and Play account state.
- Current Supabase and EAS prices.
