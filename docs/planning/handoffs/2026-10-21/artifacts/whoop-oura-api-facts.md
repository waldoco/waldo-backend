# WHOOP API v2 and Oura API v2 — primary-source facts (read 2026-10-21 11:50–11:58Z)

Read by a research subagent of the wearables-trigger session (PR waldoco/waldo-backend#1354) with curl against the
official docs/specs. [unverified] = not confirmable from a primary source. Full sandbox/doc fixtures are copied into
that PR's test files.

## 0. Terms that may BLOCK the plan (owner/legal review)
- Oura API and MCP Agreement, effective 8 June 2026 (https://cloud.ouraring.com/legal/api-agreement):
  - §4(d): Oura data may be used with an LLM "solely through the MCP Server"; bars using the Oura API to "prompt, or
    otherwise provide input or data to any AI Model or AI Platform". §1 defines AI Platform broadly.
  - §4(a)(xx): "aggregating, caching, or storing" User Data is a Prohibited Use without Oura's prior written consent.
  - §3(m): no retention beyond "strictly necessary"; §5(f): delete within 72 h of a deletion request; revocation immediate.
  - §4(a)(iii)/§6(g): no training/fine-tuning/evals on User Data, §4(c) even with user consent.
- WHOOP API Terms of Use, effective 6 Oct 2026 (https://developer.whoop.com/api-terms-of-use/):
  - §4: unless the user or law expressly authorizes, no exposure to third parties without explicit opt-in, no permanent
    copies / caches beyond cache headers, no using WHOOP Data to create/test/train/improve any LLM or AI system.
  - §3: no medical/professional advice; no medical-device use; no selling data even with consent.
  - §2: encrypt in transit/at rest; incidents reported within 48 h; users can access what the app holds.

## 1. Sources
- WHOOP: https://api.prod.whoop.com/developer/doc/openapi.json (OpenAPI 3.0.1, no version string; sha256 b40986e6…),
  OIDC discovery https://api.prod.whoop.com/oauth/.well-known/openid-configuration, developer.whoop.com docs (newest
  changelog entry 2026-09-23), API terms (eff. 2026-10-06).
- Oura: https://cloud.ouraring.com/v2/static/json/openapi-1.42.json (OpenAPI 3.1.0, info.version 2.0, file rev 1.42,
  Last-Modified 2026-10-19 15:04:18 GMT), /docs/authentication, /docs/error-handling, API agreement (eff. 2026-06-08),
  live sandbox captures (synthetic). /docs/webhooks and /docs/rate-limits were 404.

## 2. WHOOP v2 (base https://api.prod.whoop.com/developer)
- OAuth: authorize https://api.prod.whoop.com/oauth/oauth2/auth; token https://api.prod.whoop.com/oauth/oauth2/token
  (form-urlencoded, client_id+client_secret in body). PKCE NOT documented. `state` "must be eight characters long".
  Refresh only with scope `offline`; ROTATING single-use refresh token (concurrent refresh: second fails).
  Scopes: read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement offline.
  Disconnect: DELETE /v2/user/access (Bearer, 204) — also stops webhooks for that user.
- Endpoints: /v2/cycle, /v2/cycle/{id}/recovery, /v2/recovery, /v2/activity/sleep[/{uuid}], /v2/activity/workout[/{uuid}],
  /v2/user/profile/basic. score_state SCORED|PENDING_SCORE|UNSCORABLE; `score` present only when SCORED.
  timezone_offset "+hh:mm"/"-hh:mm"/"Z"; start/end in UTC.
  Recovery.score: recovery_score, resting_heart_rate, hrv_rmssd_milli (RMSSD ms), spo2_percentage, skin_temp_celsius, user_calibrating.
  Sleep: nap bool; score.stage_summary total_*_milli; sleep_efficiency_percentage; respiratory_rate (unit unstated).
  Workout: sport_name, score.kilojoule, strain.
- Pagination: limit (max 25), start (incl), end (excl), request `nextToken`, response `next_token`; sorted desc.
- Webhooks: dashboard-configured URL per app (v2). Body {user_id:int64, id:uuid, type, trace_id}; types
  workout|sleep|recovery .updated|.deleted (recovery id = SLEEP uuid). Headers X-WHOOP-Signature =
  base64(HMAC-SHA256(timestamp + raw body, client_secret)), X-WHOOP-Signature-Timestamp (ms). 5 retries ~1 h; dedupe
  on trace_id; missed webhooks possible → reconcile. No cycle/strain/steps webhooks.
- Rate limits: 100/min, 10,000/day; X-RateLimit-Reset = seconds until reset; 429, no Retry-After.
- Tiers: Sandbox 10 members (default), Build 100, Growth 1,000, Scale 5,000, Production unlimited; one tier at a time,
  ≥50% of current tier connected to ask for the next.
- No revocation webhook; revocation shows as 401 / failed refresh.

## 3. Oura v2 (base https://api.ouraring.com)
- OAuth: authorize https://cloud.ouraring.com/oauth/authorize; token https://api.ouraring.com/oauth/token; PKCE S256
  supported and recommended; state optional (use it). Blank scope = all scopes; users can switch scopes off; redirect
  `scope` param deprecated. Refresh token SINGLE-USE (rotating). Access lifetime: docs contradict (24 h vs 30 d) — use
  expires_in. Revoke: https://api.ouraring.com/oauth/revoke?access_token=… (method unstated; token in query string).
  Scopes: email personal daily heartrate workout tag session spo2 (+ heart_health in spec).
- Endpoints /v2/usercollection/{sleep,daily_sleep,daily_readiness,daily_activity,daily_spo2,workout,...} with
  start_date/end_date/next_token; heartrate with start_datetime/end_datetime. Envelope {data:[], next_token}.
  401 expired/revoked; 403 missing scope OR membership expired; 429 with Retry-After + X-RateLimit-Reset (epoch s).
- sleep: day, bedtime_start/end (ISO with offset), type long_sleep|sleep|late_nap|rest|deleted, total_sleep_duration (s),
  time_in_bed (s), efficiency (1–100), average_hrv (int; METHOD/UNIT UNSTATED), lowest_heart_rate, average_breath (/min).
  daily_readiness has only contributor scores (no raw HRV/RHR). daily_spo2.spo2_percentage.average.
- Webhooks: POST /v2/webhook/subscription (x-client-id/x-client-secret) {callback_url, verification_token, event_type
  create|update|delete, data_type}; one subscription per (event,data) pair; expiration_time + PUT …/renew/{id}.
  Verification GET ?verification_token&challenge → {"challenge": value}. Event POST {event_type, data_type, object_id,
  event_time, user_id} with x-oura-signature (sample: uppercase hex HMAC-SHA256(client_secret, timestamp + JSON body))
  and x-oura-timestamp. Reply within 10 s; returning 410 CANCELS the subscription. No heartrate webhooks.
- Rate limits: "5000 per 5 minutes" (older docs) vs a two-layer per-token/per-app model (newer, no numbers).
- Approval: 10 users before Oura approves the app.

## 4. Cross-provider pitfalls
X-RateLimit-Reset differs (WHOOP seconds-until vs Oura epoch); signature encodings differ (base64 raw body vs uppercase
hex re-serialized JSON); both rotate single-use refresh tokens (single-flight refresh); both need polling for some data;
WHOOP recovery webhook id is the sleep uuid; never return 410 to Oura by accident; revocation is silent (401).
