# Passive load: a busy day on foot counts (addendum to B20)

**Date:** 2 November 2026 · **Issue:** waldoco/waldo-backend#1820 · **Status:** design only. Nothing here runs before the gate reviews it and the owner says yes.

**Read at:**
- backend `beta-mvp` `561d7171`, and #1822 (`docs/proposals/HEALTH_BODY_PARITY_CONTRACT_2026-11-02.md`) at `1267e3b8`;
- the S4+S5 lane's committed contract at `251a848a` (revision 10, `day-load.candidate.v1`);
- waldo-app `main` `5ce83e92` (`src/health/summaries/workout.ts`, `src/health/normalize/windows.ts`);
- waldo-brain #60 at `f5d27415` (ADR-0081 amendment draft, §5).

**Companion:** a paragraph for the ADR-0081 amendment draft, §5a, in Pin4sf/waldo-brain.

## 0. Summary

S4's Load counts logged workouts only. A day of 20,000 steps with no workout scores 0, the same as a day at a desk. WHOOP and Bevel count every minute the heart is raised. The owner invited a design change for that on 2 November.

The proposal, `day-load.candidate.v2`:
- **One zone load over every observed minute of the day.** Workout minutes and the rest of the day are bucketed on the same bounds, then added up. The parts say how much came from each.
- **The phone sends a per-hour heart-rate histogram**, not minutes in zones. The server owns the zone bounds and can re-bucket any day when they move.
- **The bounds come from the owner's own data.** They are a share of the owner's observed maximum, and zone 1 never starts below the heart rate the owner usually sits at.
- **A thin hour is unknown, never light.** A day with too few observed hours falls back to v1 and is compared only with v1 days.

It needs one new reading, one health revision, one migration and the switch `HEALTH_PASSIVE_LOAD` (default `"0"`).

## 1. The phone input: a per-hour histogram

### Why not minutes in zones

The task asked for per-hour minutes in each zone, with the bounds taken from the server's usual maximum and resting heart rate. Two ways meet that. The histogram is better on every row:

| | Phone buckets into zones | Phone sends a histogram, server buckets |
|---|---|---|
| Who owns the bounds | The server, but the phone must fetch them before every upload | The server alone |
| When the usual maximum moves | Past hours stay on the old bounds; a 28-day band mixes bounds | Every day in the span is re-bucketed on today's bounds |
| Before the first bounds exist | Nothing can be uploaded, so the band cannot warm up | History is uploaded at once, and scored when bounds exist |
| Contract | A bounds version on every window, plus a staleness rule | Fixed bins, no version |
| Where computation lives | The phone does part of the load maths | The phone counts seconds; the server does all the maths (ADR-0081 §1) |

The cost is that a histogram is finer than today's min, mean and max. It is still an hour's summary with no order inside the hour, and the beat stream stays on the phone (§6).

### The reading: `heart_rate_bins_window`

A new window signal, one fixed local-hour bucket, like `heart_rate_window`:

```text
{ sample_id: 'heart_rate_bins_window:<source>:<hour start epoch>',
  signal: 'heart_rate_bins_window', unit: 'seconds',
  start_at, end_at, day, utc_offset_minutes, revision,   // as every window
  from_bpm,            // integer, a multiple of 5, 30 to 225: the lower edge of the first bin
  bin_bpm: 5,          // literal
  outside_workouts,    // seconds per bin, 1 to 40 bins, each 0 to 3600
  in_workouts }        // same length as outside_workouts
```

The contract checks that the two arrays have the same length and that their total fits the hour, with a minute's slack. Bins above 225 bpm fold into the last bin.

### How the phone fills it

- **One timeline.** All heart-rate samples in the hour, from every device the read returns, are sorted into one timeline.
  - A sample with its own span (a HealthKit series) counts over that span.
  - A point holds until the next sample, at most **10 minutes**, clipped to the hour.
  - So no second is counted twice, even when a watch and a strap both write heart rate.
- **A gap longer than 10 minutes counts nowhere.** It is uncovered time, not low time.
- **The workout split.** Time inside any workout the platform holds goes to `in_workouts`. This is an `HKWorkout` or a Health Connect exercise session, whichever app wrote it. All other time goes to `outside_workouts`.
- **Sources.** One sample per hour per source, as `heart_rate_window` does today. On the Samsung path the read is limited to Samsung Health's writer, as for windows.
- **History.** The phone sends bins for the same history it already reads for heart-rate windows. On the first build at the new revision, that includes the backfill.
- **Why the hold is 10 minutes.**
  - Apple says the time between background readings varies with activity ([support.apple.com/120277](https://support.apple.com/en-AU/120277)). One third-party measurement found 5 to 15 minutes on older watches.
  - Samsung's setting is "every 10 minutes while still" ([samsung.com](https://www.samsung.com/hk_en/support/apps-services/how-samsung-health-monitors-your-heart-rate/)).
  - Reports say the newest Apple models sample every 5 seconds all day. That is not confirmed by Apple, and not checked on a device.
  - A 30-second hold, the workout rule, would leave most of an older watch's day uncovered. Holding longer than 10 minutes would invent minutes.

## 2. Zone bounds: the owner's own

### The basis is a share of the owner's maximum

Edwards' zones start at 50, 60, 70, 80 and 90 % of the maximum heart rate. This is Edwards' own basis, and the phone already buckets workouts on it (`ZONE_BOUNDS_PCT`, from 60 % for zone 2).

Heart-rate reserve (Karvonen) fails the job this design is for. Take an owner resting at 60 with a maximum of 190:

| Basis | Zone 1 starts at | A brisk walk at 105 bpm |
|---|---|---|
| % of maximum | 95 bpm | counts, weight 1 |
| % of reserve | 125 bpm | counts for nothing |

So the % of maximum basis lets a busy day on foot count. Reserve would need resting heart rate, which the Samsung path does not write.

### The usual maximum

- **A day's peak** is the higher of:
  - the highest hourly window maximum that day;
  - the highest `max_hr_bpm` of that day's workouts.
  
  Both come from the day's chosen source (`chooseFor`). A peak counts only from 100 to 230 bpm.
- **The usual maximum** is the third-highest day peak in the producer's 30-day window. It needs at least 14 days with a peak. Taking the third highest lets two days of sensor spikes pass without setting the maximum.
- **It is always approximate.** It is observed, never measured. No age or birth date exists in the app or the backend, so there is no population maximum to fall back on, and none is used. With fewer than 14 days, passive is unavailable (`no_zone_basis`).

### Zone 1 never starts below the owner's sitting heart rate

An owner who rarely exerts has an observed maximum well under their true one. Take a sedentary owner whose highest days peak at 130:
- 50 % of 130 is 65.
- They sit at 72.
- Every waking minute would count as zone 1: about 900 load a day. A desk day would score near the top.

So zone 1 starts at the higher of:
- 50 % of the usual maximum;
- the high edge of the owner's usual **resting-hour** heart rate.

The resting-hour usual is:
- the mean heart rate of hours that are awake, outside a workout and with fewer than 10 movement minutes, over the 30-day window;
- this is the resting-hour rule of energy windows and the stress curve (`energy-windows.ts:16`);
- the high edge is centre + 1 SD (the drivers' statistic), needing 14 such days.

Time below the start of zone 1 weighs 0.

This is a statistic of the owner's own data, not a population threshold. Neither input needs the resting heart rate signal, so **the Samsung path, which writes no resting heart rate, runs the same rule as every other source.**

If zone 1's start reaches zone 2's (60 % of the maximum), the observed maximum cannot separate the owner's sitting from their effort. Passive is then unavailable (`zone_basis_low`). It returns once a harder day lifts the maximum.

### From bins to zones

- A bin that a bound splits is shared linearly: the seconds times the share of its 5 bpm above the bound.
- The bounds are recomputed on each producer run. Every day in the 28-day span is bucketed on today's bounds, so today and its band are on one basis.
- A stored past row keeps the score it was written with, as the usual band does.

## 3. Sparse days: a watch off the wrist

- **An hour is observed for passive** when `outside_workouts` and `in_workouts` together cover at least 30 minutes. Below that, the hour is null. It is never a low hour, and nothing fills it in.
- **A day has passive** when at least 12 of its hours are observed. Twelve allows for a watch charged overnight and off for a shower. The served part carries `observed_hours`.
- **A day without passive** is scored by v1 (§4) and says why.

## 4. Server compute: `day-load.candidate.v2`

- **Load.** For each observed hour of the chosen source, both arrays are bucketed on the day's bounds. The day's load is the Edwards sum: zone × minutes, with zone 0 weighing 0.
  - `parts.workouts` is the load from `in_workouts`.
  - `parts.passive` is the load from `outside_workouts`.
- **No double counting.**
  - **Workouts the phone holds:** their seconds are only ever in `in_workouts`, so each second counts once.
  - **A counted session the phone does not hold**, such as a provider workout from a strap with no watch on:
    - If any of its hours are observed, its heart rate is already in `outside_workouts`. It counts once, under passive in the parts.
    - If none of its hours are observed, its own zone load (v1's `loadOf`, in zones) is added under workouts.
  - **The total is right either way. Only the split between parts can lean to passive.**
- **One method.** v2 is zones only, so the method rule holds: nothing is mixed.
- **Fallback.** If the day has no passive (no bins, `sparse`, `no_zone_basis` or `zone_basis_low`), it is scored by v1 under v1's own method rules, and it serves `parts.passive` as unavailable with the reason.
- **Like for like.**
  - A v2 day's band is built from the v2 days among the 28 before.
  - A v1 day's band is built from v1 scores of the observed days. v1 can be computed for every observed day.
  - So a day with the watch off is never read as "below usual" just because its passive is missing.
- **Scale.**
  - v2 keeps S4's log-shaped score, with its own pinned constant set by golden vectors, on the scale the owner picks in Q4.
  - With passive, almost every observed day carries some load. S4's log1p with a constant of 600 already puts a load of 20 at 48 out of 100, which squeezes ordinary days into the top half.
  - The v2 constant and shape are pinned against anchor vectors (§7) before the switch turns on. This is the one constant the gate should look at hardest.
- **Re-warm-up.**
  - Passive's band needs 14 v2 days.
  - The phone uploads history (§1), and bins are stored before the switch turns on (§8, Q3). So the band can be personal on the first run that has 14 days of bins, not 14 days after the flip.
  - Without history, it shows the provisional band with `days_until_personal`, as S4 does.
  - v1 rows already stored are not touched.
- **Not changed:**
  - Weight's `physical_load` part (that would be `weight.v6`);
  - the 28-day training-load phrase, which stays workouts only.

## 5. Contract: health revision R-e

**Ingest.**
- `heart_rate_bins_window` is accepted from R-e.
- A backend below R-e rejects that reading alone (per-sample refusal, revision 3), so an older backend loses nothing else.
- This is why it is a new signal and not a key on `heart_rate_window`: a strict window carrying an unknown key would be refused whole, and the hour's heart rate lost with it.

**Response.** On `/scores`, from R-e, an available `day_load` gains:

```text
version: 'day-load.candidate.v1' | 'day-load.candidate.v2',
parts: {
  workouts: { share },                                   // share of the day's load, 0 to 1
  passive: { state: 'available', share, observed_hours }
         | { state: 'unavailable', reason: 'no_bins' | 'sparse' | 'no_zone_basis' | 'zone_basis_low' },
}
```

- **Shares, not loads.** The score is log-shaped, so points would not add up. Shares are unit-free and do add up to 1.
- **Method and label.** A v2 day's method is `hr_zones_observed_peak`, and `approximate` is true, because the maximum is observed. This keeps revision 10's rule that `approximate` is the observed-peak method.
- **Below R-e.** `parts` is stripped. A v2 day's `day_load` is left out entirely, because revision 10 pins the version to v1 and its parts would not add up. A v1 day is served as today. The strict pins keep parsing, and a test proves it. The app pins R-e with the passive build.
- **The zone bounds are not served.** Showing "zone 1 starts at 98 bpm" on Body would be a new derived row in the ADR, and a later ask.
- **For the S4 lane.** The committed revision-10 schema has no `parts` key. If S4 adds `parts: { workouts, passive: null }` at revision 10, a non-null passive still needs R-e under `strictObject`. So the recommendation is that S4 ships no `passive` key, and R-e adds `parts` whole.

## 6. Storage, retention and destinations

- **Bins are raw readings.**
  - They are stored in the `waldo.health_samples` payload, with its 90-day retention, its withdrawal purge and its account deletion.
  - No table is added.
  - Migration M-f adds the signal to `health_samples_signal_check` and re-creates `waldo.health_ingest` with the new bounds. `health_series_read` gains the signal too.
- **The producer reads bins in their own call.**
  - It calls `health_series_read` with `signals: ['heart_rate_bins_window']`, so 24 rows per day per source never eat into the main read's 8,000-row cap.
  - The 31-day window covers the 28-day span.
- **Derived values.**
  - v2's score, band and parts live in S4's `day_load` column. M-f re-creates its write fence for the v2 shape.
  - The usual maximum, the resting-hour edge and the bounds are computed in the producer's volatile run only. They are never stored or served, so they need no new derived row.
- **Never in** model context, DO SQLite, R2, memory, the journal, the outbox, logs, metric labels or traces. The model's view of load stays whatever S4 gives it.
- **Consent.**
  - Consent copy 2 names "intraday window summaries" (`HEALTH_PLANE_AMENDMENT.md`, continuous ingest addendum). An hour's histogram is such a summary: coarser than the stream, with no order inside the hour.
  - Recommended: no copy bump (Q4).
  - The ADR paragraph names the new reading explicitly, so it is a recorded decision rather than a reading of the copy.

## 7. Tests before the switch

These come on top of #1822 §4's list:
- **Golden vectors, on synthetic values:**
  - a desk day;
  - a busy day on foot with no workout (non-zero, the reason for this design);
  - a run day;
  - a run day where the phone's workout and a provider copy are both counted (each second once);
  - a provider-only session with observed hours, and with unobserved hours;
  - an overnight charge (12 observed hours: available; 11: `sparse`, scored by v1);
  - a low observed maximum (`zone_basis_low`);
  - fewer than 14 peak days (`no_zone_basis`);
  - a bin split by a bound;
  - a Samsung source with no resting heart rate.
- **Anchor vectors for the scale constant.** These are ordering properties, not targets:
  - desk day < busy day on foot;
  - an hour in zone 3 > an hour in zone 1;
  - the score is monotone in load.
- **Like for like:** a property test that a v1 day's direction is never computed against a v2 band, or the reverse.
- **Switch off:** with `HEALTH_PASSIVE_LOAD="0"`, the rows are byte-identical to S4's.
- **Strip and pins:**
  - at every revision below R-e, the response carries no `parts` and the v1 version;
  - the app's strict pins parse.
- **Ingest:**
  - valid and invalid pairs for the new reading: unequal array lengths, over an hour, a bad `from_bpm`;
  - per-sample refusal on an older backend.
- **App:**
  - hold and gap rules;
  - the workout split;
  - two overlapping devices counting each second once;
  - the current hour growing by revision.

## 8. Switch, numbers and order

- **`HEALTH_PASSIVE_LOAD`**, default `"0"` in both var blocks, classified in the staging profile.
- **Off,** the producer writes v1 exactly. Ingest stores bins from R-e whatever the switch, so the band warms before the flip (Q3).
- **Asked of the gate, none taken:**
  - health revision R-e: 12 if S6 ships at 11 first, or reordered if passive lands before S6;
  - migration M-f;
  - whether the brain paragraph goes on #60's branch or a follow-up PR.
- **Depends on** S4 (the `day_load` column, fence and band).
- **App (waldoco/waldo-app):** the bins builder beside `heartRateWindows`, iOS and Android, sent from R-e.

## 9. Owner decisions

1. **Histogram from the phone, not minutes in zones.**
   - Recommend the histogram (§1): the server owns the bounds and can re-bucket.
   - This would flip if the owner reads an hour's histogram as too fine to leave the phone.
2. **% of maximum with a sitting-heart-rate floor, not heart-rate reserve.**
   - Recommend % of maximum: it is what lets walking count (§2).
   - This would flip if testers see desk days scoring as load on real data. The floor is meant to prevent that, and a falsifier below checks it.
3. **Store bins before the switch turns on.**
   - Recommend yes: they are raw readings under consent copy 2 and 90-day retention, and storing them warms the band.
   - The alternative is to refuse the reading until the switch is on, which costs a 14-day warm-up after the flip.
4. **No consent copy bump.**
   - Recommend none (§6).
   - This would flip if the owner wants the copy to say "time at each heart rate, by hour".

## 10. What would change this design

| Claim | Falsified by | Then |
|---|---|---|
| A 10-minute hold covers a worn hour | On a real older Apple Watch, fewer than half of worn waking hours reach 30 covered minutes | Raise the hold to the measured cadence, or lower the observed-hour bar, with new vectors |
| The floor keeps desk days light | On real owners, a desk day scores inside the band of days with a workout | Raise the floor to the resting-hour centre + 2 SD, or fall back to reserve for that owner |
| The third-highest peak is a stable maximum | The usual maximum moves more than 10 bpm week to week on one owner | Lengthen to 90 days through S3's read |
| Bins fit the read | The bins call for one owner exceeds the read cap | Read two half-windows |
| Each second counts once | A golden vector with a phone workout and its provider copy shows any second twice | Block v2 |

## 11. Not verified

- None of this ran. It is source reading at the SHAs above.
- Apple's and Samsung's background cadence on the owner's own devices; this decides the hold.
- That HealthKit and Health Connect return non-workout heart rate at the density the hold assumes [inference from the vendor pages cited].
- The bins call's actual row count per owner.
- How S4's lane types `parts`; asked of the lane through the gate.
