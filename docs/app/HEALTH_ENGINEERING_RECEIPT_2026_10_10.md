# Health engineering source receipt — 2026-10-10

This receipt describes the preserved dirty candidate at source base
`330b52d525887e91f1d8146493074ee7691b7bbd`. It is source and local engineering
evidence, not merged, deployed, clinical or physical-device evidence. Final
committed-head review and the release writer remain separate.

## Independent acceptance and configuration boundary

[Independent formula acceptance](health-reviews/HEALTH_FORMULA_RENEWAL_ACCEPTANCE.json)
and [the reviewer report](health-reviews/HEALTH_FORMULA_RENEWAL_REVIEW.md) were
written by `/root/independent_health_review`, not the implementation writer.
The renewed reference is
`health-formula-renewal-20261010-d2401520e2f6-0fdbeb14d895`, reviewed at
`2026-10-10T04:05:28.445969Z`. It records no open formula findings, 82 focused
tests, 140 independently implemented oracle vectors, and rejection of three
invalid explicit sleep-end probes. The prior independent review's invalid
sleep-end fallback finding was fixed; supplied attribution is now mandatory
when present and cannot fall back to the measurement date.

| Reviewed target | Exact SHA-256 or version |
| --- | --- |
| Algorithm and producer source | `d2401520e2f694f1e8d99dbba3f4d1ce455fd387887b09247617dc79c677511b` |
| Final calculation and producer vectors | `0fdbeb14d895e10b0d374be7e6569bac643438d375ba240a3f61552e6db88ff0` |
| Recovery | `recovery.candidate.v1` |
| Form | `form.candidate.v1` |
| Weight | `weight.candidate.v1` |
| Weighted sleep debt | `sleep-debt.candidate.v1` |
| Sleep admission reducer | `asleep-interval-union.v1` |

Each aggregate digest covers the documented ordered paths, newline, exact bytes,
newline; see [the integration document](HEALTH_PRODUCTION_INTEGRATION.md).
The reviewer independently reconstructed prior vector bytes and verified that
the final vector change only wraps seven unchanged synthetic observations in
strict schema parsing for their ISO8601 TypeScript brand.

Engineering acceptance may enable bounded candidate summaries when the trusted
host supplies a strict complete receipt with these exact pins, all four versions,
review timestamp, the real formula reference and a separately accepted privacy
reference. A digest or arbitrary reference string is not proof of review. Do not
accept activation configuration from an app, model or ordinary tool argument.
Missing or mismatched configuration leaves scores unavailable. Even a configured
engineering candidate returns `activation=candidate_unaccepted` and
`clinical_validation=not_established`; this receipt does not authorize clinical
claims or upload activation for outside users.

## Exact normalization and eligibility

| Rule | Implemented semantics |
| --- | --- |
| Comparable baseline | At least 14 distinct non-null prior local dates from the preceding 30-date window; current date excluded. Exact owner, consent epoch, timezone, source/device/version identity, method, unit and context must match. No population fallback, source blending, SDNN/RMSSD conversion or missing-signal imputation. |
| Revisions and conflicts | Highest revision for a date wins. A null latest observation remains missing; older data cannot resurrect it. Tied contradictory observations fail. Aggregate conflicting metrics are excluded. |
| Normalization | Population standard deviation; `z=(current-mean)/deviation`. HRV uses logarithms for both current and baseline. Directional components clamp `50+direction*20*z` to 0..100. Routine-fit components clamp `100-20*abs(z)` to 0..100. A flat baseline permits an identical current value with z=0; a different value is unavailable. |
| Rounding | Component scores round to three decimals; the final weighted sum rounds to an integer bounded 0..100. Form preserves the Recovery component weights instead of rounding an intermediate Recovery score. |
| Recovery | 0.50 actual asleep duration/reference, 0.30 logarithmic HRV with increasing direction, 0.20 resting heart rate with decreasing direction. Sleep reference is a current owner-confirmed target or explicitly provisional personal usual sleep; provisional reference is never called physiological need. |
| Form | 0.40 Recovery components, 0.10 sleep-midpoint fit, 0.10 daylight fit, 0.20 movement fit, 0.20 explicit self-reported stress with decreasing direction. Midpoint uses circular 1440-minute mean/deviation; an ambiguous circular baseline is unavailable. Intraday inputs require an actual matching context. Missing Form does not suppress separately available Recovery. |
| Weight | 0.35 unioned actual Calendar busy minutes, 0.30 due-day task minutes supported by explicit owner estimates, 0.15 actual requires-owner-response obligation count, 0.20 physiological provider-load/TRIMP. Unread counts and task note inference are not substitutes. Incomplete sources remain null; zero requires complete evidence. |
| Sleep debt | Fourteen local nights, weights `1-age/26` for ages 0..13; sum=10.5. Only positive reference-minus-asleep shortfall contributes; surplus does not erase debt. Coverage is observed weight/10.5. Missing nights yield partial coverage, a null total and explicit missing dates with the observed subtotal. A provisional reference uses at least 14 non-null dates in the separate 30-date window before the debt window. |
| Time and freshness | Overnight inputs at most 36 hours old; intraday/demand inputs at most six hours. Observations cannot follow `as_of`. If `sleep_ended_at` is supplied, it must be on the waking local date, at/after observation, at/before `as_of`, within 36 hours, and only on supported sleep-attributed metrics. |

The exact computations and limits are in
[calculations.ts](../../packages/runtime/src/health/calculations.ts) and
[producer.ts](../../packages/runtime/src/health/producer.ts). These are product
index candidates. Clinical validity, capacity prediction and wearable parity
remain unestablished.

## Native origin and server admission

| Input | Preserved origin and eligibility |
| --- | --- |
| HealthKit | `read_api=healthkit`; observed `HKSourceRevision.source.bundleIdentifier`, nullable actual version, observed revision/sync version only, actual `HKWasUserEntered` Boolean where present. Observed manufacturer/product type are optional. The read API alone never establishes the physiological producer. |
| Health Connect | `read_api=health_connect`; actual `metadata.dataOrigin.packageName`, actual last-modified revision and optional client-record version. Recording method preserves the observed integer 0 unknown / 1 actively recorded / 2 automatically recorded / 3 manual. |
| Device | Only observed descriptor digest/HMAC is accepted as `device_ref`; raw serial or invented vendor identity is not a device reference. Missing origin stays unknown. Source/device/version changes separate baselines; per-record modification/sync revisions remain provenance rather than baseline identity. |
| Sleep | Same-source, same-session actual asleep-stage intervals, waking local date, contributor IDs and reducer version. Server recomputes merged asleep union; duplicate or overlapping stages do not double count. Efficiency requires an actual in-bed union containing the asleep intervals. Missing denominator is rejected. |
| HRV | RMSSD and SDNN remain distinct methods. An overnight measurement must lie wholly within observed same-source asleep union. No conversion or attribution from a read API label. |
| Resting heart rate | `overnight_resting` requires actual same-source sleep attribution. `provider_resting_daily` and `resting_measurement` remain separately admitted methods and baseline regimes; they are never relabeled overnight. Missing/unknown method cannot produce an accepted numeric component. |
| Sync acknowledgment | Request ID, source, consent epoch, exact acknowledged anchor and accepted/deleted/ignored total must match before cursor persistence. Revision, anchor or epoch conflict requires reconciliation. Lost ACK retries identical request/body; it never advances an OS anchor by assumption. |

The server retains original field types; the DTO's legacy recording-method
vocabulary does not prove that a native client supplied the correct observed
platform metadata. Actual native-client extraction and physical-device journeys
are required before claiming that evidence. The current app native upload gate
must consume the reviewed next source pin and accepted eligibility/receipt
semantics; the old `330b52d5` checkpoint is not this complete candidate.

Primary documentation: [Apple source revision](https://developer.apple.com/documentation/healthkit/hksourcerevision),
[Apple user-entered metadata](https://developer.apple.com/documentation/healthkit/hkmetadatakeywasuserentered),
[Android metadata](https://developer.android.com/health-and-fitness/health-connect/metadata)
and [Android data-origin reads](https://developer.android.com/health-and-fitness/health-connect/read-data).

## Actual host activation and remaining integration

[owner-production.ts](../../packages/runtime/src/health/owner-production.ts)
composes the signed health service, protected demand writer and actual demand
collector through this exact API:

```ts
createOwnerHealthProduction({
  call: signedRpc(env),
  doName: serverDerivedAuthenticatedOwnerHandle,
  assertCurrent: canonicalOwnerSessionSourceCurrent,
  accounts: actualSelectedAccounts,
  google: actualCurrentAccountClient,
  ownerEstimates: explicitCanonicalOwnerEstimates,
  responses: canonicalRequiresOwnerResponseObligations,
}, trustedClock, { review_receipt, sleep_need: optionalActualOwnerTarget });
// Returns { health, activation, capture }.
```

The signed owner handle is also the calculation/demand owner reference. No
Telegram subject or client-supplied owner field may replace it. Each actual signed
RPC verifies the owner binding and calls the current guard before and after IO;
SQL independently locks/checks the active authenticated owner and source-purpose
epoch in its transaction. Model reads additionally require model-purpose consent.
18+ attestation and consent-copy version are explicit. Withdrawal fences both
purposes, purges source data and compatible derived stores, and prevents regrant
from reviving old epochs. External account revision changes are fenced before
supplier results become durable demand snapshots.

| Capability | Confirmed local result | Remaining serving/release evidence |
| --- | --- | --- |
| Recovery, Form, Weight and sleep debt | Actual owner adapter + producer + collector exercise all four numeric candidates with synthetic matching baselines and current supplier-port responses. 26 adapter/collector/producer tests pass; independent six-suite review passes 82 tests. | Root must configure both factories: direct app health routes in `channels/app-api.ts` and owner-turn health sources in `channels/telegram-owner-do.ts`. No complete real privacy/activation receipt was supplied by this implementation writer. |
| Demand capture | Real Calendar free/busy union over actual DST civil bounds, fully paged Tasks, explicit estimates and canonical response obligations; snapshots stay in protected signed Supabase custody. | Root's existing scheduler must invoke `capture` at a consistent actual cutoff. Historical facts must already exist with matching timezone/account digest/local cutoff; no provider backdating. |
| Historical Weight | Matching stored protected histories work in synthetic tests. Current provider state is never relabeled historical. | `today` uses current clock while `history` uses physiological `compiled_at`; mismatch in local cutoff leaves Weight unavailable. Align host capture/physiology cutoffs or independently review a protected retained snapshot design. This adapter does not close that operational gap. |
| Protected health replies | Explicit trusted `get_health`, source-current model phase, closed non-numeric operational projection, fresh general phase and typed volatile reply custody. Ordinary transcript/episode/cache bodies retain only notice. App raw readback uses a per-instance map with owner/session/conversation and revocation checks, five-minute maximum TTL, explicit restart loss. | Root serving call sites and exact-head privacy review must pass; actual approved provider/model/native delivery is separate. A raw-phase offload boundary regression at 16,019 bytes is fixed and tested. |
| App history/Slope | Available pillar points expose real component source/method/context/time/revision, baseline counts, coverage and unavailable gaps; raw readings retain detailed origin. | No accepted Slope numerical algorithm or physical-device origin receipt. Do not fabricate points, hide gaps or call metadata parity. |
| Protected database | Actual isolated synthetic SQL execution: health 51 + demand 28 assertions; full coordinated local owner/session/native/push/erasure receipt 177 assertions. Container remains stopped with data preserved. | Health and demand SQL are still promotion candidates under `supabase/fixtures`; canonical migration promotion, independent final-head review and approved staging application remain with the sole release writer. No shared reset or live application occurred. |

[HEALTH_HOST_INTEGRATION.md](HEALTH_HOST_INTEGRATION.md) provides exact supplier
ports and current-guard responsibilities;
[HEALTH_PROTECTED_OWNER_SERVING.md](HEALTH_PROTECTED_OWNER_SERVING.md) provides
privacy and delivery evidence. Runtime TypeScript passes after the final fixture
brand correction. Static privacy guard and its five dedicated sink regressions
pass. No CI, merged, staging, live provider, physical-device, clinical or retention
scheduler evidence is claimed by this source receipt.

Automatic approval review rejected adding a new autonomous/background raw-health
model destination because explicit approval of that sensitive disclosure was not
established. No rejected path was written or substituted. Native-health background
planning remains blocked pending recognized approval and independent serving
review; the existing explicit foreground protected serving path is distinct.
