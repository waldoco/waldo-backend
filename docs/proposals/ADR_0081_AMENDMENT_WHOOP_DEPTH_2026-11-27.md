# ADR-0081 amendment: every kind WHOOP's API gives (health revision 16)

Status: draft for review with HEY-491 (HD.4). Once accepted, waldo-brain's ADR-0081 carries it as a dated amendment beside §3 (the
field × destination matrix). It extends the WHOOP decisions recorded in `docs/app/WHOOP_AND_OURA_2026-10-21.md` and the owner's
rulings of 7 November (legal basis), 19 November (ship turned on) and 27 November (take every field WHOOP gives; WHOOP data never
trains, tunes or evaluates a model; fixtures stay synthetic).

## What changes

Before this, a WHOOP connection stored six readings of a night, and a workout's minutes and energy. WHOOP's v2 API gives much more,
and three of its outputs are WHOOP's own model scores rather than measurements. This amendment says where each new field lives and
where it may go.

## Persistence

- **One store.** Every WHOOP field lands in `waldo.health_samples` (Supabase), through `waldo.health_ingest`, under the 90-day raw
  retention, the storage-withdrawal purge and account deletion that every source has. Nothing new is kept in the owner object
  (it keeps ids, dates, scopes, a token version, counters and the kinds a connection lacks), R2, logs, traces or memory.
- **No permanent copy.** WHOOP's terms forbid permanent copies of WHOOP data. The rolling retention covers it; body measurements are
  one reading per kind revised at each daily read, so they lapse 90 days after the last read like everything else.
- **New kinds** (health revision 16): `provider_recovery` (with `calibrating`), `provider_day_strain` (with the cycle's energy,
  heart rate, steps and `open`), `provider_sleep_need` (with its four parts), `provider_sleep_performance`,
  `provider_sleep_consistency`, `nap`, `skin_temperature`, `height`, `max_heart_rate`. **New keys**: `stage_totals` on a night's
  time asleep (method `provider_totals`, never `stages`); `strain`, `percent_recorded` and `elevation_change_m` on a provider workout.

## Provider scores are labelled, and never Waldo's

- Every `provider_*` kind carries method `whoop`, is admitted only from the `whoop` source, and is not in the producer's closed list
  of score inputs. Waldo's Recovery, Form and Load never read it, so they are never WHOOP's numbers under Waldo's name. A later
  decision to blend a provider score into a Waldo pillar needs its own stated method and review.
- A skin temperature is absolute and its own kind, never blended with a watch's wrist temperature (which may be a baseline delta).
- A nap is a session, never the night.

## Consent

WHOOP's copy 6 adds that its scores are stored and that the raw readings reach the AI models. A grant may name copy 4 (an installed
build) or copy 6. The scores, and a workout's strain, are stored only under a storage grant on copy 6, enforced in the owner object
and again in `waldo.health_ingest`; under copy 4 the raw readings sync as before. Owner decision pending: whether copy-4 owners must
re-consent before their raw readings keep reaching the models (see the PR).

## Destinations

| Field | Supabase health plane | Owner-channel model context | Standing health block | Logs, traces, R2, memory, third-party sends |
|---|---|---|---|---|
| WHOOP readings (sleep, stages, HRV, resting HR, SpO2, skin temperature, breathing rate, workouts, naps, body) | stored | `get_health`, turn-only | inventory: kind and freshness, no value | never (staging Langfuse capture only for opted-in testers, as already ruled) |
| WHOOP scores (`provider_*`, workout strain) | stored under copy 6 | `get_health`, turn-only, labelled WHOOP's | words only: against the owner's own WHOOP days, calibrating, need met or short | never |
| Whether a device reading was written by WHOOP's app | not stored as a new field (read from the stored origin) | used to drop the duplicate, never shown | never | never |

The numeric-health floor recognises each new reading as get_health relays it (recovery, strain, sleep need and debt, performance,
consistency, naps, skin temperature, time in bed, cycles, disturbances, height), so none leaves through a third-party send or a draft.

## Duplicates

When the owner also shares Apple Health or Health Connect, WHOOP's own app writes the night, workouts and some vitals there. The
series read marks a device reading whose source bundle or package is `com.whoop` or `com.whoop.*` without returning the origin; the
producer and `get_health` drop it on a day the WHOOP source holds the same kind. Without the WHOOP API, the copy stays the owner's
data. The bundle prefix is to be confirmed in the live test (`docs/ops/WHOOP_LIVE_TEST.md`).

## Falsifiers

- A `provider_*` value appears in a Waldo pillar's inputs, in a log line, or in the standing block as a number.
- A WHOOP row survives a storage withdrawal, or outlives 90 days without a newer read.
- A copy-4 grant stores a score.
- A night counted twice for an owner with WHOOP and Apple Health.
