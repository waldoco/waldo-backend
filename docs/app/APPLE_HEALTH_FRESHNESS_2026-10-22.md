# Apple Health freshness: why the newest reading can stop, and how to tell

Status: diagnosis from source plus a read-only staging diagnostic. On 22 October the owner's newest Apple Health reading on staging was from 10 October. That has not been observed on the staging database from this lane. The SQL in `scripts/diagnostics/apple-health-freshness.sql` is how the owner's Mac observes it.

Sources read: waldo-backend `beta-mvp` `6d70e46b`, plus this branch; waldo-app `main` `8e8c73e7` (13 October), read-only.

## Short version

- **[verified]** The app sends Apple Health in day-sized chunks, oldest first. The watermark only moves past a chunk once it has been sent (`healthIngestRunner.ts`, `pass`).
- **[verified]** If one chunk fails, the run stops there, and every later run reads from the same place. There are two ways a chunk fails:
  - the backend refuses the batch: `invalid_request` or `sample_conflict`, all or nothing until this PR;
  - the app's own strict parse throws: `ingestHealth` calls `healthIngestV1Schema.parse(batch)`.
- **[inference]** So one bad reading in one day stops every newer day, on every run, until that day falls outside the 30-day backfill. That matches a newest reading stuck on one date while the Watch keeps recording. It is the leading hypothesis, not a finding: the diagnostic decides it.
- **[verified]** Until this PR, a refused upload left no trace on the backend: no row and no log. This PR logs a refused upload by code and status only (`app health ingest refused`), once it passed authentication and the rate limit: a 401, a 429 or the limiter's or session lookup's 503 is answered before the health route runs and is not logged here. It also adds per-sample rejection at health revision 3, so a bad reading costs only itself, with a receipt that names it. Since migration `20261023120000`, each logged refusal is also counted by code and status per owner and UTC day (`waldo.health_ingest_refusals`, kept 30 days), and the console shows the last 7 days: Settings › Health for the owner, Settings › Tester health for the admin.
- **[inference]** A second hypothesis needs no bug. The legacy `health-sync` function was deleted from staging on 10 October (see `HEALTH_INGEST_DESIGN_2026-10-10.md`). If the owner's installed build still uploads the old way, or never reached the new ingest route, then the newest derived row is the last one that function wrote, on 10 October. Sections 5, 6 and 10 of the diagnostic separate the two hypotheses.

## Every way an Apple Health upload can be dropped or refused

The backend path is `POST /app/v1/health/ingest` → `app-api.ts` → `app-health.ts` → the signed `waldo.health_ingest` RPC. Each step below says what the app sees, and what its health screen says (`ingestLine.ts`).

| # | Where | Condition | Answer | App state → screen |
|---|---|---|---|---|
| 1 | `app-api.ts` | no or invalid credential | 401 `unavailable` | `stopped/signed_out` → no line, session expired |
| 2 | `app-api.ts` | session lookup or rate-limiter binding unavailable | 503 | `paused/unavailable` → "could not reach the health service (HTTP 503)" |
| 3 | `app-api.ts` | more than 120 health calls a minute per owner (`app-health:<owner>`) | 429, `retry-after: 60` | same, HTTP 429 |
| 4 | `app-health.ts` | content type not JSON | 400 `invalid_request` | `stopped/rejected` → "Waldo could not send your readings." |
| 5 | `app-health.ts` | declared length or streamed body over 98,304 bytes, or a body that takes more than 5 s | 413 | `paused/unavailable` (HTTP 413) |
| 6 | `app-health.ts` | not UTF-8 JSON | 400 | `stopped/rejected` |
| 7 | `app-health.ts` | **any one change fails the strict schema** (unit, bounds, hour bucket, time order, HRV method, unknown signal or key), or the envelope fails | 400, whole batch | `stopped/rejected`, the same chunk every run |
| 8 | `app-health.ts` | `idempotency-key` header differs from `request_id` | 400 | `stopped/rejected` |
| 9 | `app-health.ts` | time zone unknown to the Worker | 400 | `stopped/rejected` |
| 10 | `app-health.ts` | `source` names a provider (`whoop`) | 400 | `stopped/rejected` |
| 11 | `app-health.ts` | no RPC (missing Supabase config or router secret), RPC transport failure, or a database answer of the wrong shape | 503 | `paused/unavailable` (HTTP 503) |
| 12 | SQL | unsigned or expired router signature | RPC error → 503 | as 11 |
| 13 | SQL | owner not active or not linked | 403 `not_linked` | `stopped/consent_changed` → "Sending stopped because your agreements changed." |
| 14 | SQL | payload over 98,304 bytes, bad JSON, bad `request_id`/`source`, more than 128 changes, bad anchor shape, zone missing from `pg_timezone_names` | 400 | `stopped/rejected` |
| 15 | SQL | same `request_id`, different payload | 409 `idempotency_conflict` | `paused/conflict` → "could not reach the health service (HTTP 409)" |
| 16 | SQL | no storage grant for the source, or a withdrawn grant | 403 `consent_required` / `consent_withdrawn` | `stopped/consent_changed` |
| 17 | SQL | `consent_epoch` is not the current one (a regrant, or a replay after one) | 409 `epoch_conflict` | `stopped/consent_changed` |
| 18 | SQL | `anchor_before` differs from the stored anchor | 409 `anchor_conflict` | the app retries the chunk once from `null`, then `paused/conflict` |
| 19 | SQL | **any one sample fails a database check**: value outside its bound, wrong unit, offset outside ±840, start after end, **revision more than 5 min ahead of the server clock**, a window starting more than 5 min in the future, **a point reading or sleep ending more than 5 min in the future**, a day that is not the reading's local date, a window that is not one local hour, an HRV reading without `rmssd`/`sdnn` | 400, whole batch | `stopped/rejected`, the same chunk every run |
| 20 | SQL | **the same sample and revision stored with other content** (origin is ignored) | 409 `sample_conflict`, whole batch | `stopped/rejected`, the same chunk every run |
| 21 | SQL | the reading ended more than 90 days ago | 200, counted `ignored` | `done`, nothing stored |
| 22 | SQL | a newer revision is stored, or the same content is, or a tombstone at a higher revision | 200, `ignored` | `done` |
| 23 | SQL | replay of an accepted `request_id` | 200, `replayed: true`, nothing new stored | `done` |
| 24 | after commit | the derived-row recompute (owner Durable Object, else the Worker) fails or is refused | the upload still answers 200 | readings stored, derived row and `/scores` stay old |
| 25 | retention / purge | readings older than 90 days are swept; withdrawing storage purges the source | — | — |

From health revision 3 (this PR), rows 7, 19 and 20 no longer fail the batch. The bad change comes back on a 200 receipt as `{change, index, signal, reason}`, with reason `invalid_sample`, `unsupported_signal` or `revision_conflict`. The good changes are stored, and the anchor advances. Rows 1–6, 8–18 and 21–25 are unchanged, because they are about the request, not about one reading.

On the phone, before any request (waldo-app `8e8c73e7`):
- **[verified]** These stop or pause a run with nothing sent: no session, consent unreadable or not granted, no time zone, iOS access not asked or denied, a HealthKit read failure (the watermark is held there).
- **[verified]** Normalizers skip readings outside the contract's bounds (counted as `skipped`). A night still over 128 intervals is dropped.
- **[verified]** A batch that fails the app's strict `healthIngestV1Schema.parse` throws a plain error. The run then reads as `paused/unavailable` with no HTTP status, and the screen says "could not reach the health service". That is misleading: nothing reached the backend, so the backend has no trace of it.
- **[verified]** Runs happen only on foreground and on Apple Health wakes, at most every 10 minutes. A phone that never opens the app, or never gets woken, sends nothing.

## Apple's documented HealthKit behaviour, against the app's code

Each row cites the Apple page (read on 22 October 2026 through developer.apple.com's documentation data) and the waldo-app file:line at `8e8c73e7`.
- **[verified]** means both the doc and the code were read.
- **[inference]** means a conclusion drawn from them.

| # | Apple says | The app does | Can it explain a newest reading stuck on 10 Oct? |
|---|---|---|---|
| A1 | The HealthKit store is encrypted while the device is locked; a query then fails with `errorDatabaseInaccessible`, so a background read may get nothing. [Protecting user privacy](https://developer.apple.com/documentation/healthkit/protecting-user-privacy), [errorDatabaseInaccessible](https://developer.apple.com/documentation/healthkit/hkerror/code/errordatabaseinaccessible) | `readRange` throws only when every kind fails (`modules/health/ios/HealthKitManager.swift:346`). The runner turns that into `paused/read_failed` (`src/agent/healthIngestRunner.ts:238`). The session credential and the watermark are in the keychain via SecureStore (`src/agent/healthIngestDeps.ts:16`, `src/agent/secureAppStorage.ts:11`), so a background wake while the phone is locked can also find no session. | [verified] Locked-phone wakes send nothing. [inference] That delays readings until the next unlocked wake or foreground; it does not stop them for 12 days unless the app is never woken or opened while the phone is unlocked. |
| A2 | Background delivery needs the `com.apple.developer.healthkit.background-delivery` entitlement from iOS 15. Without it, `enableBackgroundDelivery` fails with `errorAuthorizationDenied`. The system wakes the app at most once per frequency period, and on iOS `stepCount` is hourly at most. [enableBackgroundDelivery(for:frequency:withCompletion:)](https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)) | Entitlement present (`ios/Waldo/Waldo.entitlements:9`, `modules/health/plugin/withHealth.js:65`). Hourly delivery for heart rate, steps and sleep (`modules/health/ios/HealthWakes.swift:13-17,117`). The result of each enable is kept only as a status code, never surfaced as an error. | [verified] The entitlement is in source. [inference] Whether the signed build's provisioning profile carries it is not visible from source. If it does not, every enable fails and only foreground runs send. That is a lag, not a hard stop. |
| A3 | The observer's completion handler must be called. If an app fails to respond three times, HealthKit stops background updates. Observer queries should be set up at launch in `application(_:didFinishLaunchingWithOptions:)`. (Same enableBackgroundDelivery page.) | Every wake's handler is called once: by the ledger, at a 20 s deadline, when background time expires, or at once on error or when not armed (`HealthWakes.swift:19,105,131,139,157-160`). The observer is restarted at launch (`HealthAppDelegateSubscriber.swift:7`). | [verified] It follows the doc. Not a likely cause. |
| A4 | An app is never told that a read type was denied. To the app, denied data simply does not exist. `requestAuthorization`'s success value does not mean access was granted. [Protecting user privacy](https://developer.apple.com/documentation/healthkit/protecting-user-privacy), [requestAuthorization(toShare:read:completion:)](https://developer.apple.com/documentation/healthkit/hkhealthstore/requestauthorization(toshare:read:completion:)) | `checkPermissions` returns `unknown` after the sheet, never `granted` (`HealthKitManager.swift:55-61`). A run with no readings says "Apple Health had no new readings … If read access is off, iOS hides them" (`src/components/health/ingestLine.ts`). | [verified] Correct handling. [inference] If the owner turned off read access for the Watch kinds in Health settings around 10 Oct, the app would send nothing and the backend could not tell. Check iOS Settings › Health › Data Access › Waldo. |
| A5 | `HKWorkout.totalEnergyBurned` is deprecated from iOS 18 / watchOS 11; use `statistics(for:)`. [totalEnergyBurned](https://developer.apple.com/documentation/healthkit/hkworkout/totalenergyburned) | The app reads `workout.totalEnergyBurned` (`HealthKitManager.swift:341`). | [verified] Deprecated API in use. [inference] It can leave `energy_kcal` absent on new workouts. That loses one optional field; it never rejects the reading. |
| A6 | Percent units measure 0.0–1.0, and oxygen saturation uses them. [HKUnit.percent()](https://developer.apple.com/documentation/healthkit/hkunit/percent()), [oxygenSaturation](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/oxygensaturation) | The app reads `.percent()` (`HealthKitManager.swift:302`) and multiplies by 100 before sending (`src/health/normalize/points.ts:41-42`). The contract takes 50–100. | [verified] Consistent. A build that dropped the conversion would lose every SpO2 reading: as a whole-batch refusal before revision 3, and as `invalid_sample` on `spo2` from revision 3. |
| A7 | `heartRateVariabilityRMSSD` exists from iOS / watchOS 27. [heartRateVariabilityRMSSD](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilityrmssd) | The app reads SDNN only (`HealthKitManager.swift:296-300`). | [verified] Not a cause. The contract already takes `method: 'rmssd'`. |
| A8 | The anchored object query returns an anchor for the last sample or deletion it saw. [HKAnchoredObjectQuery](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery) | The ingest runner does not use native anchors. It reads time ranges from a watermark kept in the keychain (`healthIngestRunner.ts:196,213,277`), and the backend anchor chain restarts from `null` each run (`:221`). Its `readChanges` (anchored) is not called from `src`. Deletions are never sent (`:255`, `deletions: []`). | [verified] No anchor can go stale. [inference] A sample deleted on the phone stays on the backend until retention. |

Checked against the contract: every type and unit the app sends matches Apple's documented unit. Each contract bound is a plausibility limit that the app's normalizers already enforce before sending: points, windows and sleep skip out-of-range readings and count them as `skipped`. **No contract bug was found that would reject a legitimately produced HealthKit reading**, so no contract change was made for this. The newer Watch types are not read by the app, so they cannot be dropped yet: RMSSD, wrist temperature, walking heart-rate average, VO2 max, heart-rate recovery. They are AW-1, which is still open. From revision 3, a build that sends one before the backend accepts it gets `unsupported_signal` for that reading only.

**Leading cause, ranked [inference].**
1. A poisoned chunk: one bad reading, or one same-revision conflict, in the day after 10 Oct. It halts every newer day on every run (rows 7, 19, 20).
2. The installed build never reached the new ingest after the legacy function was deleted on 10 Oct.
3. Read access turned off (A4), or the app rarely woken or opened while unlocked (A1).

The diagnostic separates 1–2 from 3. For 3, the backend would show no uploads at all. A poisoned chunk shows as the app line "Waldo could not send your readings", or as "could not reach the health service" with no HTTP status.

## Reading the diagnostic

Run `scripts/diagnostics/apple-health-freshness.sql` as its header says. It is read-only, and prints no values, no ids and no email.

| What the output shows | Most likely cause | Next step |
|---|---|---|
| §1 has no `20261011000000_health_plane` | staging is missing the health plane | apply the reviewed migrations on staging (owner action) |
| §2 `not found` or not `active` | wrong email, or the owner is suspended | check the owner row |
| §3 storage grant withdrawn, or epoch moved after 10 Oct | consent changed; the phone stops with "agreements changed" | regrant in the app |
| §5/§6 no uploads after 10 Oct; §10 newest derived row 10 Oct | nothing reached the new ingest after 10 Oct: refusals (rows 4–20), or a build that never uploads to it | §11, or the console's Tester health page, counts the refusals by code; `wrangler tail` shows `app health ingest refused` as they happen; the app screen shows the state from the table above |
| §5 uploads after 10 Oct, but §8 newest_end still 10 Oct | uploads arrive but carry nothing newer: the walk is stuck on an older chunk, or every new reading is `ignored` | the app issue below; for a build on revision 3, §7 shows which reading |
| §8 newest_end recent, but §10 newest row 10 Oct | readings stored, derived rows not written (row 24) | backend: owner object's recompute and `health_context_write` |
| §8 and §10 both recent | the backend is fresh; the surface the owner read is stale | find which surface showed 10 Oct |

The server clock is in §0. If the phone clock is more than 5 minutes ahead of it, every window and sleep reading is refused under row 19.

## Staging E2E (owner, after this PR is deployed to staging)

There is no secret in this runbook. Each command reads its credential from the owner's shell.

1. **Before.** Run the diagnostic and keep its output.
2. **Sync.** Wear the Watch, open the Waldo app, keep it in front for a minute, and read the line under Apple Health. A build at health revision 3 is needed to see per-sample rejections. waldo-app `8e8c73e7` sends no `x-waldo-app-contract` header, so it reads revision 1 and keeps the all-or-nothing batch.
3. **Refusals.** Run `npx wrangler tail --env staging --format pretty` from `packages/runtime` during the sync. Each upload the health route refuses prints `app health ingest refused { status, error }`. Count them by code; there is no value or owner id in the line. A 401, a 429 or the limiter's or session lookup's 503 is answered before the health route and does not print this line; the app's own status shows those.
4. **After.** Run the diagnostic again:
   - §6 newest upload should be minutes old;
   - §8 newest_end should be today for steps or heart-rate windows;
   - §10 should show today's derived row;
   - §7 lists any per-sample rejections by reason and signal.
5. **Scores.** In the app, the health screen reads `/app/v1/health/scores`; its `freshness` should be `fresh`. There is no console view of health freshness yet: the console's Health data row still says "Not built yet" (`channels/console.ts`).
6. **Per-sample answer, without the app.** This is optional. It sends one synthetic batch: one good step hour and one out-of-range one.
   - Replace the timestamps with the current UTC hour before running, so the good hour is accepted. Keep the steps value below 300,000 for the good hour.
   - Never use real readings.
   - `WALDO_APP_CREDENTIAL` is the owner's app session credential, kept in the shell. `CONSENT_EPOCH` is the storage epoch from §3 of the diagnostic.
   - Expect `200` with `accepted: 1` and `rejected: [{ "change": "sample", "index": 1, "signal": "steps_window", "reason": "invalid_sample" }]`.
   - Send it once more without the `x-waldo-app-contract` header and a new `request_id`: expect `400 {"error":"invalid_request"}` and nothing stored.

   ```sh
   curl -sS -X POST "$WALDO_STAGING_URL/app/v1/health/ingest" \
     -H "authorization: Bearer $WALDO_APP_CREDENTIAL" -H 'content-type: application/json' -H 'x-waldo-app-contract: health=3' \
     --data '{"request_id":"e2e-per-sample-0001","source":"apple","consent_epoch":'"$CONSENT_EPOCH"',"timezone":"UTC","anchor_before":null,"anchor_after":"e2e-per-sample-0001",
       "samples":[{"sample_id":"e2e-steps-ok","revision":1,"signal":"steps_window","unit":"count","value":10,"start_at":"YYYY-MM-DDTHH:00:00Z","end_at":"YYYY-MM-DDTHH+1:00:00Z","day":"YYYY-MM-DD","utc_offset_minutes":0},
                  {"sample_id":"e2e-steps-bad","revision":1,"signal":"steps_window","unit":"count","value":300001,"start_at":"YYYY-MM-DDTHH:00:00Z","end_at":"YYYY-MM-DDTHH+1:00:00Z","day":"YYYY-MM-DD","utc_offset_minutes":0}],
       "deletions":[]}'
   ```

   - This moves the stored anchor to `e2e-per-sample-0001`. The phone's next chunk then gets `anchor_conflict` once, restarts from `null` and carries on (row 18), which is safe.
   - Delete the synthetic step hour at once, so the owner's real health plane keeps no test reading and that day's steps are not inflated. Expect `200` with `deleted: 1`:

   ```sh
   curl -sS -X POST "$WALDO_STAGING_URL/app/v1/health/ingest" \
     -H "authorization: Bearer $WALDO_APP_CREDENTIAL" -H 'content-type: application/json' -H 'x-waldo-app-contract: health=3' \
     --data '{"request_id":"e2e-per-sample-0002","source":"apple","consent_epoch":'"$CONSENT_EPOCH"',"timezone":"UTC","anchor_before":null,"anchor_after":"e2e-per-sample-0002",
       "samples":[],"deletions":[{"sample_id":"e2e-steps-ok","signal":"steps_window","revision":2}]}'
   ```

## Rollback

Revert the merge commit: `git revert -m 1 <merge sha>`, then redeploy the Worker. Without the server-set field, the database function's old mode answers exactly as before, so the migration can stay. Builds that send `health=3` go back to all-or-nothing. There is no flag. Per-sample rejection ships on, as the owner asked.
