# WHOOP and Oura (21 October 2026)

Health Connect and HealthKit stay the main path. WHOOP is a cloud source behind the same health-source seam. Oura stops at pure
record mappers. Read this before registering a developer app, setting a secret, or enabling either source.

## Terms that decide what is built

Quoted from the vendors' own pages, read on 21 October 2026. Vendors can change both documents; re-read before launch.

**WHOOP API Terms of Use**, effective October 6, 2026: https://developer.whoop.com/api-terms-of-use/ (§4, WHOOP Data)

> Prohibitions on WHOOP Data. Unless expressly authorized by the WHOOP Data owner or by applicable law, Company will not, and will not permit Company's End Users or others acting on Company's behalf to, do any of the following:
> Expose WHOOP Data to other users or to third parties without explicit opt-in consent from the user that provided the WHOOP Data and in accordance with the Terms;
> Scrape, build databases, or otherwise create permanent copies of WHOOP Data, or keep cached copies longer than permitted by the cache header;
> Use any API or WHOOP Data to create, develop, test, train, fine-tune or improve any large language model or any other machine learning or artificial intelligence model, application, or system;

How the build meets it:

- Storage in the health plane and use by the AI model are authorized by the owner, expressly, through the two grants every source
  has, for source `whoop`: `storage_compute` (Waldo stores the data) and `model_processing` (AI models process it to plan the owner's
  day). Both must be live before a connection starts, before the callback code is traded for tokens, and before every sync or
  webhook fetch. The notice a WHOOP grant rests on is WHOOP's own, copy version 6 (see "WHOOP consent copy" below); the database
  accepts a new WHOOP grant on version 4 (a build still showing it) or 6, a device grant only on version 2, and stores the version.
  The database refuses a WHOOP reading while `storage_compute` is not live, and refuses WHOOP's own scores unless that grant is on
  copy 6 or later. Withdrawing `storage_compute` withdraws the source and purges what it stored (see below for what it leaves); withdrawing
  `model_processing` stops sync and model use and deletes nothing.
- WHOOP data is never used to create, develop, test, train, fine-tune or improve any model, prompt or eval. The tests, fakes and
  eval cases for WHOOP use synthetic values only (`packages/runtime/test/fixtures/whoop-synthetic.ts`). No recording of a real
  account is committed, and none may be used for a model or prompt change.
- **Legal basis (owner ruling, 7 November 2026, waldoco/waldo-backend#1980):** each user's own consent, given when they connect
  WHOOP, is the express authorization WHOOP's terms require. That consent is the two grants above, asked together on WHOOP's
  notice. Copy versions 4 and 6 say so in words. WHOOP data may feed imports and the workout trigger on that basis.
- WHOOP keeps no permanent copy here: every WHOOP reading and score lives in `waldo.health_samples` under the 90-day raw retention,
  the storage-withdrawal purge and account deletion, like every other source. A body measurement is one rolling reading per kind,
  revised at each daily read, so it too lapses 90 days after the last read.

**Oura API and MCP Agreement**, effective June 8, 2026: https://cloud.ouraring.com/legal/api-agreement

> (d) To the extent you seek to use any Oura Data or User Data in connection with a large language model, you may (unless you are an Aggregator) access and process such Oura Data or User Data solely through the MCP Server subject to the provisions of this Agreement. You shall not use, and shall not permit any third party to use, the Oura API to develop, train, fine-tune, evaluate, prompt, or otherwise provide input or data to any AI Model or AI Platform. (§4(d))

> (xx) aggregating, caching, or storing geographic location information or other User Data accessible via the Oura API or MCP Server. (§4(a)(xx), a Prohibited Use "unless Oura provides prior written consent")

> (c) With respect to User Data, the foregoing Prohibited Uses shall apply regardless of whether a User has purportedly consented to any such use (§4(c))

> (m) Unless and until you are authorized to do so by the Company in a separate written agreement or consent, you shall not store or cache any data accessed or obtained through the MCP Server. (§3(m))

So an Oura connection that stores readings and shows them to a model is a Prohibited Use that owner consent does not cure. Nothing
in the live path reads from Oura: no OAuth, no sync, no webhook, no `oura` entry in the source enum the app can send or the
database accepts. `oura-map.ts` and its tests are pure functions over synthetic records.

Owner decision for Oura (pick one):

1. Ask Oura for prior written consent or a partnership that covers storage and model use. Then the OAuth, sync and webhook slice
   is the WHOOP one with Oura's differences (PKCE, single-use refresh token, signature encoding, `410` cancels a subscription).
2. Oura owners reach Waldo through Apple Health or Health Connect on the device. The ring app writes there; no Oura API is used.
3. Use Oura's MCP server at model time with nothing stored. This loses per-source baselines, so the trigger has nothing to compare against.

## WHOOP consent copy (version 6)

A device source's consent screen is copy version 2. WHOOP's is its own. Copy 6 (health revision 16) is current; a new WHOOP grant may
name copy 4, which an installed build still shows, or copy 6, and is stored on the copy it named. Reading one back accepts every
version WHOOP has had (2, 3, 4, 6), so a copy change never breaks a stored grant. What a grant on copy 4 does not cover is stored no
longer: WHOOP's own scores (recovery, day strain, sleep need, sleep performance, sleep consistency, and a workout's strain) are kept
only under a storage grant on copy 6, checked by the owner object before it sends and by `waldo.health_ingest` when it stores. An
owner on copy 4 keeps syncing every raw reading. The wording is the app and onboarding lane's; the backend fixes what it must say,
taken from WHOOP's terms (§3 and §4 above):

1. Waldo stores the owner's WHOOP data in its health store: sleep (with its stages, time in bed, cycles and disturbances), naps,
   recovery, workouts, physiological cycles with day strain and steps, and body measurements, together with WHOOP's own scores
   (recovery, strain, sleep performance, sleep consistency and sleep need). **New in copy 6:** that WHOOP's own scores are stored.
2. AI models process that data to plan the owner's day, the raw readings included, not only Waldo's summaries of them. **New in copy
   6:** that the raw readings (heart rate variability, resting heart rate, blood oxygen, skin temperature, breathing rate, sleep and
   workout figures) reach the AI models. The notice must say who does it: the AI model providers an owner turn can route to (today
   OpenAI and Anthropic), which are third parties, and only under the model-processing grant, which is the owner's explicit opt-in
   that WHOOP's §4 asks for before WHOOP data is exposed to a third party.
3. Waldo never uses WHOOP data to create, develop, test, train, fine-tune or improve any model, prompt or eval. WHOOP's §4 also
   binds anyone acting for Waldo, so zero-retention and no-training terms with every model provider an owner turn can route to are a
   precondition for WHOOP, not optional wording. The notice may say the providers keep nothing and train on nothing only once those
   terms are in place with each of them.
4. Who else sees it: the data, and Waldo's replies drawn from it, are shown only to the owner, on the surfaces the owner chooses,
   unless the owner asks Waldo to share a specific item. A reply on WhatsApp, Telegram or iMessage passes through that channel's
   provider (Meta, Telegram, Apple), so the notice names them.
   Staging trace capture (Langfuse) is a further recipient while testing; the owner accepted that on 22 October 2026, so the notice
   names it for as long as staging capture stays on. Waldo's notes about the data are not medical advice.
5. How to stop: withdrawing storage stops the sync and deletes what was stored; withdrawing AI use stops the sync and AI use; disconnecting
   ends WHOOP's access.
6. The two yeses are the owner's express authorization, as WHOOP's terms require, for Waldo to store the data and use it with the AI
   models named (added in copy 4, owner ruling of 7 November 2026).

Both grants (storage, then AI use) are asked on this notice. The copy changes only with a new version number, which asks the owner
again; an owner on copy 4 is asked again when the app ships copy 6, and their scores start syncing from the next pass after they say
yes. Set no WHOOP secret and enter no client for the edge until all three hold: the app ships a WHOOP notice (copy 4 or 6), the
consent migrations (`20261021170000`, `20261107090000` and, for copy 6, `20261127120000_health_whoop_depth.sql`) are applied, and the
provider terms in item 3 are in place. The owner's ruling of 7 November settles the legal reading of "expressly authorized"; it does
not change item 3.

## WHOOP in the build

- Connect: the app `POST /app/v1/health/providers/connect` (health revision 2) returns a WHOOP authorize URL. The `state` WHOOP
  requires to be eight characters is a random base62 string resolved through the existing connect-session table (hash only,
  single use, 30 minutes), so it carries no owner identity.
- Callback: `GET /oauth/whoop/callback` on the Worker resolves the attempt, then calls the owner object over the signed provider
  route (it binds owner, operation and body digest). The owner object hands the code to the `oauth-proxy` Edge Function, which
  trades it with the client secret it holds, reads the WHOOP account id (`user_id`), and saves the tokens in Vault.
- Tokens: the owner object never receives a token, a code's result or the client secret. The `oauth-proxy` Edge Function holds
  them (WHOOP is registered to it in `waldo.connection_custody`), makes every WHOOP request under the pinned API base, and
  refreshes and rotates WHOOP's single-use refresh token with a compare-and-set on the stored secret. The object keeps only the
  connection id, the WHOOP account id, the version of the token last used and its expiry. It is the one retry owner: it refreshes
  once, single-file, before a token lapses or after the edge reports one expired or refused (passing the version that failed),
  then retries once. A second refusal means the owner revoked access at WHOOP: the object marks the connection `needs_reconnect`
  and stops calling until the owner connects again. An edge that could not save a rotated token fails the sync for a retry; the
  next refresh then meets a spent token and asks the owner to reconnect.
- Scopes: `offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout`, every kind WHOOP's API
  gives a member's app. The owner object records the scopes the edge reports when a connection is made and at each token refresh.
  A connection made before cycles and body measurements were asked for (or one Waldo never recorded scopes for, read as holding the
  earlier four) keeps syncing sleep, recovery and workouts and never asks for the other two. If WHOOP still refuses one of them (a
  `403`, or a `401` after the core kinds answered on the same token), only that kind waits: the connection is not marked for
  reconnecting, and the provider status names it in `reconnect_for` (`day_strain`, `body_measurements`; served from health revision
  16). Connecting again with the current request clears it.
- Sync: a `provider_sync` schedule entry (a daily interval, no model turn) backfills 30 days in seven-day windows on the first run, then
  reconciles the last three days. Each window reads sleeps (naps included), recoveries, workouts and, when granted, cycles; each pass
  then reads the body measurements once. Pages are WHOOP's maximum of 25. Cycles have no webhook, so they are polled: the open cycle
  is in every window that reaches now and is re-read on every pass, and also after each sleep or workout webhook (the cycles from 36
  hours before the record to now), so day strain follows a workout or a night without waiting for the daily pass. A failed cycle read
  after a webhook never fails the webhook; the next pass catches up. A WHOOP pass stays far inside WHOOP's 100 a minute and 10,000
  a day: a backfill is about 25 requests, a daily pass about 5, a webhook 1 to 3.
- What is stored (health revision 16): see "What Waldo reads from WHOOP" below. A webhook only makes the owner object fetch; the
  fetch uses the owner's own token.
- Webhook: `POST /events/whoop`, signature `X-WHOOP-Signature` = base64(HMAC-SHA256(timestamp + raw body, client secret)), checked against the
  raw body; deduped on `trace_id`. WHOOP can miss a webhook, so the daily sync reconciles.
- Disconnect: `POST /app/v1/health/providers/disconnect` revokes at WHOOP (`DELETE /v2/user/access`, through the edge), has the edge
  mark the connection revoked and delete the Vault secret, and cancels the sync entry.
- Withdrawing a grant is a separate act in the health plane. Withdrawing `storage_compute`: the database refuses new WHOOP readings and
  purges the stored ones. Withdrawing either grant: the owner object's next sync reads `consent_required` and only re-checks daily.
  Neither revokes at WHOOP or removes the saved token; the owner disconnects for that. Having withdrawal disconnect as well is a follow-up.
- A connect request that finds a grant missing answers `consent_required` with `missing` naming the grants that are not live
  (`storage_compute`, `model_processing`), so the app sends the owner to exactly those. A callback that finds one missing shows a page
  saying so and leaves the code unused.
- Workout notice (`WORKOUT_WAKE`): a sync or a webhook that commits a WHOOP workout which ended within the last three hours tells the
  owner object so, exactly as an app upload does. Only the yes leaves the WHOOP code, never the time, sport or detail, and the
  health trigger takes it the same way (one look at the rest of the day, or nothing).
- Every reading goes through the same `waldo.health_ingest` the app uses. The producer ranks one source per day and keeps a
  baseline per source and per HRV method; WHOOP's `hrv_rmssd_milli` is RMSSD. WHOOP's own scores are `provider_*` kinds the score
  engine never reads, so Waldo's Recovery, Form and Load are never WHOOP's numbers under another name.
- WHOOP and Apple Health or Health Connect together: WHOOP's own app also writes the night, workouts, resting heart rate, blood
  oxygen, breathing rate and weight into the phone's store, so they arrive twice. The series read marks a device reading whose
  source bundle or package is `com.whoop` or `com.whoop.*` (`whoop_writer`, without returning the origin), and the producer and
  `get_health` drop it on a day the WHOOP source holds the same kind, so the WHOOP API's record is kept. On a day the API has not
  delivered yet, the copy stays; an owner without the WHOOP API keeps WHOOP's app copy as their data.
- Model context: the standing health block's inventory names each WHOOP kind with its freshness, and a line in words places WHOOP's
  newest recovery and day strain against the owner's own WHOOP days (above, within or below their usual, or too few days for one),
  says whether WHOOP is still calibrating, whether last night met the need WHOOP set and whether that need counts sleep debt, and
  whether the newest workout carries WHOOP's strain and zone minutes. Never a number: `get_health` reads the numbers
  (`whoop_recovery` with `calibrating`, `whoop_strain`, `whoop_cycle_steps`, `whoop_sleep_need`, `whoop_sleep_debt`,
  `whoop_sleep_performance`, `whoop_sleep_consistency`, `naps`, `skin_temperature`, `time_in_bed`, `sleep_cycles`,
  `sleep_disturbances`, `height`, `max_hr`, and each workout session's `strain`, `percent_recorded` and `zone_minutes`).

## What Waldo reads from WHOOP (health revision 16)

Checked against WHOOP's live OpenAPI document (https://api.prod.whoop.com/developer/doc/openapi.json) on 27 November 2026. A field
WHOOP has not scored, or does not state, makes no reading, never a zero.

| WHOOP field | Stored as | In model context |
|---|---|---|
| Sleep `start`, `end`, `timezone_offset` | the night's waking day and offset on every reading of the night | block (day words), get_health |
| Sleep stage light + slow wave + REM | `sleep_duration` (time asleep) | block inventory, get_health `sleep` |
| Sleep midpoint (from start and end) | `sleep_midpoint` | get_health |
| `sleep_efficiency_percentage` | `sleep_efficiency` (ratio) | get_health |
| `stage_summary` light, slow wave, REM, awake, no data, in bed, `sleep_cycle_count`, `disturbance_count` | `stage_totals` on `sleep_duration` (method `provider_totals`) | get_health `sleep_light`, `sleep_deep`, `sleep_rem`, `time_in_bed`, `sleep_cycles`, `sleep_disturbances` |
| `respiratory_rate` | `respiratory_rate` | get_health |
| `sleep_performance_percentage` | `provider_sleep_performance` (method `whoop`) | get_health `whoop_sleep_performance` |
| `sleep_consistency_percentage` | `provider_sleep_consistency` (method `whoop`) | get_health `whoop_sleep_consistency` |
| `sleep_needed` baseline, debt, strain, nap | `provider_sleep_need` (value the sum; the four parts) | block (met or short; counts debt), get_health `whoop_sleep_need`, `whoop_sleep_debt` |
| Sleep with `nap: true` | `nap` (minutes asleep, or the span while unscored), never the night | get_health `naps` |
| Recovery `recovery_score` | `provider_recovery` (method `whoop`) | block (against the owner's usual), get_health `whoop_recovery` |
| Recovery `user_calibrating` | `calibrating` on `provider_recovery` | block, get_health |
| Recovery `hrv_rmssd_milli` | `overnight_hrv` (RMSSD) | get_health `hrv` |
| Recovery `resting_heart_rate` | `resting_heart_rate` (`provider_resting_daily`) | get_health `resting_hr` |
| Recovery `spo2_percentage` (4.0+) | `spo2` | get_health |
| Recovery `skin_temp_celsius` (4.0+) | `skin_temperature` (absolute °C, apart from a watch's wrist temperature) | get_health `skin_temperature` |
| Cycle `score.strain` | `provider_day_strain` (method `whoop`; `open` while the cycle runs) | block (against the owner's usual), get_health `whoop_strain` |
| Cycle `kilojoule`, `average_heart_rate`, `max_heart_rate` | on `provider_day_strain` (kcal, bpm) | not offered |
| Cycle `step_count` | on `provider_day_strain` | get_health `whoop_cycle_steps` |
| Workout span and `sport_name` | `workout` (minutes, activity) | get_health `workouts` and sessions |
| Workout `kilojoule` | `energy_kcal` on `workout` | sessions |
| Workout `average_heart_rate`, `max_heart_rate` | `avg_hr_bpm`, `max_hr_bpm` | sessions |
| Workout `distance_meter`, `altitude_gain_meter`, `altitude_change_meter` | `distance_m`, `elevation_gain_m`, `elevation_change_m` | sessions |
| Workout `zone_durations` zero to five | `hr_zones` (basis `provider`, no bounds; zone zero folds into zone 1) | block (has zone minutes), sessions `zone_minutes` |
| Workout `strain` | `strain` on `workout` (method `whoop`) | block, sessions `strain` |
| Workout `percent_recorded` | `percent_recorded` on `workout` | sessions |
| Body `weight_kilogram` | `body_mass` | get_health `body_mass` |
| Body `height_meter` | `height` | get_health `height` |
| Body `max_heart_rate` | `max_heart_rate` (method `provider_estimate`) | get_health `max_hr` |

Not stored: the profile's name and email (only the numeric `user_id` routes webhooks), record ids beyond each reading's
`sample_id`, and `created_at`. A cycle that WHOOP deletes is not signalled by any webhook; it stays until it ages out.


## Owner steps (nothing here is done by the build)

1. Register a WHOOP developer app (Sandbox tier lets 10 members connect; Build lets 100). Scopes requested:
   `offline read:profile read:body_measurement read:cycles read:recovery read:sleep read:workout`. Turn on all six in the app's
   settings at WHOOP before members connect; a member who connected on the earlier four reconnects to add the other two.
2. Set the redirect URL to `https://<worker host>/oauth/whoop/callback` and the webhook URL to `https://<worker host>/events/whoop` (v2 webhooks).
3. Only once the three conditions under "WHOOP consent copy" hold, set Worker secrets `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and
   `WHOOP_REDIRECT_URI` (the redirect URL above, exactly). The Worker
   uses the client secret only to verify `X-WHOOP-Signature`; the owner object uses the client id and redirect address only. Without all
   three the routes answer `not_configured` and nothing is sent to WHOOP.
4. Enter the client for the edge once, with the same id, secret and redirect address. The edge reads it by issuer and redirect address,
   the client id must match, and its secret is sent only to the pinned token endpoint. Use `oauth_client_seed`; seeding again rotates
   the secret. Steps are in `docs/ops/PRE_REGISTERED_OAUTH_CLIENTS.md`:
   `select waldo.oauth_client_seed('https://api.prod.whoop.com', '<worker host>/oauth/whoop/callback', '<client id>', 'client_secret_post', :'client_secret', 'https://api.prod.whoop.com/oauth/oauth2/token', null);`
5. Apply migration `20261021150000_health_wearables_zone_change.sql` to the health plane before the deploy that reads it. It registers WHOOP
   with the `oauth-proxy` custodian, so it needs the connections migration that creates `waldo.connection_custody`, and the `oauth-proxy`
   Edge Function must be deployed before a connection can start.
6. The terms question was decided on 7 November 2026 (see "Legal basis" above). The app shows WHOOP's notice at copy 4, worded in
   `docs/app/ONBOARDING_AND_CONSENT_2026-10-21.md`; the grants are `storage_compute` and `model_processing` on source `whoop`. For
   WHOOP's scores to be stored the app ships copy 6 (the two additions under "WHOOP consent copy") and names health revision 16.
7. Apply `20261127120000_health_whoop_depth.sql` before, or in the same step as, the deploy that sends the revision-16 kinds: an
   older `health_ingest` refuses a batch carrying them whole, so WHOOP sync would fail until it is applied.
8. One bundled deploy, then connect a WHOOP account on an owner account through the app. The live test checklist is
   `docs/ops/WHOOP_LIVE_TEST.md`.
