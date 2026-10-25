# Health Connect mapping (21 October 2026)

Health Connect (Android) uploads use the same `POST /app/v1/health/ingest` batch as HealthKit. The wire is
`healthIngestV1Schema` in `packages/contracts/src/app/health-ingest.ts`; nothing here widens it. This page says what the
phone maps onto that wire so a record the backend would refuse is mapped before it is sent. The app lane owns the mapping;
the backend owns the refusal, and `packages/contracts/src/app/health-ingest.test.ts` ("health connect uploads") pins both.

Platform notes below describe Health Connect as the app lane has to read it. They are **not verified on a device**; the app
lane confirms each one on an Android build before it ships.

## Source and origin

| Wire field | Health Connect value |
|---|---|
| `source` | `health_connect` (never `samsung`, `google_fit` or a package name) |
| `origin.read_api` | `health_connect` |
| `origin.source_package_name` | the record's `dataOrigin.packageName`; `source_bundle_id` stays `null` |
| `origin.recording_method` | the integer `Metadata.recordingMethod` mapped to a string: automatic, active, manual, or unknown. The wire refuses an integer. |
| `origin.manufacturer`, `origin.product_type` | `Device.manufacturer` and the device type name, when present |
| `origin.client_record_version` | `Metadata.clientRecordVersion`, when present |
| `timezone`, `utc_offset_minutes` | the record's own zone offset; a record without one takes the phone's zone for that instant |

## Signals

| Health Connect record | Wire signal | Notes |
|---|---|---|
| Sleep session with stages | `sleep_duration` (`method: asleep_duration`), `sleep_efficiency`, `sleep_midpoint` | Carry `sleep_context` with `reducer_version: asleep-interval-union.v1`. Asleep, light, deep and REM stages are `asleep` intervals; the session span is the `in_bed` interval. Awake and out-of-bed time is neither. The contract defines `sleep_duration` as the minutes in the union of the asleep intervals, so overlapping contributors are not double counted. A session without stages sends `sleep_duration` with `method: time_in_bed` or `unknown` and no `sleep_context`. |
| HRV RMSSD | `overnight_hrv` with `method: rmssd` | Health Connect's HRV record is RMSSD. An HRV reading with no method is refused: the baseline is per method and a reading with an unknown one would be blended into the wrong baseline. |
| Resting heart rate | `resting_heart_rate` | `method` is `unknown` unless the source says how it was measured. Samsung writes none. The app never computes one: it keeps sending `heart_rate_window` hours through the night, and the backend gives a night with no resting reading the low of its asleep hours (method `asleep_hours_low`, Recovery v4). |
| Steps | `steps_window` | One reading per local hour, with the hour's bounds. Only the current hour grows; its `revision` is the observation time in epoch seconds. |
| Heart rate, SpO2, respiratory rate, active energy, exercise sessions | `heart_rate_window`, `spo2`, `respiratory_rate`, `active_energy_window`, `workout` | As HealthKit's. |

## Identity, change and deletion

- A point record uses `hc:<record id>` (derived readings add `:<signal>`) and revision 0 unless Health Connect edits it. A
  window signal's id comes from source, signal and hour bucket, so re-reading an hour never adds a second row.
- The changes API names a deleted record by id only. The app keeps the record type beside each id it uploaded and sends one
  deletion per derived signal (`sleep_duration`, `sleep_efficiency`, `sleep_midpoint` for a sleep session). The wire refuses a
  bare id with no `signal`.
- `anchor_before` and `anchor_after` are opaque. When Health Connect's change token has expired the app sends
  `anchor_before: null` and re-reads; uploads are idempotent, so a resync never duplicates.

## What the backend does with a day that has two sources

The producer ranks one source per day (`apple`, `oura`, `whoop`, `health_connect`, `samsung`, in that order) and never blends two
sources into one day. Oura has no live source here; an Oura owner reaches Waldo through Apple Health or Health Connect. A baseline is kept per source and per HRV method, so a newly worn device
is not scored against the old one's history. An owner who wears a ring that writes to Health Connect gets a
`health_connect` baseline of its own.
