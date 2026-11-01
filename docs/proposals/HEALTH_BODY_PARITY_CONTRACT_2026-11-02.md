# Body parity: personal usual, part scores, signal reads, day load and curves (B14–B23)

**Date:** 2 November 2026 · **Issue:** waldoco/waldo-backend#1820 · **Status:** design only. No runtime code, migration or contract change is in this PR.

**Read at:**
- backend `beta-mvp` `37c647cde`;
- waldo-app PR #218 head `566f4853` (`Docs/design/BODY_READINGS_2026-11-01.md`, `Docs/design/TIER_SCREENS_PLAN_2026-10-23.md` §8);
- waldo-brain `main` `c5b708c` (ADR-0081);
- waldo-landing `main`, `content/legal/privacy.md`.

**Companion:** a draft ADR-0081 amendment in Pin4sf/waldo-brain for the new derived values. Nothing here runs before the owner and the gate accept it.

## 0. Summary

The app (PR #218) now draws the phone's own readings. What makes Bevel read as a coach is every number set against the owner's own usual, with scores for the parts. Under ADR-0081 those belong to the backend.

**Most of the maths already exists. What is missing is storing it and serving it:**
- The part scores are computed and then dropped.
- The baseline estimator already produces a centre and a spread for every component; neither is stored.
- The Form curve and the stress trend are built in an open draft (#1660).

**What is genuinely new:**
- an hourly stress curve;
- a per-day load score;
- a 90-day per-signal read;
- model-written reads.

**Slices, ranked by user value per unit of effort.** Each sits behind its own flag, default `"0"`. §4 has the detail and the allocation asks.

| Rank | Slice | Asks | Value | Effort | ADR row needed |
|---|---|---|---|---|---|
| 1 | **S1 Parts**: part scores, part direction, sleep need, per-part calibration, Form's rows | B16, B17 (need), B22, B23 | High: a number on every Tier 2 row, and the parts add up | Medium: the maths exists; the fence, read and revision are new | No. These are base §3 "canonical component scores" |
| 2 | **S2 Usual**: the personal usual band per signal | B14 | High: the band on every chart and card | Medium | Yes, one new row |
| 3 | **S3 Signals**: a per-signal series for 90 days, plus today's hours | B15, B17 (stages) | High: charts past the phone's 30 days, and Android parity | Medium: a new signed read and a new route | No. Base §3 "health-detail contract" |
| 4 | **S4 Day load**: a per-day load score with the owner's usual band | B20 | High for the athlete tester | Medium | Yes: a candidate algorithm and a row |
| 5 | **S5 Curves**: the measured Form curve (#1660) and a new hourly stress curve on Body | B18, B19 | Medium | Medium: rebase #1660, plus one new producer | Yes: a destination extension and a candidate |
| 6 | **S6 Waldo's read**: one model-written read per pillar per day | B21 | High | High: a new generation path, LLM cost, and a privacy path | Yes: a clarification of the narrative row |
| — | Deferred: a sleep composite score; a 60-day window (HI-7) | B17 (score), B14 (60 d) | | | |

The owner's decisions are in §5.

## 1. Where the app's picture is out of date

These change the ask before any design. They were checked in source at `37c647cde`.

- **The baseline window is 30 days, not 14.**
  - The provisional engine reads a 30-day window, and a component becomes `personal` at 14 own days (`packages/runtime/src/health/scores/stats.ts:1-2`, `packages/runtime/src/health/producer.ts:56`).
  - The owner set it on 27 Oct: "30 days ok" (ADR-0081, 2026-10-27 amendment §1).
  - So owner question 1 is really 30 days against Bevel's 60.
- **The Form definition is settled (B23).**
  - `form.v9` is the accepted canonical version (ADR-0081, 2026-10-27 amendment §3). Staging runs it: `HEALTH_PROVISIONAL_SCORES=1`, `recovery.ts:17`.
  - Production, with the flag at `"0"`, still runs `form.candidate.v8` (`recovery.ts:14`).
  - `form.safte-fast.v1` survives only as the device-fallback name.
  - `form.candidate.v4` in the app's docs is stale.
- **Confidence is already served.**
  - Each pillar's `confidence` is `round3(coverage × source confidence)` (`producer.ts:353-357`), served at every revision (`packages/contracts/src/app/health-ingest.ts:408`).
  - It is not null.
- **Score history exists.** `GET /app/v1/health/scores/history?days=7|30|90` is served from health revision 4 (`health-ingest.ts:457-480`, `packages/runtime/src/channels/app-health-history.ts:19-23`). B3 is done.
- **Retention is already 90 days raw and 24 months derived.** That holds in code and in the published privacy notice. Only ADR-0081's base §3 table still says 35 and 90; see Q2.
- **Weight has two live parts.** Tasks and messages are always null (`producer.ts:494`). Weight is the calendar plus physical load (`weight.ts:7-10`, `:17-20`), so the owner's "Stack" and "Load" rows are the whole of it.

## 2. Rules every slice keeps

- **Where it is computed.** By the single producer (`produceHealthScores`, `producer.ts:465`), as a pure function over the signed series read.
  - The producer runs inside the owner's Durable Object isolate, in volatile memory, through `healthRecompute` (`packages/runtime/src/health/recompute.ts:37`, `packages/runtime/src/channels/owner-do.ts:4943`).
  - Nothing it computes is put in DO SQLite, memory, R2, the journal, the outbox, logs, metrics or traces. Logs carry value-free tags only.
- **Where it is stored.** Only on the derived row `public.health_context_daily`, written only through the signed `waldo.health_context_write` (the one writer).
  - The write fence admits a closed set of keys and shapes (`supabase/migrations/20261031170000_health_training_load.sql:32`, `:57`, `:80-90`).
  - So every new key needs a fence migration. That migration is registered in `scripts/verify-supabase-migrations.mjs` and `supabase/fixtures/assert-canonical-migration-history.sql`.
- **Retention.** The derived row's: 733 days (`supabase/migrations/20261101040000_health_medications.sql:179`, `:186`), with deletion on withdrawal and on account deletion. No slice adds a store or a retention period.
- **Revisions.**
  - The app pins the health contract with `z.strictObject`, so any new key on any `/app/v1/health/*` response needs a new health revision and is stripped below it. This applies to `/scores/history` too.
  - The existing pattern is the revision gate on `drivers` and `windows` (`app-health.ts:166`).
  - Revisions are cumulative and 7 is taken (#1812), so they are allocated in ship order (§4).
- **One estimator per signal.** A band and a driver phrase about the same signal must never disagree. §3, B14 fixes which statistic backs each signal.
- **Method and source isolation.** A value is compared only with its own method's days (RMSSD with RMSSD, SDNN with SDNN, absolute temperature with absolute), and only from the source the producer chose for that day (`chooseFor`, `producer.ts:488`).
- **Missing is never zero.** An unobserved day or hour is `null` with a reason, never a low value. Withdrawn or missing health gives `unavailable`, never invented readiness.
- **No judgment in code** (CLAUDE.md, constraint 1).
  - Code describes a statistic: a score, a band, the direction against usual. That is what the drivers already do (`drivers.ts:4-7`).
  - Whether it matters, what to do, and how hard to train are the model's.
  - No population threshold, colour verdict or "%" on a score is added (#1820, "Not asked").

## 3. Per ask

### B14: the personal usual per reading

**What exists:**
- **The components' estimator.** `estimate()` gives every score component a `centre`, a predictive `spread`, `own` days and `ownShare` (`packages/runtime/src/health/scores/baseline.ts:33-58`).
  - It is a conjugate normal model with a population prior where one exists: RMSSD on the ln scale, and resting heart rate.
  - Otherwise it uses own days only, from 7 days (`baseline.ts:30-31`).
  - `standing()` turns a value into `z` (`baseline.ts:67-71`); the circular form handles the sleep midpoint (`:74-83`).
  - None of it leaves the function.
- **The drivers' statistic is different.** Drivers use the plain mean and population SD over at least 14 own days, with no prior (`drivers.ts:28-33`, `stats.ts:15-18`). They fire at |z| ≥ 1 ("outside usual") and |z| ≥ 2 ("far") (`drivers.ts:11-12`).

**Proposed shape.** `usual[]` on today's row, served with `/scores` and per signal on `/signals` (S3):

```text
usual: [{
  signal,                      // closed list: the score components and driver subjects below
  method | null,               // rmssd | sdnn | overnight_resting | … | absolute | baseline_delta
  state: 'personal' | 'provisional',
  low, centre, high,           // in the signal's unit; ln-scale signals are back-transformed, so the band is asymmetric
  own_days, own_share,         // own_share: the share of the centre that is the owner's own data (0 to 1)
  window_days: 30,
  estimator: 'shrunk_predictive' | 'own_mean_sd',
}]
```

**One estimator per signal, so the band and the phrase agree:**
- **Score components** (overnight HRV, resting heart rate, sleep midpoint, daylight, movement, stress heart rate): `shrunk_predictive`, which is `centre ± 1 predictive spread`.
  - ±1 spread is z = ±1, the point where the component's own direction (B16) turns.
  - While a prior carries part of the centre, `own_share < 1` and `state: 'provisional'`.
- **Driver subjects and display-only signals** (breathing rate, SpO₂, wrist temperature, awake time, walking heart rate, steps, active energy, VO₂ max):
  - `own_mean_sd`, which is `mean ± 1 SD` over at least 14 own days. This is exactly the drivers' statistic, so the band's edges are where "above usual" starts.
  - Below 14 days there is no band.
  - Deep sleep, REM sleep and heart-rate recovery join when their driver subjects are built (2026-10-31 amendment §3, accepted, not built).

**Presentation rule, for the app lane:**
- Show the band as "your usual" only at `state: 'personal'`.
- At `provisional`, say the usual is still being learned and show `own_days` of 14.
- A band shaped by the prior is never shown as the owner's own; this is the reason the baseline label exists.

**Computed:** in the same producer run that writes the day's scores ("recomputed with the day's scores", as asked), over the same 30-day read, from the same chosen source.

**Stored:** as a `usual` key on today's derived row, nothing else. A past day's row keeps the band that was current on that day, so a chart can draw the band as it was.

**Reuses:**
- `estimate`, `standing` and `circularStanding`, unchanged;
- the drivers' `deviation`, with its z-cut exported rather than copied.

**Open:**
- Q1: the 30-day or 60-day window.
- Whether a signal outside both lists gets a band in v1. Proposed: no.

### B15: per-signal daily series

**What exists:**
- **The signed series read** `waldo.health_series_read` (`supabase/migrations/20261031120000_health_coach_signals.sql:175`).
  - It refuses spans over 31 days (`:196`) and caps at 8,000 rows per source (`:182`).
  - It returns a window's `value` (the mean) but not its `min` and `max`, which the contract stores (`health-ingest.ts:259`).
- **The model's reader** `get_health` reads it turn-only (`packages/runtime/src/tools/live/health.ts:11-13`).
- **No app route** serves per-signal values.
- **ADR-0081 base §3** already names "dedicated health-detail/export contracts" as the only surface for raw and normalised values. This is that contract.

**Proposed shape.** `GET /app/v1/health/signals?signal=<one>&days=7|30|90`:

```text
{ state: 'available', signal, unit, days: [{ day, value | null, method | null, source, used_in: ['recovery' | 'form' | 'weight' | 'drivers'] }],
  hours?: [{ at, value, min, max }],   // today only, for hourly signals (heart rate, HRV windows, steps, energy, daylight, movement)
  usual?: <B14 entry for this signal, today's> }
| { state: 'unavailable', reason }
```

**Value as used:**
- Each day's value is the producer's own reduction: the night's asleep minutes, the newest overnight HRV of each method, the night-span mean for the vitals, and so on (`producer.ts:174-235`).
- The reducers are exported, so the route and the producer share them; nothing is re-derived.
- The day's source is the one `chooseFor` picks.

**Computed and stored:**
- Nothing is stored.
- A new signed read, `waldo.health_signal_read`, takes one signal over at most 92 days. Only nightly or daily signals get the full span; hourly signals get today's hours.
  - 90 nights of a nightly signal is about 90 rows.
  - 90 days of an hourly signal would be about 2,160 rows. That is why hourly signals give today only, and their days come from the daily reduction.
- The route reduces in the DO isolate and answers. Nothing is held.
- It requires `storage_compute` consent only, as `/scores` does: showing the owner their own readings in the app is not model processing.
- It spends the same per-owner health budget as every `/app/v1/health/*` route.

**Retention:** the 90-day raw retention bounds the 90-day chart. Older needs HI-7 aggregates (deferred).

**Open:**
- Whether `days=90` is wanted now, or 30 first. Proposed: all three, since retention allows them.

### B16: per-part scores and direction

**What exists:**
- **Every pillar builds `Component[]`** with a name, score and weight:
  - Recovery's are at `recovery.ts:117-141`;
  - Form scales Recovery's by 0.4 (`form.ts:81-82`) and adds its own (`:95-118`);
  - Weight's are at `weight.ts:28-56`.
- **`combine()`** turns them into the score and coverage, and the parts are dropped (`stats.ts:37-43`, `index.ts:49`).
- The z each part stood at is inside `standing()` and is also dropped.

**Proposed shape.** Per available pillar, at a new revision:

```text
components: [{
  key,                          // recovery: sleep | hrv | resting_heart_rate
                                // form: from_the_night | sleep_midpoint | daylight | movement | stress
                                // weight: calendar | physical_load
  state: 'available', score 0-100, share 0-1, points,    // shares renormalised over the available parts; Σ points = the pillar score before rounding
  direction: 'above_usual' | 'usual' | 'below_usual' | null,   // the reading against usual at z ±1; null for sleep (judged against need, not usual)
  signals: [...], baseline: { state, own_days, own_share }      // B22
} | { key, state: 'unavailable', reason: 'no_reading' | 'baseline_immature' }]
```

- **Direction is about the reading, not good or bad.** A heavier Weight part is not worse, and resting heart rate "below usual" is not better. The app's copy owns the words.
- **Form's night share is one part.** Form's `recovery.*` parts become one row, `from_the_night`: its score is Recovery's basis combined, with a share of 0.4. Form's rows are then "From the night", Circadian (midpoint and daylight), Motion and Stress, and they add up. This answers B23's presentation half, Q6.
- **Drag (B2).** Not served. Which part matters is the model's to say; the app may order rows by `points` lost, which is plain arithmetic on served numbers (Q3).

**Computed:** in the same producer run. `Component` carries its `z` and `own` outward. No formula changes, so no version changes: rows are byte-identical in score, which a golden test proves.

**Stored:** a `components` key per pillar on the derived row. The pillar fence widens.

**History:** `/scores/history` at the same revision gains per-day part scores, for the app's Components toggle.

**ADR:** none new. Base §3's "canonical component scores" row already allows numeric part scores on the authenticated health UI, with the derived row's retention, and nowhere else. The amendment states this so the gate can check it.

**Model context:** unchanged in S1. Feeding the direction words (a non-numeric class) to the model is a later, separate choice.

### B17: sleep as a scored part

**What exists:**
- **The Recovery sleep part** is `clamp(asleep ÷ need × 100)` at a share of 0.5 (`recovery.ts:117`).
- **The need** is the owner's stated need when there is one (`waldo.health_owner_settings`, behind `HEALTH_COACHING`). Otherwise it is the owner's own nights shrunk toward 8 h (`baseline.ts:85-92`).
- **The need is computed on every row, then dropped.** `sleepDebtOf` keeps `need_basis` but not `sleep_need_minutes` (`producer.ts:322-327`).
- **Stage minutes** are stored on each `sleep_duration` reading (`producer.ts:66`, `:87-90`).
- **Sleep efficiency** is ingested and feeds model context only.

**Proposed:**
- **S1:** the `sleep` part of B16, carrying `need_minutes` and `need_basis`. This is "Sleep needed 7 h 44 m". The need is a derived value of the owner's own nights or their statement, already within the component-score class.
- **S3:** asleep minutes, the four stage minutes as used, and efficiency, as `/signals` series. These are raw values on the health-detail contract, not on `/scores`.
- **No stage targets.** A deep or REM target is a population threshold, which is ruled out. Stages are read against the owner's own usual (B14) once their driver subjects are built.
- **"Tonight's sleep needed"** is the same `need_minutes`. A need that grows with load (the WHOOP style) is a new derived value, deferred (HI-12).
- **A sleep score** of its own (time asleep, deep, REM, heart-rate dip, efficiency, continuity) is a new composite and a new candidate version. Deferred, Q7.

### B18: stress through the day

**What exists:**
- **Form's stress part** is one figure for the day: the mean heart rate over awake, non-workout hours, and that day's HRV of one method, against the same hours on earlier days (`form.ts:20-25`, `:42-51`, `:104-118`).
- **Draft #1660** stores a `stress_trend` word (`rising | steady | easing`) from that part at the last three hour ends. It is accepted in the ADR (2026-10-27 later, §3) for the calendar day view only. The draft has been conflicting since 28 Oct.

**Proposed:** `stress-curve.candidate.v1`, hourly for today.
- **Hours:** each settled local hour that is awake, outside a workout, and with fewer than 10 movement minutes. The resting-hour rule of energy windows is reused (`energy-windows.ts:16`, `:55-69`).
- **Heart-rate part:** `z_hr` is the hour's mean heart rate against the same wall-clock hour on the owner's earlier days in the window, needing at least 7 such days (energy windows' `MIN_DAYS_PER_HOUR`, `:20`).
- **HRV part:** when the hour has HRV with 7 same-method, same-hour days, `z_hrv` on the ln scale. Apple's hourly HRV is sparse, so expect most hours to be heart rate only. Methods are never mixed.
- **Value:** `clamp(50 + 20·z_hr)`, averaged with `clamp(50 − 20·z_hrv)` when present. It is 0–100 and higher means more strain. It is the same 50 ± 20z map every part uses (`stats.ts:32-35`), so 50 is the owner's usual hour.
- **High, Medium and Low** are served as `z ≥ 1`, `|z| < 1` and `z ≤ −1`: the same edges as the drivers. They are not population bands.
- **Missing hours:** a sleep, workout, moving, unread or immature hour is `null` with no value.
- **Shape:** `stress_curve: { version, hours: [{ at, value | null, band | null }] }` with at most 24 points. It is on today's row and served on `/scores` for today at S5's revision.

**Naming, open.** A raised heart rate at rest is not psychological stress. The app's copy should say "strain on your body at rest" or keep Form's word "stress" with an explainer. That is a copy call for the app lane, not a backend one.

### B19: energy as a served curve

**What exists:**
- **`energy-windows.v1`:** up to four peak and dip windows a day, served at revision 4 (`energy-windows.ts:86-132`, `health-ingest.ts:439`).
- **Form through the day:**
  - The measured curve (`form-curve.v1`) is accepted in the ADR and built in #1660: today's Form re-run at each quarter hour, with no interpolation and no new method.
  - The ADR's remainder-of-day projection is not built.

**Proposed:**
- Body's energy line is the measured Form curve, with the energy windows drawn on it.
- Waldo does not build an energy bank. Bevel's carry-over bank is an unvalidated composite, and the owner has ruled no app-side composite. Inventing a server-side one would need a new algorithm with no evidence base. That is the named reason asked for.
- The ADR's remainder-of-day projection stays off Body. The issue rules out next-day projections, and a remainder-of-day projection is close enough to ask (Q9).
- **ADR:** extend `form_curve`'s destination from the calendar day view to `/app/v1/health/scores` for today, at S5's revision. The measured points only.
- **Reuses:** #1660 as written, rebased. Its migration timestamp `20261028100000` predates applied migrations, so it needs a new one.

### B20: load as a day score

**What exists:**
- **`training-load.candidate.v1`:** a 28-day phrase (acute 7 against the 21 before), behind `HEALTH_TRAINING_LOAD` (`training-load.ts:6`, `:51-63`). It is not on the app response; the 2026-10-31 amendment §6 defers that.
  - **Method isolation:** zones, then effort, then minutes (`:31-39`).
  - **Edwards zone TRIMP:** Σ zone index × minutes (`:36-39`).
  - **Session deduplication:** `sessionsOf`, `producer.ts:381`.
  - **Observed-day rule:** `WORN_SIGNALS`, `producer.ts:371`.
  - **The approximate label** for zones set from an observed peak (`hr_zones_observed_peak`, revision 6).
- **Weight's `physical_load` part** is the day's active energy against usual (`weight.ts:17-20`).

**Proposed:** `day-load.candidate.v1`.
- **Load:** a day's load is the Edwards TRIMP of its deduplicated workouts, in the window's method.
- **Rest days:** an observed day with no workout is 0.
- **Unobserved days:** `null`.
- **Score:** served as a score on the scale the owner picks (Q4), with the owner's usual band of day load (B14's `own_mean_sd` over observed days among the last 28), the method, and `approximate: true` when zones came from an observed peak.
- **Passive load is not in v1.** The phone sends hourly min, mean and max, not seconds in zones, so passive time in zones cannot be faithfully computed. Hourly means would understate and smear it. It needs a per-hour zone summary from the phone: a new input and a new revision.
- **No target formula.** The gate ruled on 31 Oct that how hard to train is the model's call ("no computed target number", coaching plan B). The owner's usual band stands in for Bevel's target band, and the model says in words whether today has room. Q5 asks whether the owner wants a formula band instead.
- **Stored:** a `day_load` key on the derived row, numeric, with a new matrix row. **Shown:** `/scores` at S4's revision, and as the Load row's reading on Weight's detail.
- **Weight's formula is unchanged.** Replacing Weight's physical-load part with day load would be `weight.v6` and a separate decision.

### B21: a written read per score and part

**What exists:**
- **Base §3 "Sanitized health narrative" row:** a purpose-built projection, generated by the model from allowed context, with the parent row's retention.
- **The model's allowed context** for a run is non-numeric: zones, the baseline label in words, drivers, debt in words, windows (2026-10-27 §5).
- **`get_health`** gives a turn the owner's own numbers, turn-only.
- **The beta diagnostic records** strip health numbers before keeping text (privacy notice §3).

**The problem.** A read that quotes values ("your resting HR, 58 bpm, is below its usual 62.8") would put numbers in a model turn: provider egress, the DO run journal and traces. §3 rules that out for anything stored.

**Proposed, in two parts:**
1. **Fact lines, now, with no backend work.** With S1–S3 the app renders "Resting HR 58 bpm · your usual 59–66" from a served value and a served band. That is display, not computation. It covers the per-part lines.
2. **Waldo's read, S6.** One read per pillar per day, written by the model as a digit-free template with closed slot tokens:
   - for example, "Your resting heart rate is {resting_heart_rate.value}, under your usual {resting_heart_rate.usual}. An easier morning would fit."
   - The context is the non-numeric class only: zones, part directions, drivers, debt words, windows.
   - **The fence:** the template is checked deterministically before storage. It must contain no digit, and every slot must come from a closed list. This is a hard egress boundary of the kind CLAUDE.md allows, not a judgment rule.
   - **Storage:** the template is stored on the derived row (narrative class).
   - **Serving:** `/scores` fills the slots from the same row at serve time, so no number crosses the DO, the journal, a trace or the provider.
   - **When it runs:** once per day per pillar, when the zone or a part's direction changes, at most a few times a day. It runs as a job with no message and no card.
   - **Cost and timing are open:** Q8.

### B22: confidence and calibration as numbers

**What exists:**
- the pillar's `confidence` (§1);
- `baseline: { state, personal_days, needed: 14, prior }` per pillar (`health-ingest.ts:380-386`, `baseline.ts:95-98`).

**Proposed:**
- Per part, `baseline: { state, own_days, own_share }` in S1 (B16).
- `own_share` is the estimator's own figure (`baseline.ts:39`): how much of the usual is the owner's data rather than the prior. It is the honest calibration number.
- "Days left" is `needed − own_days`, plain arithmetic on served counts (Q3).
- No new "% confidence" score is invented. If the app shows the pillar's `confidence` as a percent, that is a copy decision; the issue rules out "%" only on scores.

### B23: Form's definition

**Settled** (§1): `form.v9`, accepted on 27 Oct. Form's rows add up once S1 serves `from_the_night` (Q6). No backend design is left.

## 4. Slices, flags, revisions and migrations

Every slice includes:
- red tests first;
- golden vectors on synthetic values;
- strip tests at every earlier revision (and on `/scores/history`), with strict pins still parsing;
- a test that no new value reaches the model context, a log, DO storage or a trace;
- the flag classified in `packages/runtime/evals/nightly/staging-profile.ts`;
- the full `verify` record at the exact SHA.

A slice with the flag at `"0"` writes and serves byte-identical rows to today, and a test proves it.

| Slice | Flag (proposed name, default `"0"` in both var blocks) | Health revision (asked of the gate) | Migration (asked of the gate) | Depends on |
|---|---|---|---|---|
| S1 Parts | `HEALTH_SCORE_PARTS` | R-a (next free after 7) | M-a: the fence admits pillar `components` and `sleep_debt.need_minutes`; `health_scores_read` and `health_scores_history` return them | — |
| S2 Usual | `HEALTH_USUAL` | R-a (shipped with S1) | M-a (same migration) | the amendment §3 row |
| S3 Signals | `HEALTH_SIGNALS_READ` | R-b (the route exists only from R-b, like `/scores/history` at 4) | M-b: the new `waldo.health_signal_read` | S2, for the `usual` key |
| S4 Day load | `HEALTH_DAY_LOAD` | R-c | M-c: `day_load` column and fence | Q4, Q5; amendment §5 |
| S5 Curves | `HEALTH_FORM_CURVE` (already named by ADR and #1660) plus `HEALTH_STRESS_CURVE` | R-c (shipped with S4) | M-d: #1660 re-timestamped, plus `stress_curve` | #1660 rebased; amendment §6 |
| S6 Reads | `HEALTH_WRITTEN_READS` | R-d | M-e: `reads` column and fence | Q8; amendment §7; S1, S2 |

**PRs.** The owner wants fewer, bigger PRs. Proposed:
- one PR for S1 and S2;
- one for S3;
- one for S4 and S5;
- one for S6.

The app lane pins each revision after its PR deploys.

**Asked of the gate, none taken here:**
- **Four health revisions**, R-a to R-d, after 7, in ship order.
- **Five migration timestamps**, M-a to M-e.
- **The flag names** above.

## 5. Owner decisions

1. **Baseline window: 30 days (today) or Bevel's 60.**
   - Recommend keeping 30.
   - Sixty cannot be a constant change: the read is capped at 8,000 rows, so it needs HI-7 daily aggregates (or a split read) and a new set of score versions (`docs/proposals/HEALTH_BASELINE_HISTORY_2026-10-28.md`).
   - Would flip if the owner prefers a steadier band over one that follows a change of routine within a month.
2. **Raw retention: the contract's 90 days or ADR-0081 base §3's 35.**
   - Recommend ratifying the values in force: readings 90 days and daily summaries and scores 24 months. These are in the 2026-10-25 amendment §1, the code (`20261101040000…sql:182`, `:179`) and the published privacy notice (§3 and the retention table).
   - The amendment restates base §3's rows so the ADR stops contradicting itself.
   - The app's charts then show readings up to 90 days and scores up to 90 days (history could later go to 24 months).
3. **The app's plain "mean of the days shown".**
   - Recommend allowing it. It is arithmetic on readings the phone itself holds (or on served numbers), with no verdict, never uploaded, and not a score, band or direction, so ADR-0081 §1 and §4 do not reach it. The same goes for `needed − own_days` and ordering parts by points.
   - **Condition:** once S2 serves the usual band, the mean line must not look or read like a second "usual".
   - Would flip if the owner reads "no app-side computation" as no arithmetic at all; then S3 serves the window's mean too.
4. **Load scale: 0–21 or 0–100.**
   - Recommend 0–100, log-shaped over the day's TRIMP with one pinned scale constant, the same on every account. Every other ring on Body is 0–100.
   - 0–21 invites a number-for-number comparison with WHOOP that Waldo's maths will not match.
   - The scale constant is a unit, not a judgment threshold.
   - Either way the maths is the same and only the multiplier differs, so a change later is cheap.
   - Would flip if the athlete tester's WHOOP habit matters more than consistency on Body.
5. **Target load band.**
   - Recommend keeping the gate's 31 Oct ruling: no target formula. The owner's own usual band of day load, plus the model's words on whether today has room.
   - Would flip if testers ask for a number to aim at; then a candidate formula band from recent Recovery is its own amendment.
6. **Form's rows.**
   - Recommend confirming that `form.v9` closes B23.
   - Show Form as "From the night" (Recovery's basis, 40%), Circadian, Motion and Stress, so the parts add up to the score.
7. **A sleep score of its own.**
   - Recommend not yet. Recovery's sleep part (asleep against need) is the sleep number now, with stages shown against the owner's usual once the driver subjects are built.
   - A sleep composite (deep, REM, efficiency, continuity, heart-rate dip) is a later candidate with its own vectors.
   - Would flip if the owner treats a sleep ring as a launch must.
8. **Waldo's written read.**
   - Recommend fact lines from S1–S3 now, and S6 after: one model-written template per pillar per day.
   - In S6, numbers fill in at serve time and never pass the model, the DO or a trace.
   - It adds up to three model calls per owner per day.
9. **Curves on Body.**
   - Recommend the measured Form curve as the energy line (#1660), energy windows on it, and the new hourly stress curve.
   - No energy bank, and no remainder-of-day projection on Body.

## 6. What would change this design

| Claim | Falsified by | Then |
|---|---|---|
| Adding `components` changes no score | A golden test shows any pillar score, zone or coverage moving with S1 on | Block S1; the extraction is wrong |
| A band and a driver never disagree | A property test finds a value inside its band with a driver phrase, or outside it with none | Fix the estimator choice for that signal before S2 ships |
| Hourly stress has enough history | On real owners, fewer than half of awake hours reach 7 same-hour days by day 14 | Serve the curve only from day 14, or widen to two-hour buckets as v2 |
| A 90-day nightly read stays small | `health_signal_read` for one nightly signal exceeds 200 rows (duplicate writers) | Reduce by day in SQL |
| The slot fence keeps numbers out | A template with a digit or an unknown slot is stored | Block S6 |

## 7. Not verified

- Nothing here ran. All of it is source reading at the SHAs above.
- That Form's `from_the_night` equals Recovery's score on the same day [inference]: Form re-runs the Recovery basis on its own hours (`form.ts:65-66`). A test must prove equality, or the row must say why it differs.
- How sparse Apple's hourly HRV is on the owner's real data; this decides how often the stress curve is heart-rate only.
- The app's draw cost for 24 hourly points against 96 Form points; that is the app lane's to check.
