# waldo-app issue text: adopt per-sample health rejection

For the app lane to file in waldo-app. Nothing was posted from the backend lane. Observations are from waldo-app `main` `8e8c73e7`, read-only, plus the backend contract on this branch.

---

**Title:** Health ingest: one bad reading stops every newer day. Adopt per-sample rejection (health contract revision 3).

**Problem (verified in source at `8e8c73e7`)**

- `HealthIngestRunner.pass` sends Apple Health in day chunks, oldest first. It saves the watermark only after a chunk is sent.
- A chunk can fail in two ways:
  - the backend refuses its batch: `invalid_request` or `sample_conflict`, all or nothing. `fail` then sets `stopped/rejected`;
  - `AppRoutesClient.ingestHealth` throws on `healthIngestV1Schema.parse(batch)` for one bad change. `fail` then sets `paused/unavailable`.
- Either way, the next run starts from the same watermark (minus the one-day overlap), reads the same day and fails again. Every newer day is never sent.
- The parse failure is shown as "Waldo could not reach the health service", so the owner sees a network problem that is not one. The backend has no trace of it, because nothing was sent.
- [inference] This fits the owner's newest staging reading staying on 10 October while the Watch keeps recording. The backend diagnostic (`scripts/diagnostics/apple-health-freshness.sql` in waldo-backend) confirms or rules it out.

**What the backend offers (waldo-backend, health revision 3, additive to `app.v1`)**

- **Header.** A request carrying `x-waldo-app-contract: health=3` gets per-sample rejection on `POST /app/v1/health/ingest`. Use the header's `name=revision` list grammar, together with any other pairs the app sends.
- **Receipt.** The same receipt as today, plus `rejected: [{ change: 'sample' | 'deletion', index, signal | null, reason }]`.
  - `reason` is one of `invalid_sample`, `unsupported_signal` or `revision_conflict`.
  - `index` is the change's position in its own array.
  - There is never a value in it.
- **Batch.** The good changes are stored, and the anchor advances. The answer is still 200.
- **Request-level refusals are unchanged:** auth, consent, epoch, anchor, idempotency, size, envelope.
- **Without the header,** the backend keeps today's all-or-nothing behaviour exactly. The two sides can ship in either order: a build at revision 3 against an older backend gets today's behaviour.
- **New exports in `contracts/src/app/health-ingest.ts`:** `HEALTH_PER_SAMPLE_REVISION_V1`, `healthChangeRejectionReasonV1Schema`, `healthChangeRejectionV1Schema`, `healthIngestEnvelopeV1Schema`, `checkHealthChangeV1`, and the optional `rejected` on `healthIngestReceiptV1Schema`. The file still imports only zod.

**Asks**

1. Re-pin `contracts/src/app/health-ingest.ts` from waldo-backend.
2. Send `x-waldo-app-contract: health=3` on the health routes.
3. Check each change with `checkHealthChangeV1` before batching, instead of letting one bad change throw away the whole batch:
   - a change that fails is not sent. Count it as skipped, by reason code and signal only, never by value or sample id;
   - keep the envelope check strict.
4. Read `rejected` on the receipt:
   - the chunk counts as sent, and the watermark moves on;
   - add the counts by reason to `IngestStatus`, codes only;
   - do not retry `invalid_sample` or `unsupported_signal`;
   - for `revision_conflict`, re-read and send the reading again at a higher revision. Point records are sent at revision 0 today, so this needs an edit revision: decide which, for example the observation time as windows use. That is an app-lane decision.
5. Report a local schema failure as its own reason, not as `unavailable`. The screen should not say the health service could not be reached when nothing was sent.
6. Check the time zone and clock edge cases the backend refuses per reading. The 5-minute future limits are on revision, window start and point or sleep end. A phone clock that runs fast loses windows and sleep as `invalid_sample`. Count them, so the owner can see it.

7. Read workout energy with `workout.statistics(for: HKQuantityType(.activeEnergyBurned))`. `HKWorkout.totalEnergyBurned` is deprecated from iOS 18 / watchOS 11 (https://developer.apple.com/documentation/healthkit/hkworkout/totalenergyburned), and the app still reads it at `modules/health/ios/HealthKitManager.swift:341`. [inference] New workouts can then arrive without `energy_kcal`.
8. Name the locked-phone case in the status:
   - a range that fails with `HKError.errorDatabaseInaccessible` is the HealthKit store encrypted while the phone is locked (https://developer.apple.com/documentation/healthkit/hkerror/code/errordatabaseinaccessible, https://developer.apple.com/documentation/healthkit/protecting-user-privacy);
   - today it is reported as `read_failed` (`HealthKitManager.swift:346` → `src/agent/healthIngestRunner.ts:238`). A distinct code tells the owner it will catch up after unlock.
9. Show the background-delivery result. `enableBackgroundDelivery` fails with `errorAuthorizationDenied` when the signed build lacks the `com.apple.developer.healthkit.background-delivery` entitlement (https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)). `HealthWakes.swift:117-120` records `failed` but nothing shows it. A visible "background updates off" line separates "the Watch only syncs when I open the app" from a stuck upload.

**Apple-documented behaviour checked against this code (no change needed)**

- Observer completion handlers are always called within 20 s (`HealthWakes.swift:19,105,131,139`). Apple stops background delivery after three missed completions.
- Read authorization is never assumed (`HealthKitManager.swift:55-61`). Apple never reveals a denied read type: the data just looks absent.
- SpO2 is converted from HealthKit's 0–1 percent unit to 0–100 (`src/health/normalize/points.ts:42`).
- The hourly background-delivery limit (steps hourly on iOS) bounds freshness to roughly an hour, at best, while the phone is unlocked.

**Acceptance**

- A chunk with one invalid reading sends the other readings. The next day's chunk is sent in the same run.
- A receipt with `rejected` advances the watermark. The status shows counts by reason and no value.
- A build talking to a backend without revision 3 behaves as today. It never receives `rejected`.
- Unit tests:
  - a mixed chunk;
  - an all-bad chunk, where the watermark advances and nothing is retried;
  - `revision_conflict`, resent at a higher revision;
  - a client-side invalid change, which is skipped with a reason and does not throw;
  - an old-backend answer without `rejected`.
- On a device: after the change, a sync brings the newest reading to today, shown by the backend diagnostic §8 and §10.
