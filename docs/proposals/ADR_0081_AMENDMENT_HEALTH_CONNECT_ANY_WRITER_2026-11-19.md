# ADR-0081 amendment: Health Connect scores from whichever app wrote the reading

Status: **proposed. Needs the owner's accept before this ships on staging.** It changes the 27 October rule that a Health
Connect reading enters a canonical score only from Samsung Health. It is not an ordinary fix to ride the release train.

## The problem

On the owner's phone, Fitbit, Nothing X, Fit and Samsung Health all write into Health Connect. Build 44 reads only Samsung
Health's records, so staging holds one night of sleep in three days and no HRV or resting heart rate; Recovery cannot be
scored. App PR waldoco/waldo-app#288 reads every writer, choosing one writer per kind and slot (Samsung Health first, otherwise
the writer with the most readings). Its description calls the backend side "gap 6": `acceptable()` in
`packages/runtime/src/health/producer.ts` accepts a Health Connect row only when every scored reading carries
`samsung_writer`, so every row from another writer is stored `candidate_unaccepted` and never scored. That is the dead end
the 16 November ruling forbids ("use whatever body data exists").

## Decision

A Health Connect row is accepted when it holds a scored reading, whichever app wrote it. It carries the Health Connect
confidence, 0.6, the same as the Samsung Health one. Apple Health, Oura and WHOOP are unchanged.

### Why not the other designs

| Design | Result |
|---|---|
| Source allowlist of packages | Needs package names to leave the database, which the series read deliberately never does (pgTAP `waldo_health_series_origin`); a migration; and a brand list that goes stale. An unlisted writer is the same dead end again. |
| "A writer was recorded" | Merged hourly totals name no writer by design: steps and energy where several apps contributed, 286 of 424 hours on one Pixel. Form would stay a candidate for most hours. |
| Accept only when one writer wrote every reading | Same dead end for any owner whose sleep and HRV come from different apps (a ring and a watch). |
| **Accept any writer, one reading per slot** | No migration; the series read already returns what is needed. Chosen. |

### Why mixed writers are still not averaged

The phone names one writer per kind and slot. A window's `sample_id` hashes source, signal and the hour, never the writer, so
a second app's hour replaces the first at ingest. The producer keeps one reading per hour and the newest asleep reading
per night. Tests pin both (`health-connect-galaxy-watch.test.ts`).

### Residual risk

- A night's breathing rate and blood oxygen are means of point readings, which keep OS record ids, so two apps' readings of one
  night can both be stored and averaged. They feed driver text only, never a score or its acceptance, and the app names the
  case as a known limit. A writer-aware read would close it and would need a migration and a decision on what may leave the
  database.
- A manually entered reading is scored like a recorded one. Excluding manual entries would need `recording_method` in the read.

## Not changed

- The database writer does not look at the writer: it refuses `accepted` only for a source outside the five it names.
- `samsung_writer` is still returned by the series read and is now unused. Removing it is a migration for a later cleanup.

## Rollback

Revert the PR. Rows already written `accepted` from another writer keep that label until the day is recomputed, which the
producer does for the current day on each run and for older days only through its backfill.
