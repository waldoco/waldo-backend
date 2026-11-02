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
  value,               // covered seconds, 0 to 3600: the sum of both arrays (ingest requires a numeric value)
  from_bpm,            // integer, a multiple of 5, 30 to 225: the lower edge of the first bin
  bin_bpm: 5,          // literal
  outside_workouts,    // seconds per bin, 1 to 40 bins, each 0 to 3600
  in_workouts }        // same length as outside_workouts
```

The contract checks three things:
- the two arrays have the same length;
- `value` equals their total;
- the total fits the hour, with a minute's slack. Bins above 225 bpm fold into the last bin.

### How the phone fills it

- **Each device's own timeline.** For each device (the sample's source bundle and device), every sample covers an interval:
  - A sample with its own span (a HealthKit series) covers that span.
  - A point covers from its time until that device's next sample, at most **10 minutes**.
  - Every interval is clipped to the hour's bucket.
- **Then one union, with precedence.** Two devices can write the same seconds, for example a watch and a chest-strap app. So in each hour:
  - The **primary** device is the one whose intervals cover the most seconds. A tie goes to the lower device id, then to the earlier first sample, then to the lower bundle id. The bundle id cannot settle a tie alone: Health Connect names writers by package, and Samsung Health writes for every Galaxy device under one package.
  - Its intervals count in full.
  - Another device's intervals count only for seconds no device before it in that order has covered.
  - Within one device, overlapping spans are cut the same way: the earlier-starting span keeps its seconds.
  - So each second of the hour is counted at most once, from one sample.
- **A gap longer than 10 minutes counts nowhere.** It is uncovered time, not low time.
- **Time-zone changes.** Buckets follow the local-hour grid that the contract already checks. A half-hour zone change makes one bucket short, and intervals are clipped to it, so that hour covers fewer seconds and may read as unobserved (§3).
- **The workout split.** Time inside any workout the platform holds goes to `in_workouts`. This is an `HKWorkout` or a Health Connect exercise session, whichever app wrote it. All other time goes to `outside_workouts`.
- **Sources.** One sample per hour per source, as `heart_rate_window` does today. On the Samsung path the read is limited to Samsung Health's writer, as for windows.
- **History.** The phone sends bins for the same history it already reads for heart-rate windows. On the first build at the new revision, that includes the backfill.
- **Why the hold is 10 minutes.**
  - **Newest Apple watches.** Apple says Series 12 and Ultra 4 measure "as often as every five seconds" during the day, and the owner can turn this off ([support.apple.com/120277](https://support.apple.com/en-us/120277)). What reaches HealthKit at that cadence is not checked on a device.
  - **Older Apple watches** sample in the background at a gap that varies with activity. One third-party app's documentation puts it at 5 to 15 minutes on average ([Cardiogram](https://cardiogram.helpscoutdocs.com/article/97-when-does-the-apple-watch-take-a-heart-rate-measurement)).
  - **Samsung's default** is "every 10 minutes while still" ([samsung.com](https://www.samsung.com/hk_en/support/apps-services/how-samsung-health-monitors-your-heart-rate/)). Walking at that setting may be sampled more often, or not at all: this is unchecked, and §8 gates Samsung on a device check.
  - A 30-second hold, the workout rule, would leave most of an older watch's day uncovered. Holding longer than 10 minutes would invent minutes.

## 2. Zone bounds: the owner's own

### The basis is a share of the owner's maximum

Edwards' summated heart-rate-zone method weighs each minute by its zone, 1 to 5. The zones start at 50, 60, 70, 80 and 90 % of the maximum heart rate (Edwards S., *The Heart Rate Monitor Book*, Polar Electro, 1993). This is Edwards' own basis, and the phone already buckets workouts on it (`ZONE_BOUNDS_PCT`, from 60 % for zone 2).

Heart-rate reserve (Karvonen M.J., Kentala E., Mustala O., "The effects of training on heart rate: a longitudinal study", *Ann Med Exp Biol Fenn* 35:307–315, 1957) fails the job this design is for. Take an owner resting at 60 with a maximum of 190:

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
- the **sitting edge**: the 95th percentile of the seconds in the owner's resting hours.

**How the sitting edge is built:**
- **Resting hours** are hours that are outside a workout and not inside a recorded night, and that hold fewer than **250 steps**.
- **Why steps.** The resting-hour rule of energy windows and the stress curve uses movement minutes (`energy-windows.ts:16`, under 10). Health Connect has no movement minutes (no Apple Exercise Time), so on Android, Samsung included, that rule finds no resting hour at all. Steps are on both platforms.
- **Why 250 steps.** That is about two and a half minutes of walking at 100 steps a minute: getting up for a coffee, not a walk. A 1,000-step bar would let about ten minutes of walking into a "resting" hour. Walking heart rate is then over 15 % of that hour's seconds, so the 95th percentile would land on walking pace and lift the floor over the very walks this design counts.
- **The percentile** is taken over those hours' `outside_workouts` bins in the 30-day window, and needs 14 days with resting hours.
- **Why a percentile of seconds.** The edge must be in the same unit as what it gates. Heart rate while sitting varies more within an hour than hourly means vary between days, so an edge built from hourly means would let a quarter of desk seconds through.
  - At the 95th percentile, about 5 % of a desk day's sitting seconds still count: under an hour of zone 1.
  - That is a near-constant offset that the owner's own band absorbs, and a vector pins it well below a day on foot.
- **It is internal.** It is not a "usual" and is never served. #1822 gives the stress heart rate one estimator for display, and this edge does not compete with it.

Time below the start of zone 1 weighs 0.

This is a statistic of the owner's own data, not a population threshold. It needs neither resting heart rate nor movement minutes, so **the Samsung and Health Connect paths, which write neither, run the same rule as Apple.**

If zone 1's start reaches zone 2's (60 % of the maximum), the observed maximum cannot separate the owner's sitting from their effort. Passive is then unavailable (`zone_basis_low`). It returns once a harder day lifts the maximum.

**A low observed maximum also squeezes the upper zones.** With a maximum of 130:
- zones 2 to 5 start at 78, 91, 104 and 117;
- every hard effort above 117 counts as zone 5;
- a brisk walk at 105 bpm is already zone 4.

So that owner's load runs high per minute. It still runs high against their own band, and `approximate` says why. The cheap guard is the `zone_basis_low` rule above. No other guard is added, because any second floor on the maximum would be a population number. §10 has the falsifier.

### From bins to zones

- A bin that a bound splits is shared linearly: the seconds times the share of its 5 bpm above the bound.
- The bounds are recomputed on each producer run. Every day in the 28-day span is bucketed on today's bounds, so today and its band are on one basis.
- A stored past row keeps the score it was written with, as the usual band does.

## 3. Sparse days: a watch off the wrist

- **An hour is observed** when `outside_workouts` and `in_workouts` together cover at least 30 minutes.
- **The bar gates passive seconds only.**
  - An unobserved hour's `outside_workouts` seconds are not counted: the hour is null for passive, never a low hour, and nothing fills it in.
  - Its `in_workouts` seconds always count. A workout that falls in a thin hour, such as the first ten minutes of a run that starts at 7:50, is never lost.
- **A day has passive** when at least 12 of its hours are observed. Twelve allows for a watch charged overnight and off for a shower. The served part carries `observed_hours`.
- **A day without passive** is scored by v1 (§4) and says why.

## 4. Server compute: `day-load.candidate.v2`

- **Load.** From the chosen source's bins, on the day's bounds, the day's load is the Edwards sum: zone × minutes, with zone 0 weighing 0.
  - `parts.workouts` is the load from every hour's `in_workouts`.
  - `parts.passive` is the load from observed hours' `outside_workouts` (§3).
- **No double counting.**
  - **Workouts the phone holds:** their seconds are only ever in `in_workouts`, so each second counts once.
    - A deduplicated session that `sessionsOf` kept from another app is still phone-held when a phone workout covers its span. This is the phone workout plus its provider copy case.
  - **A counted session the phone does not hold**, such as a provider workout recorded on a strap while the watch was off, follows **one rule, pro rata by hour**:
    - **Minutes in an observed hour:** they are already in that hour's `outside_workouts`, so they count once, under passive in the parts. The session adds nothing for them.
    - **Minutes in an unobserved hour:** that hour's `outside_workouts` are not counted (§3). The session adds its own zone load (v1's `loadOf`, in zones) under workouts, in proportion to its minutes in unobserved hours over its total minutes.
    - A session with no zones adds nothing for those minutes, and the part says so.
  - **Worked example.** A provider run from 7:00 to 8:30. The 7:00 hour is observed and the 8:00 hour is not.
    - The 7:00–8:00 minutes count from bins, under passive.
    - The run adds 30 / 90 of its own zone load, under workouts.
    - The 8:00 hour's outside bins are not counted.
  - **No second is counted twice. No observed second is lost. The split between parts can lean to passive.**
- **The phone's own workout zones are not used in v2.** A phone workout's load comes from its `in_workouts` bins on the server's bounds. So v2's workout part need not equal v1's workout load for the same session, and the vectors do not expect it to.
- **One method, with one exception.** v2 is zones only, so zones are never mixed with effort or minutes. Within zones, the bins are all on the server's bounds. The one exception is a provider session's added load in unobserved hours, which is on the provider's own bounds (or WHOOP's zone durations). That is the same approximation v1 makes today, and it is limited to hours the phone did not see.
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

## 5. Contract: health revision R-e (12, provisional)

**Allocated by the gate on 2 November.** R-e is 12 for now. Revisions go in landing order, so if passive merges before S6, it takes 11 and S6 moves to 12. The gate confirms the number at merge. The build keeps it in one constant, so the change is one line. M-f is `20261102080000`.

**Ingest.**
- `heart_rate_bins_window` is accepted from R-e.
- A backend below R-e rejects that reading alone (per-sample refusal, revision 3), so an older backend loses nothing else.
- This is why it is a new signal and not a key on `heart_rate_window`: a strict window carrying an unknown key would be refused whole, and the hour's heart rate lost with it.
- **Deploy order.** The app drops a reading refused as `unsupported_signal`; the contract says "a newer build loses only that reading". So the backend's R-e migration and Worker go live before any app build that sends bins.

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
- **Below R-e, the v1 score is served.** An older build never silently loses a day's load.
  - The producer computes v1 for every observed day anyway, for the like-for-like bands (§4). So on a v2 day it also writes that day's v1 object, in exactly revision 10's shape (v1 version, method, band and direction), under `v1` in the same `day_load` column.
  - Below R-e, the response serves that `v1` object as `day_load`. At R-e and above, `v1` is stripped and the v2 object is served.
  - A v1 day is served as today at every revision.
  - The strict pins keep parsing, and a test proves it at revisions 10 and 11.
- **The zone bounds are not served.** Showing "zone 1 starts at 98 bpm" on Body would be a new derived row in the ADR, and a later ask.
- **For the S4 lane.** The committed revision-10 schema has no `parts` key. If S4 adds `parts: { workouts, passive: null }` at revision 10, a non-null passive still needs R-e under `strictObject`. So the recommendation is that S4 ships no `passive` key, and R-e adds `parts` whole.

## 6. Storage, retention and destinations

- **Bins are raw readings.**
  - They are stored in the `waldo.health_samples` payload, with its 90-day retention, its withdrawal purge and its account deletion.
  - No table is added.
  - Migration M-f adds the signal to `health_samples_signal_check` and re-creates `waldo.health_ingest` with the new signal's unit and bounds.
  - It re-creates `waldo.health_series_read` to take the signal. Today that read returns only `value` for a window, so M-f also returns `from_bpm`, `bin_bpm` and both arrays, from a fixed key list, as it already does for a workout's detail.
- **Batch size.** A bins sample is a few hundred bytes. The app's packer already holds a batch to 128 changes and the request size limit (`batch.ts`), so a full batch of bins splits rather than being refused. A test proves it with the widest arrays.
- **The producer reads bins in their own call.**
  - It calls `health_series_read` with `signals: ['heart_rate_bins_window']`, so 24 rows per day per source never eat into the main read's 8,000-row cap.
  - The 31-day window covers the 28-day span.
- **Derived values.**
  - v2's score, band and parts, and the day's `v1` object, live in S4's `day_load` column. M-f re-creates its write fence for that shape.
  - The usual maximum, the sitting edge and the bounds are computed in the producer's volatile run only. They are never stored or served, so they need no new derived row.
- **Never in** model context, DO SQLite, R2, memory, the journal, the outbox, logs, metric labels or traces. The model's view of load stays whatever S4 gives it.
- **Consent and the written record.**
  - **Consent copy 2** names "intraday window summaries". An hour's histogram is such a summary: it covers one hour, holds no sample times, and has no order inside the hour.
  - **The amendment needs an edit.** `docs/app/HEALTH_PLANE_AMENDMENT.md`, in its continuous-ingest addendum, listed heart rate only as "min/mean/max". This PR edits that line in the same change: it names the hourly time per 5 bpm, and says the 24-hour stream stays on the phone. Without that edit, "no copy bump" (Q4) would rest on a record that says otherwise.
  - **The published privacy notice needs no change.** Its §3 wording covers the histogram (waldo-landing `content/legal/privacy.md:50`): "Our servers receive summaries over short periods and single readings, not beat-to-beat heart data or your continuous heart-rate stream."
  - **Unrelated to this design:** the same line still names only Apple Health as a source, while Health Connect is live in the app. It is left for the privacy-notice owner.
  - The ADR paragraph names the new reading explicitly, so it is a recorded decision rather than a reading of the copy.
- **If the owner rejects v2, or turns it off for good,** stored bins do not wait out their 90 days.
  - A follow-up migration deletes every `heart_rate_bins_window` row.
  - The app build stops sending them.
  - No derived row holds a bin, so nothing else changes. A v2 day's stored score stays until the derived row's own retention, like any candidate score.

## 7. Tests before the switch

These come on top of #1822 §4's list:
- **Golden vectors, on synthetic values:**
  - a desk day whose sitting heart rate varies sample to sample (a flat desk day would hide a leaky floor);
  - a busy day on foot with no workout (non-zero, the reason for this design);
  - a run day;
  - a run day where the phone's workout and a provider copy are both counted (each second once);
  - a provider-only session with observed hours, and with unobserved hours;
  - the provider run from 7:00 to 8:30, with 7:00 observed and 8:00 not (it adds 30 / 90 of its own load, and the 8:00 outside bins are not counted);
  - a run starting at 7:50 in a thin 7:00 hour (its `in_workouts` seconds still count);
  - "resting" hours of about 800 steps, with walking pace inside them, must not count as resting hours at the 250-step bar, and must not lift the floor;
  - an overnight charge (12 observed hours: available; 11: `sparse`, scored by v1);
  - a low observed maximum (`zone_basis_low`);
  - fewer than 14 peak days (`no_zone_basis`);
  - a bin split by a bound;
  - a Samsung source with no resting heart rate and no movement minutes;
  - a provider session that is half in observed hours.
- **Anchor vectors for the scale constant.** These are ordering properties, not targets:
  - desk day < busy day on foot;
  - an hour in zone 3 > an hour in zone 1;
  - the score is monotone in load.
- **Like for like:** a property test that a v1 day's direction is never computed against a v2 band, or the reverse.
- **Switch off:** with `HEALTH_PASSIVE_LOAD="0"`, the rows are byte-identical to S4's.
- **Strip and pins:**
  - at every revision below R-e, the response carries no `parts`, and a v2 day serves its v1 object in revision 10's shape;
  - the app's strict pins parse.
- **Ingest:**
  - valid and invalid pairs for the new reading: unequal array lengths, over an hour, a bad `from_bpm`;
  - per-sample refusal on an older backend.
- **App:**
  - hold and gap rules;
  - the workout split;
  - two devices with overlapping spans (a watch and a chest strap) counting each second once, with the primary device's seconds kept;
  - overlapping spans from one device;
  - a half-hour zone change making one short bucket;
  - the current hour growing by revision.

## 8. Switch, numbers and order

- **`HEALTH_PASSIVE_LOAD`**, default `"0"` in both var blocks, classified in the staging profile.
  - Its value is `"0"` or a list of upload sources, for example `"apple"` or `"apple,health_connect,samsung"`.
  - A day whose chosen source is not on the list is scored by v1.
  - So Samsung can stay off until a real Galaxy Watch passes the cadence check (§10), while Apple turns on first.
- **Off,** the producer writes v1 exactly. Ingest stores bins from R-e whatever the switch, so the band warms before the flip (Q3).
- **Gate allocations (2 Nov):**
  - health revision R-e: allocated, 12 (provisional, confirmed at merge);
  - migration M-f: allocated, `20261102080000`;
  - the brain paragraph: its own PR (#61) on #60's branch, reviewed after #60 (gate ruling).
- **Depends on** S4 (the `day_load` column, fence and band).
- **App (waldoco/waldo-app):** the bins builder beside `heartRateWindows`, iOS and Android, sent from R-e.

## 9. Owner decisions

1. **Histogram from the phone, not minutes in zones.**
   - Recommend the histogram (§1): the server owns the bounds and can re-bucket.
   - This would flip if the owner reads an hour's histogram as too fine to leave the phone.
2. **% of maximum with a sitting-heart-rate floor, not heart-rate reserve.**
   - Recommend % of maximum: it is what lets walking count (§2). The floor is built from resting hours of under 250 steps.
   - This would flip if testers see desk days scoring as load on real data. The floor is meant to prevent that, and a falsifier below checks it.
3. **Store bins before the switch turns on.**
   - Recommend yes: they are raw readings under consent copy 2 and 90-day retention, and storing them warms the band.
   - The alternative is to refuse the reading until the switch is on, which costs a 14-day warm-up after the flip.
4. **No consent copy bump.**
   - Recommend none (§6). The health-plane amendment's heart-rate line is edited in this PR to name the hourly histogram.
   - This would flip if the owner wants the copy to say "time at each heart rate, by hour".

## 10. What would change this design

| Claim | Falsified by | Then |
|---|---|---|
| A 10-minute hold covers a worn hour | On a real older Apple Watch, fewer than half of worn waking hours reach 30 covered minutes | Raise the hold to the measured cadence, or lower the observed-hour bar, with new vectors |
| The floor keeps desk days light | On real owners, a desk day scores inside the band of days with a workout | Raise the percentile to 99, or fall back to reserve for that owner |
| Steps find resting hours | Under 14 days of resting hours by day 30 on a real Android owner | Raise the step bar a little, with the 800-step vector kept passing, or use the hourly heart-rate low as the resting hour's mark |
| The floor stays below walking pace | On a real owner, the sitting edge is within 5 bpm of their walking-hour heart rate, or a busy day on foot scores within the desk-day band | Lower the step bar or the percentile, and re-run the anchor vectors |
| A low observed maximum still ranks days honestly | An owner with a usual maximum under 140 has a run day and a walk day scoring within 5 points of each other | Add a guard from the owner's own data (for example, passive only once a workout peak sets the maximum) as a new version |
| Galaxy Watch's default cadence samples walks | On a real Galaxy Watch at the default setting, a 30-minute walk has under half its seconds covered | Keep `samsung` off the switch's list, and tell Samsung owners in the app that continuous measurement gives Load its day |
| The third-highest peak is a stable maximum | The usual maximum moves more than 10 bpm week to week on one owner | Lengthen to 90 days through S3's read |
| Bins fit the read | The bins call for one owner exceeds the read cap | Read two half-windows |
| Each second counts once | A golden vector with a phone workout and its provider copy shows any second twice | Block v2 |

## 11. Not verified

- None of this ran. It is source reading at the SHAs above.
- Apple's and Samsung's background cadence on real devices: this decides the hold, and Samsung's place on the switch's list.
- That HealthKit and Health Connect return non-workout heart rate at the density the hold assumes [inference from the vendor pages cited].
- The bins call's actual row count per owner.
- How S4's lane types `parts`; asked of the lane through the gate.
