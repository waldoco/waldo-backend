# Health ingest, producer and read model: design for owner approval

Status: design note, 10 October 2026, revised after the owner's first decisions the same day (§6). No migration, no runtime change, no deployment. It implements nothing. Tags: **[verified]** read in source or docs at the stated pin; **[documented]** stated in Apple's iOS 27.0 SDK headers, as reported by the app lane; **[inference]** reasoned, not observed; **[proposed]** this note's recommendation.

Authority: `docs/app/HEALTH_PLANE_AMENDMENT.md` (beta rulings), the owner rulings of 10 October (§1), ADR-0081 and ADR-0082 as amended. The amendment already allows raw readings for 90 days in owner-only tables, so intraday window summaries need no new storage class on the backend. What does extend existing decisions is recorded in §6: the app's own decision that intraday data never leaves the device (recorded in the app repository, not here), and the consent copy and version. Under CLAUDE.md, health persistence that extends a decision needs bounded review, so slice H1 carries a short addendum to the amendment and the app lane updates its own record. Where a ruling conflicts with source, §3 says so.

## 1. Rulings this design answers

1. **Continuous, not one summary per day.** Health updates as it happens and drives proactive changes. A daily aggregate uploaded on app foreground cannot do that. Intraday readings arrive from OS background delivery (HealthKit, Samsung sync), each arrival is an event the backend can act on, and idempotency is per reading window, not per day.
2. **RMSSD is the canonical HRV.** SDNN is accepted only as a labelled fallback with its own baseline, never blended.
3. **Timezone travels with every upload** (IANA zone plus UTC offset at the reading). The owner-settings timezone stays the agent's default when they differ.
4. **Scores:** the backend is canonical for Recovery, Form and Weight (one formula, one writer, identical on iOS and Android; Weight needs calendar, messages and tasks that only the backend has). The app may show a provisional local score until the backend's arrives. This is the contracts lane's recommendation; decided as D2 (§6).
5. Standing: Recovery first; owner's own readings may reach model context and owner-channel replies, never traces of record beyond the staging text-capture ruling, third-party sends, long-term memory or R2; 90 days raw, 24 months aggregate; withdrawal purges; consent must be explicit and server-recorded.

## 2. What exists

**The app (waldo-app main, as read by the app lane; not run on a device) [verified by that lane, relayed].** One upload per local day: `day`, `source`, an `inputs` object (sleep stages and times, overnight HRV and its method, resting HR, steps, active energy, exercise minutes, SpO2, respiratory rate, daylight), and the app's own `form`/`recovery`/`weight` pillars with score, zone, drivers and confidence. Zones are mapped before sending to `low|moderate|good|high|unknown`. The app's Weight **score is demand** (strain / 21 × 100, high = heavy day) but its **zone word is readiness-oriented** (`readinessZone(100 − score)`), so a heavy day arrives as zone `low` with a high score [verified by the app lane from code]. No raw samples leave the phone today: the overnight beat-to-beat stream and the 24 h heart-rate series stay on the device by an earlier app decision. Uploads fire from the metrics query on launch or foreground only; there is no background delivery task. The app reads HRV as SDNN. Android (Samsung Health SDK) has no HRV, resting HR, respiratory rate or daylight; overnight RMSSD comes from the watch beat bridge. No timezone is sent. No backfill exists. The consent flag is local and defaults on; unmerged app PR #14 makes it fail closed. The legacy `health-sync` function writes to the older Supabase project, so nothing writes `public.health_context_daily` on the Waldo-MVP project today.

**The backend read side (beta-mvp `e24d6974`) [verified].** `waldo.health_context_read` (migration `20260928160000`) returns the latest `public.health_context_daily` row for an owner over the signed router rail. `channels/health-context.ts` redacts it to zone words and a trend, and #1014 puts that in the reply prompt on every surface. The row must carry a Form score, plus recovery and weight zone words from `low|moderate|good|high`; anything else degrades the whole material to absence. `compiled_at` is the row's `updated_at`, and #1012 uses it as the source's `produced_at`.

**PR #998's health slice [verified at head `fc4c2b9d`; it is a 279-file branch and is not being merged whole].** It already contains most of what this design needs, tested locally against a synthetic Postgres: `contracts/src/health/ingest.ts` (anchored sample sync: `request_id`, source, consent epoch, IANA timezone, anchors before and after, up to 128 samples and deletions per batch, per-sample revision, receipts), `supabase/fixtures/health-production-candidate.sql` (five tables in the `waldo` schema, forced RLS, signed RPC only; 51 pgTAP-style assertions in `assert-health-production-candidate.sql`), `health/producer.ts` and `health/calculations.ts` (candidate Recovery, Form, Weight and sleep debt, each labelled `candidate_unaccepted`, with no source blending and no RMSSD/SDNN conversion), `health/demand-collector.ts`, and the consent, purge and retention operations. It does not write `health_context_daily`; it only purges it.

## 3. Gaps between the rulings and what exists

| Ruling | Gap |
| --- | --- |
| Continuous | The app sends daily aggregates on foreground. #998's ingest is anchored samples, which fits, but its metric list has no intraday heart-rate or HRV windows, SpO2, respiratory rate or workouts, and nothing reacts when a batch lands. |
| Idempotency per reading window | #998 keys samples by `(owner, source, metric, sample_id)` with revisions and replays by `request_id`. That is per window if clients derive `sample_id` from the window. The app today keys by day, and a client-side revision counter resets on reinstall, after which a growing window would be ignored as a lower revision (§4.1). |
| RMSSD canonical | #998 carries `method: rmssd|sdnn` and separates baseline regimes. HealthKit's long-standing HRV type is SDNN, so on iOS 13 to 26 Apple reports only SDNN. iOS 27 and watchOS 27 add a native RMSSD type [documented]; before that RMSSD must be computed on the phone from heartbeat series (§4.2). |
| Timezone on every upload | #998 has a per-batch IANA zone and keeps it per sample, but fails the whole batch with `sample_conflict` when one source and day hold incompatible zones. That rejects an honest travel day. |
| Backend-canonical scores | #998's formulas are unaccepted candidates, and the reader needs all three pillars. See §5.4. |
| Consent refused server-side | #998 has per-source, per-purpose, per-epoch consent with an 18+ attestation. The app's default-on flag must not matter. |

## 4. Design

### 4.1 Wire: anchored sample sync, re-cut from #998

Adopt #998's DTOs as the base, in a **new app leaf file** `packages/contracts/src/app/health-ingest.ts`, reviewed with the app lane, additive only, leaving `core.ts` and `controls.ts` untouched.

- Route family `POST /app/v1/health/ingest`, `GET|POST /app/v1/health/consents`, `POST /app/v1/health/consents/withdraw`, with the app bearer (never Supabase auth), owner rate limit, the streamed 98,304-byte body bound, `Idempotency-Key` equal to `request_id`, `Cache-Control: no-store`, and closed error codes. Owner identity is derived server-side; the client never sends an owner, Auth user or DO name. [proposed, taken from #998's serving contract]
- Samples are **reading windows**. `sample_id` is stable per `(metric, window start, window end)` for aggregates and the OS record id (the HealthKit sample UUID [documented]) for point records. A window whose value grows (steps so far today) re-uploads with a higher `revision`; lower revisions are ignored; same-revision differences fail the batch. [proposed; matches #998 semantics]
- **Revision must survive a reinstall.** A client-side counter resets on reinstall, so a re-uploaded growing window would be ignored as a lower revision. For aggregate windows `revision` is the observation time in epoch seconds, which only grows; point records are immutable and use revision 0 unless the OS edits them. The same revision with identical content is an idempotent replay. [proposed; answers the app lane]
- Additive intraday metrics, set decided with the app lane from what each platform can deliver: `heart_rate_window` (min/mean/max over a short window), `hrv_window` (RMSSD, with `n_beats`), `spo2`, `respiratory_rate`, `steps_window`, `active_energy_window`, `workout`. **Window summaries, not beat-to-beat data**: the phone computes RMSSD from its beat series and uploads the value, the window and the beat count. Beat series and the full 24 h heart-rate stream stay on the device. [proposed]
- Every batch carries `timezone` (IANA) and each sample carries `utc_offset_minutes` at the reading, so a repeated hour at a DST change is not ambiguous. [proposed]
- Server and client both need the app's earlier decision that intraday data never leaves the device explicitly reversed, and the consent copy and `HEALTH_CONSENT_VERSION` raised so the owner consents to what is now sent (D1).

### 4.2 HRV

`rmssd` is the only method that feeds baselines and scores by default. `sdnn` is stored with its method label and gets its own baseline regime and lower confidence; a score computed from it carries `hrv_method: sdnn`, and nothing converts or blends the two. [owner decision D3]

Preference order on iOS, as reported by the app lane [documented API; cadence unverified]: (1) the native RMSSD quantity type on iOS and watchOS 27, which needs its own authorization (the app does not request it today) and whose Watch write cadence is undocumented; (2) on iOS 13 to 26, RMSSD computed on the phone from `HKHeartbeatSeriesSample`, where third-party access to Watch-recorded series and the Watch cadence are unproven until a device test; (3) SDNN uploaded labelled `sdnn`. Android computes RMSSD from the watch beat bridge.

### 4.3 Timezone and travel

- A reading's `day` is the civil date in the reading's own zone at the reading's offset. Aggregates group by that date. [proposed]
- A day that contains two zones is **allowed** and flagged `zone_changed`; it is not a `sample_conflict` and does not fail the batch. Historical samples are never relabelled with the current zone. [proposed; changes #998]
- The owner-settings timezone (`set_owner_settings`) stays the default for scheduling, quiet hours and what "today" means in a reply. When the latest upload's zone differs from it, the agent is told both zones as context and judges what to do. The backend never edits the owner's setting on its own. [proposed]

### 4.4 Scores and the read model

- The backend computes Recovery first, then sleep debt, Form and Weight, from stored aggregates, using #998's calculations as the starting point. The phone may show a provisional local score, labelled as such, until the backend's arrives and replaces it; it never uploads a phone-computed score as canonical (ADR-0081: a device score cannot become canonical by upload). Every result keeps its algorithm version and `candidate_unaccepted` label until a review receipt exists; the owner decides whether a labelled candidate may reach replies (D2).
- **`public.health_context_daily` stays the read model, and the backend producer is its only writer on the Waldo-MVP project.** The app must not write it by any path. Today `20260930134308` still grants `service_role` direct `insert` and `update` on it; slice H2 revokes that once the write RPC exists, so the RPC is the sole write path. A new signed write RPC, `waldo.health_context_write`, upserts one row per `(owner, day)`. The reader, #1014's prompt section and the app's existing display keep working unchanged. `compiled_at` remains the row's own compile time (`updated_at`), never the read time; a future stamp degrades to absence. [proposed]
- **Zone vocabulary is pinned in the contract.** Row pillars carry `zone` in `low|moderate|good|high|unknown`. The writer maps the backend's CRS words with one shared table (`excellent→high`, `solid→good`, `mixed→moderate`, `compromised→low`; load `light→low`, `moderate→moderate`, `heavy→good`, `peak→high`), the inverse of the reader's tables in `health-context.ts`. The tables move to `contracts` so reader and writer share one definition, with a round-trip test. Form's zone on the row is informational; the reader derives Form's zone from the score with `formZoneOf`. [proposed]
- **Direction is pinned by meaning, not only by words.** Weight is the day's demand (owner ruling, #1016), so a heavy day writes `high` and the reader says `peak`; a light day writes `low` and the reader says `light`. The app lane confirms that its Weight score is demand (high = heavy) but its zone word is readiness-oriented, so a heavy day arrives from the app as `low`, which the reader would call `light`. The writer therefore never copies the app's zone; it derives the zone from the backend's own demand score, and the app shows the backend's value labelled by its meaning, not by the zone word. [verified by the app lane from code]
- **Dependency owned by the read side:** `toContextHealthMaterial` returns null unless Form has a score and Recovery and Weight carry zone words. "Recovery first" would therefore write rows that the reader drops. Before the first Recovery-only row is useful, the reader must accept a partial row and report the missing pillars as unavailable. That change is in `health-context.ts` and the prompt section, owned by the contracts lane. [verified from source; proposed fix]

### 4.5 Where computation runs, and arrival events

The owner DO stays the one durable writer for the owner's aggregate; Supabase holds the health values.

1. The Worker route commits a batch through the signed `waldo.health_plane` RPC (one short transaction, no network I/O inside it) and returns the receipt.
2. After a commit with at least one accepted change, the route calls the owner DO with a **value-free** `health_arrived { source, local_days, metrics_touched }`. No readings, scores or zones in the event, its logs or its alarms.
3. The DO coalesces arrivals (at most one recompute per owner per N minutes, N tuned in the slice), reads aggregates over the signed RPC into volatile memory, computes the pillars, writes the read-model row, and records a value-free `health_changed` observation (day, which pillars crossed a zone, direction).
4. **Whether to tell the owner is model judgment**, through the existing proactive path under quiet hours, volume and current grants. No fixed rule decides it. The exact entry point is chosen in slice H5 after reading the proactivity code; it is unverified here.
5. Raw readings never enter durable DO SQLite, checkpoints, transcripts, R2, browser jobs or third-party sends. [proposed, from the amendment]

### 4.6 Consent, retention, purge

- An upload is refused unless the server holds a current explicit consent for that source with the `storage_compute` purpose at the epoch the batch names. A model read also needs `model_processing`. The client's default-on flag is irrelevant. Withdrawal revokes both purposes for the source, raises the epochs, purges source data, and fences late requests. [verified in #998; proposed to reuse]
- 90 days for raw samples and tombstones, 24 months for daily aggregates and scores, receipts shorter. An owner-inactive retention scheduler is required, or retention only runs for active owners. [verified in #998; scheduler proposed]
- Backfill: the app proposes 30 days oldest first in batches of at most seven days. #998's anchors support it. Pending D5.

### 4.7 Honest limits to state in product copy and tests

- **Cadence.** `enableBackgroundDelivery` takes immediate, hourly, daily or weekly, and the SDK header states that step count has a minimum of hourly, enforced silently. Per-type minimums for heart rate, HRV and sleep are not documented. Developer reports suggest minutes to about an hour for a Watch-recorded type, no delivery while the phone is locked, drops, and no background delivery on the Simulator [inference]. Samsung's sync timing is undocumented; Health Connect has no push and would need polling at 15 minutes or more [inference]. No measured latency exists without a device.
- **Realtime is bounded by delivery, not by where a formula runs.** The backend computes in milliseconds when `health_arrived` fires, so backend-canonical scores are as fresh as the upload that feeds them.
- A Simulator harness can prove the read and payload path with synthetic samples; it cannot prove background delivery or real Watch cadence.
- If the app is force-quit or the phone is off, nothing arrives. "Continuous" therefore means near-real-time within OS limits, with freshness stated. Reads carry the freshness limits already in #998 (sleep and resting inputs at most 36 h old; intraday inputs at most 6 h). Absence is truthful: a stale or missing input becomes an explicit unavailable reason, never an invented value.

## 5. Slices (each red-first, small, staging only)

| Slice | Content | Gate |
| --- | --- | --- |
| H1 | `contracts/src/app/health-ingest.ts`: DTOs, intraday metrics, offsets, error codes, shared zone-bridge tables, the amendment addendum, and the `app/pin.test.ts` update (it pins exactly five files; the app then pins six). Valid/invalid test pairs. | Contracts lane reviews, then the app lane re-pins |
| H2 | Migration `20261011xxxxxx_health_plane.sql`: five tables, `waldo.health_plane`, `waldo.health_context_write`, forced RLS, no client privileges, revoke `service_role` direct DML on `health_context_daily`, promoted from #998's fixture. pgTAP: its 51 assertions plus travel day, RMSSD/SDNN regimes, consent refusal, write RPC, unsigned calls, ACLs. | **Owner go before any hosted apply** |
| H3 | Worker routes under `/app/v1/health/*` with app bearer, rate limit, body bound, idempotency, closed errors, and a **score read route** (`GET /app/v1/health/scores`) returning each pillar's value, zone, `computed_at` (the row's own compile time), `algorithm_version` and confidence, Recovery first, so the app can replace its provisional score; absent data is explicit, not zero | After H1, H2 |
| H4 | Producer and writer: Recovery first, candidate labels, writes the read model | Owner D7; reader accepts partial rows |
| H5 | `health_arrived` to the owner DO, coalescing, `health_changed`, proactive entry | After H3, H4 |
| H6 | Retention scheduler, history and export reads, Galaxy source, backfill, withdrawal proof | After H5 |

Hot files: H5 touches `telegram-owner-do.ts` minimally; H1 never edits `contracts/app/core.ts` or `controls.ts`; `approvals.ts` is untouched.

## 6. Owner decisions

Decided on 10 October, relayed by the contracts session:
- **D1** intraday window summaries (never beat-to-beat) with new consent copy, a consent version bump and the amendment addendum: yes.
- **D2** the backend computes the official scores and the phone shows previews: no ADR-0081 amendment. The phone uploads readings on every background wake, including on-phone RMSSD windows, and may show a provisional local score labelled as such; the backend computes the canonical scores on `health_arrived`, and Waldo acts on those. Candidate-labelled scores may reach replies with their version.
- **D3** SDNN as a labelled fallback with its own baseline and lower confidence: yes.
- **D4** travel days allowed and flagged: yes.
- **D5** 30-day backfill, oldest first: yes.
- **D6** re-cut #998's health plane in these slices: yes.
- Background health delivery is approved for the app lane (native observer queries plus background delivery behind the new consent screen, with physical-device proof).

Still open:
- **D7. Zone bands.** Recovery, Form and Weight zones need bands pinned per `algorithm_version`; Form uses the ADR-0024 bands and the other two have none accepted. Recommended: start from the app's existing bands, label them candidate, and let the formula review ratify them. Until a band exists the zone is `unknown`, which the reader treats as absence.

## 7. Falsifiers (the first red tests per slice)

This section is the test plan. A docs-only pull request cannot carry failing tests, so each slice lands its red tests together with its code, in that order within the slice: the tests are written and shown failing first, then the code makes them pass.

- A batch for an owner without a current explicit consent record at the named epoch is refused, whatever the client sent. (H2, H3)
- Replaying a request with the same `request_id` and body returns the same receipt and changes nothing; the same id with a different body fails. (H2)
- A higher-revision window replaces; a lower one is ignored; a deletion cannot be resurrected by an older revision. (H2)
- SDNN and RMSSD samples for one day yield two baseline regimes and no blended value. (H2, H4)
- A source and day holding two zones is accepted, flagged `zone_changed`, and keeps each sample's own zone. (H2)
- The writer's zone words round-trip through the reader's bridge for every pillar and every zone. (H1, H4)
- Heavy demand writes `high` and is read as `peak`; light demand writes `low` and is read as `light`. The mapping is tested on both directions with a worked example, not only on the vocabulary list. (H1, H4)
- A row whose `compiled_at` is later than the turn snapshot degrades to absence; a fresh row's `compiled_at` equals its own `updated_at`. (H4)
- A Recovery-only row yields partial material with Form and Weight unavailable, not absence. (H4, reader)
- `health_arrived` carries no readings, scores or zones, and neither do its logs. (H5)
- Two arrivals inside the coalescing window cause one recompute. (H5)
- An unsigned call, a call from `authenticated` or `service_role` directly, and a cross-owner read all fail. (H2)
- Withdrawal purges raw, aggregate, anchor, receipt and the read-model row, and a late batch at the old epoch is refused. (H2, H6)
- A stale input yields an explicit unavailable reason, never a carried-forward value. (H4)

## 8. Not verified

No device, simulator or staging run supports any statement about delivery cadence or HealthKit behaviour. #998's 51 assertions were run by its authors against a local container, not re-run here. Per-type background-delivery minimums, whether third-party apps can read Watch-recorded heartbeat series, the iOS 27 RMSSD type's write cadence, Samsung Health SDK partner approval for production, and Health Connect coverage are unconfirmed. The staging Supabase project's actual `health_context_daily` rows and ACLs were not inspected. The proactive entry point for H5 was not read.
