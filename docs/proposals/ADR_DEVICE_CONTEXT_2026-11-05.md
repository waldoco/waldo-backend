# ADR: device context (place, time zone, weather, steps, screen time, trips), with consent per signal

Status: **accepted** (5 November 2026). The gate accepted it with edits, under the owner's 5 Nov ruling: a Wave 2 ADR good enough for the industry and the product is accepted without waiting for the owner. An independent review at `b5d9cadc` found no factual errors in the platform claims.

It extends two accepted ADRs, and waldo-brain records it under the next free number. Open brain PRs already propose 0085, 0086 and 0087.
- ADR-0081: health computation and destinations.
- ADR-0082: the device's sensitive cache and its lifecycle.

Every switch it names is `"0"` in production. Base: `beta-mvp` `60496b8b`. The platform facts are in the companion plan, [`WAVE2_PLATFORM_PLAN_2026-11-05.md`](WAVE2_PLATFORM_PLAN_2026-11-05.md), each with a primary source.

## The problem

The owner's reference is OnePlus "AI Suggest": the phone reads screen time, location, steps, weather and trips, and suggests the right thing at the right moment. Waldo already has the judgment layer for that:
- the proactive layer (#1884–#1887): one set of owner limits, act-ahead triage, the day shape, and Waldo's own look every 90 minutes between the Brief and the Close;
- the Brief.

What Waldo lacks is context. It cannot tell:
- what the weather is where the owner is;
- that the owner is in another city or time zone today;
- that the evening went to the phone.

Each of those changes whether a suggestion is good. "Move the run, rain starts at 7." "You landed in Bengaluru, so the 9:00 call is at 9:00 there."

The job is to give the model this context without a second proactive path and without fixed rules ("if rain > 60% then…").

## Decision

### 1. Signals and where each one lives

Each signal has one store and one writer. No signal is copied into a second store.

| Signal | Comes from | Store and writer | Consent | Kept | What the model sees |
|---|---|---|---|---|---|
| **Screen time, Android** (exists, #1863) | Usage access on the phone | Supabase `waldo.screen_time_days`. Writer: the `screen_time_*` signed router calls behind `/app/v1/screen-time/*` | Its own consent, purposes `storage_compute` and `model_processing` | 90 days | `get_screen_time`, turn-only |
| **Screen time, iOS** | Apple's Screen Time APIs | **None on the server.** Apple's report extension cannot send data off the device (see the platform plan) | — | — | Nothing, unless the owner types it |
| **Time zone** (new) | The phone's IANA time zone, sent on **every app wake**, including background health sync. No location permission is needed | Supabase `waldo.device_place_latest`, one row per owner and phone. Writer: the `device_context_*` signed router calls behind `/app/v1/device-context/place` | The place consent (§2) | Latest only; removed after 30 days without a refresh | `get_device_context`: the zone and how old the reading is |
| **Coarse place** (new) | The phone's own coarse location, rounded **on the phone** to a 5-character geohash cell (about 4.9 km × 4.9 km), plus the place name the OS gives (locality, region, country) | The same row as the time zone. Overwritten, never appended. An upload with only a time zone leaves the last cell in place, with its own time | The place consent (§2) | Latest only; removed after 30 days without a refresh | `get_device_context`: the place name, how old it is and which phone sent it. **Never the cell** |
| **Weather, UV and air** (new) | A weather provider, called **by the Worker** with the cell's centre only. WeatherKit REST covers forecast and UV; a second source covers air quality, which WeatherKit lacks | Not stored per owner. A shared cache keyed by cell and hour holds no owner or device id | The place consent, which names the provider. It can be withdrawn on its own | What the provider's cache terms allow; at most a few hours | `get_weather`: today and tomorrow where the owner is, as a short summary |
| **Steps** (exists) | HealthKit or Health Connect, through the existing health ingest | The health plane (ADR-0081), unchanged | Health consent, unchanged | Unchanged | `get_health` signal `steps`. A step goal is what the owner says, kept as memory. No new store |
| **Trips** | Booking mail and calendar (existing connectors), plus a change of place or time zone | No new store. Mail, calendar and open loops already hold trips | The existing connector grants | Unchanged | The model reads mail and calendar as today and judges whether it is a trip |

**Rules for every signal:**

- **Absent means unknown.** A missing, stale or withdrawn signal reads as unavailable, with its reason and age. It is never filled in: no default home city, no "fine weather", no zero minutes. This is ADR-0081's missingness rule applied to device context.
- **Coarse is a schema rule, not a judgment.** The contract accepts a 5-character geohash and nothing finer. No latitude or longitude field exists. The stable rules allow this kind of schema validation.
- **Finer precision only by opt-in, under an amendment.** v1 has no fine location, no geofences and no background ("Always") location.
- **No new trigger.** A place or time-zone upload does not start a turn. The model decides what matters inside the triggers that already run (§4).

### 2. Consent: one place consent, separate withdrawals on the server

**What the owner sees:** one place consent. Its text says:
- the phone's time zone and city-level place are kept, latest only;
- Waldo's model may read them;
- the cell's centre is sent, with no owner or device id, to the named weather provider (WeatherKit at launch).

**What the server keeps:** three purposes, so each use can be withdrawn on its own.

| Purpose | Allows | Withdrawing it |
|---|---|---|
| `storage_compute` | Keep the latest time zone and place | Also withdraws the other two. Deletes every place row and upload receipt, and moves the epoch, so an upload read before the withdrawal is refused |
| `model_processing` | Let Waldo's model read them | `get_device_context` and `get_weather` answer `consent_withdrawn`. The row stays until storage is withdrawn or the row expires |
| `provider_lookup` | Weather lookups with the cell's centre | `get_weather` answers `consent_withdrawn`. Place still works |

**Granting.** The app grants all three together from the one consent screen, storage first, because the others sit on top of it. The pattern is screen time's:
- the server owns status and the epoch;
- every write carries `expected_epoch`;
- every request carries an idempotent `request_id`;
- an unknown state reads as not granted.

**Considered: one consent table keyed by signal, or one table family per signal.**
- Screen time keeps its own tables, which are live in staging. This ADR does not touch them.
- New signals share **one consent and scope table pair keyed by `(signal, purpose)`**, and each signal gets its own data table, because shape and retention differ.
- So a later signal or purpose needs no new consent machinery.

### 3. The phone (extends ADR-0082)

- **Time zone on every wake.** The app sends its IANA time zone on every wake, foreground or background (health sync included), under the place consent. It needs no location permission. This lets "landed in Bengaluru" work before the owner opens the app.
- **Place in the foreground.** The app reads place only while the app is open, with the coarse or approximate permission:
  - Android coarse is about 3 km²;
  - iOS approximate is 1–20 km and "typically preserves the city";
  - a 5-character cell is no finer than either.

  Background place (iOS visit monitoring, Android passive or background location) needs "Always" or background-location permission and store review. That is an owner decision, not v1.
- **Rounded before it leaves memory.** The app rounds to the cell before anything is written to disk or sent over the network.
- **No local history.** The app may keep the last upload as an ADR-0082 upload-staging row (24 hours) and keeps no place history on the phone.
- **Purge on lifecycle events.** Sign-out, account switch, withdrawal and deletion purge it as ADR-0082 §4–§5 say. The place epoch is an account-scoped field; a mismatch cancels any pending upload.
- **Screen time is unchanged** (Ashish's #234).

### 4. How device context reaches the model

There is one path: the existing triggers and the tool permission table.

- **Where the tools are offered.** `get_device_context` and `get_weather` join `get_screen_time` in `TOOL_PERMISSIONS` for:
  - owner chat;
  - the Brief and the Close;
  - `patrol` (Waldo's own look);
  - `intervention`;
  - `fetch_alert`;
  - `handoff_plan`.
- **Limits are unchanged.** The proactive layer's limits govern anything the model chooses to say: consent, quiet hours, the day window, the budget and the gap.
- **The model decides relevance.** There is no rain or UV threshold, no "far from home" radius and no trip detector in code.
- **Tool output is turn-only.** The tool results (`turn_only_output`) never reach the tool ledger, memory, logs or storage.
- **What Waldo says is not turn-only.** A reply that names the city ("you're in Bengaluru today") lands in the chat history like any other message, under the existing forget paths. The same goes for anything the owner says ("I'm in Bengaluru till Friday"), which the model may remember as it does today.
- **Owner decision:** whether a change of city or time zone should bring Waldo's next look forward. That would be the only new wake-up. v1 says no; the next 90-minute look sees it.

### 5. Place history: room for v1.1

v1 keeps only the latest place. Learning the owner's routines (home, work, gym, the usual Tuesday) is what makes suggestions feel smart, and needs a history. The room for it is named now.

**The v1.1 purpose: `place_history`.**
- It is opt-in on its own consent line, granted on top of storage.
- It keeps a daily city log: one cell and place name per phone per local day, for 90 days, like screen time.
- The model reads it through `get_device_context` with a day range.
- Withdrawing it deletes the log and leaves the latest place.

**Why this needs no redesign.** The consent tables are keyed by `(signal, purpose)` as text with check constraints. The contract's purpose enum is additive under `app.v1`. So v1.1 needs:
- one additive migration (a widened check constraint and a `device_place_days` table);
- one enum value;
- one more line on the consent screen.

The routine itself (home, work) stays the model's reading of the log. It is never a stored "home" label.

### 6. Egress and privacy

| Destination | Gets | Never gets |
|---|---|---|
| Supabase health plane | The cell, place name, time zone, platform, device id and times | Latitude, longitude or a history (until §5) |
| Weather provider | The cell's centre, from the Worker's own address | The owner or device id, the place name or the phone's address |
| LLM provider (the owner's turn) | Place name, time zone, how old the reading is, the forecast summary | The cell or coordinates |
| Chat history | What Waldo or the owner wrote, as ordinary conversation | Tool output |
| Logs, traces, metrics, eval fixtures | Counts and closed error codes only | The cell, place name, time zone or forecast for an owner. Fixtures use synthetic cells |
| Memory (other than the owner's words), R2, browser jobs | Nothing from these tools | — |

Location is personal data, not ADR-0081 health data. It lives on the health plane anyway, for three reasons:
- that plane already gives a signed router, owner-cascade deletion (ADR-0055), a retention sweep, and forced RLS with no role access;
- it keeps place apart from the DO's model-written memory;
- each aggregate keeps one writer.

**Before production,** the privacy notice and the store listings must say four things:
- what is kept (the city-level cell, place name and time zone, latest only);
- which weather provider is called;
- that withdrawing deletes it;
- for §5 when it ships, the 90-day log.

### 7. Revoking, deleting, missing data

- **Withdraw:** see §2. The app then purges its local copy (§3).
- **Account deletion:** the owners cascade removes places, consents and receipts. Weather caches hold nothing linked to an owner.
- **Stale:** the tool gives the reading's age; whether a two-day-old place still holds is the model's call.
- **Phone off, or the OS permission denied:** nothing is sent. The last row stays until it expires, and the tool reports its age.
- **Receipts:** upload receipts are kept 7 days, because time-zone uploads arrive on every wake. Consent receipts are kept 90 days.

## Considered options

1. **Place in the owner's Durable Object SQLite.** The DO is the owner's authority root and has migrations. Rejected for v1:
   - the DO holds model-written memory;
   - the screen-time pattern already proves consent, epoch, retention and deletion on the health plane;
   - a second copy of the consent machinery would be a second representation of the same thing.
2. **The phone fetches weather (WeatherKit on iOS) and uploads it.** Rejected:
   - it needs the phone awake before the Brief;
   - it means two code paths, one per platform;
   - it puts the provider key in the app.
3. **A place history from day one.**
   - Deferred to an opt-in v1.1 purpose (§5), which the schema leaves room for.
   - v1 ships latest-only, so the consent stays simple while the app slices land.
4. **Geofences or background location for "you arrived" moments.** Rejected for v1:
   - they need permissions beyond coarse, plus store review, on both platforms;
   - an arrival trigger is a fixed rule about what matters.
5. **Coordinates rounded on the server.** Rejected: the finer value would reach the Worker. Rounding on the phone means the server never holds it.
6. **A separate consent screen for weather lookup.** Rejected, because the owner asked not to over-restrict. The one place consent names the provider, and the server keeps a separate withdrawal.
7. **iOS screen time on the server.** Not possible under Apple's terms. An on-device-only view inside the report extension is possible later; it never reaches the model.

## Consequences

**What Waldo gains:**
- It can suggest from the weather, the owner's city and the time zone. The time zone reaches it even when the app stays closed.
- Screen time is Android-only.
- Steps and trips need no new store.

**What it costs:**
- Location becomes a new kind of personal data on the health plane, and needs the privacy-notice and store lines before production.
- The weather provider is a new processor.
- Each tool adds to the prompt's tool budget, and is offered only while its switch is on.

## Verification (for the build slices)

- **Contract tests:** a valid and an invalid case for every schema, covering:
  - a cell one character too long;
  - a latitude field;
  - an extra key;
  - place names without a cell.
- **pgTAP, proving that:**
  - withdrawing storage deletes rows and receipts and moves the epoch;
  - an upload at the old epoch is refused;
  - model reads need both purposes;
  - a time-zone-only upload keeps the last cell;
  - an older reading never overwrites a newer one;
  - account deletion cascades.
- **Worker tests, proving that:**
  - the routes answer 404 with the switch off;
  - each route spends its own per-owner budget;
  - no log line carries a cell, a place name or a time zone.
- **Tool test:** output is turn-only, and unknown stays unknown.
- **Before production:**
  - the privacy notice and the store disclosures;
  - a device test on both platforms, including a time-zone upload from a background health sync.
