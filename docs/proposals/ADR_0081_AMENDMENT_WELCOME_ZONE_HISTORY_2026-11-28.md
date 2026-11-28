# ADR-0081 amendment: backfilled zone words in the first build

Status: proposed with migration `20261128100000_health_zones_history`. Needs the gate's confirmation at review and the owner's go before the migration is applied.

## Problem
The first build joins what Waldo learns about a new owner into constellations, for example "late calls, then short sleep, then low Form". On day one, the only health it has is the history the phone sends at link. ADR-0081 (HI-8) stores those days as `backfilled` rows, and `waldo.health_zones_read` has never returned a backfilled row. A new owner's first build therefore gets almost no body days, so no body link can form until live days arrive.

## What changes
- `waldo.health_zones_read` takes one optional payload key, `history` (a JSON boolean). With `history: true`, a backfilled day is returned beside the live days, as its date and its Recovery zone word. A backfilled row holds no Form, so Form is null.
- Only the runtime's first-build health stage sends `history: true`. Personal experiments and the body-pattern review send `{from, to}` as before, and still never see a backfilled day.

## What does not change
- **Words only.** No score, reading, driver or backfilled mark leaves the health plane. The pgTAP test asserts that no score value and no mark appears in the answer.
- **Consent.** Each day still needs a live model-use consent basis, the range is still at most 57 days, and the key list is still closed.
- **No events.** A backfilled row still never raises a zone-change event or wakes the trigger. This read writes nothing.
- **No readings in the model call.** Readings in the welcome call were considered and rejected: zone words are the only health the first build sees.

## Order and rollback
- Apply the migration before the Worker that sends `history`. A Worker that runs first has its first-build health read refused with `invalid_request`, and the stage settles `unavailable`. Nothing else is affected.
- Rollback: roll the Worker back, then run `supabase/rollback/20261128100000_health_zones_history.down.sql`. It restores the 20261106120000 definition exactly (checked by comparing the function definition and grants before, after and back).
