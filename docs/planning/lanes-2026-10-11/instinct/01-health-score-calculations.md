# Brief 01: health score calculations as a pure module

**Branch:** `instinct/health-score-calculations`. A draft PR to `beta-mvp`.

## Why

The app promises Recovery, Sleep debt, Form and Weight scores. Staging has zero computed rows, because no producer exists.

The owner's Claude lane (L1) builds the producer plumbing:
- the per-day read function and its migration;
- the trigger that runs after each ingest commit;
- the consent-epoch snapshot;
- the write through `waldo.health_context_write`.

You build the **math** that the producer calls. It is pure: no I/O, no clock reads, no logging.

## Read first

- `packages/contracts/src/app/health-ingest.ts`: the H1 contract.
  - Signals: `healthSignalV1Schema` (~line 140) and the sample union (~121).
  - Sleep context: ~76.
  - Score zones: ~172-174.
  - **Unavailable reasons: `healthScoreUnavailableReasonV1Schema` (~175).** Use only these.
  - Scores shape: ~193-203.
- `supabase/migrations/20261011000000_health_plane.sql`: the stored daily row (pillars, `algorithm_version`, `activation`, `hrv_method`, basis).
- `packages/contracts/src/health/zone-bridge.ts`: stored zone words (`low|moderate|good|high|unknown`) and how they map to the app's zone words.
- `packages/contracts/src/health/crs.ts`: an existing score engine. Do not duplicate it. If Recovery should reuse part of it, say so in the PR.
- The reviewed candidate formulas live in unmerged PR #998:
  - `git fetch origin pull/998/head:pr998`
  - then `git show pr998:packages/runtime/src/health/calculations.ts`.
  - Port the formulas. Do **not** port its vocabulary (`context_ref`, old metric names), its producer, or its I/O.
- **Zone bands:** use the exact candidate bands the app lane posted on waldoco/waldo-backend issue #116 (comment id 6101070400). Copy the numbers with a citation; do not reconstruct them.
  - Until the owner's formula review ratifies them, every available pillar carries `activation: 'candidate_unaccepted'`.

## What to build

A new folder, `packages/runtime/src/health/scores/`, with a small interface:

```
computeDailyScores(input) -> output
```

**Input** is a typed, already-validated per-day series for one owner:
- hourly buckets per H1 signal;
- the waking-day sleep record;
- the IANA time zone;
- the target day;
- the trailing days needed for baselines.

Define the input type in your module from the H1 types. Do not change H1.

**Output, for each pillar** (recovery, sleep_debt, form, weight), one of:
- **available:**
  - `{ score 0–100 integer, zone, algorithm_version, activation:'candidate_unaccepted', coverage }`;
  - `hrv_method` where HRV is used: RMSSD is canonical; SDNN is allowed only as a labelled fallback;
  - plus `used`: the signals and days the result was computed from, so the producer can write the basis.
- **unavailable:** `{ reason }`, with `reason` from the pinned enum.

Build order: Recovery first, then sleep debt, Form, Weight.
- **Recovery:** sleep, HRV and resting state against a 14-day personal baseline (z-scores, as in #998).
- **Sleep debt:** 14 weighted nights, aware of coverage.
- **Form:** circadian, motion, and an HR/HRV stress component.
  - The owner approved a consented, non-diagnostic stress component with workout attribution.
  - High heart rate during a recorded workout is not stress.
- **Weight:** the day's demand.
  - Take demand inputs (meeting minutes, message volume, open tasks, physical load) as an explicit input type.
  - L1 wires the collectors. You define the shape and the math.

## Behaviour that must hold

- **Sparse or missing data gives `{ reason }`, never an invented number.**
  - Revoked or absent health data is also an unavailable reason.
  - There is no "default 50".
- **Deterministic.** Same input, same output. No `Date.now`, no randomness.
- **Day boundaries follow the given time zone,** including DST changes and travel days (the time zone can differ across the trailing window).
- **No NaN or Infinity, ever.** Scores are clamped integers.
- **Pure means pure:** no fetch, no storage, no console output.

## Tests (red first)

- **Unit:**
  - each pillar on a normal synthetic week;
  - each unavailable reason;
  - the SDNN fallback label;
  - a workout excluded from stress.
- **Properties** (use the repo's existing property-test setup; check `package.json` `verify:property`):
  - output is always schema-valid;
  - fewer days never raises coverage;
  - with everything else fixed, better sleep never lowers Recovery;
  - no NaN or Infinity.
- **Time:** a DST spring-forward day, a fall-back day, and a time-zone change inside the baseline window.
- **Fixtures** are synthetic and generated in the test. No real readings.

## Must not change

- H1, the health plane SQL, the prompt reader `channels/health-context.ts`, and every hot file listed in `00-README.md`.

## Done means

- A draft PR with the module and tests.
- The gate table at the head SHA.
- A short note per pillar: the formula source (a #998 line reference), what you changed, and open formula questions for the owner's review.
