# Health production candidate: custody and integration

Source base: `1206d7a8e7577fe23ed454c328007767507b9101`. This is an implemented,
locally tested candidate; it is not deployed, a physical-device receipt, or consent
to activate real health processing for outside users. The owner has authorized
the code/design work. Live migration application still requires the exact reviewed
migration receipt and release coordination.

## Serving contract

`packages/contracts/src/health/ingest.ts` owns strict DTOs. The authenticated
Worker calls `createHealthProduction(signedRpc(env), serverDerivedDoName)` and
`healthProductionRequest(request, service)`. The caller must verify the current
app session and rate-limit by owner before entering this adapter. It must preserve
the explicit health 98,304-byte streamed-body bound; the chat body's smaller limit
must not truncate health backfill batches. POSTs require `Idempotency-Key` equal
to `request_id`. Responses use `Cache-Control: no-store` and closed error codes.

Implemented operations:

| Operation | Exact route or internal method | Behavior |
| --- | --- | --- |
| Inspect consent | `GET /app/v1/health/consents` | Current source/purpose/epoch/status and timestamps; no invented grants |
| Grant | `POST /app/v1/health/consents` | Exact source, storage/model purpose, integer copy version, explicit 18+ attestation, expected epoch |
| Withdraw | `POST /app/v1/health/consents/withdraw` | Revokes both purposes for this source, raises both epochs, purges source data and compatible derived stores |
| Anchored sync | `POST /app/v1/health/ingest` | Zero to 128 changes; samples/deletion revisions; acknowledged before/after anchor; exact source/unit/method/local day |
| Latest summary | `GET /app/v1/health/today?source=apple` | Genuine absent data is null; failed store reads are unavailable; coverage is sourced |
| History | `GET /app/v1/health/history?source=apple&from=…&to=…&consent_epoch=…` | Up to 90 local dates per page; retained aggregate coverage survives raw expiry |
| Owner readings | `GET /app/v1/health/readings` with the same query | Bounded raw owner read from current epoch; count, `has_more`, and an owner/source/epoch/range/data-revision bound `next_cursor` |
| Model reading | `service.readings(query, 'model')` | Requires both current storage and model-processing purpose grants |
| Retention | `service.retention()` | Physically removes owner raw samples/tombstones after 90 days, aggregates after 24 months, old request receipts |
| Account health purge | `service.purge()` | Atomic all-source revoke/fence/purge; count-only receipt for the rights deletion ledger |

There are no owner, Auth-user, or DO-name fields accepted from the client. The
signed RPC resolves an active `waldo.owners.do_name` to its `auth_user_id`, then
the existing `public.users.auth_id` mapping. An absent mapping returns
`not_linked`; it does not manufacture an identity or consent. Owner provisioning
must establish this mapping through the canonical identity writer.

## Data plane and recovery

`supabase/fixtures/health-production-candidate.sql` is the promotion candidate.
It creates five tables in the existing Supabase plane, with forced RLS and no
direct client table privileges. Every read/write is an HMAC-bound
`waldo.health_plane` RPC using the existing router secret/publishable-key rail.
It locks the active owner row for the short database transaction; no network or
provider execution occurs under that lock. An admitted owner turn may process
volatile health inputs; raw data never enters durable owner DO storage, ordinary
checkpoints or transcripts. Fresh purpose/owner/session checks surround model use
and delivery through the protected health-serving adapter.

`health_scopes` joins the existing append-only canonical `user_consents` records
to per-source/purpose epochs. Regrant creates a new canonical row and increments
the epoch. Revocation changes status and increments epochs before any late
request can read or repopulate data. Withdrawn grants cannot be restored by replay;
fresh grants cannot admit an upload from the old epoch. Withdrawing either purpose
withdraws both purposes for that source and deletes its retained data. The app
must describe this scope before the withdrawal action.

`health_requests` stores only input digests and count/status receipts, never raw
request bodies. It distinguishes a duplicate from changed-body reuse. Sample
identity is `(owner, source, metric, sample_id)`; increasing revisions replace,
same-revision differences fail the entire transaction, and lower revisions are
ignored. Deletions retain value-free revision tombstones for 90 days. Owner/source
anchors advance atomically with accepted ingestion, including zero-change OS
queries. Clients persist only acknowledged server anchors and their associated
epoch; a conflict requires reconciliation, not blind replay or a fabricated ACK.

Per-sample timezone is retained in Supabase. A source/day containing incompatible
timezone assertions fails with `sample_conflict`; deleting a historical sample
does not relabel surviving samples with the current travel timezone. Daily
aggregation retains source/method, coverage/conflict evidence, and observed time.
Its timestamp is the latest actual sample observation, not the upload/read clock.
The producer consumes up to 44 complete aggregate dates and returns no duplicate
raw sample array. Recovery and Form use the preceding 30 dates; provisional
sleep shortfall uses up to 30 dates before the separate fourteen-night window.
The purpose-bound readings operation supplies raw context independently.

Withdraw/account purge removes the new raw, aggregate, anchor, and request custody
as applicable plus owner-mapped legacy `health_daily`, `crs_scores`,
`user_baselines`, and `health_context_daily`. Historical canonical consent evidence
and epoch barriers remain. Deletion of active context, qualitative patterns,
device SQLCipher caches, offline queues, and provider staging is a separately
tracked owner/device rights phase. A Supabase count receipt alone must not claim
those copies or third-party backups are gone.

## Native provenance, sleep admission and sync acknowledgment

Optional `sample.origin` preserves observed read origin independently of the selected
source: `read_api`, nullable `source_bundle_id`, `source_package_name`,
`source_version`, `source_revision`, digest-only `device_ref`, and
`recording_method`. Optional nullable `manufacturer`, `product_type`,
`client_record_version` and `sync_version` retain only actual observations.
`recording_method` preserves the raw Health Connect integer 0..3 or HealthKit
user-entered Boolean; other adapters use the explicit automatic/active/manual/unknown
vocabulary. Never rename every HealthKit producer Apple or every Health Connect
producer Google. HealthKit requires its actual producer bundle ID; Health Connect
requires its actual data-origin package. Missing legacy origin remains unknown.

[Apple source revision documentation](https://developer.apple.com/documentation/healthkit/hksourcerevision)
and [user-entered metadata](https://developer.apple.com/documentation/healthkit/hkmetadatakeywasuserentered)
describe separate source/version and recording metadata.
[Android record metadata](https://developer.android.com/health-and-fitness/health-connect/metadata)
and [data-origin reads](https://developer.android.com/health-and-fitness/health-connect/read-data)
are the primary source for Health Connect attribution. Native upload adapters must
supply observed metadata; these DTOs alone are not physical-device proof.

Optional `sample.sleep_context` contains `source_ref`, opaque `session_ref`,
`waking_day`, `reducer_version: asleep-interval-union.v1`, bounded distinct
`contributor_ids`, and actual `{contributor_id,start_at,end_at,kind:asleep|in_bed}`
intervals. Admission independently verifies the source, interval bounds and local
waking day. Actual asleep minutes use merged interval union, avoiding duplicate
stages. Efficiency requires an observed in-bed union containing asleep intervals;
an absent denominator is rejected. HRV RMSSD/SDNN and overnight resting heart rate
must occur inside the same-source asleep union. Provider daily resting or actual
resting measurement methods remain distinct; missing legacy methods remain unknown.
Stored aggregate observations retain actual origin, method, eligibility and sleep
end attribution. Stable producer/device/version changes separate baseline regimes;
per-record modification revisions remain provenance, not invented vendor identities.

A successful ingest receipt must match the submitted request ID, source, consent
epoch, exact `anchor_after`, and total accepted/deleted/ignored changes. The service
rejects a substituted receipt as unavailable. The client persists a new OS anchor
only after that receipt. On lost acknowledgment it retries the same request/body;
on revision/anchor/epoch conflict it reconciles, never advances by assumption.

## Calculation status and activation

The accepted beta amendment selects Recovery and permits untainted owner health
in model/owner replies. It does not define numerical normalization/weights or
the weighted 14-night debt algorithm. The earlier 0.55/0.45 Recovery proposal was
explicitly retracted; legacy app population curves are not silently promoted.

The default serving producer therefore returns real source coverage, freshness,
method-separated history, and an explicit unavailable reason. It never invents
a baseline maturity threshold or a score. `baseline.state = not_computed` and
`required_days = null` describe the current accepted registry state. Candidate
Recovery, intraday Form, day-demand Weight, and weighted sleep debt are implemented
and tested separately in `health/calculations.ts`; their documented choices and
scientific limits are in `HEALTH_CALCULATION_CANDIDATE.md`. Exact reviewed algorithm
versions, fixtures, and native/provider evidence must precede numerical serving.
Form and Weight are full calculation work, not removed final scope.

Trusted numeric candidate configuration is the fourth argument to
`createHealthProduction(call, doName, clock, calculations)`:
`{review_ref, review_receipt, versions: CANDIDATE_VERSIONS, sleep_need?, supplemental?}`.
A bare review string cannot activate numbers. `review_receipt` must pass
`healthCalculationReviewReceiptSchema` with the same review reference, exact
algorithm/source and vector digests, exact four versions, timestamp, and formula
and privacy review references. No real accepted receipt is present in this checkout;
test receipts are synthetic. Even after host admission, each numerical response
remains `activation=candidate_unaccepted`, `clinical_validation=not_established`.
The fingerprint binds a review target, not clinical acceptance.

The reviewed source target uses SHA-256 over each path, newline, exact file bytes,
newline, in order: `packages/runtime/src/health/calculations.ts`, then
`packages/runtime/src/health/producer.ts`. Its pin is
`d2401520e2f694f1e8d99dbba3f4d1ce455fd387887b09247617dc79c677511b`.
The same format over `packages/runtime/test/health-calculations.test.ts`, then
`packages/runtime/test/health-producer-integration.test.ts` gives vector pin
`0fdbeb14d895e10b0d374be7e6569bac643438d375ba240a3f61552e6db88ff0`.
Any relevant source/vector change requires a new exact independent review and pin.

`createHealthDemandCollector(host, clock)` supplies actual day-demand inputs to
`calculations.supplemental`. The host derives the authenticated owner, current
source-purpose/epoch and connection revision fence, selected Calendar/task accounts,
explicit owner-confirmed task estimates and actual response obligations. Calendar
busy intervals are unioned within real local day bounds, preserving DST; unread mail
is never substituted for obligations. Current provider state may only be captured
near the trusted current clock. Historical summaries read stored comparable demand
observations rather than stamping today's provider state with an old date. Comparable
historical baselines require the same timezone, account digest and local cutoff;
an inactive or changed source yields unavailable inputs rather than made-up zeros.
The host must schedule consistent owner cutoff capture and supply source facts;
the adapter does not authorize scheduler effects or new provider access.

History provides Slope graph inputs as genuine available pillar scores plus
component provenance, freshness and coverage. Preserve unavailable days as gaps
and retain candidate activation labels. There is no accepted Slope/numerical producer
receipt or native acceptance in this source; contracts and synthetic vectors do not
establish that evidence.

The service object's purpose-bound raw read is volatile. The model call and any
health-bearing owner delivery must recheck current session/owner/epoch/purpose
immediately before dispatch and after resume. It must not persist raw outputs in
the ordinary tool checkpoint, transcript, tracing, R2, browser job, third-party
draft, or bulk memory. Provider requests retain `store: false`. Ordinary observers
may receive enums, counts, and algorithm versions only. The existing owner-context
read connection must be fenced too; this module does not grant a bypass to the
legacy signed derived read.

## Verification and remaining operational proof

Executed against a new network-disabled, port-unpublished PostgreSQL container
using pinned local image `public.ecr.aws/supabase/postgres:17.6.1.155`, image digest
`sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`:
51 synthetic health assertions cover actual SQL consent, age/version evidence, two
owners, replay/body conflicts, anchors, source revisions, deletion resurrection,
raw-expired aggregate history, withdrawal/regrant epochs, ACLs, unsigned calls,
full stored Form/physical-load methods and contexts, zero observations, actual
native sleep interval union/source attribution/efficiency denominator, dense-day
export continuation, and the complete pre-window sleep reference. The separate
health-demand fixture covers 28 source/consent/freshness/purge assertions.
`assert-health-production-candidate.sql` uses `BEGIN/ROLLBACK` and discloses all
readings as synthetic fixtures. Runtime and contract tests additionally exercise
strict admission, byte limits, generic failures, restart without local cache,
null absence, raw-free summary responses, and malformed producer output.

Remaining proof: promote the candidate through the sole migration writer's
canonical migration lists; run the final independent exact-head security/health
review and full gates; apply only the approved staging receipt; wire the owner
retention scheduler for inactive owners, inspect actual provider/model/trace
negative sinks, and prove physical HealthKit consent/backfill/incremental/delete
and later real source adapters. Raw pages return at most 4,096 samples. Continue with the returned `next_cursor`
and identical source/date/epoch query until `has_more=false`. Cursor identity is
value-free; sample mutations invalidate it with `anchor_conflict`, requiring an
export restart. Never label an incomplete page a full export.
No new health provider, Health Connect client, or clinical validation is claimed.
