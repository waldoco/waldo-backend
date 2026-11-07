# ADR-0081 amendment: a finished workout wakes the health trigger (`WORKOUT_WAKE`)

Status: written with the A3 PR for waldoco/waldo-backend#1980. Under the Wave 2 rule, a bounded, product-first amendment is
pre-accepted, and the gate confirms it at review. Once confirmed, waldo-brain's ADR-0081 carries it as a dated amendment beside
the 27 October §6a (the health trigger).

## The problem

The health trigger wakes on what the derived rows show: a zone change, sleep debt building, a driver, a Load jump. A workout the
owner just finished often moves none of those for hours, so an evening that now asks too much of the owner (a hard session
still booked, a late heavy commitment) goes unremarked until the Close.

## Decision

1. **The signal.** An app health upload that commits a `workout` sample which ended within the last three hours (the phone can
   deliver late, ADR-0010) sends the owner's object one signed word, `workout: true`, beside `woke: true` when both hold. No time,
   type, duration or detail leaves the health plane. A new statement (`healthworkout` and `healthwokeworkout`) is signed, and the
   existing ones are unchanged. Only a sample the ingest took counts: one the database rejected never says a workout just ended.
2. **The wake.** The owner's object notes when the notice arrived. The first recompute that *starts* after that, and finds
   today's row, hands `workout_ended` to the trigger beside the reasons it reads from the rows, even when the run changed no row.
   A run already under way when the upload landed may have read the rows before the workout was in them, so it never takes it.
   Once handed over, the note is deleted. A note older than three hours is ignored, so a later upload that day cannot call an old
   workout "just finished".
3. **The decision.** The trigger runs as it does for every wake reason: zone words only, the coming items, one change or `no_op`,
   with the egress check, the delivery gate (`adjustment`), quiet hours, the proactive interrupt limits under `PROACTIVE_GATE`,
   its dedupe and the owner's `health_proposals` preference. The prompt adds one line: look at the rest of today and this evening
   with recovery in mind, and propose a change only when one clearly helps. A finished workout on its own needs none. Whether
   anything changes is the model's call. There is no fixed rule such as "always suggest food after a workout".
4. **Bounds.** `workout_ended` is marked once per owner-local day, like every non-zone reason, and once per workout: a mark
   within three hours of the last one is refused on any day. A workout that ends late in the evening and comes again after
   midnight (re-sent, or with its effort rating added) wakes the trigger once. A second workout the same day finds the day's wake
   taken. A run held past three hours (quiet hours, the hourly floor) drops the reason, and when it was the only reason the run
   ends as `stale_day`. On a day with nothing coming, a run only a workout woke ends as `nothing_coming` and writes no note: the
   question is whether to reshape what is left of the day, and nothing is.
5. **Switch.** `WORKOUT_WAKE` is off in production and on in staging. The nightly eval classifies it as a known gap, because no
   trial uploads a finished workout.

## What the owner's object keeps

No reading, type, duration or zone. Two things carry a time near the workout's end, so they are named here:

| What | Where | How long | On withdrawal of health consent |
|---|---|---|---|
| The time the `workout: true` notice arrived | owner DO key-value `health_workout_noted_v1` | until a recompute hands it over, and ignored after three hours | not read: a recompute under withdrawn model-use consent finds no row, so it is never handed over and lapses |
| The wake: owner-local day, `workout_ended` and when it was marked | owner DO `health_trigger_wakes` | 3 days (`HEALTH_WAKE_KEEP_MS`), as for every wake reason | the trigger reads no row and clears it (`no_health`); the row then ages out with the others |

Both are removed by account deletion with the rest of the owner's object.

## What this does not touch

- **ADR-0082** (the device-local cache and account lifecycle). No device event, device cache or consent purpose changes. The
  owner's object keeps the two server-side entries in the table above. Their lifetime and their withdrawal path are stated there,
  and account deletion removes them with the object, as ADR-0082's lifecycle already requires of owner state.
- **Arrivals.** By the owner's ruling of 7 November, arriving home or at the gym brings Waldo's existing look forward, as a
  move to another city does (device-context ADR §9, waldoco/waldo-backend#2006). It does not wake the health trigger.
- **WHOOP.** Its syncs do not say `workout`, pending the owner's ruling on WHOOP's API terms of 6 October 2026.

## Freshness, and what is not anchored

The workout's end time stays on the health plane, so freshness is measured from what the owner's object has: the notice's
time (three hours to a handover) and the mark's time (three hours to the trigger's run). A run that quiet hours or the hourly
floor hold can therefore come up to about six hours after the workout ended, never later. Anchoring both to the end would
need that time in the owner's object.

## Rollback

- Turn `WORKOUT_WAKE` off. Nothing new is noted or marked, and the entries above lapse on their own.
- Reverting the code: a `workout_ended` row still pending reads back on the earlier code as a zone change ("moved zone") for up
  to 12 hours (`HEALTH_TRIGGER_PENDING_TTL_MS`). Switch off first and revert after 12 hours, or accept that one run.
