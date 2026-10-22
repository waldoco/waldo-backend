# ADR draft: fuller Apple Watch coverage in the health plane (ADR-0081 amendment proposal)

Status: proposal for the owner, 22 October 2026. Nothing here is built, migrated or deployed. Phase 2 (code) starts only after the owner accepts it. If accepted, the decisions in §0 are published as a dated, append-only amendment to ADR-0081 in waldo-brain. ADR-0081 allows changes only that way. `docs/foundation/accepted-adrs.json` is then regenerated, and the destination fixtures land in Brain, as the Brief-chip addendum in `docs/app/HEALTH_PLANE_AMENDMENT.md` requires.

Owner priority this answers (22 October): get the best Apple Watch data, "almost all of it". Compute a real understanding of each owner's physiology and its changes, as fresh as possible, so Waldo can act on it. Health Connect and Samsung come second, WHOOP later.

Source read for this note:
- waldo-backend `beta-mvp` `c5e44093`, which contains `7bab4193`.
- waldo-app `main` `8e8c73e7`, read-only, to see what the phone sends today.
- ADR-0081 at waldo-brain `main` `c9219839`.

Tags:
- **[verified]**: read in source at those pins.
- **[documented]**: stated in a platform's own documentation.
- **[cited]**: a published source, listed in §15.
- **[inference]**: reasoned, not observed.
- **[proposed]**: this note's recommendation.
- **UNCONFIRMED**: looked for and not found in a primary source.

## 0. Short version and the owner's decisions

The biggest gains don't come from new HealthKit types. They come from five signals the backend already accepts and then ignores, and from the sleep stages the phone already reads but flattens before upload. New types come after that, ranked by how much they tell Waldo about a change in the owner's body before the owner notices it.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Accept the wellness tier W1 (§3.2): sleep stages, sleeping wrist temperature, walking heart-rate average, VO2 max, one-minute heart-rate recovery, mindful minutes. Also feed the five accepted-but-unused signals. | Yes |
| D2 | New candidate versions `recovery.candidate.v2` and `weight.candidate.v4` (§4). Form's next version waits for the freshness lane's version (§4.3). | Yes, all labelled `candidate_unaccepted` like today |
| D3 | Illness-sensitive signals (respiratory rate, wrist temperature, SpO2, awake time, walking heart rate) become **drivers**: descriptive deviations from the owner's own baseline, persisted on the derived row. They are not score weights. The model judges what a deviation means. | Yes |
| D4 | Clinical-adjacent types (§3.4): AFib burden, ECG, irregular-rhythm, high/low heart-rate, sleep-apnea and hypertension notifications. | **Defer.** Design the seam now as a separate consent purpose. Accept nothing until legal review. |
| D5 | Consent copy for W1. The in-app copy is generic (§8). | No copy bump for W1, provided the privacy notice draft lists the categories (owner or legal check). If a bump is still wanted, the §8.2 plan keeps old builds safe. |
| D6 | Per-sample rejection (§6), negotiated at app health contract revision 3. Older builds keep today's all-or-nothing batch. | Yes. It ships first because it unblocks backfill and decouples app and backend release order for every later signal. |
| D7 | Sleep debt is persisted and served by rebuilding #1127's change on the current writer, not by merging #1127 (§9). | Yes |
| D8 | Deferred: State of Mind (self-reported mood), walking steadiness, stand time, physical effort (§3.3). | Defer |

## 1. What exists: the audit, re-verified

Every row was re-read at `c5e44093` [verified]. Line numbers are current; some moved since the audit at `7bab4193`.

| Audit claim | Verdict | Where |
|---|---|---|
| `spo2`, `respiratory_rate`, `sleep_efficiency`, `steps_window` and `active_energy_window` are accepted and stored, but feed nothing | **Confirmed.** The producer's `SIGNALS` lists 9 signals; `get_health`'s enum has none of these five. | `contracts/src/app/health-ingest.ts:149-165`; `runtime/src/health/producer.ts:25`; `contracts/src/tools/schemas/reads.ts:32` |
| Sleep stages can't be represented | **Confirmed, and worse than stated.** The phone already reads stages (`light`, `deep`, `rem`, `awake`) and collapses them to `asleep`/`in_bed` intervals. It drops a whole night that still has more than 128 intervals after merging. `health_series_read` returns only `value`, `method`, `activity`. | `health-ingest.ts:104-116`; app `src/health/normalize/sleep.ts:5-11,78-84`; `supabase/migrations/20261011020000_health_series.sql:171-176` |
| Many Watch types aren't accepted | **Confirmed.** The wire, the SQL unit table, the `health_samples_signal_check` constraint and the series read each hard-code the same 14 signals. | `health-ingest.ts:168-171`; `20261011000000_health_plane.sql:44`; `20261021150000_health_wearables_zone_change.sql:306-312,343`; `20261011020000_health_series.sql:128,145` |
| Sleep debt is computed but never stored or served | **Confirmed, with context.** The contract landed in `3601fe76` (`healthSleepDebtV1Schema`, optional on `/scores`). The migration is open as #1127, which **conflicts** and was written against the fence-era writer. The producer's `rowOf` omits it and the `/scores` route never emits it. | `scores/index.ts:53`; `producer.ts:174-188`; `channels/app-health.ts:120-123`; #1127 head `a0669da8` |
| Pillar drivers are never persisted | **Corrected.** The writer already accepts `drivers` at both row and pillar level. The prompt reader already threads up to four digit-free row-level and Form-pillar drivers into the prompt. Only the producer never sends them. | `20261021150000…sql:27,52,59,62`; `channels/health-context.ts:64-86,150-153` |
| `resting_heart_rate` methods share one baseline | **Confirmed, latent.** The phone sends only `provider_resting_daily` today, so it does not bite on Apple yet. A Health Connect or WHOOP source sending two methods would mix them. | `producer.ts:125`; `scores/recovery.ts:53`; app `points.ts:49` |
| `heart_rate_window` uses only the mean | **Confirmed.** The series read doesn't return `min`/`max`/`n_samples`, so they can't be used. | `scores/form.ts:30-36`; `20261011020000…sql:176` |
| `get_health` picks the source with the most readings; the producer picks by rank | **Confirmed.** | `tools/live/health.ts:101-115`; `producer.ts:26-29,213-215` |
| One bad sample fails a whole batch | **Confirmed at two layers.** The Worker parses the whole body with the discriminated union, so one unknown or invalid sample is `invalid_request` before SQL runs. SQL then raises `22023` or `40001` for one sample, which rolls back the batch. | `channels/app-health.ts:164` (`readJson` with `healthIngestV1Schema`); `20261021150000…sql:316,319,326,332,366-367` |
| The baseline needs 14 days within 30 | **Confirmed.** | `scores/stats.ts:1-2`; `scores/recovery.ts:19-22` |
| `HEALTH_CONSENT_VERSION_V1` is `z.literal(2)` | **Confirmed in the app's pin.** The backend now has a per-source copy table with a `had` list (`health-ingest.ts:30-38`). The app's pinned copy still has `version: z.literal(2)` on both the grant and the stored consent state, so an installed build fails on any consent row whose version is not 2. The grant SQL hard-codes `'2'`/`'3'`. | app `src/agent/contracts/backend-999/health-ingest.ts:36,50`; `20261021170000_health_consent_copy_version.sql:9,37,53` |

Found while re-verifying [verified]:
- **Truncation.** `health_series_read` caps each source at 8,000 rows, newest first, and reports `truncated`. Neither `parseSeries` nor `get_health` reads that flag, so a truncated read silently shortens the baseline and can leave the oldest day partial. See §10 for why this matters once dense point signals join (`20261011020000…sql:129,170`; `producer.ts:51-64`).
- **One HRV method per night.** The phone computes one `overnight_hrv` per night, RMSSD when any RMSSD sample exists, else SDNN (app `sleep.ts:98-100`). Recovery has no fallback for a night whose method has no mature baseline yet, so when RMSSD starts appearing (iOS and watchOS 27) Recovery loses its HRV component for about two weeks [inference].
- **What `movement_duration` is.** It is Apple's exercise minutes (app `fromRange.ts:96`, labelled "Exercise Minutes" in `ingestLine.ts:11`), so exercise time needs no new signal.
- **Source enum in `get_health`.** `get_health`'s result hard-codes the source enum (`reads.ts:60`), which is a second copy of `healthSourceV1Schema`.

## 2. Rules this proposal holds to

1. **Against the owner's own baseline, never population norms.** This is the existing rule in ADR-0081 §2, "baselines remain per source", and in the amendment. Population thresholds appear here only as cited physiology, never as code.
2. **The code computes; the model judges.** Deviations go out as statistics turned into fixed descriptive words. No code rule says "this temperature means illness" or decides that a change is worth telling the owner. That stays with the model, under the existing trigger budget (CLAUDE.md "Judgment belongs to the model"; `health/trigger.ts:12-16`).
3. **Changed inputs mean a new version** (`scores/recovery.ts:4-6`; ADR-0081 §2: "old rows are never silently reinterpreted").
4. **One representation per concept.** One source choice, shared by the producer and `get_health`. One driver vocabulary, shared by writer, prompt and app. One sleep reducer, shared by phone and backend.
5. **app.v1 is additive only.** A new key or value reaches an installed build only when that build names a later revision in `x-waldo-app-contract` (`contracts/src/app/core.ts:8-11`). That is the mechanism WHOOP's consent rows already use at `health=2`.
6. **Data stays where the amendment puts it.** Raw readings live 90 days in owner-only tables. Derived rows keep 24 months. Nothing goes to DO SQLite, R2, memory, logs or traces beyond the staging text-capture ruling. Every new field below lands in an existing ADR-0081 matrix class: raw samples, normalized daily inputs, component scores, or "zone, named drivers, trend". No new destination is created.

## 3. Which Watch types to accept, ranked

### 3.1 How they are ranked

Value to proactive health awareness is judged on five things:
1. Does the Watch record it passively, without the owner doing anything?
2. Is it nightly or daily, so it is fresh enough for today's plan?
3. Is its within-person signal-to-noise good enough to track against the owner's own baseline?
4. Is there published evidence that it moves before or with strain, illness or recovery?
5. Does Health Connect have an equivalent, so Android follows the same seam?

### 3.2 Wellness tier W1: accept in phase 2 [proposed]

Identifiers are reconciled in §3.5. "Feeds" says where the value goes: a pillar weight, a driver (§4.5), or model context only (via `get_health`).

| Rank | Wire signal (new unless noted) | Apple Watch | Cadence | Feeds | Why it earns its place |
|---|---|---|---|---|---|
| 1 | `sleep_duration.stages` (a new optional field, §5) plus interval stages | Sleep stages: core, deep, REM, awake | nightly, passive | Context; awake time becomes a driver | The phone already reads stages and throws them away. Awake time inside the night is the Watch's honest fragmentation measure. The `in_bed` span is often a phone-side schedule, not time in bed [inference, app lane to confirm]. Stage proportions are context only: consumer stage accuracy against polysomnography is moderate and device-specific [cited: de Zambotti 2019; Chinoy 2021]. |
| 2 | `respiratory_rate` (already accepted) | Sleeping respiratory rate | nightly, passive | Driver | Nightly respiratory rate is stable within a person, and its rise preceded symptoms in a wearable cohort [cited: Miller 2020]. |
| 3 | `wrist_temperature` (new) | Sleeping wrist temperature (Series 8, Ultra and later): one absolute value per night [documented] | nightly, passive | Driver | Peripheral temperature rises tracked fever and infection in ring studies [cited: Smarr 2020; Mason 2022]. Applying that to wrist temperature is [inference]. Apple's own Vitals feature flags overnight metrics against a personal "typical range" [documented: Apple support 120142], the same baseline-deviation idea used here. Health Connect stores deltas instead, so the two arrive as separate methods (§3.5). |
| 4 | `resting_heart_rate` (accepted, fed today); `heart_rate_window` min/max (accepted, half-read) plus new optional sedentary fields | Resting HR; heart-rate samples with their motion context | daily / hourly | Recovery (unchanged weight); Form's stress input (§4.3) | Resting HR above one's own baseline was the main pre-symptomatic signal in smartwatch illness studies [cited: Mishra 2020; Quer 2020]. |
| 5 | `walking_heart_rate_average` (new) | Walking HR average | daily, passive | Driver | Heart rate at a matched everyday effort, so it moves with fitness, fatigue and illness without needing a workout [inference; no primary source found for Apple's metric, UNCONFIRMED]. |
| 6 | `steps_window`, `active_energy_window` (accepted, unused) | Steps, active energy | hourly | Weight's physical load (§4.2) | Energy integrates intensity and duration; minutes do not. Wrist energy estimates carry large absolute error [cited: Shcherbina 2017], so only within-person change is used. |
| 7 | `spo2` (accepted, unused) | Blood oxygen (availability varies by model and region [documented: Apple support 120142]) | intermittent | Driver ("below usual" only described, never diagnosed) | Useful only as a deviation. Pulse oximetry has known bias with skin pigmentation [cited: Sjoding 2020]. No wrist-SpO2 accuracy source for Apple was found (UNCONFIRMED). |
| 8 | `heart_rate_recovery` (new) | Cardio recovery, one minute after a workout | per workout | Context; driver when a baseline exists | One-minute heart-rate recovery is an established autonomic marker in clinical exercise tests [cited: Cole 1999]. Transfer to Watch post-workout values is [inference]. |
| 9 | `vo2_max` (new) | Cardio fitness (outdoor walk, run or hike) | weekly-ish | Context only (slow trend) | Cardiorespiratory fitness strongly predicts long-term outcomes [cited: Kodama 2009], but the Watch estimate underestimated laboratory VO2 max by about 6 ml/kg/min in a 2025 validation [cited: Lambe 2025]. It is a trend for the model, never a daily score input. |
| 10 | `sleep_efficiency` (accepted, unused) | — | nightly | Context only | On Apple its denominator is the `in_bed` span, whose provenance is doubtful (rank 1). Awake time replaces it as the driver. |
| 11 | `mindful_duration` (new) | Mindful minutes | per session | Context only | It is the owner's own practice. The model can relate it to stress, but it carries no physiological measurement. |

Exercise minutes need no new signal: `movement_duration` already carries them (§1).

### 3.3 Not now [proposed]

| Type | Why not now |
|---|---|
| State of Mind (iOS 18, self-reported mood) | Self-reported mental state. It is Art. 9 data with a higher harm profile than physiology. It needs its own consent analysis before any persistence. |
| Walking steadiness | iPhone-measured gait, not Watch [cited: Apple walking-quality paper]. Weekly cadence, and low value for planning a day. |
| Stand time and stand hours | Adds little beyond steps and movement for day planning. Revisit with a sedentary-behaviour use case [cited: Bull 2020 gives no numeric sedentary threshold]. |
| Physical effort (METs), workout effort score | Promising for Weight. Wait for one release of energy-based load (§4.2) before adding a second intensity measure. |
| Beat-to-beat series, the 24-hour heart-rate stream | Stays on the phone: owner decision D1 of 10 October. |
| Cycle tracking, reproductive data | Out of scope. Wrist temperature arrives as a sleeping-temperature reading, never as a cycle or ovulation estimate. Waldo never derives one. |

### 3.4 Clinical-adjacent tier C: defer, design the seam [proposed]

**Types:**
- **Rhythm:**
  - AFib History burden;
  - ECG recordings and their classification;
  - irregular rhythm notifications;
  - high and low heart-rate notifications.
- **Sleep:**
  - sleep apnea notifications;
  - breathing disturbances.
- **Blood pressure and fitness:**
  - hypertension notifications;
  - low cardio-fitness notifications.

**Several are cleared medical-device functions** [cited]:
- **ECG app:** FDA De Novo DEN180044.
- **Irregular rhythm notification:** DEN180042. It is not meant for people already diagnosed with AF.
- **Sleep apnea notification:** 510(k) K240929.
- **Hypertension notification:** 510(k) K250507.
- **AFib History:** reported as 510(k)-cleared, but the K number was not found (UNCONFIRMED).

**Why this is a separate tier, and why the boundary is allowed to be deterministic:**
- **Regulatory exposure.** These are outputs of cleared devices with specified intended uses. If Waldo interpreted them into individual recommendations, that could itself become software with a medical purpose under EU MDR or FDA rules [inference; needs legal review, not asserted]. The stated launch scope is wellness and planning.
- **Consent specificity.** Art. 9 explicit consent is per purpose. "Store and compute my health data" in today's copy (§8) does not tell an owner that rhythm diagnoses are included [inference].
- **Harm asymmetry.** A wrong reassurance about an arrhythmia costs far more than a missed sleep insight.
- **CLAUDE.md fit.** CLAUDE.md lists "health vs clinical" as a *judgment call* that code must not make. That rule is about classifying conversation content. This tier is a fixed data-type consent boundary at ingest, of the same kind as owner checks and schema validation, which CLAUDE.md allows to be deterministic. What the model *says* about a tier-C event, if it is ever accepted, stays model judgment under prompt guidance.

**The seam, so it can be added later without breaking anything:**
- **Consent and contract.** A third consent purpose, `clinical_events`, with its own copy version. It is shown only to builds at a later health revision (4), the same mechanism as WHOOP's provider rows.
- **What is stored.** Event presence only: kind, time and the platform's own classification enum. Never an ECG waveform or voltage series.
- **Where it is used.** Tier-C data feeds no score and no driver, and never wakes the health trigger. It needs `clinical_events` plus `model_processing` to reach the model.
- **Before any build:** a short ADR, a legal read, and the owner's yes.

### 3.5 HealthKit and Health Connect equivalents

Each row is one wire signal, the same on both platforms, so Android follows one seam. The phone owns the mapping; the backend owns the refusal, as in `docs/app/HEALTH_CONNECT_MAPPING_2026-10-21.md`.
- **Apple column:** the `HKQuantityTypeIdentifier` or `HKCategoryTypeIdentifier` case with its first iOS version, from Apple's documentation [documented].
- **Health Connect column:** an `androidx.health.connect.client.records` class [documented]. Neither column has been tested on a device.

**W1 and existing signals:**

| Wire signal | HealthKit (iOS) | Health Connect | Notes |
|---|---|---|---|
| `sleep_duration` + v2 intervals and `stages` | `sleepAnalysis` (8.0). Values: `inBed`, `awake`, `asleepUnspecified`; and from 16.0 `asleepCore`, `asleepDeep`, `asleepREM` | `SleepSessionRecord.stages` | Apple `asleepCore` is AASM N2 including N1, so it maps to `light`. `asleepUnspecified` and HC `SLEEPING` are unspecified. HC `LIGHT`, `DEEP`, `REM` map directly. HC `AWAKE`, `AWAKE_IN_BED`, `OUT_OF_BED` map to `awake`; HC `UNKNOWN` is not sent. Apple `inBed` overlaps the stages. Stages never overlap each other on either platform, which is why §5 refuses overlapping stages. The Watch writes `awake` only between two sleep samples. |
| `overnight_hrv`, `hrv_window` | `heartRateVariabilitySDNN` (11.0) → `sdnn`; `heartRateVariabilityRMSSD` (27.0, documented as a bare declaration, so its semantics and whether the Watch writes it are UNCONFIRMED) → `rmssd` | `HeartRateVariabilityRmssdRecord` → `rmssd` | Health Connect has no SDNN record, so Android baselines are RMSSD from the start. |
| `resting_heart_rate` | `restingHeartRate` (11.0) → `provider_resting_daily` | `RestingHeartRateRecord` → `unknown` unless the source says | Apple may delete and replace the current and previous day's samples, so the phone must send the deletion and the new record. The existing anchored deletions carry this. |
| `heart_rate_window` + new optional `sedentary_mean`, `n_sedentary` | `heartRate` (8.0), using `HKMetadataKeyHeartRateMotionContext` (`sedentary` after 5 minutes still) | `HeartRateRecord` (no motion context, so no sedentary fields) | See §4.3. |
| `wrist_temperature` (new) | `appleSleepingWristTemperature` (16.0). One absolute, bias-corrected value per night, readable from night one, read-only. Series 8, Ultra or newer, with Sleep Focus on. → method `absolute` | `SkinTemperatureRecord` with `measurementLocation` `WRIST`. It stores deltas against an optional baseline. → method `baseline_delta` (the night's mean delta) | Per-method baselines, never blended, like HRV. Bounds, as unit-mistake catches only: `absolute` 25–42 °C; `baseline_delta` −5 to +5 °C. |
| `respiratory_rate` | `respiratoryRate` (8.0) | `RespiratoryRateRecord` | Point density is not measured (§10). |
| `spo2` | `oxygenSaturation` (8.0) | `OxygenSaturationRecord` | |
| `walking_heart_rate_average` (new) | `walkingHeartRateAverage` (11.0). Created only by the system; delete-and-replace like resting HR | none | No Android driver; a gap, not an error. |
| `vo2_max` (new) | `vo2Max` (11.0), ml/kg/min. Estimated after outdoor walks, runs or hikes; estimate range 14–60 | `Vo2MaxRecord`, with its measurement-method constant | Bounds 10–90. |
| `heart_rate_recovery` (new) | `heartRateRecoveryOneMinute` (16.0): the drop from peak exercise heart rate to one minute after, always positive | none | Unit `beats_per_minute`; bounds 0–120. |
| `movement_duration` (exists) | `appleExerciseTime` (9.3): full minutes at brisk-walk intensity or above | `ActivityIntensityRecord` (library 1.2.0-alpha06, feature-gated), else minutes inside `ExerciseSessionRecord` | Today's Health Connect note doesn't map this; the app lane adds it. |
| `steps_window` | `stepCount` | `StepsRecord` | |
| `active_energy_window` | `activeEnergyBurned` | `ActiveCaloriesBurnedRecord`, never `TotalCaloriesBurnedRecord`, which includes basal energy | |
| `daylight_duration` (exists) | `timeInDaylight` (17.0) | none listed | |
| `mindful_duration` (new) | `mindfulSession` (10.0): a category whose duration is its start and end | `MindfulnessSessionRecord` (feature-gated) | |
| `workout` (exists) | `HKWorkout` | `ExerciseSessionRecord` | |

**Tier C (deferred, §3.4) and the deferred wellness types (§3.3):**

| Type | HealthKit (iOS) | Health Connect |
|---|---|---|
| AFib burden | `atrialFibrillationBurden` (16.0). Percent, computed weekly by the iPhone after the owner enables AFib History; needs a physician's AFib diagnosis; read-only | none |
| ECG | `HKElectrocardiogram` (14.0). Classification enum: `sinusRhythm`, `atrialFibrillation`, `inconclusiveHighHeartRate`, `inconclusiveLowHeartRate`, `inconclusivePoorReading`, `inconclusiveOther`, `unrecognized`, `notSet`. The voltage series is a separate query that Waldo would never read. | none |
| Irregular rhythm, high and low heart-rate notifications | `irregularHeartRhythmEvent`, `highHeartRateEvent`, `lowHeartRateEvent` (12.2) | none |
| Low cardio fitness | `lowCardioFitnessEvent` (14.3) | none |
| Sleep apnea, breathing disturbances | `sleepApneaEvent`, `appleSleepingBreathingDisturbances` (18.0; unit and values UNCONFIRMED) | none |
| Hypertension notification | `hypertensionEvent` (26.2; values UNCONFIRMED) | none |
| State of Mind | `HKStateOfMind` (18.0): valence −1 to 1, labels, associations | none |
| Walking steadiness | `appleWalkingSteadiness` (15.0), iPhone-measured, about weekly | none |
| Stand time and stand hours; physical effort; workout effort | `appleStandTime` (13.0), `appleStandHour` (9.0); `physicalEffort` (17.0, METs); `workoutEffortScore`, `estimatedWorkoutEffortScore` (18.0) | none; none; none |
| Apple Sleep Score (watchOS 26) | Not found in HealthKit's type indexes or its updates page. This is an absence check, UNCONFIRMED against the iOS 27 headers. | — |

**Background delivery** [documented]:
- **iOS:** wakes the app at most once per chosen frequency. Some types are capped at hourly without notice (`stepCount` is the documented example), and Apple publishes no per-type table for iOS.
- **Health Connect:** background reads need `READ_HEALTH_DATA_IN_BACKGROUND`. Data older than 30 days before the first grant needs `READ_HEALTH_DATA_HISTORY`, which fits the 30-day backfill.

Delivery latency is the freshness lane's concern. This note only adds types to it.

## 4. Which signals feed which pillar

All new versions stay `candidate_unaccepted` until a review receipt exists. That matches every algorithm today (`scores/types.ts:64`).

### 4.1 `recovery.candidate.v2` [proposed]

Shares are unchanged: sleep 0.5, variability 0.3, pulse 0.2 (`recovery.ts:9`). Two input rules change, so the version changes.

1. **HRV: one method per night, with a fallback.**
   - v1 takes the night's single `overnight_hrv`, whatever its method, and drops HRV when that method's baseline is immature.
   - v2 takes RMSSD when the night has an RMSSD reading and the owner has a mature RMSSD baseline (at least 14 of the last 30 nights); otherwise SDNN with a mature SDNN baseline; otherwise no HRV component.
   - This needs the phone to send both methods for a night when both exist, as two samples with method-specific ids (app lane, §7.3).
   - Why: RMSSD and SDNN are different measures, so neither converts to the other. That is owner decision D3 of 10 October, grounded in the HRV standards [cited: Task Force 1996]. No source was found stating "short-term SDNN and RMSSD are not interchangeable" verbatim (UNCONFIRMED); the rule rests on D3 and on their different definitions. Day-to-day HRV is useful only against a stable personal baseline [cited: Plews 2013; Buchheit 2014], and a baseline that restarts for two weeks when iOS 27 adds RMSSD breaks that.
2. **Resting HR: baseline per method.**
   - A night's resting HR is compared only with earlier readings of the same `method`.
   - When two methods exist on one day, the one whose baseline is mature wins, in the order `overnight_resting`, `provider_resting_daily`, `resting_measurement`, `unknown`.
   - Why: a nightly minimum and a daytime resting estimate are different quantities [inference]. Mixing them adds a step change unrelated to physiology.

What v2 deliberately leaves out of the score: respiratory rate, wrist temperature, SpO2, awake time and stage proportions.
- These are illness and fragmentation **flags** with a low base rate and asymmetric meaning. Their rise matters; their fall mostly doesn't.
- Weighted linearly into a 0–100 score, a 2.5 SD temperature rise at a 0.1 share moves the score about 5 points, so it disappears.
- As drivers (§4.5) they are salient, and the model weighs them with the calendar and what the owner said.
- This also matches the earlier Recovery note in `docs/app/RECOVERY_WEIGHT_PROPOSAL.md` ("respiratory rate/temp/SpO2 only as flags, not weights").
- Folding any of them into the score later needs owner-labelled days showing it improves agreement with how the owner actually felt.

### 4.2 `weight.candidate.v4` [proposed]

Only the `physical_load` input changes. Its share is unchanged at 0.2 (`weight.ts:7`).

- **v3:** movement (exercise) minutes plus workout minutes not already counted (`producer.ts:139-149`).
- **v4:** the day's active energy (the sum of `active_energy_window` buckets in the local day), as a z-score against the owner's own baseline. It falls back to v3's minutes on a day with no energy reading.
- **Workout energy** is not added a second time. Apple's active energy already includes workout energy [inference; app lane to confirm the HealthKit sum].
- **Why energy over minutes:** minutes count a stroll and intervals the same, while energy reflects intensity times duration.
- **Why only within-person change:** wrist energy estimates have large absolute error [cited: Shcherbina 2017]. A per-owner z-score is insensitive to a stable per-device bias [inference].
- **Why not a TRIMP or acute:chronic ratio:** heart-rate impulse needs time in zones, which hourly means can't give. The acute:chronic ratio has no causal support for injury [cited: Impellizzeri 2020]. Banister's TRIMP citation was not verified (UNCONFIRMED).

### 4.3 Form: the next version after the freshness lane's [proposed]

The health-freshness session (`claude/distracted-pascal-afbce1`, no commits at this note's pin) owns Form's partial-day logic and will likely mint the next Form version. This note does not take a Form number. The candidate change for the version after it:

- **What changes:** the stress input today uses each awake, non-workout hour's mean heart rate (`form.ts:30-36`), and that mean includes walking about inside the hour.
- **Why:** smartwatch illness work computed resting heart rate only in step-free minutes for exactly this reason [cited: Mishra 2020].
- **On Apple, the platform already marks still moments.** Each heart-rate sample may carry a motion context, `sedentary` after five minutes still [documented: `HKMetadataKeyHeartRateMotionContext`]. The phone adds two optional fields to `heart_rate_window`: `sedentary_mean`, the mean of that hour's sedentary-context samples, and `n_sedentary`.
- **On a source without motion context** (Health Connect, older Watches), the hour's minimum is the fallback proxy [inference].
- **Read path:** the series read returns `min`, `max`, `n_samples` and the sedentary fields (§9).
- **How it is accepted:** compute the old and new stress input on owner data and compare their day-to-day stability before choosing. This is a hypothesis, not a settled choice.

### 4.4 Sleep debt [proposed]

`sleep-debt.candidate.v1` is unchanged. It gets persisted (§9, from #1127) and served:
- **On `/scores`:** at every revision. The app's pin already declares the field optional (app `health-ingest.ts:215`).
- **To the model:** through the prompt row. Debt is cumulative and invisible to the person carrying it: in a 14-day restriction study, deficits grew while participants rated themselves only slightly sleepy [cited: Van Dongen 2003].
- **Need:** stays the owner-confirmed value or their own 14-night average. Population guidance of at least 7 hours [cited: Watson 2015] is context for the model, never a coded default.

### 4.5 Drivers: descriptive deviations [proposed]

A **driver** says that one of the owner's signals is outside their usual range today, in which direction, and how far. It is computed only against the same source and the same method, with a mature baseline of at least 14 of the last 30 days, using the existing bounded `zScore`, or `logZScore` for HRV (`stats.ts:15-20`).

| Field | Values |
|---|---|
| subject | `sleep_duration`, `sleep_awake`, `overnight_hrv`, `resting_heart_rate`, `respiratory_rate`, `wrist_temperature`, `spo2`, `walking_heart_rate_average`, `physical_load`, `calendar_load` |
| direction | `above`, `below` |
| extent | `outside` when abs(z) ≥ 1; `far_outside` when abs(z) ≥ 2. These are candidate band constants, ratified together with the zone bands (decision D7 of 10 October). |

**Stored form.** One digit-free phrase per driver in the existing `drivers` array of the derived row. Examples: `"wrist temperature far above usual"`, `"resting heart rate above usual"`.
- A closed regex in `waldo.health_context_write` admits only phrases built from the table.
- At most 8 are stored, strongest first.
- The prompt reader already admits digit-free strings and shows the four strongest (`health-context.ts:64-86,150-153`), so drivers reach every turn **with no change to the composer**.
- The app gets a structured DTO parsed from the phrase by one shared function in the contract, so there is one stored representation and one pure projection.

**Why this is not a judgment rule.** A z-band is a fixed description of a statistic, like the zone bands Waldo already ships. Nothing decides that a deviation is illness, or that it matters today. Apple's Vitals feature uses the same idea: a personal typical range per overnight metric [documented: Apple support 120142]. Its notification rule (two or more metrics out of range) is a decision this proposal deliberately leaves to the model.

**Waking the trigger is a separate step.** The health trigger wakes on zone changes only (`trigger.ts:12-16`). Letting a new `far_outside` driver wake it needs `trigger.ts`, which this lane does not own. It is listed as PR P6 for its owner (§12). Until then, drivers reach the model on every turn and in every scheduled run that reads the health row.

### 4.6 Baseline speed: backfill, not a lower bar [proposed]

The fastest way to a mature baseline is the 30-day HealthKit backfill (owner decision D5 of 10 October). Most Watch owners have months of history, so a backfill makes Recovery available on the first sync.

Two things block that today:
- one bad sample fails a backfill batch (§6);
- the phone drops whole nights with more than 128 intervals (§5).

Lowering the 14-of-30 rule is not proposed. The relative standard error of a sample standard deviation is about 1/√(2(n−1)): about 0.20 at n = 14 and 0.29 at n = 7. So a 7-day baseline would mislabel ordinary days as unusual.

## 5. Sleep stages: representation [proposed]

**Wire (request side):**
- `sleep_context.reducer_version` gains the literal `asleep-interval-union.v2`.
- Under v2, `intervals[].kind` adds `awake`, and an `asleep` interval may carry `stage: 'light' | 'deep' | 'rem'`. No stage means unspecified.
- A v1 context may carry neither. Today's v1 data keeps its exact meaning: no silent widening.
- **Mapping.** Apple "core" becomes `light`; Apple's own description of core is light sleep, to be confirmed in §3.5. Health Connect `LIGHT`, `DEEP` and `REM` map directly, `SLEEPING` becomes unspecified, and `AWAKE`, `AWAKE_IN_BED` and `OUT_OF_BED` become `awake`.
- **Totals.** `sleep_duration` (method `asleep_duration`) gains an optional `stages` object `{ light, deep, rem, unspecified, awake }` in minutes. Within a minute, `light + deep + rem + unspecified` equals `value`.
- **Why this shape.** One sample per night keeps the stages atomic with the duration. A deleted session still needs exactly the three deletions the Health Connect mapping already sends, with no new ids or deletion rules.

**Reducer: one function, both sides.** `reduceSleepContextV2(context)` is a pure function in `health-ingest.ts`, a zod-only file the app pins verbatim. It returns the minutes per kind and stage:
- asleep is the union of asleep intervals, unchanged from v1;
- each stage is the union of its intervals;
- awake is the union of awake intervals minus asleep, clipped to the span from the first asleep start to the last asleep end.

Two differently staged intervals that overlap make the sample `invalid_sample`; no priority rule resolves them. A schema refine requires a v2 sample's `stages` to equal the reducer's output. The phone and the backend run the same code, so the totals can't drift.

**Read side:**
- `health_series_read` returns `payload->'stages'` for `sleep_duration`, stripped when absent.
- The producer exposes awake minutes as the `sleep_awake` driver.
- `get_health` exposes all stage minutes (§11).

**The 128-interval limit.** Stages can't be merged across kinds, so a staged night has more intervals. The phone currently drops a night above 128. The app lane measures real nights on a device. If any exceed 128, the bound is raised to 256. That is a request-side widening, safe for old builds. The 98,304-byte batch limit then fits about two such nights per batch [inference].

## 6. Per-sample rejection [proposed]

**Contract.** All additions are in `health-ingest.ts`:

```ts
export const HEALTH_INGEST_REVISION_V1 = 3;
export const healthChangeRejectionReasonV1Schema = z.enum(['invalid_sample', 'unsupported_signal', 'revision_conflict', 'not_consented']);
export const healthChangeRejectionV1Schema = z.strictObject({
  change: z.enum(['sample', 'deletion']),
  index: z.int().min(0).max(HEALTH_INGEST_MAX_CHANGES_V1 - 1),
  sample_id: sampleIdV1.nullable(),          // null when the change had no readable id
  reason: healthChangeRejectionReasonV1Schema,
});
// The receipt gains rejected: z.array(healthChangeRejectionV1Schema).max(128).optional().
// Present only for a request naming health=3 or later.
// healthIngestV1Schema stays strict and unchanged: the app validates its own batch with it.
// The server parses health=3 batches with an envelope whose samples and deletions are z.array(z.unknown()),
// then parses each change on its own.
```

**Semantics:**
- **Health revision 3 or later.**
  - Each change is checked on its own; valid changes commit; rejected ones are listed by position, id and a closed reason, never by value.
  - `revision_conflict` replaces today's batch-wide `sample_conflict` for a same-revision change with different content.
  - `not_consented` is the reason a tier-C signal will get before its purpose is granted.
  - The receipt is stored with the request, so a replay returns the same rejections.
  - The anchor advances as today. The app does not retry `invalid_sample`/`unsupported_signal`, re-reads and resends `revision_conflict` with a higher revision, and logs counts only.
- **Below health revision 3: unchanged.** The batch stays all-or-nothing, with `invalid_request` or `sample_conflict`. An installed build never sees a receipt it can't parse. It also never gets a partial commit that would let it advance its anchor past a dropped sample with no trace, which is silent data loss.
- **The payoff is forward compatibility.** A new app build can send a signal the deployed backend doesn't know yet, and lose only that signal (`unsupported_signal`) instead of the whole backfill. After this PR, app and backend releases for each new type no longer need to be ordered.

**SQL.**
- The Worker passes the mode as a server-set field `"rejection": "per_sample"` in the RPC payload. It is never client-supplied: the client envelope is a strict object.
- Valid-shape changes go to SQL in the payload. Changes rejected at the Worker stay in it too, recorded as their position and reason only, so SQL writes one complete receipt.
- `waldo.health_ingest` records a reason and `continue`s instead of raising when the mode is per-sample. The all-or-nothing path is kept byte for byte for the old mode.

## 7. Contract plan (app.v1, additive)

### 7.1 Revisions

| Health revision | Adds | Who sees it |
|---|---|---|
| 1 | today's device consent, ingest and scores | every build |
| 2 | WHOOP provider rows (exists) | builds sending `health=2` |
| 3 | per-sample rejection, W1 signals, stage fields, the `drivers` DTO on `/scores` | builds sending `health=3` |
| 4 (reserved) | the `clinical_events` purpose and tier-C signals, only if D4 changes | builds sending `health=4` |

### 7.2 App-lane announcement (before the contract PR merges)

Per the additive-only rule, each new value is announced to the app lane with the schema it lands in, and whether an installed build can receive it.

| New value | Schema | Direction | Reaches an old build? |
|---|---|---|---|
| `wrist_temperature`, `walking_heart_rate_average`, `vo2_max`, `heart_rate_recovery`, `mindful_duration` | `healthSampleV1Schema` (`signal`), `healthSignalV1Schema` (deletions) | request | No. Only new builds send them. |
| `celsius`, `ml_per_kg_min` units; `absolute`, `baseline_delta` temperature methods | `healthSampleV1Schema` | request | No |
| `sedentary_mean`, `n_sedentary` on `heart_rate_window` (both or neither; the mean between `min` and `max`) | `healthSampleV1Schema` | request | No |
| `asleep-interval-union.v2`; `awake` interval kind; `stage` field; `stages` object | `healthSleepContextV1Schema`, `sleep_duration` sample | request | No |
| `rejected` and the rejection reasons | `healthIngestReceiptV1Schema` | response | No, only at `health=3` |
| `drivers` (subject, direction, extent) | `healthScoresV1Schema` (row level) | response | No, only at `health=3` |
| `sleep_debt` on `/scores` | `healthScoresV1Schema` (exists, optional) | response | Yes. The app pin declares it (app `health-ingest.ts:215`). |
| No new `healthScoreUnavailableReasonV1Schema` value | — | — | — |

### 7.3 App-lane items (owned by the app, listed so the seam is clear)

1. Send stages and awake intervals under reducer v2, with `stages` totals computed by the pinned reducer. Measure intervals per real night.
2. Send both HRV methods for a night when both exist, with method-specific `sample_id`s (`…:overnight_hrv:rmssd`).
3. Read the W1 types and request their authorizations (iOS asks per type).
4. Send `health=3`, and handle the rejection reasons as §6 says.
5. Confirm where Apple `in_bed` samples come from, and whether HealthKit's active energy includes workout energy.
6. Send `sedentary_mean` and `n_sedentary` on Apple heart-rate windows, from the motion context.
7. Send the deletion and the replacement when Apple rewrites the current or previous day's resting or walking heart rate.

## 8. Consent and copy versions

### 8.1 W1 needs no copy bump, subject to one check [proposed]

- **Grants are per source and purpose, never per signal** (`20261021170000…sql`; `tools/live/health.ts:31-55`).
- **The in-app copy doesn't list types.** On app `main` `8e8c73e7`, "Store and compute my health data" reads "Waldo keeps the readings this phone sends and works out your scores from them". The model-use row reads "Waldo can use your health data when he writes to you" (app `HealthConsent.tsx:89-90`).
- **iOS asks per type,** so the owner still chooses each new type on the system sheet.
- **The privacy notice is the remaining check.** The draft (unpublished, per the owner's 19 October notes) should list the categories. Owner or legal confirms. If it lists categories, the W1 types are added to it. That changes the notice, not the in-app grant copy.

### 8.2 If a device copy bump is ever made (or for tier C) [proposed]

Installed builds parse `version: z.literal(2)` on the grant and on every stored consent row (app pin lines 36 and 50), so a bump has to be revision-gated.

**Contract.**
- `CONSENT_COPY_V1.apple` becomes `{ current: 4, had: [2, 4] }`.
- A grant from a build below the gate may still name 2. A build at or above the gate must name 4.

**SQL.** The grant function's hard-coded `'2'`/`'3'` becomes a per-source accepted set. This is a migration.

**Supersede.**
- A grant at a newer copy while an older-copy grant is live supersedes it: one new consent row and epoch +1, with no withdrawal and no purge.
- Without this, upgrading would mean withdraw-and-delete, because today a second live grant is `epoch_conflict`.

**Old builds.**
- When an owner's device-source row is at a version a build below the gate can't parse, `GET /consents` answers that build with the known error `unavailable`. The build shows its existing "could not be loaded" state.
- It never gets a misreported version, and never a hidden row that would trigger a doomed re-grant. It fails closed and honest.
- Its uploads keep working if it cached its epoch. If not, the owner updates the app.

**Data scope.** Readings that only the newer copy covers are rejected per sample with `not_consented` under an older-copy grant.

**Tier C** uses this mechanism with its own purpose and copy, at health revision 4.

## 9. Migration plan [proposed]

Both migrations use `create or replace` with unchanged signatures. Grants survive, and the security definer and `search_path` stay as they are. Each is registered in `scripts/verify-supabase-migrations.mjs` and `supabase/fixtures/assert-canonical-migration-history.sql`, and ships pgTAP tests in the same PR. Numbers are taken at the final rebase, above the newest on `beta-mvp` (today `20261021170000`). The owner applies them on staging, and only after the review.

**M1, signals and per-sample ingest:**
- `alter table waldo.health_samples drop constraint health_samples_signal_check`, then add it again with the new signal list. This is the same pattern `20261021150000` used for the source check (lines 159-160).
- `waldo.health_ingest`, rebuilt from its `20261021150000` body:
  - unit and bound rows for the new signals;
  - a method check for `wrist_temperature`;
  - the per-sample mode (§6);
  - the deletion allowlist.
- `waldo.health_series_read`, rebuilt from its `20261011020000` body:
  - `v_all` (line 128) and the 1–14 bound (line 145) become the new list;
  - it returns `stages` for `sleep_duration`, and `min`, `max`, `n_samples`, `sedentary_mean` and `n_sedentary` for `heart_rate_window`.
- No table is added. New readings live in `waldo.health_samples.payload`, under the existing 90-day retention and the existing withdrawal and account purge. Those delete whole sample rows by owner and source, so they cover new signals with no change (`20261011220000_health_retention_sweep.sql:9`).

**M2, the derived row:**
- `public.health_context_daily.sleep_debt jsonb null`, as #1127 adds it.
- `waldo.health_context_write`, rebuilt from the `20261021150000` body:
  - #1127's exact key sets for `sleep_debt`;
  - the closed driver-phrase regex (§4.5) on row-level and pillar-level `drivers`.

  The zone-change `changed` logic and the WHOOP basis stay as they are.
- `waldo.health_scores_read` returns `sleep_debt` and `drivers` when stored.
- #1127's 19 pgTAP tests are carried over, plus tests for driver phrases.

**What happens to #1127:**
- It is not merged. It is numbered `20261013090000`, which sorts before `20261021150000`.
- Its writer is the fence-era body (`20261011030000`). Applying it would drop the zone-change report and the WHOOP basis.
- M2 rebuilds its change on the current body and credits it. #1127 is then closed with a pointer.

**Order.** M1 and M2 apply before any Worker that sends their new keys. Against the current functions, a new key is refused, and a refused derived-row write stops all three scores from updating, as #1127 recorded. A Worker deployed before M1 degrades safely: SQL ignores the unknown mode field and stays all-or-nothing.

**Rollback.** Revert the Worker first. Both functions can be re-created from their previous bodies. The new column and the new constraint values are additive. Rows written with the new signals stay valid under the old functions, which never read them.

## 10. The series-read cap [proposed]

`health_series_read` returns at most 8,000 rows per source, newest first [verified]. Worst-case rows per source for the producer's 31-day read:

| Signal set | Per day | 31 days |
|---|---|---|
| Today: 4 hourly windowed signals (24 each) plus about 6 point readings | ~102 | ~3,160 |
| Plus steps and energy windows (24 each) | ~150 | ~4,650 |
| Plus `spo2` and `respiratory_rate`, sent as one point per platform sample (app `points.ts:42-45`) | unknown; dozens per night is plausible [inference] | could pass 8,000 |

**Proposed:**
1. The producer and `get_health` read `truncated`. On truncation the producer drops the oldest day in the read, which may be partial, and computes on the rest. `get_health` reports the truncation to the model, so it can narrow the range. Both log a value-free hop.
2. The producer reads in signal groups, each sized well under the cap: sleep, HRV and resting readings; hourly windows; nocturnal point signals.
3. The app lane measures real per-night counts for SpO2 and respiratory rate. If they are dense, the phone sends them as one summary per night keyed to the waking day, as an added `method` value. That reduction is the same kind the phone already does for `overnight_hrv`.

## 11. `get_health` [proposed]

`get_health` is the model's on-demand read. Its schema is a backend-internal tool contract (`contracts/src/tools/schemas/reads.ts`).

**Signals and units:**
- **New signals:**
  - **sleep:** `sleep_light`, `sleep_deep`, `sleep_rem`, `sleep_awake`, `sleep_efficiency`;
  - **body signals:** `respiratory_rate`, `spo2`, `wrist_temperature`;
  - **heart and fitness:** `walking_hr`, `hr_recovery`, `vo2_max`;
  - **activity:** `steps`, `active_energy`, `mindful`.
- **Per-call limit:** raised from 8 to the full enum. The output stays bounded at 31 days times the enum size, and the owner's ruling of 14 October is against limits that block the product.
- **New units:** `ratio`, `percent`, `breaths_per_minute`, `celsius`, `ml_per_kg_min`, `count`, `kcal`.
- **New methods:** the resting-HR methods and the temperature methods.

**Source and method choice:**
- The result's `source` is derived from `healthSourceV1Schema`, not a second hard-coded list.
- Source choice is the producer's ranked choice, through one shared function: the highest-ranked source that has the signal in the range.
- For HRV, resting HR and temperature, one method per signal, chosen by the same rule as Recovery v2.

**Freshness and truncation:**
- `heart_rate` keeps its daily mean of hourly means. Hourly minimums reach the model through Form, not this tool.
- `truncated` is reported (§10).

The tool-list snapshot and the hook argument registry (`hooks/registry.ts` `TOOL_ARG_SCHEMAS`) are updated in the same PR.

## 12. Phase 2 PR order

Each PR is small and red-first. Each uses synthetic fixtures only, valid and invalid Zod pairs for every schema change, and the full wall at its head.

| PR | Content | Gate | Touches |
|---|---|---|---|
| P1 | Contract, health revision 3: rejection DTOs and envelope, W1 signals, units and methods, the sedentary heart-rate fields, reducer v2 and its refine, the `stages` field, the driver DTO and phrase parser, the `drivers` key on scores | §7.2 announced to the app lane; orchestrator review | `contracts/src/app/health-ingest.ts` (+ test). Conflicts with #1159/#1161, which also edit this file. Whoever merges second rebases. |
| P2 | M1 and M2 | Owner applies on staging after review | `supabase/migrations/*`, pgTAP, migration registry |
| P3 | Worker: per-sample ingest at `health=3`, receipt shaping. Producer: `SIGNALS`, signal groups, `truncated`, `rowOf` (sleep debt, drivers). `recovery.candidate.v2`, `weight.candidate.v4`. `/scores` serves `sleep_debt` and `drivers`. | After P2 is applied | `channels/app-health.ts`, `health/producer.ts`, `health/scores/*` (not Form's partial-day logic) |
| P4 | `get_health`: signals, units, shared source and method choice, truncation | After P3 | `contracts/src/tools/schemas/reads.ts`, `tools/live/health.ts`, tool snapshots, hook registry |
| P5 | Form, the version after the freshness lane's: hourly-minimum stress input, compared against the mean | After the freshness lane merges | `scores/form.ts`, with that lane's agreement |
| P6 | Health trigger: drivers in the trigger's view, and the writer reports a driver set change in `changed` | Owner of `trigger.ts` | `health/trigger.ts`, a small writer migration |

## 13. Falsifiers: the first red tests

**P1, contract:**
- A health=3 envelope with one unknown signal parses, and that one change is reported `unsupported_signal`.
- The strict `healthIngestV1Schema` still refuses that batch.
- A v1 sleep context carrying `stage` or `awake` is refused.
- A v2 sample whose `stages` disagrees with its intervals is refused.
- Overlapping differently staged intervals are refused.
- A driver phrase outside the vocabulary, or containing a digit, is refused.
- Every phrase round-trips through the DTO parser.
- A `heart_rate_window` with `sedentary_mean` and no `n_sedentary`, or with a sedentary mean outside `min`–`max`, is refused.
- A `wrist_temperature` labelled `absolute` at 95 (a Fahrenheit value) is refused.

**P2, SQL:**
- Per-sample mode commits the valid changes and stores a receipt naming the rejected ones. A replay returns the same receipt.
- The old mode still fails the whole batch.
- A new signal at the wrong unit or out of bounds is rejected per sample.
- The series read returns `stages`, `min`, `max` and `n_samples`.
- A write with a driver phrase containing a digit is `invalid_request`, and the row is unchanged.
- A write without `sleep_debt` clears it.
- Withdrawing storage still deletes new-signal samples.

**P3, producer and scores:**
- A night with RMSSD but an immature RMSSD baseline uses mature SDNN (Recovery v2). Under v1 the same input loses HRV.
- Two resting-HR methods never share a baseline.
- A wrist-temperature reading 2.5 SD above baseline yields the driver "wrist temperature far above usual". The Recovery score is identical to the same day without it.
- A truncated read drops the oldest day and logs no value.
- Weight v4 uses energy when present and v3 minutes when not.
- A health=2 client never receives `rejected` or `drivers`.
- A health=1 client's `/scores` with `sleep_debt` parses against the app's pinned schema (copied into the test).

**P4, `get_health`:**
- Two sources, the lower-ranked one with more readings: `get_health` and the producer choose the same source.
- `truncated` reaches the result.

## 14. Not verified, and open questions

**Not observed:**
- No device or staging run supports any statement here about Watch cadence, interval counts, point density, or how much Health Connect covers.
- The staging database was not inspected.
- The health-freshness lane's eventual Form version is not known.

**Not found in a primary source (UNCONFIRMED):**
- SDNN and RMSSD being non-interchangeable, stated verbatim;
- Apple wrist SpO2 accuracy;
- Banister's TRIMP;
- the AFib History clearance number and white paper;
- an Apple white paper on wrist temperature;
- the walking heart-rate average source;
- sleep-stage agreement figures, in either Chinoy 2021 or Apple's sleep-stage paper;
- the semantics of `heartRateVariabilityRMSSD`, `appleSleepingBreathingDisturbances`, `sleepApneaEvent` and `hypertensionEvent`, which Apple's pages list as bare declarations;
- whether Apple's Sleep Score is exposed anywhere (absence check only).

**Open for the owner:** D1 to D8.

**Open for legal:** tier C (§3.4), and whether the privacy notice draft lists categories (§8.1).

## 15. Sources

**How these were checked.** Each bibliographic record was confirmed from a publisher, PubMed, PMC, FDA or Apple page on 22 October 2026. Findings are paraphrased from abstracts unless marked. A DOI appears only where it was seen. "Abstract" marks a source read only at abstract level.

**Heart-rate variability**
- **Task Force of the ESC and NASPE (1996).** Heart rate variability: standards of measurement, physiological interpretation and clinical use. *Circulation* 93(5):1043–1065. doi:10.1161/01.CIR.93.5.1043.
- **Plews DJ et al. (2013).** Training adaptation and heart rate variability in elite endurance athletes: opening the door to effective monitoring. *Sports Med* 43(9):773–781. doi:10.1007/s40279-013-0071-8.
- **Buchheit M (2014).** Monitoring training status with HR measures: do all roads lead to Rome? *Front Physiol* 5:73. doi:10.3389/fphys.2014.00073.
- **Shaffer F, Ginsberg JP (2017).** An overview of heart rate variability metrics and norms. *Front Public Health* 5:258. doi:10.3389/fpubh.2017.00258.

**Wearable illness signals**
- **Mishra T et al. (2020).** Pre-symptomatic detection of COVID-19 from smartwatch data. *Nat Biomed Eng*. doi:10.1038/s41551-020-00640-6.
- **Quer G et al. (2020, online).** Wearable sensor data and self-reported symptoms for COVID-19 detection. *Nat Med*. doi:10.1038/s41591-020-1123-x.
- **Radin JM et al. (2020).** Harnessing wearable device data to improve state-level real-time surveillance of influenza-like illness in the USA. *Lancet Digit Health* 2(2):e85–e93. doi:10.1016/S2589-7500(19)30222-5. Population-level surveillance, not individual detection.
- **Smarr BL et al. (2020).** Feasibility of continuous fever monitoring using wearable devices. *Sci Rep* 10:21640. doi:10.1038/s41598-020-78355-6. Oura finger temperature.
- **Mason AE et al. (2022).** Detection of COVID-19 using multimodal data from a wearable device: results from the first TemPredict Study. *Sci Rep* 12:3463. doi:10.1038/s41598-022-07314-0. Oura finger temperature.
- **Miller DJ et al. (2020).** Analyzing changes in respiratory rate to predict the risk of COVID-19 infection. *PLOS ONE*. doi:10.1371/journal.pone.0243693. WHOOP data; several authors are affiliated with WHOOP.

**Measurement accuracy**
- **Sjoding MW et al. (2020).** Racial bias in pulse oximetry measurement. *N Engl J Med* 383(25):2477–2478 (letter).
- **Shcherbina A et al. (2017).** Accuracy in wrist-worn, sensor-based measurements of heart rate and energy expenditure in a diverse cohort. *J Pers Med* 7(2):3. PMID 28538708. Abstract.
- **Lambe R et al. (2025).** Investigating the accuracy of Apple Watch VO2 max measurements: a validation study. *PLOS ONE* 20(5):e0323741. doi:10.1371/journal.pone.0323741. Read in full.

**Sleep**
- **Van Dongen HPA et al. (2003).** The cumulative cost of additional wakefulness. *Sleep* 26(2):117–126. PMID 12683469.
- **Watson NF et al. (2015).** Recommended amount of sleep for a healthy adult: a joint consensus statement of the AASM and SRS. *J Clin Sleep Med* 11(6):591–592.
- **de Zambotti M et al. (2019).** Wearable sleep technology in clinical and research settings. *Med Sci Sports Exerc* 51(7):1538–1557. doi:10.1249/MSS.0000000000001947.
- **Chinoy ED et al. (2021).** Performance of seven consumer sleep-tracking devices compared with polysomnography. *Sleep* (online December 2020). Agreement figures were not read in the source.
- **Apple.** Estimating sleep stages from Apple Watch (September 2023; October 2025 revision). Agreement figures were not read.

**Fitness and activity**
- **Kodama S et al. (2009).** Cardiorespiratory fitness as a quantitative predictor of all-cause mortality and cardiovascular events. *JAMA* 301:2024–2035. doi:10.1001/jama.2009.681.
- **Apple.** Using Apple Watch to estimate cardio fitness with VO2 max (white paper; date not observed).
- **Cole CR et al. (1999).** Heart-rate recovery immediately after exercise as a predictor of mortality. *N Engl J Med* 341(18):1351–1357. doi:10.1056/NEJM199910283411804.
- **Bull FC et al. (2020).** World Health Organization 2020 guidelines on physical activity and sedentary behaviour. *Br J Sports Med* 54(24):1451–1462. doi:10.1136/bjsports-2020-102955.
- **Impellizzeri FM et al. (2020).** Acute:chronic workload ratio: conceptual issues and fundamental pitfalls. *Int J Sports Physiol Perform* 15:907–913. doi:10.1123/ijspp.2019-0864.
- **Apple.** Measuring walking quality through iPhone mobility metrics (May 2022 version). iPhone-measured.

**Clinical-adjacent Apple features**
- **FDA De Novo DEN180044** (ECG app) and **DEN180042** (irregular rhythm notification), both granted 11 September 2018.
- **FDA 510(k) K240929** (sleep apnea notification, 13 September 2024) and **K250507** (hypertension notification, 11 September 2025).
- **Perez MV et al. (2019).** Large-scale assessment of a smartwatch to identify atrial fibrillation. *N Engl J Med* 381(20):1909–1917. doi:10.1056/NEJMoa1901183.

**Platform documentation** (developer.apple.com/documentation/healthkit; developer.android.com/reference/kotlin/androidx/health/connect/client/records)
- `HKCategoryValueSleepAnalysis`, `appleSleepingWristTemperature`, `HKMetadataKeyHeartRateMotionContext`, `restingHeartRate`, `walkingHeartRateAverage`, `vo2Max`, `heartRateRecoveryOneMinute`, `appleExerciseTime`, `atrialFibrillationBurden`, `HKElectrocardiogram`.
- `HKHealthStore.enableBackgroundDelivery(for:frequency:withCompletion:)`.
- `SleepSessionRecord`, `SkinTemperatureRecord`, `HeartRateVariabilityRmssdRecord`, `Vo2MaxRecord`, `MindfulnessSessionRecord`, `ActivityIntensityRecord`, `HealthPermission`.
- **Apple Support:** 120142 (overnight vitals), 120357 (retrospective ovulation estimates), 108375 (AFib History).
- **App Store Review Guideline 5.1.3:** HealthKit data only for health management or research, never advertising or data mining.
