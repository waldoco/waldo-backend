# Production alpha runbook, 22 October 2026

This document plans the stand-up of a production backend for an invite-only alpha of 50 owners: what production needs, the order to stand it up, what must be true before the first invite, and which gaps need code first. It authorises nothing. Every hosted step below needs the owner's explicit yes for that action. Deploys and migrations to production are never batched under an earlier approval.

Source pin: `origin/beta-mvp` at `c5e44093`. This work was read-only on every hosted system. Nothing was deployed, migrated, set or sent. The only network reads were GitHub, and public documentation from Supabase, Cloudflare and Langfuse.

Labels:
- **[source]**: read in source at `c5e44093` in this session.
- **[staging, recorded]**: staging evidence that another session recorded; the record is named.
- **[cited]**: a primary external document read this session, linked.
- **[unverified]**: not checked.
- **[inference]**: a conclusion drawn from the above.

## 0. The answer

1. **No production backend exists.**
   - The 21 Oct read-only Cloudflare check found no `waldo-runtime` Worker (recorded in #1400).
   - No production Supabase project is named anywhere in the repo, and every migration and gate script refuses any project but staging [source].
   - There is no production Google client, no production domain and no production Langfuse project [source; `docs/research/GOOGLE_INTEGRATION_2026-10-21.md:27-31`].
2. **Production is not staging, so the 22 Oct staging E2E proves little about it.** The top-level (production) Worker in `packages/runtime/wrangler.jsonc` differs from `env.staging` in these ways [source]:
   - it uses a different entry file;
   - it has no browser, no egress (`WALDO_EGRESS_ALLOWLIST` empty) and no MCP servers;
   - it keeps the default CPU limit and has no cron, so the health retention sweep never runs;
   - four feature flags are `"0"`;
   - it has no Workers AI or Vectorize binding, and no source file reads either one.

   A production console E2E on a seeded test owner (step S11) comes before the first invite.
3. **Hard blockers, in the order they bite:**
   - **Account choices.** Choose the Cloudflare account, the Supabase region and the domain first; each is expensive to undo.
   - **Sign-in email.** Supabase's built-in email sends only to project team members, at 2 messages an hour [cited], so invitees could not sign in.
   - **Migration route.** The existing preflight and apply scripts cannot target a second project [source].
   - **Config separation.** The production Worker shares its R2 bucket name and its rate-limit namespace with staging, and the bindings guard forbids separating them [source].
   - **Account deletion.**
     - Provider grants are never revoked.
     - The device and iMessage bridge objects keep state.
     - One failure window strands the owner's whole Durable Object with no retry path.
     - The receipt names no residue.
     - ADR-0055 requires the full cascade to be walked on a test user before any external user.
   - **The ADR-0073 §1 floor.** It is accepted and binds "before any external user". Data export does not exist. The DPIA, the processor DPAs with zero retention, the crisis pack per geography, the breach plan and the retention schedule are not in this repo.
   - **Spend.** The per-owner spend ceiling is off unless `WALDO_COST_LEDGER_SYNC=on`. No limit covers all owners together.
   - **Alerting.** No alerting is configured in the repo, and none is recorded anywhere else [source; hosted consoles not read].
4. **What already holds in production by code [source]:**
   - Text capture to Langfuse is forced off when `WALDO_ENVIRONMENT=production` (`observability/trace-privacy.ts:83-87`).
   - The WhatsApp debug log works only on staging (`channels/whatsapp-webhook.ts:23`).
   - The synthetic probe route returns 404 outside staging (`channels/probe-turn.ts:82`).
   - Production binds no browser (`scripts/guards/guard-wrangler-local-bindings.mjs`).
   - The production bundle starts without Node compatibility (`scripts/tests/runtime-bundle-startup.test.mjs`).

`node scripts/production-alpha-dryrun.mjs` turns the config half of this document into a check that runs offline. It reads `wrangler.jsonc` and the committed migrations, prints each gap, and exits 1 while any gap or open decision remains. It runs no command and reads no secret.

## 1. Environment matrix

Secret names only. No value appears in this repo, in this document or in any command below.

### 1.1 Cloudflare Worker and bindings

| Item | Staging (`env.staging`) | Production (top level) today | Production needs for the alpha |
| --- | --- | --- | --- |
| Cloudflare account | The personal testing account (`docs/ops/TEARDOWN.md`) | No Worker deployed (recorded in #1400) | An organisation-owned account (decision D1). Durable Object data lives in the account that created it, so choose before the first deploy. |
| Worker name | `waldo-runtime-staging` | `waldo-runtime` | Same, or `waldo-runtime-production` under `env.production` (P2) |
| Entry | `src/staging-browser.ts` (adds the Playwright SDK, re-exports `index`) | `src/index.ts` | Keep `index.ts` |
| `compatibility_flags` | `nodejs_compat` | none | none; the bundle startup test asserts production needs none |
| `limits.cpu_ms` | 300000 | default (30 s) | 300000. The staging comment says long owner turns pass 30 s (P3). |
| Cron | `17 3 * * *` (health retention sweep) | none | The same cron (P3). Without it, raw health is never swept on schedule. |
| Durable Objects | `OWNER_DO`, `DEVICE_BRIDGE_DO`, `IMESSAGE_BRIDGE_DO`, three retired classes; migrations v1–v7 | identical | identical. Open PRs #1334 and #1355 change DO migration tags; freeze before stand-up. |
| `WALDO_OWNER_DO_NAMESPACE` | the staging `OWNER_DO` namespace id | `""`, so the workspace and files answer `unavailable` (`channels/workspace-host.ts:59-60`) | The production namespace id. It exists only after the first deploy (S5). |
| R2 `ARTIFACTS` | bucket `waldo-artifacts` | bucket `waldo-artifacts`, the same name | Its own bucket (P2). On one account the name is the same bucket. |
| Rate limiter `RESPONSIBILITY_RATE_LIMITER` | namespace `1001`, 120 per 60 s | namespace `1001` | Its own namespace (P2). Same id on one account means shared counters across Workers [cited: [Cloudflare rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)]. |
| Browser Rendering `BROWSER` | bound | forbidden by guard | none (owner ruling) |
| Workers AI `AI`, Vectorize `VECTORIZE` (`waldo-recall`) | bound | none (guard forbids top level) | none. No source file reads them [source]. |
| Assets | `../dashboard-app/dist` | same | same |
| Observability | logs on, invocation logs off, query strings redacted, traces off | same | same (guarded) |
| Routes / custom domain | `staging.heywaldo.in` (custom domain) and `workers.dev`, which webhooks still post to; `WALDO_PUBLIC_ORIGIN` is `https://staging.heywaldo.in` | none | One custom domain with `WALDO_PUBLIC_ORIGIN` set to it (S6, P2). Every stored-origin writer goes through `publicOrigin()` (`connectors/public-origin.ts`), so a second live host cannot flip the owner DO's origin. Browser page loads on another host move to the configured one (`channels/canonical-host.ts`). |
| Deploy path | `scripts/deploy-runtime.sh --env staging` from the Mac | **The same script with no flag deploys production** (`scripts/deploy-runtime.sh:5`) | An explicit `--env production`, with no argument refused (P2) |

### 1.2 Worker vars

| Var | Staging | Production today | Production for the alpha |
| --- | --- | --- | --- |
| `WALDO_ENVIRONMENT` | `staging` | `production` | `production`. It forces Langfuse text off. |
| `WALDO_RELEASE` | restamped by the deploy wrapper | same | same |
| `WALDO_OWNER_TELEGRAM_ID` | the owner's Telegram id | `""` | `""`. The single-owner fallback stays off. |
| `LANGFUSE_CAPTURE_TEXT` | `true` | `false` | `false` (code forces it off in any case) |
| `WHATSAPP_DEBUG_LOG` | `true` (#1398 commits `false`) | `false` | `false` |
| `WALDO_COST_LEDGER_SYNC` | not set | not set | `on` (S9). The guard mirrors var keys, so committing it adds the key to staging too; #1400 recommends `on` there as well. |
| `WALDO_COMPACTION` | `on` | `off` | `off`. Only `on` turns it on, and only for the app chat: after the app drain settles a reply, the owner object compacts that chain under its own scope and deadline (`compactApp`, `owner-do.ts`), on the auxiliary model, costed as a turn. Production waits for the compaction eval (`WALDO_EVAL_COMPACTION=on`, ADR draft §6); `off` is the rollback. |
| `CALENDAR_GROUNDED_PREP`, `MAIL_SOURCE_FOLLOWUPS` | `1` | `0` | Decision D6. Unset means on; only `0` disables (`channels/proactive-gate.ts:14`). |
| `PREP_PUSH_NAMES` | `0` | `0` | `0` until privacy notice v2 (which lets a push name an event title and time) is live. While it is off, a prep note's app push is the fixed line "Waldo has a note before your next meeting". At `1` it reads "Prep: <title> at HH:MM", with email addresses removed and a health value falling back to the fixed line (`channels/event-briefs.ts` `prepPushBody`). Off unless `1`. |
| `WALDO_DAY_STATE` | `0` | `0` | `0` until the S0 day-change scenarios pass. At `1` the update sweep keeps what each calendar event last looked like (DO table `calendar_last_seen`, two weeks), reads changes from a day back to two weeks ahead, and its apply turn chooses effects: revise a delivered day card, say an update, push, or nothing. The "Close already sent" hold is gone; quiet hours, volume and follow-ups off still hold. `0` is the rollback: the update card as before. Off unless `1`. |
| `UPDATE_PUSH_NAMES` | `0` | `0` | `0` until the privacy notice's Expo row says an update push may name the change. While it is off, an update push is the fixed line "Waldo has an update to your day". At `1` the push carries the model's line, checked at the send: no email address, no health value, no span of a mail it read; any failure sends the fixed line. Off unless `1`. |
| `DRIVE_READS`, `MCP_READ_INTENTS` | `1` | `0` | Decision D6. Off unless `1`. |
| `APP_AGREEMENTS` | `0` | `0` | `0` until the owner approves the version 1 terms and privacy notice (`docs/app/ONBOARDING_AND_CONSENT_2026-10-21.md`). Off unless `1`. While it is off, the app shows no agreements step and no first run. |
| `OWNER_LOOKUP` | `0` | `0` | `0` until the privacy notice that discloses the look-up is published (`docs/app/ONBOARDING_AND_CONSENT_2026-10-21.md`). Off unless `1`. |
| `OWNER_PROFILE` | `0` | `0` | `1` gives every owner turn the owner profile view (`memory/owner-profile.ts`: owner-grounded claims grouped by source, pins first, no stated health readings) in place of the pinned blocks. Off unless `1`; design in `docs/planning/owner-profile-noticing.md`. |
| `MEMORY_NIGHTLY_SOURCE_UPDATES` | `0` | `0` | `1` lets the 03:00 nightly pass also read the calendar and mail changes the update sweep recorded since its own mark (`channels/nightly-sources.ts`). That is outside content: only adds apply, and every claim it writes is `origin:'untrusted'` (not recalled, pinned, promoted or shown in the constellation block until the owner confirms it). The adds and the mark commit in one transaction. At most 3 auxiliary calls of 40k characters a night; a busier day drains over the next nights. Text stays out of traces (`memory_*` purpose). Off unless `1`. |
| `PHONE_SMS_VERIFY` | `0` | `0` | `0` until every precondition in §1.2.1 is met. Off unless `1`; with it on, the console and app phone views offer a texted code (`identity/phone-sms.ts`). |
| `PHONE_SMS_COUNTRIES` | `+91` | `+91` | `+91`. The country codes a code may be texted to, comma-separated. The ledger refuses any other number (`unsupported`), and an empty or malformed list keeps texting off. `+1` would admit every NANP number, Caribbean ones included [inference: NANP spans the US, Canada and Caribbean countries]; Twilio's geo permissions are the finer control (§1.2.1). |
| `PHONE_SMS_DAILY_LIMIT` | `20` | `20` | `20`. Texts per UTC day across the whole server, counted by the ledger. The ledger holds any higher value to 200; a missing or malformed value keeps texting off. |
| `CONSOLE_GOOGLE_SIGNIN` | `0` | `0` | Off unless `1`. With it on, the console sign-in page offers Continue with Google: Supabase's web OAuth with PKCE, back to `/console/signin/google/callback`, existing members only (`identity/google-pkce.ts`). Before turning it on, add that callback URL to the Supabase project's Redirect URLs; otherwise Supabase sends the browser to the Site URL and the sign-in is lost. Web Apple is not built (it needs a Services ID and an expiring client secret). A Google account that reaches an existing owner for the first time signs in only after an email code confirms it (`waldo.owner_signin_identities`, migration `20261026160000`). |
| `APP_ID_TOKEN_SIGNIN` | `1` | `0` | Off unless `1`. With it on, the app's Sign in with Apple and Google (`POST /app/v1/auth/id_token`) is served; off, it answers 404 and the app offers the email code. Needs migration `20261026160000` applied first, and each provider's client IDs listed on its Supabase provider (Google: the web and iOS clients; Apple: `com.heywaldo.app`). An Apple or Google identity that reaches an existing owner for the first time gets `confirm_with_email_code` and signs in only after that code. |
| `WALDO_MCP_SERVERS` | Google Workspace MCP JSON | `[]` (pinned by `google-mcp-catalogue.test.ts:175`) | `[]` for the alpha. Workspace MCP is a developer preview, and our client is not marked agentic (Google research doc §1). |
| `WALDO_EGRESS_ALLOWLIST` | `*` | `""`, so egress fails closed (`allowlist_unavailable`) | Decision D6 |
| `IMESSAGE_CONNECTOR_ENABLED`, `IMESSAGE_CONNECTOR_POLICY`, `IMESSAGE_ONBOARDING_URL`, `IMESSAGE_WALDO_ADDRESS` | enabled, heywaldo.in values | off, empty | off until a production host Mac and Apple Account exist (D5) |
| `WHATSAPP_ONBOARDING_URL`, `WHATSAPP_REENGAGE_TEMPLATE`, `WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE` | onboarding URL set; templates empty | empty | empty until Meta verification and a production number (D5) |
| `WHATSAPP_WALDO_NUMBER` | `919226067544` | `""` | `""` until the production number exists (D5). Not a secret: the number Waldo is reached on, as E.164 digits without the plus (8 to 15 digits, no leading 0). Set, the app's WhatsApp channel link (`POST /app/v1/onboarding/channel-link`) returns `address: "+<digits>"` and `send_url: "https://wa.me/<digits>?text=waldo%20<CODE>"`, and the console's WhatsApp code shows Open WhatsApp (`channels/whatsapp-send-url.ts`). Unset or malformed, both fall back to the code alone (`address` and `send_url` null). Code expiry, throttles and step-up are unchanged. `""` is the rollback. |
| `GMAIL_PUSH_PROJECT` | `waldo-dev-492217` | `""` | `""` until the production Cloud project has its `waldo-gmail-push` topic and push subscription (S7). While it is empty, production starts no Gmail watch (`gmail_watch_skipped:unconfigured`) and `/events/gmail` answers 404; mail reads still work (`connectors/google-push.ts`, `channels/event-ingress.ts`). |
| `WALDO_TOOL_SEARCH` | `off` (OpenAI refused the request shape on every round, 26 Oct) | `off` | `off` until staging's tool-search E2E and a live flag-on eval pass (`docs/ops/staging-e2e/tool-search.md`). `off` is the rollback. |
| `WALDO_TOOL_LOADER` | `harness` | `off` | `off` until staging's harness loader is measured live (tokens per round, rounds, latency) and its eval passes. `harness` offers core tools plus `find_tools`/`use_tool` on any provider and wins over `WALDO_TOOL_SEARCH`; `off` is the rollback. |
| `HEALTH_SOLO_NOTICE` | `0` | `0` | `0` until the gate turns it on for staging and the health-only scenarios pass the judged nightly run. Off unless `1`. With it on, on a day with nothing on the owner's calendar, tasks or open loops, the health trigger asks the model whether a health change is worth one short note. A note goes out as an update card through the final outbox (`health-notice:<day>`, at most one a day). It shares the trigger's delivery-gate budget, quiet hours and opt-out, and it is held whenever an update card could not go out (follow-ups off, low volume, The Close sent, the surface's window closed). A note naming a health reading is refused (`health/trigger.ts`). Off keeps such a day silent (`nothing_coming`), and `0` is the rollback. |
| `HEALTH_TRAINING_LOAD` | `0` | `0` | `0` until migration `20261031130000` is applied and the gate turns it on. Off unless `1`. With it on, the health producer adds the candidate training load (`training-load.candidate.v1`, ADR-0081 amendment of 31 Oct 2026, §2) to today's and yesterday's derived rows: a closed, digit-free phrase comparing the last seven days of workouts with the twenty-one before them, and its method. The model's health context gets it in words, labelled a candidate. The app's scores response never carries it. Before the migration, the writer refuses the key and the whole row with it, so turn it on only after. `0` is the rollback. |
| `AGENT_MAIL_INBOUND`, `AGENT_MAIL_DOMAIN` | `0`, `mail.heywaldo.in` | `0`, `""` | `0` and `""` until the Email Routing rules for handles exist (build PR 1b) and the privacy paragraph on third-party mail is live on heywaldo.in/privacy. Off unless `AGENT_MAIL_INBOUND` is `1` and `AGENT_MAIL_DOMAIN` is set. With both, the Worker's `email` handler routes mail by envelope recipient `<handle>@AGENT_MAIL_DOMAIN` through `waldo.route_agent_mail`; mail from the owner's confirmed sign-in address, or in a thread Waldo knows, runs one tainted owner job turn whose answer goes to the owner's proactive surface. Everything else is dropped and counted, with no reply or bounce. Logs carry fixed codes only (`agent_mail_inbound`, `agent_mail_turn`). `0` is the rollback; nothing is sent by mail. |
| `WALDO_OWNER_TIMEZONE`, `WALDO_STT_PROVIDER`, `WALDO_TOOL_OFFLOAD` | not set | not set | not set. The defaults apply: UTC, the first provider with a key, offload on. |
| `WALDO_STREAM_REPLIES` | `on` (owner ruling, 25 Oct: app and console) | not set | not set. Owner replies arrive whole, and no request or receipt changes. `on` shows a reply while it is written: on the app and console, a `draft` on the running message's receipt, served only to clients that send `x-waldo-app-contract: chat=2`; on the Telegram test channel, a `sendMessageDraft` preview. Only a message the model labels its final answer streams; WhatsApp and iMessage always get whole messages (`channels/owner-do.ts`, `conversation/reply-stream.ts`). A streamed call that shows no output within 15 s (`FIRST_TOKEN_TIMEOUT_MS`) moves to the second provider when `ANTHROPIC_API_KEY` is deployed and that provider's circuit is closed; otherwise the call keeps the 120 s limit. A late first token does not count against the provider's circuit. The reply hop records `ttft_ms`. |

#### 1.2.1 Before `PHONE_SMS_VERIFY=1` (hard preconditions)

A texted code costs money for every send, and an open SMS endpoint is a target for SMS pumping. Every item below is done and checked before anyone sets the switch to `1`, on any environment.

1. **Twilio account, Verify service and DPA.** A Verify service with six-digit codes valid ten minutes or less, and Twilio's DPA reviewed. The privacy notice naming Twilio is published.
2. **Verify geo permissions.** In the Twilio console's Verify geo permissions, every country is off except those in `PHONE_SMS_COUNTRIES` (India for the alpha). Twilio: "Review your Verify Geographic Permissions and disable all countries that you do not plan to send messages to" [cited: [Twilio, preventing toll fraud](https://www.twilio.com/docs/verify/preventing-toll-fraud)].
3. **Fraud Guard on.** Verify SMS Fraud Guard is on for the service, at Standard or Max (Verify > Services > the service > SMS tab). A blocked send shows as error 60410 in Twilio's logs [cited: [Twilio, SMS Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard)]. Twilio's [60410 page](https://www.twilio.com/docs/api/errors/60410) gives no HTTP status: if the answer is a 4xx, Waldo logs `provider_refused` with `twilio_code: 60410`; otherwise the send is recorded as `unknown` [unverified]. Twilio's page does not say whether it is on by default, so check it.
4. **Spend ceiling and alert.** Twilio's usage triggers only call a webhook; they stop nothing [cited: [Twilio, usage triggers](https://www.twilio.com/docs/usage/api/usage-trigger)]. The hard ceiling is the ledger's server-wide cap, `PHONE_SMS_DAILY_LIMIT` (at most 200 a day). Also set a daily usage trigger that alerts the owner, and add the service's own rate limits as Twilio recommends [cited: [Twilio, preventing toll fraud](https://www.twilio.com/docs/verify/preventing-toll-fraud)]. Keeping a small prepaid balance with auto-recharge off would bound spend further [inference: check that the account's billing works that way].
5. **Credentials.** Prefer an API key restricted to Verify (`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`) over the account auth token. Twilio's restricted keys list Verify among the supported products; choose the Verify permissions from Twilio's permission list [cited: [Twilio, restricted API keys](https://www.twilio.com/docs/iam/api-keys/restricted-api-keys)].
6. **India DLT (checked 26 Oct 2026).** Twilio reaches India by two routes. On the international route, "No DLT registration is required"; messages come from random ILDO short codes (5NNNN…) and skip India's DND list. On the domestic route, the company and sender ID must be registered on the operators' DLT portal first [cited: [Twilio, India SMS guidelines](https://www.twilio.com/en-us/guidelines/in/sms)]. Verify's template guide names special SMS rules only for Singapore, Canada and China (registered templates); India is not among them, and the Verify Default template ("Your {Service Friendly Name} verification code is: {code}") needs no setup [cited: [Twilio, verification templates](https://www.twilio.com/docs/verify/verification-templates)]. So Waldo needs no DLT registration or template as long as it uses the default template and no branded Indian sender ID [inference: neither page says outright which route Verify uses for +91; the first staging send to a real +91 number, made by the owner, settles it]. A custom template or an alphanumeric sender ID for India would need DLT registration first. A Twilio trial account texts only numbers verified in that account, so a real cohort needs an upgraded account [cited: [Twilio, Verifications](https://www.twilio.com/docs/verify/api/verification)].

### 1.3 Worker secrets (names only)

There is no authoritative list of staging secrets in the repo. Before copying the shape, the owner runs `npx wrangler secret list --name waldo-runtime-staging`, which prints names only. Production values are always created fresh and never copied from staging (`docs/planning/waldo-agent-mvp/PRODUCTION_DEPLOYMENT_2026-09-24.md:47`).

| Secret | Read at | Missing in production means | Alpha |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | `owner-do.ts:2518` | every owner turn fails | **required**: a separate production project with a spend limit |
| `ANTHROPIC_API_KEY` | `owner-do.ts:3210` | the fallback model fails with `auth_failed` | **required**: a separate workspace with a spend limit |
| `SUPABASE_PROJECT_URL`, `SUPABASE_PUBLISHABLE_KEY` | `identity/owner-directory.ts:64`, `identity/console-auth.ts:77` | no directory, no sign-in | **required** |
| `WALDO_ROUTER_HMAC_SECRET` | `identity/owner-directory.ts:64` | every signed database call fails; the console ticket returns 403 | **required**. One fresh value, held identically in three places: this Worker secret, the Vault secret `waldo_router_hmac`, and the `connector-proxy` and `oauth-proxy` function secrets. |
| `WALDO_OAUTH_STATE_SECRET` | `connectors/oauth-state-secret.ts:8`, read by `channels/google-oauth.ts:80` and `channels/mcp-oauth-routes.ts:37` | **the Google and MCP OAuth callbacks return 404**; it signs their OAuth state, with no fallback to any other secret | **required**: one fresh value |
| `TELEGRAM_WEBHOOK_SECRET` | `channels/telegram-webhook.ts:103` | the Telegram webhook answers 404 | **not set**, with `TELEGRAM_BOT_TOKEN`. It no longer signs OAuth state. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `channels/google-oauth.ts:77` | no Google connect | **required**: the production client (S7) |
| `BRAVE_SEARCH_API_KEY` | `owner-do.ts:3243` | `web_search` says it is not set up | recommended |
| `ELEVENLABS_API_KEY` or `SMALLEST_AI_API_KEY` | `llm/transcriber.ts:17-18` | voice notes go untranscribed | optional |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | `observability/otlp-turns.ts:36-43` | no trace export | decision D7 |
| `TELEGRAM_BOT_TOKEN` | `channels/telegram-webhook.ts:116` | Telegram off | **not set**. Telegram is retiring, and ADR-0055/ADR-0073 item 7 treat it as a privacy residual. If it is ever set, use a new bot: the owner DO re-registers the webhook whenever its origin changes (`owner-do.ts:1219-1228`), so two Workers sharing one bot steal it back and forth. |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | `channels/whatsapp-webhook.ts:173-212` | WhatsApp off | not set until Meta verification and P5 (D5) |
| `IMESSAGE_CREDENTIAL_WRAPPING_KEY` | `channels/imessage/bridge-do.ts:35` | iMessage off | not set (D5) |
| `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI` | `health/providers/whoop-routes.ts:21` | WHOOP off | not set. WHOOP comes later (owner ruling, 22 Oct). |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSER_USE_API_KEY` | `owner-do.ts:2957`; `browser-use-errand-engine.ts:60` | browser submit says it is not set up | not set (browser is Cloudflare-only, on staging) |
| `WALDO_PROBE_TOKEN` | `channels/probe-turn.ts:84` | none; the route is 404 outside staging | not set |
| `WALDO_PROBE_TELEGRAM_ID` | `channels/probe-turn.ts` | none; without it the staging probe refuses (503) | not set |
| `WALDO_PROBE_SYNTHETIC_DO_NAMES` | `channels/probe-turn.ts` | none; a probe target outside the list is refused (403) | not set |
| `WALDO_EVENT_SOURCES` | `channels/event-ingress.ts:178` | event ingress returns 404 | not set |
| `TWILIO_VERIFY_SERVICE_SID`, and either `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` (preferred) or `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | `identity/phone-sms.ts` | no texted code; the phone views offer the link code only | not set until `PHONE_SMS_VERIFY` goes on (§1.2.1). The API key, standard or restricted to Verify, is used whenever its SID is set; a malformed key (`SK…`), account (`AC…`) or service (`VA…`) id, or an empty secret or token, keeps texting off rather than falling back. |

#1393 (merged 22 Oct as `e228a483`) moved Google and MCP OAuth state onto `WALDO_OAUTH_STATE_SECRET`. Freeze the secret list on the stand-up SHA (S0).

### 1.4 Supabase

| Item | Staging | Production today | Production needs |
| --- | --- | --- | --- |
| Project | `togdshayyxycitzckpqv` ("Waldo-MVP") | none in the repo | A new project (S1). Region is fixed at creation (D2). |
| `supabase/config.toml` `project_id` | `oqcjjcytjvrckvylagsl` is the HEY-125 spike project; it only names local containers | n/a | nothing. `db push` does not push config. Every auth and function setting is a dashboard or Management API step. |
| Exposed schemas | `public`, `graphql_public`, `waldo` (set by hand) | n/a | expose `waldo` in the API settings (no migration does it) |
| Vault `waldo_router_hmac` | exists | n/a | create by hand with a fresh value. No migration creates it; every signed RPC fails closed with 42501 without it (`20261003000000_waldo_router_signed_fail_closed.sql:8`). |
| Auth: Email OTP, Site URL, redirect URLs | set by hand. On 24 Sep the Site URL was `localhost:3000` and the hosted template lacked `{{ .Token }}` (`CONNECT_FLOW_DESIGN_2026-09-24.md:197-204`) | n/a | Email OTP on; Site URL and redirect URLs = the production origin; the Magic Link template from `supabase/templates/magic_link.html` (it carries `{{ .Token }}`, guarded by `guard-otp-template`) |
| Auth email delivery | **[unverified]** whether staging has custom SMTP | n/a | **custom SMTP with a sender domain**. The built-in provider sends only to team members, 2 an hour, "not meant for production use"; custom SMTP starts at 30 an hour, adjustable [cited: [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)]. |
| Extensions | `pgcrypto` (in `extensions`), `supabase_vault`, assumed present | n/a | check both on the new project before the apply. No migration creates an extension. |
| Migrations | 68 committed; staging history was a prefix up to the last recorded apply | none | all 68 from zero, through the reviewed route (S2, after P1) |
| PITR and backups | **[unverified]** plan and PITR state | n/a | PITR on (ADR-0058, proposed: RPO ≤ 5 min, RTO ≤ 1 h; it needs a compute add-on), and one restore drill before the first invite (S10) |
| Legacy `public.*` tables (0001–0005) | present | n/a | created by the from-zero apply; `delete_owner` covers them by cascade |

### 1.5 Edge functions

| Function | Purpose | Secrets it reads | Production |
| --- | --- | --- | --- |
| `connector-proxy` | The only holder of Google tokens | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (injected by the platform, **[unverified]**), `WALDO_ROUTER_HMAC_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Deploy with `--no-verify-jwt`. `config.toml` has no entry for it, so the default JWT check would reject every call; this already happened once (`KEY_VERIFICATION_RUNBOOK_2026-09-24.md:44`). |
| `oauth-proxy` | Tokens for MCP servers and health providers | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WALDO_ROUTER_HMAC_SECRET` | Deploy. `verify_jwt = false` is in `config.toml`. |
| `mint-agent-jwt` | The ADR-0066 proof issuer | hard-coded to the spike project's issuer and kid; throws on any other `SUPABASE_URL` (`supabase/functions/mint-agent-jwt/index.ts:9-22`) | **Do not deploy** |

### 1.6 Third parties and channels

| Item | Staging | Production needs | Status |
| --- | --- | --- | --- |
| Google Cloud project | `waldo-dev-492217`: Testing, External, 7 of 100 lifetime users, no organisation, branding links empty, one Web client with only the staging redirect | A separate production project. Google recommends separating test and production. It needs branding (home, privacy and terms pages on the owned domain) and a Web client whose only redirect is `https://<domain>/oauth/google/callback` (S7). | source doc, read-only GCP facts recorded 21 Oct |
| Gmail push | Pub/Sub in `waldo-dev-492217`, named by `GMAIL_PUSH_PROJECT` (§1.2) | `GMAIL_PUSH_PROJECT` set to the production project once its topic and push subscription exist (S7) | code done (P6); production off until set |
| Langfuse | one project; text captured for every tester (#1398 gates it on agreement) | decision D7: none, or a separate production project with capture off, identifiers hashed (P5) and a retention period (Pro plan only) [cited: [Langfuse retention](https://langfuse.com/docs/data-retention)] | gap |
| WhatsApp | Meta app callback is the staging webhook; system user `waldo-staging`; business verification in review (ECOFRESH GREENSYNC LLP, 22 Oct) | its own number, system user and callback, or a callback move; billing; a utility template (`docs/channels/whatsapp/NUMBER_SETUP_AND_SMOKE_TEST.md`) | blocked on Meta |
| iMessage | connector on; host profile is fixtures-only | a real Apple Account, a dedicated host Mac, the number on iMessage | not started |
| Telegram | team test bot | none (see 1.3) | by design |
| App push | not built: no APNs, Expo or FCM sender; `app_push_register` has no runtime caller | nothing for the alpha, or build it | gap (outside this runbook) |
| App build | `EXPO_PUBLIC_WALDO_APP_API_ORIGIN` = the staging origin | a production build pinned to the production origin (waldo-app repo) | cross-repo |
| CI | `deploy-staging.yml` dispatch only, `--env staging` and the staging ref hard-coded; Actions dispatch returned 422 for the account | no production workflow exists; production stays a Mac-lane run | by design |

## 2. Stand-up runbook

Each step lists the owner action, the blast radius and the rollback. A step starts only after the one before it has passed its check. The P-numbers are the code gaps in §4, and each must be merged before the step that names it.

### S0. Decide and freeze (no hosted change)

- **Owner action.** Answer D1 to D10 (§5). Name the stand-up SHA: the `beta-mvp` commit that carries P1, P2 and P3. Hold #1388 and #1398 (new migrations) and #1334 and #1355 (DO migration tags) until they land on that SHA or after the stand-up.
- **Check.** `node scripts/production-alpha-dryrun.mjs` at that SHA reports no `GAP` lines. `DECIDE` lines remain only for decisions the owner has answered in writing.
- **Blast radius.** None.
- **Rollback.** n/a.

### S1. Create the production Supabase project

- **Owner action.**
  - Create the project in the chosen organisation and region (D2), with PITR enabled.
  - In the dashboard:
    - expose `waldo`;
    - turn Email OTP on;
    - set the Site URL and redirect URLs to the D3 production origin (the domain goes live at S6);
    - set the Magic Link template from `supabase/templates/magic_link.html`;
    - configure custom SMTP and raise its hourly limit to cover a batch of invites;
    - check that `pgcrypto` and `supabase_vault` are present.
  - Create the Vault secret `waldo_router_hmac` with a fresh 32-byte hex value (for example `openssl rand -hex 32`) in the dashboard's Vault page ("Click a button, type in your secret, and save" [cited: [Supabase Vault](https://supabase.com/docs/guides/database/vault)]). Do not use `vault.create_secret` in the SQL editor: the editor keeps query history. The value never passes through chat or a file in the repo.
  - **Never run `scripts/owner_wire_supabase.sh` for production.** It runs an unpinned CLI with the database password in argv, pushes with no dry run, and writes secrets to `--name waldo-runtime-staging`, which is hard-coded (`scripts/owner_wire_supabase.sh:22-39`).
- **Check.** Project ref recorded in the stand-up note; the dashboard shows PITR on; a test OTP email reaches a non-team address.
- **Blast radius.** A new, empty project. No staging effect.
- **Rollback.** Delete the project. Nothing depends on it yet.

### S2. Apply migrations from zero (needs P1)

- **Owner action.** From a clean, detached checkout of the stand-up SHA, run the production preflight with the production ref, then review the pending list: 68 files at `c5e44093`. The digest `node scripts/production-alpha-dryrun.mjs` prints is the from-zero `pendingManifestSha256` at that SHA only; it is a preview, not an approval value. Apply with the reviewed digest, then preflight again and require 0 pending.
- **Check.** History equals the committed manifest. A read-only count shows zero rows in `waldo.owners`.
- **Unverified.**
  - What `GET /v1/projects/{ref}/database/migrations` returns on a project that has never had a migration: `[]`, 404 or an error. P1 must handle each.
  - Whether `delete_owner` may delete from `auth.users` on a hosted project as security definer. No recorded run on a hosted project proves it.
- **Blast radius.** The production database only. Migrations are forward-only.
- **Rollback.** Before any owner exists: delete and recreate the project (S1). After: a new reviewed forward migration (`docs/ops/REVIEWED_STAGING_MIGRATION_ROUTE.md`).

### S3. Edge functions

- **Owner action.**
  - Set the function secret `WALDO_ROUTER_HMAC_SECRET` (the S1 value) with `supabase secrets set --project-ref <prod-ref>`, the value typed at the prompt or read from a file outside the repo. The Google function secrets follow at S7, once the client exists.
  - Deploy `connector-proxy` with `--no-verify-jwt`, then `oauth-proxy`. Do not deploy `mint-agent-jwt`.
  - Enter every pre-issued confidential client (WHOOP once it is enabled; Slack's MCP app) with `waldo.oauth_client_seed`, never `oauth_client_put`, so its secret is bound to its token endpoint (`docs/ops/PRE_REGISTERED_OAUTH_CLIENTS.md`).
- **Check.**
  - An unsigned `POST /functions/v1/connector-proxy` returns 401 (the same probe as the staging gate).
  - `select issuer, redirect_uri from waldo.oauth_clients where client_auth <> 'none' and token_endpoint is null;` returns no rows. A row there is a confidential client whose secret is not bound to an endpoint: seed it again.
- **Blast radius.** The production project's functions.
- **Rollback.** Supabase keeps no restorable earlier function version: redeploy from the previous reviewed SHA.

### S4. Cloudflare account, resources and Worker secrets

- **Owner action.**
  - In the D1 account: Workers Paid (needed for `cpu_ms` 300000), the production R2 bucket named in P2, and a rate-limit namespace id unused on the account.
  - Set each **required** secret in §1.3 except the Google pair, which follows at S7, with `npx wrangler secret put <NAME> --name <production worker>`, value typed at the prompt.
  - Set OpenAI and Anthropic project spend limits before the key exists in the Worker (S9).
- **Check.** `npx wrangler secret list --name <production worker>` shows exactly the required names and nothing from the "not set" rows.
- **Blast radius.** The production Worker's secrets only. Never use a command without an explicit Worker name: an unflagged command targets the top-level Worker.
- **Rollback.** `wrangler secret delete <NAME>`; rotate at the provider if a value may have leaked (`PRODUCTION_DEPLOYMENT_2026-09-24.md`, rotation procedure).

### S5. First Worker deploy and smoke

- **Owner action.**
  - From a clean, detached checkout of the stand-up SHA, deploy with the explicit production target (P2).
  - Read the `OWNER_DO` namespace id: `npx wrangler durable-objects namespace list` [unverified command shape on the pinned wrangler; check with `--help` first].
  - Merge a one-line config PR that sets `WALDO_OWNER_DO_NAMESPACE`, and redeploy.
- **Smoke.** These are unauthenticated, content-free probes against the production origin. A production gate script (P7) replaces this list.

  | Probe | Expect |
  | --- | --- |
  | `GET /healthz` | 200, `release` = the stand-up SHA |
  | `GET /app/v1/session` | 401 |
  | `GET /console` | 303 when signed out |
  | `POST /probe/turn` with a body | 404 (staging-only route) |
  | `POST /telegram/webhook` without the secret header | 404 while `TELEGRAM_WEBHOOK_SECRET` is unset (`channels/telegram-webhook.ts:104`). OAuth state no longer needs it (§1.3). |
  | `POST /events/gmail` without a bearer | 403 or 404 |
  | unsigned `POST /functions/v1/connector-proxy` | 401 |

- **Blast radius.** A new Worker with no owners. DO data created from here on lives in this account.
- **Rollback.** `wrangler rollback <previous-version-id>` restores code and bindings only, not DO state, secrets or migrations. Before any owner exists: delete the Worker.

### S6. Domain

- **Owner action.** Attach one custom domain to the production Worker in the D1 account (decision D3). Set `workers_dev: false` in the P2 config so only that host is live. Rebuild the app with `EXPO_PUBLIC_WALDO_APP_API_ORIGIN` set to that origin (waldo-app). Update the Supabase Site URL and redirect URLs if S1 used a placeholder.
- **Check.** The S5 smoke passes on the domain; `workers.dev` no longer answers.
- **Blast radius.** Every link Waldo builds, and the Google redirect URI. Adding a redirect URI after Google verification restarts verification (Google research doc §1).
- **Rollback.** Detach the domain. Owner DOs that stored the old origin rebuild links on their next request.

### S7. Google OAuth production client

- **Owner action.**
  - Create the production GCP project, in an organisation if one exists (D4).
  - Enable the Calendar, Gmail, Tasks, People and Drive APIs.
  - Fill in branding: home, privacy and terms links on the domain, plus authorised domains.
  - Create one Web client whose only redirect is `https://<domain>/oauth/google/callback`.
  - Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` twice: as Worker secrets (`wrangler secret put … --name <production worker>`) and as `connector-proxy` function secrets (`supabase secrets set --project-ref <prod-ref>`). Values are typed at the prompt.
  - Choose Testing (each invitee added as a test user, at most 100 for the project's lifetime, refresh tokens expiring every 7 days) or publishing unverified (the unverified-app screen, a 100-new-user cap, no 7-day expiry [inference in the research doc]). The research doc recommends Testing for the alpha and restricted verification with CASA for production (`docs/research/GOOGLE_INTEGRATION_2026-10-21.md:96-110`). Under Testing, each weekly lapse reaches the owner as one reconnect notice per failure episode: a reconnect button on Telegram and WhatsApp (WhatsApp only inside its 24-hour window), and plain text pointing at Connections on the app and iMessage. The owner still has to reconnect every week.
  - Gmail push: create the `waldo-gmail-push` topic and a push subscription whose service account is `waldo-gmail-push@<project>.iam.gserviceaccount.com` and whose endpoint and audience are `https://<domain>/events/gmail` (the names `connectors/google-push.ts` and `channels/event-ingress.ts` check), then set `GMAIL_PUSH_PROJECT` on the production Worker. Until then production gets no Gmail push. Mail reads still work.
- **Check.** A test owner connects Google on production and a Calendar read returns.
- **Blast radius.** Google access for production owners only.
- **Rollback.** Delete the client; owners re-link.

### S8. Langfuse production (capture off)

- **Owner action, per D7.**
  - **Option A (no Langfuse in production for the first batch).** Set no Langfuse keys. Worker logs stay content-free.
  - **Option B.** A separate Langfuse project, keys set as Worker secrets, and a retention period (Pro plan). Before any WhatsApp owner, land P5, because trace `sessionId` is `${channel}-dm:${owner}` and for WhatsApp the owner value is the phone number in digits (`owner-do.ts:2511-2525`). Text capture stays off by code.
- **Check.** Option B: one test-owner turn shows a trace with `environment=production`, no input or output text, and no phone number.
- **Blast radius.** Trace metadata leaves to Langfuse (a processor, in the DPA inventory).
- **Rollback.** Delete the three secrets; delete the project's traces (`DELETE /api/public/traces` exists [cited: Langfuse OpenAPI `trace_deleteMultiple`]).

### S9. Cost ledger on, provider spend limits

- **Owner action.**
  - Set `WALDO_COST_LEDGER_SYNC=on` for production, as a committed var or `--var` at deploy.
  - Set hard monthly limits on the production OpenAI project and the Anthropic workspace, sized for 50 owners. These provider limits are the only real stop. USD 25 per owner per month is where degradation starts, not a cap: past it an owner keeps spending on the auxiliary route, and background work is never gated (§3.1). So 50 × USD 25 = USD 1,250 a month is the point where degradation begins for everyone, not a ceiling on the bill [inference from `docs/ops/OBSERVABILITY.md:85-89` and §3.1].
- **Check.** After one test-owner turn, `waldo.cost_ledger_daily` has a row for that owner (service-role read in the SQL editor).
- **Blast radius.** A turn past the ceiling degrades to the auxiliary route and refuses browse and execute tools. The provider limit stops every owner at once.
- **Rollback.** Unset the var. Raise the provider limit.

### S10. Alerting, backups and the incident path

- **Owner action.**
  - Configure Cloudflare notifications for the production Worker's error rate, an external uptime check on `/healthz`, provider budget alerts at 50% and 80%, and Supabase usage alerts.
  - Name who is paged (D9; ADR-0073 item 11 says both founders).
  - Run one Supabase PITR restore drill into a scratch project and one DO point-in-time restore on the test owner (ADR-0058 names `getBookmarkForTime` and `onNextSessionRestoreBookmark`).
  - Adopt the incident steps in §3.3.
- **Check.** A deliberate failed `/healthz` (a paused uptime target) pages the named people.
- **Blast radius.** None.
- **Rollback.** n/a.

### S11. Test owner, then invites in batches

- **Owner action.**
  - Seed the first admin by hand in the SQL editor: one `waldo.owners` row with the owner's email, `bootstrap_claimable = true` and `is_admin = true`. No migration seeds an owner. The owner then signs in by emailed code and issues admin invites from the console, copying each link to its recipient; Waldo emails nothing.
  - Invite one test owner (not an admin) from the console. Run the production console E2E on that account: chat; calendar and Gmail reads; a reminder; an honest health reply with and without data; the forget flow; the spend ledger row; account deletion. Account deletion follows ADR-0055 and checks every store in §3.2 by a read afterwards.
  - Then invite 5, then 20, then the rest, with a day of logs and ledger read between batches.
- **Check.** Every §3 item marked as a gate is closed.
- **Blast radius.** Real owners' data from the first invite onward.
- **Rollback.** Pause invites. Per-owner deletion per §3.2.

## 3. Alpha readiness checklist

Status: **source** (verified in source at `c5e44093`), **staging (recorded)**, **unverified**, or **gate** (an accepted ADR or owner ruling requires it before any external user, and it is not met).

### 3.1 The checklist

| Item | Status | Evidence | Closes it |
| --- | --- | --- | --- |
| **Invite flow capacity for 50** | source; **gate** on email | See the notes after this table. | Custom SMTP and its limit (S1); the first admin row (S11); D-ruling or P13 on member invites |
| **Account deletion end to end** | source; **gate** | The path and store table are in §3.2. No full-cascade run on a real account is recorded on staging [unverified]. ADR-0055 requires the walk on a test user before any external user. | P4 (at least P4a), then the S11 walk with a read-back of every store |
| **Per-owner cost ceiling** | source | See the notes after this table. | S9, D10, P12 |
| **Rate limits** | source | See the notes after this table. | P2. D5 keeps the unlimited channels off. |
| **Abuse limits** | source | See the notes after this table. | Acceptable for the alpha with D6 [inference]. Reminder limits are a follow-up. |
| **Backups and point-in-time recovery** | unverified; **gate** | Staging's plan and PITR state were not read. ADR-0058 (proposed) sets RPO ≤ 5 min and RTO ≤ 1 h. ADR-0055's post-restore re-deletion and tombstone ledger are not built [source: no tombstone code]. | PITR on at S1; the drills at S10; the tombstone ledger is part of the ADR-0055 gate |
| **Alerts and who gets paged** | source: **none in the repo** | No Sentry, PagerDuty, uptime monitor, alert webhook or Cloudflare notification config in code, scripts or workflows. `/healthz` is probed only by the manual staging gate. | S10, D9 |
| **Incident runbook** | none before this document | `RCA_OWNER_DO_CPU_RESET_2026-10-09.md` was found by a human E2E, not an alert | §3.3 |
| **Support and feedback into eval cases** | source: no path | §3.4 | §3.4 now; P9 later |
| **Privacy-notice dependencies** | **gate** | §3.5 | Legal items, linked, not drafted here |
| **Data export** | source: **none**; **gate** (ADR-0073 §1 item 3) | No data-subject export in the app, console or tools. Artifact exports (`artifacts/exports/by-owner/`) are file downloads, not an account export. | P10 |
| **Crisis guidance per geography** | source: India only; **gate** (ADR-0073 §1 item 10) | `prompt/messaging-behavior.ts:104` | Clinical-reviewed pack, then P11 |
| **18+ gate** | source: partial; **gate** (ADR-0073 §1 item 13) | Health consent v2 requires `age_attested_18_plus` (`20261021150000_health_wearables_zone_change.sql:182`). No age step at sign-up was found [unverified beyond grep]. | An age attestation at sign-up (#1356 owns onboarding [inference]) |

**Invite flow.**
- **Who can sign in** [source]. A code is sent only to:
  - an active owner's email;
  - a bootstrap-claimable owner row;
  - an address that holds a live invite (`20260928190000_waldo_invite_chain.sql:13-23`).
- **Admin invites** are uncapped (`20261014060000_waldo_admin_invite_uncapped.sql`). Each code works once, only for its email, and lasts 14 days. Waldo never emails invites; the issuer copies the link (`channels/console.ts:137-138`).
- **Member invites** are capped at 5 each (`20260928190000:80-82`), so 50 members can admit 250 more people with no admin step. No overall owner cap exists [source].
- **The admin flag** (`is_admin`) is set by hand in the database (`20260924150000_waldo_admin.sql:2`).
- **Throttles on sign-in** [source; `console-signin.ts:23-26,218-283`, `20261017100000`]:
  - 5 code sends per email per 15 minutes;
  - 10 verifies per email per 15 minutes;
  - 30 attempts per IP per 15 minutes.

  A group onboarding behind one office network will meet the IP limit [inference].
- **App sessions last 12 hours** (`app-api.ts:87`), so 50 daily app users means 50 or more code emails a day [inference]. The built-in mailer cannot send them (§1.4). Console sessions stay signed in for up to 30 days while used (`identity/console-auth.ts`).

**Cost ceiling.**
- **The ceiling** is USD 25 per owner per month (`llm/cost-ledger.ts:4`), and it is off unless `WALDO_COST_LEDGER_SYNC=on` (`observability/cost-rollup.ts:32`). Past it, a turn degrades to the auxiliary model, and browse and execute tools are refused (`llm/provider.ts:443-448`, `owner-turn.ts:212-215`).
- **Not gated: background work.** Heartbeat, the nightly memory pass, briefs, reminders and standing orders never consult the ceiling. (A DO-local `spendPosture` helper that would have skipped background work was never called outside a test and has been deleted with the rest of the unused DO-local `cost_ledger` code.)
- **Not attributed.** No producer sets `cost_kind`, so every row files as `turn` (`cost-rollup.ts:39,46`).
- **Not priced.** Browser, sandbox, search, speech-to-text and cache writes count as 0.
- **No overall limit.** Nothing caps all owners together, and no per-owner daily cap exists.

**Rate limits.**
- **The binding.** `RESPONSIBILITY_RATE_LIMITER` allows 120 per 60 s per key per Cloudflare location. It keys sign-in, app auth, app and console chat (per owner), approvals, health, the Telegram link and the iMessage host (`app-api.ts:68-146`, `console-chat.ts:89-92`).
- **The durable sign-in throttles** above add to it.
- **No per-owner limit on chat channels.** Telegram, WhatsApp and iMessage turns are bounded only by inbox capacity: 512 rows for Telegram, 256 in flight for the app (`telegram-owner-inbox.ts:6`, `app-inbox.ts:61`). A full inbox answers 503 and the owner is told nothing.
- **Webhook checks.** Telegram uses a constant-time secret and de-duplicates for 25 hours. WhatsApp checks an HMAC signature and de-duplicates by message id, with no freshness window. Router RPCs must be signed within 300 s.

**Abuse limits** [source]:
- **Inputs.** Messages are capped at 4000 characters (`contracts/src/app/core.ts:54`) and media at 20 MiB.
- **Turns.** At most 150 tool rounds a turn (`llm/time-budget.ts:34-35,68`), a 14–15 minute turn deadline, and 5 subagents a turn.
- **Tools.**
  - Egress fails closed in production.
  - `send_message` only proposes; the owner approves before anything is sent (`owner-turn.ts:60-65`).
  - `execute_code` has no handler.
- **Not bounded.** Reminders and standing orders have no count limit [source], and each firing can cost a model call [inference]. `docs/planning/TOOL_LOOP_BUDGET.md` still says 25 rounds, which is stale.

### 3.2 Account deletion, store by store

The path [source]:
1. `POST /app/v1/actions` or the dashboard JSON action runs `ownerControlsAction` (`channels/dashboard-owner-controls.ts:51-115`).
2. It requires `confirmation: DELETE`, a `request_id` and a fresh read.
3. It writes an "unconfirmed" receipt.
4. It purges the owner's R2 prefixes. If that fails, it stops with nothing deleted.
5. It calls `delete_owner` over the signed rail. The SQL is one function, so it commits or rolls back whole (`20261011230000_delete_owner_identity.sql`).
6. Last, `ctx.storage.deleteAll()` empties the Durable Object.

| Store | Deleted | Evidence | Test |
| --- | --- | --- | --- |
| Owner DO SQLite, KV and alarm | yes, on the normal path | `owner-do.ts:1095,1777`; `dashboard-owner-controls.ts:108-110` | `test/app-account-delete.test.ts` |
| R2 artifacts, exports, workspace prefix | yes, up to 10 pages of 1000 objects per prefix per attempt | `channels/owner-files-purge.ts:7-44` | artifacts and exports tested; workspace prefix untested |
| `waldo.owners`, connections, sessions, health logs, auth users, sessions and refresh tokens | yes | `20261011230000_delete_owner_identity.sql:17-41` | `supabase/tests/waldo_delete_owner*.sql` |
| Vault secrets for connections (Google, MCP, WHOOP) and push devices | yes | same, `:20-26` | no MCP-specific case |
| Health samples, scopes, consents, basis; devices; cost ledger; iMessage rows; presences | yes, by cascade from `waldo.owners` | migration FKs | health samples, scopes, consents and devices tested; anchors, requests, cost ledger, iMessage and push operations untested |
| Redeemed invite | partial: the email is nulled, the row stays | `:31` | tested |
| `workspace_owner_mappings`, the Auth audit log | no, on purpose | `:8-9` | n/a |
| `whatsapp_onboarding_replies` (hashed number), `console_auth_attempts` (expire on a window) | no | `20261017090000:5-6`; `console-signin.ts:232` | none |
| `DeviceBridgeDO`, `IMessageBridgeDO` state | **no**. Never contacted; iMessage keeps held bodies up to 30 days [unverified whether pruned] | `devices/device-bridge-do.ts:163-206`; `imessage/bridge-store.ts:41-43` | none |
| Google, WHOOP and MCP grants at the provider; Gmail and Calendar watches | **no** on account deletion. A disconnect revokes at the provider first: Google through `googleProxy.revoke`, which asks the `connector-proxy` `revoke` operation only for a mailbox no other owner holds; WHOOP and MCP through `oauth-proxy`'s. Account deletion calls none of them (P4 item 2). | `connectors/connections.ts` (`revoke`), `connectors/mcp-connections.ts`, `health/providers/whoop-owner.ts` | disconnect only |
| Langfuse traces | **no** | export only | none |
| DO point-in-time recovery (30 days), Supabase backups and PITR | **no**, and not disclosed | ADR-0058; ADR-0055 requires a tombstone ledger and re-deletion after restore, not built | none |

Three deletion failures matter beyond the table [source; the consequence is inference]:
- **The stranded Durable Object.** If `delete_owner` commits but its response is lost, the action returns `unknown` with the DO intact (`dashboard-owner-controls.ts:106`). The same happens if `deleteAll` throws (`:112-113`). Every later request needs a directory session that no longer exists, so the owner cannot retry, and no sweeper exists.
- **The legacy console form** (`owner-do.ts:1930-1936`) has no receipt and no confirmation field, and says "Everything Waldo held for you is gone", which is false by the table above.
- **The receipt names no residue.** That covers Langfuse, model providers, provider grants, backups and point-in-time recovery.

### 3.3 Incident runbook (minimum for the alpha)

These steps hold until ADR-0062 or an owner-approved runbook replaces them. Each step names its tool, and none of them sends anything on an owner's behalf.

1. **Detect.**
   - An uptime, Cloudflare or provider-budget alert pages the D9 people.
   - So does an owner report through the support path (§3.4).
2. **Triage, within 15 minutes.**
   - Run the S5 smoke.
   - Check `npx wrangler deployments list --name <production worker>`.
   - Tail the logs with `npx wrangler tail <production worker> --format json`. The logs are content-free: hops, codes and trace keys.
   - Read the cost ledger for today.
   - Read the OpenAI and Anthropic status pages.
3. **Contain.**
   - **Bad deploy.** Run `wrangler rollback` to the previous version. It restores code only, so check that no migration in between was destructive.
   - **Provider outage.** The breaker and the fallback model carry turns. Nothing else to do.
   - **Runaway spend.** Lower the provider limit; the ceiling is per owner.
   - **Data exposure.** Rotate the affected secret by the rotation procedure in `PRODUCTION_DEPLOYMENT_2026-09-24.md`, and start the breach clock: 72 hours, and the named owner of the notification call (ADR-0073 item 11). The breach plan itself is a legal item.
4. **Tell owners** only through the app or console, in words the owner approved for that incident.
5. **Close.** Write a blameless note in `docs/ops/`. Add the failing case as a regression eval in the same PR as the fix (BUILD_DIRECTION, "How we prove it").

### 3.4 Support and feedback into eval cases

What exists [source]:
- Useful and Not useful buttons on Telegram update cards only (`owner-do.ts:3814-3815`).
- Hand-written eval fixtures (`packages/runtime/evals/fixtures/`, `evals/nightly/*`).
- The rule that each failure becomes a regression case (`docs/planning/BUILD_DIRECTION_2026-10-21.md`), with no procedure behind it.

What does not exist: no in-product report, no support address in code, and no trace-to-fixture export. Production traces carry no text, so a report must carry the owner's own words.

The minimum for the alpha, with no code:
1. A support email address, named in the privacy notice (a legal item).
2. Each report is logged as a GitHub issue labelled `alpha-report`. The issue holds the trace key or time, the surface, and the owner's own description, given with their consent to use it for debugging. It holds no health values and no third-party content.
3. The fix PR adds an eval case from that issue, with synthetic values.

P9 replaces steps 1 and 2 with an in-product path.

### 3.5 Privacy-notice and legal dependencies (links only)

| Item | Where it is tracked | Blocks |
| --- | --- | --- |
| Privacy Policy and Terms (draft, unpublished, ECOFRESH GREENSYNC LLP) | owner's private Claude Doc (privacy-terms draft, 19 Oct); open rows: grievance officer, fees, DPAs, retention, effective date | Google branding (S7), Meta, first invite |
| Diagnostic recording agreement (staging only) | #1398 | publishing the privacy draft |
| ADR-0073 §1: DPIA, DPA inventory with zero retention (Anthropic and OpenAI), retention schedule, breach plan, crisis pack per geography, 18+ gate, data export, privacy copy | `Pin4sf/waldo-brain` ADR-0073; `docs/planning/waldo-agent-mvp/IMPLEMENTATION_CONTRACTS.md:99-101` | first invite (ADR text: "before any external user") |
| ADR-0055: the deletion cascade walked on a test user, per-store latency, tombstone ledger | `Pin4sf/waldo-brain` ADR-0055 | first invite |
| Beta geography: ADR-0073 §2 excludes EU/EEA/UK at beta; BUILD_DIRECTION says global-first | both documents | decision D8 |
| Google Limited Use statement, in-app disclosure before consent, CASA for restricted scopes | `docs/research/GOOGLE_INTEGRATION_2026-10-21.md:57,96-110` | publishing the Google app |
| Owner look-up disclosure (GDPR Art. 14, DPDP notice) | `BUILD_DIRECTION_2026-10-21.md`, "Owner look-up" | the look-up skill (#1356) |
| WhatsApp AI-provider terms and the India exclusion | `docs/channels/whatsapp/NUMBER_SETUP_AND_SMOKE_TEST.md:196-204` | WhatsApp in production |

## 4. Gaps that need code

Each item is one small PR against `beta-mvp`, proposed here and not implemented. Each names its files and the tests that prove it.

**P1. Production migration route.**
- **Change.** Allow exactly two refs: staging, and a production constant added in this PR once S1 records the ref. Production requires an extra `--confirm <ref>`. Preflight, apply and gate stop importing a staging-only constant.
- **Handle an empty history.** Accept `[]`, and treat 404 and other errors on a fresh project as `history_unavailable`, never as "nothing applied".
- **Files.** `scripts/staging-migration-preflight.mjs`, `scripts/staging-migration-apply.mjs`, `scripts/staging-gate.mjs`, their tests, and `docs/ops/REVIEWED_STAGING_MIGRATION_ROUTE.md`.
- **Tests.** An unknown ref is rejected. Production without the confirmation is rejected. A from-zero history gives all files pending with the digest `production-alpha-dryrun` prints. The existing staging tests stay green.

**P2. Separate the production Worker config.**
- **Choose one of two options:**
  - (a) the guard mirrors bindings by name rather than value, as vars already do;
  - (b) production moves to `env.production`, and the top level becomes a local-dev default.

  Option (b) also makes the unflagged deploy harmless. Either way: give production its own R2 bucket and rate-limit namespace id, set `workers_dev: false` and the D3 route, and make `deploy-runtime.sh` refuse to run without `--env`.
- **Files.** `packages/runtime/wrangler.jsonc`, `scripts/guards/guard-wrangler-local-bindings.mjs`, `scripts/guards/guards-selftest.mjs`, `scripts/deploy-runtime.sh`, `scripts/tests/runtime-bundle-startup.test.mjs` (it builds with `--env ''`), `scripts/guards/guard-runtime-preview-config.mjs`, and `scripts/production-alpha-dryrun.mjs` (point it at the new block).
- **Tests.**
  - The guard rejects a production bucket or namespace equal to staging's.
  - The bundle startup test builds the production target.
  - `deploy-runtime.sh` without `--env` exits non-zero before building.

**P3. Production runtime parity.** Add the retention cron and `limits.cpu_ms: 300000` to the production block.
- **Files.** `wrangler.jsonc`, the bindings guard (require both in production), and the `index.ts` comment at `:197`.
- **Tests.** The guard fails when either is missing, and the scheduled handler test runs against the production config.

**P4. Account deletion that finishes.**
1. **Erase the DO even when the directory call fails or is unknown.** Write an erase-pending marker first. On a lost or failed `delete_owner`, retry it from the DO's alarm with the same request id, and make the retry return a distinct "already gone" result instead of `false`.
2. **Revoke at providers before the Vault delete.** The signed revoke operations exist: `connector-proxy` `revoke` for Google (`oauth2.googleapis.com/revoke`) and `oauth-proxy` `revoke` for WHOOP and MCP (ADR-0075 custody). Account deletion must reach each one before `delete_owner` removes the Vault rows, and stop the Gmail and Calendar watches. Each call is best-effort, and the receipt names it.
   - For Google, the only entry point is the Worker's `googleProxy(env).revoke` in `connectors/connections.ts`. Never call the edge `revoke` op directly.
   - Google's revocation ends Waldo's whole authorization for that Google user, so it would also end another owner's grant on the same mailbox.
   - `googleProxy.revoke` asks Google only when signed `gmail_push_route` lists this connection as the mailbox's one live connection. The edge op has no such check.
   - Call it while the owner's state is still `active`. `gmail_push_route` lists only active owners' connections, so once the owner is not active it no longer lists this one, and `googleProxy.revoke` answers `unavailable` without asking Google.
3. **Clear the device and iMessage bridge objects.**
4. **Delete or fix the legacy console form and its copy.**
5. **Name every store outside reach in the receipt:** Langfuse until P5's purge, model providers, backups and PITR, and copies the owner shared.

- **Files.** `channels/dashboard-owner-controls.ts`, `channels/owner-do.ts` (delete branch only; a hot file, one writer), `identity/console-auth.ts`, `supabase/functions/connector-proxy/index.ts` and `supabase/functions/oauth-proxy/index.ts` (the revoke operations), `connectors/connections.ts` and `connectors/oauth-proxy-client.ts` (the signed calls), `devices/device-bridge-do.ts`, `channels/imessage/bridge-do.ts`, `channels/console.ts`, and a new migration only if `delete_owner` needs the "already gone" result.
- **Tests.**
  - Fault injection on each step: a lost SQL response, `deleteAll` throwing, a revoke 500.
  - Edge-function tests for each revoke operation, in the existing `test/connector-proxy-entry.test.ts` and `test/support/oauth-edge-harness.ts` pattern, including that an unsigned call is refused.
  - A read-back of every store in §3.2.
  - pgTAP cases for the untested cascades.

  Split this into P4a (items 1, 4 and 5) and P4b (items 2 and 3) if review prefers.

**P5. Trace identity without personal data.**
- **Change.**
  - Langfuse `userId` and `sessionId` carry a keyed hash of the owner principal, never a phone number or Telegram id.
  - `resolveCaptureText` allows capture only when `WALDO_ENVIRONMENT === 'staging'` (an allowlist; today it is `!== 'production'`).
  - A per-owner Langfuse purge on account deletion: list traces by the hashed user id, then `DELETE /api/public/traces`.
- **Files.** `channels/owner-do.ts:2520-2526`, `observability/trace-privacy.ts:83-87`, `observability/otlp-turns.ts`, `docs/ops/OBSERVABILITY.md`; this needs a `TRACE_SCHEMA_VERSION` bump.
- **Tests.**
  - No E.164 string reaches any exported attribute.
  - Capture stays off for `prod`, `production`, unset and `preview`.
  - The purge is called on deletion.

**P6. Gmail push per environment.** Done: `GMAIL_PUSH_PROJECT` names the project per environment (§1.2). Unset, the watch is skipped (`gmail_watch_skipped:unconfigured`) and `/events/gmail` answers 404.

**P7. Production gate.**
- **Change.** `staging-gate.mjs` takes a pinned target (staging or production), with the production origin and ref as constants added after S1 and S6. The production probe list is §2 S5.
- **Files.** `scripts/staging-gate.mjs` (or a new `scripts/production-gate.mjs` sharing its functions), its tests, and `docs/ops/STAGING_DEPLOY_GATE.md`.
- **Tests.** The probe expectations per target, and that an unknown target is refused.

**P8. A dedicated OAuth state secret.** Done by #1393 (`e228a483`): Google and MCP state are signed with `WALDO_OAUTH_STATE_SECRET`, with no fallback (`connectors/oauth-state-secret.ts`).

**P9. Report a problem.**
- **Change.** A tool the model can call when the owner says something went wrong. It records the trace key, the surface and the owner's own words in the owner's DO, and shows an approval card before anything leaves. Sending the report to the support address is an approved effect with a receipt. The console lists the owner's reports.
- **Files.** `tools/live/*` (a new tool), `channels/owner-do.ts`, `packages/contracts` tool lists, the console, and an eval scenario. It needs an owner decision on the destination (D9).
- **Tests.** Tool schema valid and invalid pairs. The card shows the frozen content. No send happens without approval.

**P10. Data export (ADR-0073 §1 item 3).**
- **Change.** An authenticated in-app download of the owner's DO and Supabase records, machine-readable and human-readable, over a short-lived signed URL. It is never sent by email or chat.
- **Files.** A design note first. This is larger than the others and is a gate before the first invite.

**P11. Emergency guidance per locale.** The prompt names only "112 in India" (`prompt/messaging-behavior.ts:104`), and the cohort is global. The numbers come from the clinical-reviewed crisis pack (a legal and clinical item); the code reads the owner's locale.
- **Files.** `prompt/messaging-behavior.ts`, a small locale table, voice and safety eval cases.
- **Tests.** The eval cases pass for India, the US and the UK.

**P12. Make the spend ceiling cover background work and attribute it.**
- **Change.** Read the month's spend (`costs.monthSpendUsd`) against the ceiling at the background entry points, as owner turns already do: heartbeat, nightly memory, briefs, reminders and standing orders. Past the ceiling, skip or defer the work, and never the owner's own turns. Set `cost_kind` at each producer so the ledger tells turn from background from worker.
- **Files.** `channels/owner-do.ts` (the background entry points; hot file), `observability/cost-rollup.ts`, `llm/cost-ledger.ts`, and `docs/ops/OBSERVABILITY.md`.
- **Tests.**
  - A machine turn past the ceiling is skipped, with a `spend_hold` hop.
  - An owner turn past the ceiling still runs on the auxiliary route.
  - Ledger rows carry each `cost_kind`.
  - Each of these fails with the wiring removed.

**P13. Hold the cohort size.**
- **Change.** An admission policy row (`member_invites_enabled`, `max_active_owners`), read by `issue_member_invite` and by owner creation at sign-up. The owner sets it per environment through SQL, and production starts with member invites off and a cap of 50.
- **Files.** One new migration, `supabase/tests/waldo_invite_*.sql`, `channels/console-invites.ts` (show "invites are closed"), and the `verify-supabase-migrations.mjs` manifest.
- **Tests.** pgTAP: member issuance refused when disabled; the 51st sign-up refused; the admin path unchanged.

## 5. Owner decisions

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Which Cloudflare account hosts production | An account owned by the LLP, not the personal testing account | DO data stays in the creating account; moving later means moving every owner's state |
| D2 | Supabase organisation, region, plan | The LLP's organisation; a region near the cohort; a plan with PITR | Region is fixed at creation; PITR needs a compute add-on (ADR-0058) |
| D3 | Production host | One subdomain of heywaldo.in, for example `api.heywaldo.in` [inference]. The contracts also name `api.heywaldo.com` for problem-type URIs (`packages/contracts/src/public/morning-brief.ts:104-141`), so pick one. | Google redirects, links and the app origin all hang off it |
| D4 | Google project and publishing state | A separate production project; Testing for the first batch | Testing costs a weekly re-link and a manual test-user add per invitee, up to 100 in the project's lifetime |
| D5 | Channels in production | App and console only for the alpha. WhatsApp after Meta verification and P5. iMessage after a host Mac exists. No Telegram. | Each channel adds a processor and residue |
| D6 | Feature flags and egress in production | Match staging (flags `1`, egress `*`) after the production E2E, or keep them off for the first batch | The 22 Oct E2E ran with them on |
| D7 | Langfuse in production | Option A (none) for the first batch; Option B after P5 | Phone numbers in trace ids; retention needs the Pro plan |
| D8 | Beta geography | Use the invite list to follow ADR-0073 §2 (no EU, EEA or UK invitees) until the ADR is amended | An accepted ADR and the 21 Oct build direction disagree |
| D9 | Who is paged, and where reports go | Both founders (ADR-0073 item 11); one support address | Nothing pages anyone today |
| D10 | Provider spend limits | Hard monthly caps on the production OpenAI and Anthropic projects | The only limit that covers all owners together |

## 6. Evidence

**Observed this session.**
- Files read at `c5e44093`:
  - `packages/runtime/wrangler.jsonc`, `scripts/deploy-runtime.sh`;
  - `scripts/staging-migration-preflight.mjs`, `scripts/staging-migration-apply.mjs`, `scripts/staging-gate.mjs`;
  - `scripts/guards/guard-wrangler-local-bindings.mjs`, `scripts/owner_wire_supabase.sh`, `supabase/config.toml`;
  - `channels/dashboard-owner-controls.ts:51-115`, `owner-do.ts:1215-1230,1925-1937,2505-2535`, `channels/google-oauth.ts:70-80`, `channels/mcp-oauth-routes.ts:22-30`, `channels/proactive-gate.ts:14`, `channels/probe-turn.ts:81-86`, `observability/trace-privacy.ts:55-87`;
  - the docs under `docs/ops/`, `BUILD_DIRECTION_2026-10-21.md`, the #1400 verdict, and `docs/research/GOOGLE_INTEGRATION_2026-10-21.md`;
  - ADR-0055, ADR-0058 and ADR-0073 from `Pin4sf/waldo-brain`.
- Four read-only subagent sweeps covered the env inventory, Supabase, deletion, ops and channels. Their claims cited above were re-read at the named lines before being labelled [source].
- `node scripts/production-alpha-dryrun.mjs`: 9 open items (6 gaps, 3 decisions); from zero, 68 migrations.

**Inference.** The stranded-DO consequence, the spend upper bound, the domain suggestion, and two Workers fighting over one Telegram webhook.

**Unverified.**
- The staging secret list.
- Whether staging has custom SMTP.
- Supabase plan and PITR state on staging.
- Whether `delete_owner` may delete `auth.users` on a hosted project.
- The migrations endpoint on an empty project.
- Platform injection of function secrets.
- The `wrangler durable-objects namespace list` shape on the pinned version.
- Whether iMessage held events are pruned after deletion.
- Whether publishing the Google app unverified ends the 7-day expiry.
