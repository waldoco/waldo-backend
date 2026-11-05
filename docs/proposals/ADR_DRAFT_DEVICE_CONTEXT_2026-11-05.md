# ADR draft: device context (place, weather, steps, screen time, trips), with consent per signal

Status: **proposed** (5 November 2026). Not accepted. Nothing in this draft is built unless a later PR names it, and every switch it names is `"0"` in production.

It extends two accepted ADRs and needs the owner's review:
- ADR-0081, health computation and destinations;
- ADR-0082, the device's sensitive cache and its lifecycle.

The ADR number is assigned when waldo-brain accepts it. Open brain PRs already propose 0085, 0086 and 0087.

Base: `beta-mvp` `60496b8b`. The platform facts are in the companion plan, [`WAVE2_PLATFORM_PLAN_2026-11-05.md`](WAVE2_PLATFORM_PLAN_2026-11-05.md), with a primary source for each one.

## The problem

The owner's model is OnePlus "AI Suggest": the phone reads screen time, location, steps, weather and trips, and suggests the right thing at the right moment. Waldo already has the judgment layer for that:
- the proactive layer (#1884–#1887): one set of owner limits, act-ahead triage, the day shape, and Waldo's own look every 90 minutes between the Brief and the Close;
- the Brief.

What it lacks is context. It cannot tell:
- what the weather is where the owner is;
- that the owner is in another city today;
- that the evening went to the phone.

Each of those makes a suggestion better or worse. Example: move the run because rain starts at 7; the owner landed in Bengaluru, so the 9:00 call is at 9:00 there.

The job: give the model this context **without** building a second proactive path, a pile of fixed rules ("if rain > 60% then…"), or a location history.

## Decision

### 1. Signals and where each one lives

Each signal has one store and one writer. No signal is copied into a second store.

| Signal | Comes from | Store and writer | Consent | Kept | What the model sees |
|---|---|---|---|---|---|
| **Screen time, Android** (exists, #1863) | Usage access on the phone | Supabase `waldo.screen_time_days`. Writer: the `screen_time_*` signed router calls behind `/app/v1/screen-time/*` | Its own consent, purposes `storage_compute` and `model_processing` | 90 days | `get_screen_time`, turn-only |
| **Screen time, iOS** | Apple's Screen Time APIs | **None on the server.** Apple's report extension cannot send the data off the device (see the platform plan) | — | — | Nothing, unless the owner types it |
| **Coarse place** (new) | The phone's own coarse location, rounded **on the phone** to a geohash cell of 5 characters (about 4.9 km × 4.9 km), plus the place name the phone's OS gives (locality, region, country) and the IANA time zone | Supabase `waldo.place_latest`: one row per owner and device, **overwritten**, never appended. Writer: new `place_*` signed router calls behind `/app/v1/device-context/place/*` | Place consent, purposes `storage_compute`, `model_processing` and `provider_lookup` | Latest row only. A row not refreshed in 30 days is removed by the retention sweep | `get_device_context`: the place name, time zone, how old the reading is and which device sent it. **Never the cell** |
| **Weather, UV and air** (new) | A weather provider, called **by the Worker** with the cell's centre only. Proposed: WeatherKit REST for forecast and UV, plus a second source for air quality, which WeatherKit lacks | Not stored per owner. A shared cache keyed by cell and hour holds no owner or device id | Needs place consent `provider_lookup` | The provider's cache terms; at most a few hours | `get_weather`: today and tomorrow for the owner's current place, as a short forecast summary |
| **Steps** (exists) | HealthKit / Health Connect through the existing health ingest | The health plane (ADR-0081), unchanged | Health consent, unchanged | Unchanged | `get_health` with signal `steps`. A step goal is something the owner says, kept as memory. No new store |
| **Trips** | Booking mail and calendar (existing connectors), plus a change of place or time zone | No new store. Trips stay where mail, calendar and open loops already live | The existing connector grants | Unchanged | The model reads mail and calendar as it does today and judges whether this is a trip |

Rules that apply to every signal:

- **Absent means unknown.** A missing, stale or withdrawn signal is reported as unavailable, with its reason and age. It is never filled with a default: no home city, no "fine weather", no zero minutes. This is ADR-0081's missingness rule applied to device context.
- **Coarse is a schema rule, not a judgment.** The contract accepts a 5-character geohash and nothing finer. A latitude or longitude field does not exist. This is schema validation, which the stable rules allow.
- **Finer precision only by opt-in, under a later amendment.** v1 has no fine location, no geofence, no visit history and no background ("Always") location.
- **No new trigger.** A place upload does not start a turn. The model decides what matters, inside the triggers that already run (§4).

### 2. Consent: per signal, revocable, on the screen-time pattern

Place consent copies screen time's proven shape:
- server-owned status and epoch;
- `expected_epoch` on every write;
- an idempotent `request_id`;
- an unknown state reads as not granted.

The three purposes:

| Purpose | Allows | Withdrawing it |
|---|---|---|
| `storage_compute` | Keep the latest place on the server | Withdraws all three purposes. Deletes every place row and upload receipt. Bumps the epoch, so an upload read before the withdrawal is refused and cannot repopulate what was deleted |
| `model_processing` | Let Waldo's model read the place | `get_device_context` and `get_weather` answer `consent_withdrawn`. The row stays until storage is withdrawn or it expires |
| `provider_lookup` | Send the cell's centre, with no owner or device id, to the weather provider | `get_weather` answers `consent_withdrawn`. Place still works |

Model use needs `storage_compute` and `model_processing`. Weather needs all three. The database checks the purposes on every read, as `screen_time_refusal` does.

**Considered: one consent table keyed by signal, or one table family per signal.**
- Screen time already has its own tables, and they are live in staging. This draft does not touch them.
- For new signals, the proposal is **one consent and scope table pair keyed by `(signal, purpose)`**, with `signal` starting as `place`, plus a data table for each signal, because shape and retention differ by signal.
- One table pair means a later signal needs no new consent machinery.
- Folding screen time into it later is a separate migration, and is not proposed here.

### 3. Device side (extends ADR-0082)

- The app reads place only **in the foreground** (when the app is open), with the coarse or approximate permission. Android coarse is about 3 km²; iOS approximate is 1–20 km and "typically preserves the city". A 5-character cell is no finer than either.
- Reading in the background needs the "Always" or background-location permission and store review. Examples are iOS visit monitoring and Android passive updates. This is an **owner decision**, not v1.
- It rounds to the cell before anything is written to disk or the network.
- It may keep the last upload as a staging row under ADR-0082's 24-hour upload-staging class.
- It keeps **no place history**.
- Sign-out, account switch, consent withdrawal and deletion purge it exactly as ADR-0082 §4–§5 says.
- The consent epoch for place is a new account-scoped field. An epoch mismatch cancels any pending place upload.
- Screen time's device-side rules are Ashish's app spike (#234) and are unchanged.

### 4. How device context reaches the model

There is one path: the existing triggers and the tool permission table.

- `get_device_context` and `get_weather` join `get_screen_time` in `TOOL_PERMISSIONS` for:
  - owner chat;
  - the Brief and the Close;
  - `patrol` (Waldo's own look);
  - `intervention`;
  - `fetch_alert`;
  - `handoff_plan`.
- The proactive layer's limits are unchanged: consent, quiet hours, the day window, the budget and the gap. They govern anything the model decides to say.
- The model decides relevance. There is no rain threshold, UV threshold, "far from home" radius or trip detector in code.
- Both tools are `turn_only_output`. The forecast, the place name and their ages live in the turn that asked. They never reach the tool ledger, memory, logs or storage.
- The model may remember what the owner **says** ("I'm in Bengaluru till Friday") as it already does. That memory is the owner's words, under the existing forget paths, and is not a place history.
- **Owner decision:** whether a change of city should bring Waldo's next look forward. That would be the only new wake-up. v1 says no; the next 90-minute look sees it.

### 5. Egress and privacy

| Destination | Gets | Never gets |
|---|---|---|
| Supabase health plane | The cell, place name, time zone, device id and received time | Latitude, longitude or a history |
| Weather provider | The cell's centre, from the Worker's own address | The owner or device id, the place name, or the phone's address |
| The LLM provider (owner's turn) | Place name, time zone, the reading's age, and the forecast summary | The cell or coordinates |
| Logs, traces, metrics, eval fixtures | Counts and closed error codes only | The cell, place name or forecast for an owner. Fixtures use synthetic cells |
| Memory, R2, browser jobs | Nothing from these tools | — |

Location is personal data; it is not ADR-0081 health data. It still lives on the health plane, for three reasons:
- that plane already gives a signed router, owner cascade deletion (ADR-0055), a retention sweep and RLS with no role access;
- it keeps place apart from the DO's memory, which the model writes;
- one writer per aggregate holds.

**Before production** the privacy notice must say three things: what place is kept (the city-level cell, place name, time zone, latest only), which weather provider is called, and that withdrawing deletes the place.

### 6. Revoking, deleting, and missing data

- **Withdraw:** the behaviour is in §2. The app then purges its local copy (§3).
- **Account deletion:** the owners cascade removes place rows, consents and receipts. Weather caches hold nothing owner-linked.
- **Stale:** the tool reports the reading's age. Whether a two-day-old place still holds is the model's judgment, given the age.
- **Phone off or permission denied by the OS:** the app sends nothing. The server keeps the last row until it expires, and the tool says how old it is.

## Considered options

1. **Keep place in the owner's Durable Object SQLite.**
   - For: the DO is the owner's authority root and has a migration system.
   - Rejected for v1, for three reasons:
     - the DO holds model-written memory;
     - the screen-time pattern already proves consent, epoch, retention and deletion on the health plane;
     - a second copy of the consent machinery would be a second representation.
2. **The phone fetches weather (WeatherKit on iOS) and uploads it.**
   - Rejected. It needs the phone awake before the Brief, gives two code paths across iOS and Android, and puts the provider key in the app.
   - The Worker fetch needs only the cell, which the owner has consented to.
3. **Store a place history, so Waldo can learn home, work and trips.**
   - Rejected for v1. A history is the most sensitive form of location, and the model can learn trips from mail, calendar and what the owner says.
   - If the owner wants it later, it needs its own consent purpose and an amendment.
4. **Geofences or background location for "you arrived" moments.**
   - Rejected for v1. On both platforms they trigger store review and need permissions beyond coarse.
   - A trigger keyed to arrival is also a fixed rule about what matters.
5. **Coordinates rounded on the server.**
   - Rejected. The finer value would reach the Worker. Rounding on the phone means the server never holds it.
6. **A generic `device_context` consent with a signal key** (chosen for new signals), against copying the screen-time tables per signal. See §2.
7. **iOS screen time on the server.**
   - Not possible under Apple's terms (see the platform plan).
   - An on-device-only screen-time view is possible later inside the app's report extension. It would never reach the model.

## Consequences

- Waldo can suggest from weather, place and time zone. Screen time is Android-only. Steps and trips need no new store.
- Location becomes a new kind of personal data on the health plane. It needs the privacy-notice line and store-listing disclosures before production.
- The weather provider is a new processor, and its terms decide the vendor (platform plan, Weather).
- Every new tool adds to the prompt's tool budget. The two tools are offered only while their switch is on.

## Verification (for the build slices)

- Contract tests: valid and invalid pairs for every schema, including a cell one character too long, a latitude field, and an extra key.
- A test that the strict schema rejects a payload with coordinates.
- pgTAP (or the PGlite runner), proving that:
  - withdrawing storage deletes rows and receipts and bumps the epoch;
  - an upload carrying the old epoch is refused;
  - model reads are refused without both purposes;
  - account deletion cascades.
- Worker tests, proving that:
  - with the switch off, every route answers 404;
  - each route spends its own per-owner budget;
  - no log line carries a cell or a place name.
- A tool test: the result is `turn_only_output`, and unknown stays unknown.
- Before production: the privacy notice, the store disclosures, and a device test on both platforms.

## For the owner to decide

The ranked list is in the PR body.
