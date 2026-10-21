# Google integration check, 21 October 2026

How Waldo's Google integration compares with Google's current documentation and with the Cloud project as it stands today.

**Method.**
- Google pages were read on 21 Oct 2026 in a browser. Every fact below names its page and that page's "last updated" date; source list at the end.
- The Cloud console was read without changing anything (the Data Access page's second page was viewed; nothing was saved).
- Code was read at `f1bd5d09`, the tip of `wave1/integration`.

Nothing here was deployed, and no Google setting was changed.

## 1. Deadlines

| Date | What happens | Waldo impact | Source |
|---|---|---|---|
| **2026-11-11** | Workspace MCP servers start rejecting OAuth clients not marked "Use this client for an AI-powered agent". A client not marked by **2026-11-12** stays non-agentic for good. | Our only client is **not marked** (console). Staging's `read_mcp_tool` / `call_mcp_tool` reads through `gmailmcp`, `calendarmcp` and `drivemcp` stop on 11 Nov. Production has MCP off (`packages/runtime/wrangler.jsonc:20`). | Gmail, Calendar and Drive release notes, entry of 2026-10-12 |
| **2026-10-30** | Fitbit Web API turned off. Support already ended 2026-09-30. | **This repo calls no Fitbit, Google Fit or Google Health API**: grep for `api.fitbit.com`, `fitness.googleapis.com` and `health.googleapis.com` finds nothing in `packages/` or `supabase/`. So nothing here breaks. What's at risk is the plan's promise of Fitbit and Pixel data, which needs a new Google Health API integration (§5). | `/health/about` (2026-09-29) |
| Every 7 days | Refresh tokens issued while the app is in **Testing** expire after 7 days. | All 7 testers lose Google every week. The failure shows up as `invalid_grant`, which the code treats as a dead grant and answers with a reconnect notice (`connectors/google.ts:106`). | `/identity/protocols/oauth2` (2026-10-16) |
| 2026, no date given | Google Fit REST API deprecated; no new sign-ups since 2024-05-01. | Not used. The Fitness API is still enabled in the project. | `/fit/rest` (2026-10-08) |
| Later in 2026, with 90 days' notice | Workspace API use above the daily per-project thresholds gets billed, and quota increases will need billing enabled. | None at today's traffic (§2). | `/workspace/tools-safety` (2026-09-03) |
| Every 12 months, once restricted scopes are verified | CASA security reassessment. | Applies only if we choose option D in §5. | restricted-scope-verification (2026-08-19) |

## 2. Cloud project as it stands (read-only, 21 Oct)

| Item | Finding |
|---|---|
| Projects | One Waldo project: `waldo-dev-492217` ("Waldo-Dev"). It has **no organization** and there is **no separate production project**. |
| Publishing status / user type | **Testing**, **External**. 7 of 100 users, all test users. The cap counts over the app's lifetime. |
| Verification | "Verification is not required since your app is configured with a Testing publishing status." |
| Branding | App name "Waldo". No logo. **Home page, privacy policy and terms of service links are all empty.** Authorized domains are the Supabase project host and a personal `workers.dev` subdomain. The support and developer contacts are personal Gmail addresses. |
| OAuth clients | **One Web client** (created 2026-09-24). Its only redirect URI is the staging Worker's `/oauth/google/callback`, which matches `GOOGLE_CALLBACK_PATH` (`connectors/google.ts:38`). It has no JavaScript origins. **"AI-powered agent" is unticked.** |
| Declared scopes, non-sensitive | `user.phonenumbers.read`, `calendar.events.freebusy`, `userinfo.profile` |
| Declared scopes, sensitive (12) | `calendar.events`, `calendar.events.readonly`, `calendar.readonly`, `tasks`, `tasks.readonly`, `gmail.send`, `contacts.readonly`, `contacts.other.readonly`, `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly`, `youtube.readonly` |
| Declared scopes, restricted (4) | `gmail.readonly`, `gmail.compose`, `gmail.metadata`, `drive.readonly` |
| Enabled APIs that we use | Gmail, Calendar, Tasks, Drive, People, Pub/Sub, Gmail MCP, Calendar MCP, Drive MCP, Workspace MCP |
| Enabled but unused | Fitness API, Google Health API, YouTube Data v3, Maps JavaScript, the BigQuery family, Gemini |
| **Not enabled** | Docs, Sheets and Slides APIs, and their MCP APIs; People MCP |
| Pub/Sub | Topic `waldo-gmail-push`, with one push subscription `waldo-gmail-push-staging` (ack 10 s, retention 1 h) |
| Traffic and quota | In the last 24 h: Calendar 14 requests, Gmail 2, 0 errors. That is several orders of magnitude below every limit in §3. |

**Scopes the code requests but the console does not declare.** `calendar.calendarlist.readonly` (`connectors/google.ts:12`) is requested but not declared. Google shows the "unverified app" screen whenever the scopes a request asks for differ from the declared set (support answer 7454865).

**Scopes declared but never requested.** `youtube.readonly`, `calendar.readonly`, `calendar.events.readonly`, `tasks.readonly` and `gmail.metadata` are declared, but no code asks for them.

## 3. What Google documents today

| Area | Current rule | Source (last updated) |
|---|---|---|
| Gmail quota | 1,200,000 units/min per project, 6,000 units/min per user, 80 M units/day per project before billing. `messages.get` costs 20 units (60 with `format=full`), `threads.get` 40 (120 full), `history.list` 2, `watch` 100. Projects created on or after 2026-05-01 get these new limits. | gmail `/reference/quota` (2026-10-16) |
| Calendar quota | 10,000 requests/min per project, 600/min per user (sliding window), 1 M/day before billing. | calendar `/guides/quota` (2026-09-11) |
| Drive quota | 1 M units/min per project, 325,000 units/min per user, 1 TB egress/day, 400 M units/day before billing. A `403` with reason `userRateLimitExceeded` or `rateLimitExceeded`, or a `429`, means back off and retry. | drive `/guides/limits` (2026-09-11), `/guides/handle-errors` (2026-09-03) |
| Gmail push | Renew `watch` at least every 7 days; Google recommends daily. At most 1 notification/s per user, and extras are dropped. If `history.list`'s `startHistoryId` is too old it returns `404` and you must do a full sync. History is kept for "at least one week", sometimes less. | gmail `/guides/push`, `/guides/sync` (2026-09-15) |
| Calendar push | Channels don't renew themselves: create a new one before expiry and stop the old one with `channels/stop`. A `syncToken` that returns `410` means wipe and do a full sync. `nextSyncToken` arrives only on the last page. | calendar `/guides/push`, `/guides/sync` (2026-09-11) |
| Workspace MCP | **Developer Preview**: the project must be in the Workspace Developer Preview Program. Endpoints `https://{gmail,calendar,drive,…}mcp.googleapis.com/mcp/v1`. Each product needs both its API and its "MCP API" enabled. Refresh tokens need `access_type=offline`. You "must screen prompts and responses for … prompt injection" with Model Armor, or with your own solution if it is documented for users. | `/workspace/guides/configure-mcp-servers` (2026-10-19), `/configure-mcp-security` (2026-10-20) |
| MCP tool names | Gmail: `create_draft, get_message, get_thread, label_*, list_drafts, list_labels, search_threads, unlabel_*`. Calendar: `create/delete/get/update_event, list_calendars, list_events, respond_to_event, search_events, suggest_time`. Drive: `copy_file, create_file, download_file_content, get_file_metadata, get_file_permissions, list_recent_files, read_file_content, search_files`. Slides: `read_presentation, read_slide_page, read_slide_page_thumbnail, update_presentation`. | same, plus per-server reference pages |
| Agentic clients | Marking a client agentic "does not grant additional scopes or privileges". If an app has both user-interactive and agent features, Google says to use separate client IDs. | support answer 15549257 |
| Workspace data policy | Applies to "Workspace APIs, MCPs". Requirements: incremental auth "in context"; a disclosure in the app **immediately before** consent; a Limited Use statement on the site; OAuth tokens encrypted at rest with keys in an HSM or equivalent KMS; prompt-injection protection; CASA for restricted scopes. Gmail use for "generative AI summaries" is an approved use. Training is allowed only for "that specific user's personalized model". | `/workspace/workspace-api-user-data-developer-policy` (2026-09-03) |
| Testing mode | 7-day refresh tokens, a user cap, and a tester warning screen. Google recommends separate projects for test and production. A user can hold at most 100 refresh tokens per client. | `/identity/protocols/oauth2` (2026-10-16), restricted-scope-verification (2026-08-19) |
| Unverified, in production | An "unverified app" screen, and a cap of 100 new users in total until verified. Adding redirect URIs or JavaScript origins, or renaming the app after verification, triggers re-verification. | support answer 7454865 |
| Restricted scopes | Restricted means any Gmail scope that reads message bodies, metadata or headers, and any Drive scope without per-file grant. Storing or transmitting restricted data on servers requires a yearly CASA assessment by an App Defense Alliance lab, at AL1 or AL2; Google picks the level, and once at AL2 an app stays at AL2. Review "can potentially take several weeks", after 2–3 business days of brand verification. **Neither Google nor ADA publishes prices.** | restricted-scope-verification (2026-08-19), support answer 13465431, ADA `casa-tiering` (2026-06-27) |
| Google Health API | Successor to the Fitbit Web API. Uses Google OAuth; tokens **cannot be transferred**, so every user must consent again. Scopes are `googlehealth.{activity_and_fitness,health_metrics_and_measurements,sleep,…}.readonly`. **"All Google Health API scopes are categorized as Restricted."** Identity: `GET health.googleapis.com/v4/users/me/identity`. If the user has no Google Health profile the API returns `400 ACCOUNT_NOT_LINKED`. History can be backfilled after the user re-links. Webhooks subscribe automatically. Minute-level SpO₂ is filtered more strictly than before, so expect fewer points. | `/health/about`, `/health/migration` (2026-09-28), `/migration/data-access` (2026-10-09), `/migration/api-specifications` (2026-09-22) |
| Health Connect (Android) | Reads go back 30 days from the first grant by default. Older data needs `PERMISSION_READ_HEALTH_DATA_HISTORY`, and background reads need `READ_HEALTH_DATA_IN_BACKGROUND` plus a feature check. Uninstalling the app drops every permission. | developer.android.com `health-connect/read-data` (2026-10-09) |

## 4. Where our code stands

### Matches current docs

| Item | Code |
|---|---|
| Offline access, PKCE S256, `include_granted_scopes` | `connectors/google.ts:94-101` |
| Gmail watch renewed daily, with a margin before the 7-day expiry | `connectors/google-push.ts:99`, `:186-188` |
| Calendar channel TTL of 7 days, renewed 24 h before expiry, old channel stopped | `connectors/google-push.ts:8-9`, `:77`; `channels/calendar-push.ts:80-84` |
| Pub/Sub push carries an OIDC token, which we verify (signature, issuer, audience, service account) | `connectors/google-push.ts:123-159` |
| `invalid_grant` treated as auth failure; `429` and `5xx` from the token endpoint treated as transient | `connectors/google.ts:104-109` |
| MCP endpoints and the `/mcp/v1` path | `connectors/google-mcp.ts:17-24` |
| MCP calls limited to read tools; Drive MCP forces `excludeContentSnippets` | `connectors/google-mcp.ts:16-25`; `tools/live/mcp.ts` |
| Signed page cursors on Calendar, Tasks, Drive and the Gmail mail page | `connectors/google.ts:538-616`, `:793-799`; `connectors/drive-rest.ts:30-37` |

### Behind current docs, or a gap

| # | Gap | Where | Why it matters |
|---|---|---|---|
| G1 | The OAuth client is not marked agentic. | Console | Staging's MCP reads stop on 2026-11-11 (§1). |
| G2 | Every consent asks for every scope: Drive, Docs, Sheets, Slides, contacts and phone included. | `connectors/google.ts:92` | The Docs, Sheets and Slides APIs aren't even enabled. This goes against Google's minimum-scope and in-context incremental-auth rules, and it puts `drive.readonly` (restricted) into any verification. |
| G3 | The mail sweep reads only the 10 newest messages, then moves its marker to "now". | `channels/update-cards.ts:83`, `:91` | If more than 10 inbox mails arrive between sweeps, the older ones are never surfaced as updates. A Gmail push only makes the sweep run sooner (`channels/gmail-push.ts:29-34`). |
| G4 | No incremental sync. Gmail `history.list` with its `404` fallback is missing, and so are Calendar `syncToken` and `410` handling. | grep for `history.list`, `startHistoryId`, `syncToken` and `410` finds nothing. Polling is by time window: `connectors/google.ts:611`, `:801`. | Google recommends history and sync tokens. The time window loses events (G3) and costs more quota. |
| G5 | Disconnect doesn't revoke the token at Google. | `channels/owner-do.ts:2707` calls `connection_revoke`, which only deletes the Vault row (`supabase/migrations/20260924170000_waldo_connections.sql:78-86`). There is no call to `oauth2.googleapis.com/revoke`. | The grant stays valid at Google and keeps counting toward the 100-token-per-user limit. The data policy expects users to be able to delete and withdraw. |
| G6 | No Google-specific rate-limit handling. A `403` `rateLimitExceeded` or `userRateLimitExceeded` is reported as "rejected". | `tools/live/google.ts:73`; `connectors/drive-rest.ts:24`, `:85` → `tools/live/drive.ts:78` | The model hears that the read was refused, when Google said to back off and retry. No reader honours `Retry-After`. |
| G7 | On the Vault rail every proxied call does a refresh-token grant, with no access-token reuse. | `supabase/functions/connector-proxy/index.ts:208`; `connectors/google.ts:461-471` | One extra token call per read, which adds latency and token-endpoint load. |
| G8 | The Gmail push project name is hard-coded, and only a staging subscription exists. | `connectors/google-push.ts:96` | There is no production push path. |
| G9 | The MCP allowlist has `get_draft`, which Google's Gmail MCP tool list doesn't include (its reference page returns 404). | `connectors/google-mcp.ts:17` | Harmless, since the server refuses it, but the list has drifted from Google's. |
| G10 | No prompt-injection screening is documented for MCP or REST content, as Google requires. | n/a | Policy requirement for MCP use and for restricted scopes. Waldo's taint and approval model may satisfy it, but it isn't written up anywhere Google would accept. |
| G11 | No Google Health API integration. Health enters only through the phone's `/app/v1/health` push. | `channels/app-health.ts` | Fitbit and Pixel users have no cloud path. Whether the app reads Health Connect is not verified from this repo. |
| G12 | Health source lists disagree: `health_connect` appears in the ingest contract and the migrations, but not in the adapter contract. | `packages/contracts/src/adapters/health.ts:12-19` vs `packages/contracts/src/app/health-ingest.ts:15` | Contract drift. |

## 5. Verification and CASA: what to decide

The fact that changes the decision: **every Google Health API scope is restricted.** Narrowing Gmail scopes avoids CASA only if Waldo also skips cloud Fitbit and Pixel data.

| Option | What it means | Cost and limits |
|---|---|---|
| **A. Stay in Testing** (today) | Test users only. | Refresh tokens expire every 7 days. At most 100 users ever (7 used). There is no Internal user type, because the project has no organization. |
| **B. Publish without verification** | Change publishing status to "In production". | Users see the unverified-app screen, and the cap is 100 new users in total. The 7-day expiry is documented for Testing only, so it should stop [inference from `/identity/protocols/oauth2`; check after publishing]. Branding blocks publishing until home page, privacy policy and terms are set. |
| **C. Verify sensitive scopes only** | Drop `gmail.readonly`, `gmail.compose` and `drive.readonly`. Keep send, calendar, tasks and contacts. Use `drive.file` for files the owner picks. | Brand plus sensitive-scope review, with no CASA. **Waldo loses the ability to read mail**, the core of the mail half of the product, and cannot add Google Health. |
| **D. Restricted verification plus CASA** | Keep the Gmail read scopes and add the Google Health scopes. | Yearly CASA by an ADA lab, at AL1 or AL2 as Google decides. **Prices aren't published, so ask 2–3 labs for quotes.** Review takes "several weeks". Prerequisites missing today: home page, privacy policy and terms on a verified domain we own; a Limited Use statement; an in-app disclosure before consent; a documented prompt-injection defence; a production project and redirect URI; and probably a custom domain instead of `workers.dev` or the Supabase host (Search Console must verify ownership) [inference; check in Search Console]. |

**Recommendation.**
1. Do **B now** so testers stop losing Google every week.
2. Start **D's prerequisites** in parallel: production project, domain, policy pages, consent copy.
3. Ask labs for CASA quotes. Then decide between C and D once the owner has decided whether Google Health is in launch scope.

A choice of C rules out Fitbit and Pixel data in the cloud.

## 6. Fixes, ranked and sized for one PR each

| Rank | Fix | Size | Owner of files |
|---|---|---|---|
| 1 | Mark the client agentic, or create a separate agentic client for MCP, before **2026-11-11** (owner ask, console). | Console | Owner |
| 2 | Drive: treat `403 rateLimitExceeded`/`userRateLimitExceeded` as rate-limited so the tool reports it as transient. **Opened in this pass** (see PR list). | S | `drive-rest.ts` |
| 3 | Mail sweep: page through every new message since the marker, or move to `history.list` with the `404` full-sync fallback (fixes G3 and G4 for mail). | M | `update-cards.ts`, `connectors/google.ts` (after pr-carries lands) |
| 4 | Revoke at Google on disconnect: a new edge op that calls `oauth2.googleapis.com/revoke` before deleting the Vault row (G5). | M | proxy, `connections.ts`, `owner-do.ts` |
| 5 | Incremental consent: ask for the base set at connect and for Drive, Docs, Sheets, Slides and contacts only when a feature first needs them, per Google's "in context" rule (G2). This reverses the 2026-09-24 owner ruling, so it needs a fresh owner call. | M | `connectors/google.ts`, `owner-do.ts` |
| 6 | Rate limits across the Gmail, Calendar, Tasks and People readers: recognise rate-limit reasons, report them as transient, and honour `Retry-After` (G6). | S–M | `connectors/google.ts`, `tools/live/google.ts` (after pr-carries lands) |
| 7 | Calendar `syncToken` with `410` handling for the update sweep (G4, calendar). | M | `connectors/google.ts`, `update-cards.ts` |
| 8 | Reuse access tokens on the Vault rail for their lifetime, or cache them in the edge per request batch (G7). | S–M | proxy |
| 9 | Make the Gmail push project configurable per environment; add a production subscription (G8). | S | `google-push.ts`, `wrangler.jsonc` |
| 10 | Google Health API connector, behind the health plane, before any promise of Fitbit or Pixel data (G11). It needs an ADR: restricted scopes, re-consent flow, `users.getIdentity`, handling `ACCOUNT_NOT_LINKED`, and backfill. | L | new |
| 11 | Align the health source enum between the adapter and ingest contracts (G12). | S | contracts |
| 12 | Drop `get_draft` from the Gmail MCP allowlist (G9). | XS | `google-mcp.ts` |

Items 3, 5, 6 and 7 touch `connectors/google.ts` or `tools/live/google.ts`, which #1105/#1112/#1117/#1109 are changing. They wait until those land.

## 7. Owner asks

| Ask | Where | Why | By |
|---|---|---|---|
| Tick "Use this client for an AI-powered agent" on the one Web client, **or** create a second, agentic client for MCP only. Google advises the split when an app has both user-interactive and agent features. Every Waldo Google call is made by the agent, so ticking the existing client avoids a second consent [inference]. | Auth Platform → Clients | MCP reads otherwise stop | **2026-11-11** |
| Confirm the project is enrolled in the Workspace Developer Preview Program. Keep MCP off in production while it is a preview. | Workspace Developer Preview | MCP prerequisite | before 11 Nov |
| Add `calendar.calendarlist.readonly`; remove `youtube.readonly`, `calendar.readonly`, `calendar.events.readonly`, `tasks.readonly` and `gmail.metadata` | Auth Platform → Data Access | Avoids a mismatch with what the code requests; keeps scopes to the minimum | next console session |
| Either enable the Docs, Sheets and Slides APIs, or approve removing those scopes from consent | APIs & Services, or code | They are requested today but cannot be used | with fix 5 |
| Disable the unused Fitness API and YouTube Data API | APIs & Services | Smaller surface | any time |
| Fill in home page, privacy policy and terms (heywaldo.in), and logo; replace personal contact emails with a role address | Auth Platform → Branding | Needed to publish (option B) and to verify | before B |
| Create a production project (or decide staging and production share one) with a production redirect URI and Pub/Sub subscription | Cloud console | No production Google path exists | before launch |
| Decide B now, and C or D | §5 | Testers reconnect weekly today | this week |
| If D: get CASA quotes (AL1 and AL2) from 2–3 ADA labs; budget for yearly renewal | Spend | Prices aren't published | before submitting |
| Decide whether Google Health (Fitbit, Pixel) is in launch scope | Product | All its scopes are restricted, so it forces D | before CASA scoping |

## 8. Not verified

- Whether the app repo reads Health Connect, and with which permissions. That code isn't in this repo.
- Whether ticking "AI-powered agent" changes anything for REST calls. Google's help page says it grants nothing extra, but this hasn't been tested on our client.
- CASA prices, and the level Google would assign us.
- Whether the 7-day expiry stops on publishing (option B). It is inferred from the docs and untested.
- Any Cloud project under a different Google account. Only the signed-in account's projects were visible.

## Sources (all read 21 Oct 2026)

On developers.google.com unless stated otherwise:

- **Workspace MCP:** `/workspace/guides/configure-mcp-servers` (2026-10-19) · `/workspace/guides/configure-mcp-security` (2026-10-20) · `/workspace/gmail/api/reference/mcp` (2026-07-21) · `/workspace/slides/api/reference/mcp`
- **Workspace policy and tiering:** `/workspace/workspace-api-user-data-developer-policy` (2026-09-03) · `/workspace/tools-safety` (2026-09-03)
- **Release notes:** `/workspace/{gmail,calendar,drive}/release-notes` (entry 2026-10-12) · `/people/release-notes` (2026-04-22) · `/workspace/tasks/release-notes` (latest entry 2024-07-23)
- **Gmail:** `/workspace/gmail/api/reference/quota` (2026-10-16) · `/workspace/gmail/api/guides/push` and `/sync` (2026-09-15)
- **Calendar:** `/workspace/calendar/api/guides/quota`, `/push` and `/sync` (2026-09-11)
- **Drive:** `/workspace/drive/api/guides/limits` (2026-09-11) · `/workspace/drive/api/guides/handle-errors` (2026-09-03)
- **OAuth and verification:** `/identity/protocols/oauth2` (2026-10-16) · `/identity/protocols/oauth2/production-readiness/restricted-scope-verification` (2026-08-19)
- **support.google.com/cloud answers:** 7454865 (unverified apps) · 13465431 (security assessment) · 15549257 (manage OAuth clients)
- **App Defense Alliance:** appdefensealliance.dev `/casa` and `/casa/casa-tiering` (2026-06-27)
- **Google Health and Fit:** `/health/about` (2026-09-29) · `/health/migration` (2026-09-28) · `/health/migration/data-access` (2026-10-09) · `/health/migration/api-specifications` (2026-09-22) · `/fit/rest` (2026-10-08)
- **Health Connect:** developer.android.com `/health-and-fitness/health-connect/read-data` (2026-10-09)
