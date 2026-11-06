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
   existing ones are unchanged.
2. **The wake.** The owner's object notes the day. The recompute that upload asked for hands `workout_ended` to the trigger beside
   the reasons it reads from the rows, once today's row exists. It does so even when the run changed no row, so the trigger never
   evaluates the day before the workout.
3. **The decision.** The trigger runs as it does for every wake reason: zone words only, the coming items, one change or `no_op`,
   with the egress check, the delivery gate (`adjustment`), quiet hours, the proactive interrupt limits under `PROACTIVE_GATE`,
   its dedupe and the owner's `health_proposals` preference. The prompt adds one line: look at the rest of today and this evening
   with recovery in mind, and propose a change only when one clearly helps. A finished workout on its own needs none. Whether
   anything changes is the model's call. There is no fixed rule such as "always suggest food after a workout".
4. **Bounds.** `workout_ended` is marked once per owner-local day, like every non-zone reason. A second workout that day finds
   it taken.
5. **Switch.** `WORKOUT_WAKE` is off in production and on in staging. The nightly eval classifies it as a known gap, because no
   trial uploads a finished workout.

## What this does not touch

- **ADR-0082** (the device-local cache and account lifecycle). No device event, cache or consent changes.
- **Arrival or departure triggers.** The device-context ADR of 5 November adds no trigger in v1 and rejects arrival moments.
  Building one waits for the owner to change that ruling.
- **WHOOP.** Its syncs do not say `workout`, pending the owner's ruling on WHOOP's API terms of 6 October 2026.
