# ADR draft: Google Health (Fitbit, Pixel) as a cloud health source for the beta cohort (4 November 2026)

This is a draft for `Pin4sf/waldo-brain/01-Waldo/Architecture Decision Records (ADR)/`. It lands there through that repo's own review. On its own it changes no accepted ADR and authorizes no build.

It amends the build direction of 21 October 2026, which limits launch health sources to HealthKit, Health Connect, WHOOP and Oura. It also amends the earlier recommendation to keep cloud Google Health out of launch, in `docs/research/GOOGLE_INTEGRATION_2026-10-21.md` (row G11 and item 10).

**Why now.** The owner ruled on 4 November 2026 that the beta cohort needs it: several testers wear a Fitbit with an iPhone.

**Sources.** Google's pages were read on 4 November 2026, each with the "last updated" date it shows:

- Developer and User Data Policy (2026-03-24)
- Setup (2026-10-09)
- Data types (2026-10-06)
- Vitals and Sleep (2026-09-22)
- Migration (2026-09-28)
- Data access (2026-10-09)
- About (2026-10-23)
- Webhooks

Code was read at `beta-mvp` `8455b0b9`.

---

## New ADR 0087 (the next free number in this repository's documents; confirm it against waldo-brain): Google Health is a cloud health source, connected for at most 100 owners before Google's security review

```markdown
---
status: proposed
date: 2026-11-04
canonical_location: waldo-brain/01-Waldo/Architecture Decision Records (ADR)/0087-google-health-cloud-source-beta.md
related: [0081-health-computation-and-destinations, 0082-device-lifecycle]
---

# Google Health is a cloud health source, connected for at most 100 owners before Google's security review

Some beta owners wear a Fitbit and carry an iPhone. Their data can reach Waldo two ways.

The Google Health app (formerly the Fitbit app) has written to Apple Health since version 5.05 (August 2026). Secondary
reports say it doesn't write HRV or skin temperature, and Recovery needs HRV.

The Fitbit Web API is gone: support ended 30 September 2026 and it switches off on 2 November 2026. Its successor is the
Google Health API, behind Google OAuth. Every Google Health scope is Restricted.

An unverified OAuth client may serve up to 100 users, in Testing or in production. Serving more than 100 needs Google's
third-party security review (CASA, repeated yearly).

**Decision.**

- Waldo adds `google_health` as a cloud provider source behind the same seam as WHOOP.
- It runs on its own Google Cloud projects, separate from the Workspace project.
- It is published to production and left unverified for the beta, capped at 100 owners.
- The security review and CASA wait until the cohort works end to end. They are required before the 101st owner.

## Rules

1. **One seam, the WHOOP one.** Same custody, same retry owner, same ingest path as WHOOP:
   - The `oauth-proxy` Edge Function holds every token and the client secret, in Vault. It makes each request under the
     pinned base `https://health.googleapis.com/v4`.
   - The owner's Durable Object never sees a token. It is the one retry owner and refreshes on demand, single-file.
   - Every reading goes through `waldo.health_ingest`. The producer ranks one source per day and keeps baselines per
     source and per HRV method. So an owner who also syncs Google Health into Apple Health is never counted twice.
2. **Its own Google Cloud projects.**
   - One project per environment (staging, production), as Google's setup guide requires.
   - Never the Workspace project that serves Gmail, Calendar and Drive. Restricted health scopes there would tie that
     project's verification to this review.
   - The publishing status is **In production**, so refresh tokens don't expire after 7 days. The client stays unverified
     during the beta, so owners see Google's "unverified app" screen and the client is capped at 100 users.
3. **Least scope, read only.** Exactly three:
   - `googlehealth.sleep.readonly`
   - `googlehealth.health_metrics_and_measurements.readonly`
   - `googlehealth.activity_and_fitness.readonly`

   No write, nutrition, ECG, irregular-rhythm or reproductive-health scope. Adding one is a new decision.
4. **Mapping to the existing signals only** (no new signal):

   | Google Health type | Waldo signal |
   |---|---|
   | `sleep` (session, with LIGHT/DEEP/REM/AWAKE stages) | `sleep_duration` with stages, `sleep_efficiency`, `sleep_midpoint` |
   | `daily-heart-rate-variability` (RMSSD, ms) | `overnight_hrv`, method `rmssd` |
   | `daily-resting-heart-rate` | `resting_heart_rate`, method `provider_resting_daily` |
   | `daily-respiratory-rate` | `respiratory_rate` |
   | `daily-oxygen-saturation` | `spo2` |
   | `daily-sleep-temperature-derivations` (nightly skin temperature against the owner's baseline, °C) | `wrist_temperature`, method `baseline_delta` |
   | `steps`, `active-energy-burned` (hourly `rollUp`) | `steps_window`, `active_energy_window` |
   | `heart-rate` (hourly `rollUp`, min/mean/max) | `heart_rate_window` |
   | `exercise` | `workout` |
   | `weight`, `body-fat` | `body_mass`, `body_fat_percentage` |

   - Second-level heart rate and intraday HRV samples are not stored, matching the ingest addendum: the beat-level series
     stays with the provider.
   - A field Google hasn't computed produces no sample, never a zero.
5. **Linking before connected.**
   - After the code is exchanged, the edge calls `GET /v4/users/me/identity`.
   - A `400 ACCOUNT_NOT_LINKED` leaves the connection unconnected. The app tells the owner to sign in to the Google Health
     app (migrating their Fitbit account if needed) and try again.
   - The identity's `healthUserId` is the provider account id that `health_provider_route` maps to the owner.
6. **Sync.**
   - A `provider_sync` entry backfills 30 days on first connect, in seven-day windows, then reconciles the last three days
     daily, as WHOOP does. The daily runs are spread per owner, not run as one batch.
   - Webhooks only trigger a fetch; the owner's object fetches with the owner's token.
   - Webhooks are not backfilled and can be missed, so the daily reconcile stays.
7. **Webhook.**
   - `POST /events/google-health` checks the `Authorization` header in constant time against a secret Waldo sets on the
     Google subscriber (`endpointAuthorization`).
   - It answers Google's ownership challenge: success with the secret, `401` without it.
   - It caps the body size, routes each notification's `healthUserId` through `health_provider_route`, and asks for a
     retry only when an owner's object couldn't be reached.
   - The subscriber uses `AUTOMATIC` subscriptions for the mapped types.
8. **Consent: two grants and Google's disclosure.**
   - Source `google_health` carries the same two grants as WHOOP: `storage_compute` and `model_processing`. Both must be
     live before connect, before the code exchange, and before every sync and webhook fetch.
   - Its consent copy is its own, version 4.
   - Google requires the disclosure inside the app, immediately before the consent request, and on an affirmative tap.
     Navigating away is never consent.
   - The disclosure names the data types, Waldo's storage, and the AI model providers an owner turn can route to (today
     OpenAI and Anthropic) as third parties.
   - The privacy policy carries Google's Limited Use statement verbatim.
   - Withdrawal and disconnect behave as they do for WHOOP. Disconnect also revokes the token at Google.
9. **No human reads Google Health data.** Google's Limited Use rules allow human reading only with the user's explicit
   consent to read specific data, for security, for law, or once the data is aggregated and anonymized.
   - Staging's Langfuse text capture would let staff read model inputs that include these readings. So a turn whose
     context holds `google_health` data does not capture text, in any environment.
   - No `google_health` reading reaches logs, audit rows, R2, metrics or eval fixtures. Tests use synthetic values.
10. **Secrets and keys.**
    - Tokens are encrypted at rest (Vault), and every call uses HTTPS.
    - New Worker secrets: `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_REDIRECT_URI`, `GOOGLE_HEALTH_WEBHOOK_SECRET`. The
      client secret lives only at the edge.
    - Without all three, the routes answer `not_configured` and nothing is sent to Google.

## Considered options

1. **Rely on Google Health → Apple Health.**
   - No build, and it ships today.
   - Reportedly no HRV and no skin temperature, so Recovery is missing its main input for these owners.
   - Kept as the fallback while a tester waits for this connector, and for owners past the 100 cap.
2. **Cloud connector in Testing status.**
   - Same build.
   - Refresh tokens expire every 7 days, so each owner reconnects weekly. Rejected.
3. **Cloud connector, published and unverified, capped at 100 (chosen).**
   - Same build as the reviewed version: nothing is thrown away when CASA comes.
   - Costs: the unverified-app screen, and a hard cap that test accounts count against.
4. **Verify and pass CASA first.**
   - Correct for general availability, but it delays the cohort by weeks for a review that runs the same either way.
   - Deferred to before the 101st owner.
5. **Third-party bridge apps that copy HRV into Apple Health.** Rejected: they add another company to the path of owners'
   health data, with no agreement.
6. **Read through an aggregator (for example Terra).** Rejected for the beta: a second processor and a contract for a
   cohort Waldo can serve directly.

## Consequences

- **Contract.**
  - `HEALTH_PROVIDER_SOURCES_V1` gains `google_health`, a new app.v1 enum value announced on #1450 before it lands.
  - `CONSENT_COPY_V1` gains its row (current 4).
  - The health plane's source checks and consent version gain it in one migration.
- **Backend.**
  - New code: `google-health-client.ts`, `google-health-map.ts` (pure, synthetic tests), `google-health-owner.ts` and
    `google-health-routes.ts`, beside the WHOOP files.
  - Generalising the WHOOP owner code is not part of this. It waits until a third provider shows what is truly shared.
- **App.** A "Connect Fitbit / Google Health" row in the connections screen, behind the version-4 notice, plus the plain
  `ACCOUNT_NOT_LINKED` message.
- **Ops.** Two Cloud projects, one Google subscriber per environment, one edge client seed per environment, three Worker
  secrets per environment.
- **Cap.** At most 100 owners per environment's client, test accounts included, until verification and CASA pass.
- **Later, before the 101st owner:** Google's OAuth verification and a CASA assessment (at AL1 or AL2, Google's choice),
  repeated yearly. Key management must meet Google's "hardware security module or equivalent" bar; confirm Vault's key
  custody against it then.

## Verification

- **Mapper:** for each type in the table, a valid and an invalid record (synthetic), plus a missing field producing no
  sample.
- **Owner object:** connect with both grants, connect with one grant missing (`consent_required`), `ACCOUNT_NOT_LINKED`
  (not connected), refresh single-flight, second refusal (`needs_reconnect`), backfill windows, and a disconnect that
  revokes.
- **Webhook:** correct secret routes a hint; wrong or missing secret gets `401`; the ownership challenge passes; an
  oversized body is refused; an unknown `healthUserId` is acknowledged and dropped; an unreachable owner object gets a
  retry.
- **Traces:** a turn holding `google_health` context captures no text in staging, shown by a trace assertion.
- **End to end:** one Fitbit-and-iPhone tester connects on staging, and HRV, sleep stages, resting heart rate and SpO₂
  arrive under source `google_health`. Recovery then computes with method `rmssd`.
```

---

## Amendment to the build direction of 21 October 2026

Health data row, after "WHOOP and Oura connect through their cloud APIs": add **"Google Health (Fitbit, Pixel Watch) connects through its cloud API for up to 100 beta owners until Google's security review passes (ADR-0087)."**

## Owner steps (nothing here is done by the build)

1. **Create two Google Cloud projects:** `waldo-health-staging` and `waldo-health-prod`. Not the Workspace project.
2. **In each project:**
   - Enable the Google Health API.
   - Set the consent screen to External, with app name, support email, logo, home page, privacy policy, terms and
     authorized domain.
   - Add the three read-only scopes from rule 3.
   - Publish to production, and leave the app unverified.
3. **Create a Web OAuth client** with the redirect URI `https://<worker host>/oauth/google-health/callback`. Seed it for
   the edge with `oauth_client_seed` (`docs/ops/PRE_REGISTERED_OAUTH_CLIENTS.md`), token endpoint
   `https://oauth2.googleapis.com/token`.
4. **Put Google's Limited Use statement on heywaldo.in's privacy page:** "The use of information received from Google
   Health API and/or Developer Tools will adhere to the Google Health API Developer and User Data Policy, including the
   Limited Use requirements."
5. **Set the Worker secrets** `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_REDIRECT_URI` and `GOOGLE_HEALTH_WEBHOOK_SECRET`.
   Only after the app ships the version-4 notice and the migration is applied.
6. **Create the Google subscriber:** endpoint `https://<worker host>/events/google-health`, `endpointAuthorization` set
   to the webhook secret, and `AUTOMATIC` for the mapped types.
7. **Testers:** each signs in to the Google Health app (migrating their Fitbit account) before connecting.

## Open questions

1. **Trace capture.** Rule 9 turns off staging text capture for turns holding Google Health data. The other way is a
   tester's explicit consent to staff reading specific data. Recommended: keep rule 9 as written.
2. **Rate limits.** Google publishes no per-user read quota on the pages read. The daily reconcile and webhook fetches are
   few, but the first backfill should pace itself and respect `429` with `Retry-After`.
