# Health calculation candidates

These are concrete, deterministic implementation candidates for owner review. The
versions are `recovery.candidate.v1`, `form.candidate.v1`, `weight.candidate.v1` and
`sleep-debt.candidate.v1`. Every result identifies `activation: candidate_unaccepted`
and `clinical_validation: not_established`. None is a medical, diagnostic,
productivity, causal or clinical validity claim. No numeric constants below are
represented as scientifically validated product weights.

The implementation is [calculations.ts](../../packages/runtime/src/health/calculations.ts)
and the synthetic golden/adversarial vectors are
[health-calculations.test.ts](../../packages/runtime/test/health-calculations.test.ts).
The health service may consume this module through an explicit trusted algorithm
configuration. Such integration does not ratify a version or change its candidate
status. Default production activation, live migration, model use and native/provider
acceptance remain separately controlled by the existing health consent and release
processes. Client supplied weights, algorithm names or consent epochs cannot grant
that authority. This module performs no IO, effects, persistence or logging.

## Authority and evidence boundary

[HEALTH_PLANE_AMENDMENT.md](HEALTH_PLANE_AMENDMENT.md) establishes Recovery first,
using sleep, HRV and RHR against the owner's history. It does not ratify numeric
normalizers. [CONSULT_VERDICTS.md](CONSULT_VERDICTS.md) retracts the previous
0.55/0.45 Recovery proposal. These candidates use new version names and do not
reintroduce that proposal as accepted source. Brain ADR0081 at inspected pin
`10f20c6a9c8792bb222a99c6b65cf9b89225be6d` specifies the earlier
`form.safte-fast.v1` component weights but does not supply the component
normalizers needed to derive the new Recovery product. These candidates do not
claim to implement that ADR or the proprietary SAFTE model.

The following primary sources motivate careful measurement handling. They do not
validate this implementation's equations, weights, freshness limits, baseline
maturity policy, or interpretation as capacity.

| Primary source | Relevant evidence and implementation limit |
| --- | --- |
| [Van Dongen et al., 2003, randomized sleep restriction experiment](https://pubmed.ncbi.nlm.nih.gov/12683469/) | Forty-eight adults underwent controlled restriction including fourteen consecutive restricted nights. Performance deficits accumulated. This supports retaining a multi-night record; it does not establish the linear recency weights below, the owner's sleep need, or a deficit-to-score conversion. The candidate makes no performance prediction. |
| [Herzig et al., 2018, parameter and sleep-stage HRV reproducibility](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2017.01100/full) | ECG/PSG measurements across three nights in fifteen young men showed that reproducibility depends on HRV parameter and sleep stage. This supports preserving measurement regime and method. RMSSD and SDNN remain separate; the candidate does not convert between them. |
| [Dial et al., 2025, wearable nocturnal RHR/HRV validation](https://pubmed.ncbi.nlm.nih.gov/40834291/) | Wearable measurements were compared with ECG across thirteen adults and 536 nights. Accuracy differed among devices and measures. Per-source baselines avoid implying interchangeable devices; this study does not validate Waldo scores or establish parity for an untested provider. |
| [Quer et al., 2020, longitudinal RHR cohort](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0227709) | The cohort of 92,457 adults showed substantial differences between people and narrower within-person variation. This supports examining personal history. The authors lacked clinical data for the observed increases; the candidate assigns no diagnosis or clinical meaning. |
| [Zeitzer et al., 2014, controlled circadian light experiment](https://pubmed.ncbi.nlm.nih.gov/25227334/) | A timed sequence of millisecond light flashes during sleep shifted measured melatonin timing in a small controlled study. Light effects depend on exposure context. Generic daylight minutes and sleep midpoint are insufficient to infer biological circadian phase; Form reports only a routine-relative candidate index. |
| [NASA Task Load Index, original paper-and-pencil package](https://ntrs.nasa.gov/citations/20000021488) | NASA-TLX treats subjective workload as multidimensional. Calendar duration, tasks, messages and physical load remain separate in Weight. This candidate is not NASA-TLX and does not infer subjective workload from source counts. |

## Typed serving boundary

The module exports `candidateCalculationInputSchema`, `CandidateCalculationInput`,
`CandidateObservation`, `CandidateSeries`, `CandidateMetric`,
`CandidateCalculationResult`, `CANDIDATE_VERSIONS`, `CANDIDATE_WEIGHTS` and
`calculateCandidate(untrusted: unknown)`.

Each request has a discriminant `kind` (`recovery`, `form`, `weight` or
`sleep_debt`) and these required fields:

```ts
{
  owner_ref: string;       // server derived, admitted authenticated owner
  consent_epoch: number;   // positive, current storage/compute epoch
  day: string;            // ISO local date; must match as_of in timezone
  timezone: string;       // valid IANA timezone
  as_of: string;          // ISO timestamp supplied by trusted service clock
}
```

A series is `{ current: CandidateObservation | null, history:
CandidateObservation[] }`. Each observation contains:

```ts
{
  owner_ref: string; consent_epoch: number;
  source_ref: string; context_ref: string;
  metric: CandidateMetric; method: string; unit: string;
  day: string; timezone: string; observed_at: string;
  revision: number; value: number | null;
  sleep_ended_at?: string; // observed same-source asleep-union end, for waking date
}
```

`source_ref` identifies an admitted source/account/device regime, not a user
supplied authorization token. `context_ref` identifies a comparable measurement
regime: for example overnight ECG HRV, or accumulated activity through the same
local noon cutoff. The supplier must change the regime when device, aggregation,
sampling window or provider calculation changes. The calculator can check identity
and equality; it cannot prove that a supplier's descriptive labels are truthful.

The service must derive the owner, validate consent/source scope, supply admitted
data, and recheck the epoch after any asynchronous external supplier work before
returning, storing or sending a result. Computing a candidate grants neither model
processing nor calendar/message effects. Raw inputs and outputs remain sensitive
health data under the existing custody policy, never DO storage, traces or R2.

## Common measurement and baseline policy

- Objects are strict, arrays bounded, timestamps/dates/timezones validated, values
  finite and units/methods explicit. Schema bounds are engineering input limits,
  not health reference ranges. Missing signals are `null`, never fabricated zero.
  A real observed zero is permitted for duration, count, load and self-report.
- Every observation must match the server owner and epoch. Its timestamp's local
  date must equal its stated day, except admitted overnight signals may use their
  actual `sleep_ended_at` waking date within the 36-hour window. The timezone must
  match the request, and neither timestamp may be later than `as_of`. Travel/timezone changes require a newly comparable
  history; this version does not silently reinterpret old local dates.
- For each series, current and history must share source, metric, method, unit and
  context. Current must belong to the requested local day. Overnight inputs are
  at most 36 hours old; intraday/demand inputs at most 6 hours old. These limits
  are candidate product choices.
- Baselines use all distinct non-null prior days in the preceding 30 local dates,
  with at least 14 required. The current day is excluded. Higher daily revisions
  replace lower revisions, including deletion represented by `value: null`.
  Conflicting values or timestamps at the highest revision make the result
  unavailable. Older superseded conflicts cannot make the answer depend on order.
- No population baseline, source blending, RMSSD/SDNN conversion, gap filling,
  partial-score renormalization or inferred self-report is used. All score
  components are required. Fourteen days and thirty days are candidate engineering
  parameters, not a claim that a personal baseline has matured clinically.

For a comparable personal baseline `x_1..x_n`, the mean is `mu = sum(x_i)/n`,
and the deviation is `sigma = sqrt(sum((x_i - mu)^2)/n)`. HRV uses `ln(ms)` for
both the current value and baseline. Other scalar measures use their stated units.
The candidate scale is:

```text
z                 = (current - mu) / sigma
directional(x, d) = clamp(50 + d * 20 * z, 0, 100)
routine_fit(x)    = clamp(100 - 20 * abs(z), 0, 100)
```

If a flat baseline's current value matches its mean, `z = 0`. If it differs,
normalization is unavailable (`baseline_variance_zero`); a made-up noise scale is
not substituted. The factor 20, directions and routine-fit interpretation are
explicit unvalidated mapping choices. Higher HRV and lower RHR are not universally
better; normal illness, training, medication and other changes can invalidate that
directional assumption.

Components are rounded to three decimal places before their weighted sum. Final
0..100 score rounding is half up (`Math.round` on nonnegative values). Result
components retain metric, unit, source, method, context, observation timestamp,
revision and distinct baseline days. Coverage `1` means required inputs passed
these checks; it is not a confidence or accuracy estimate.

## Recovery

Input adds `sleep`, `hrv`, `resting_heart_rate` (nullable series) and `sleep_need`.
Accepted candidate metrics and methods are:

| Metric | Unit | Method |
| --- | --- | --- |
| `sleep_minutes` | `minutes` | `asleep_duration` |
| `hrv_ms` | `milliseconds` | `rmssd` or `sdnn`, kept separate |
| `resting_heart_rate` | `beats_per_minute` | `overnight_resting`, `provider_resting_daily` or `resting_measurement`, each a distinct regime |

`sleep_need` must explicitly choose one basis:

```ts
{ basis: 'owner_confirmed', owner_ref, consent_epoch, minutes, confirmed_at }
// OR
{ basis: 'provisional_baseline' }
```

The confirmed target is supplied/confirmed by this owner in the current epoch,
positive and at most 1,440 minutes; confirmation cannot be in the future. It is a
target, not an established physiological need. The provisional reference is the
personal sleep mean. Habitual sleep can be chronically restricted; usual sleep
does not establish adequate sleep. Results preserve the selected basis.

```text
sleep_component = clamp(100 * actual_asleep_minutes / reference_minutes, 0, 100)
hrv_component   = directional(log_HRV, +1)
rhr_component   = directional(overnight_RHR, -1)
Recovery        = round(0.50*sleep + 0.30*hrv + 0.20*rhr)
```

Sleep, HRV and RHR all require their own complete comparable personal baselines.
Sleep efficiency, respiration and stress are not substituted for an absent signal.
This version does not map shortfall into Recovery again, avoiding an undocumented
second penalty; the separately returned debt index remains independently reviewable.

## Form

Input adds a complete `recovery` input group plus `sleep_midpoint`, `daylight`,
`motion`, `stress` (nullable series) and `intraday_context_ref`. The actual intraday
series must match that context. They must be admitted observations, not a copy of
Recovery or a synthetic noon placeholder.

| Metric | Unit | Method |
| --- | --- | --- |
| `sleep_midpoint` | `local_minute` in [0,1440) | `sleep_midpoint` |
| `daylight_minutes` | `minutes` | `daylight_duration` |
| `movement_minutes` | `minutes` | `active_minutes` |
| `stress_rating` | `rating_0_10` | `self_report_0_10` |

Sleep midpoint uses a circular mean on the 1,440-minute clock and shortest signed
differences in [-720,720). The deviation is the RMS circular difference. A circular
resultant below `1e-8` is ambiguous and unavailable. Thus 23:50 and 00:10 have a
midnight mean rather than a noon mean. This is sleep timing context, not a
measurement of circadian phase or chronotype.

```text
timing_fit    = routine_fit(circular_sleep_midpoint)
daylight_fit  = routine_fit(actual_daylight_minutes_at_matching_cutoff)
motion_fit    = routine_fit(actual_active_minutes_at_matching_cutoff)
stress        = directional(explicit_owner_stress_rating, -1)
Form          = round(0.40*unrounded_Recovery_components
                    + 0.10*timing_fit + 0.10*daylight_fit
                    + 0.20*motion_fit + 0.20*stress)
```

Recovery's three component weights are each multiplied by 0.40, with their sources
preserved. Form does not use the already rounded Recovery total. Routine-fit
rewards proximity to the owner's history, not healthy behavior. Beneficial exercise,
more light, changing schedules or a poor habitual routine can therefore move this
candidate in unintuitive directions. That limitation must be assessed before
product activation. Stress has to be an explicit report; message sentiment and
HRV cannot silently manufacture it. Absent or stale intraday inputs keep Form
unavailable without affecting a separately computed Recovery.

## Weight: actual day demand

Input adds `calendar`, `tasks`, `messages`, `physical_load` (nullable series).
Each is separately normalized against the owner's comparable history.

| Metric | Unit/method | Supplier obligation |
| --- | --- | --- |
| `calendar_minutes` | `minutes` / `union_busy_minutes` | Actual selected-account busy intervals for the local day; union overlaps before counting. Respect timezone, all-day and free/busy semantics. |
| `task_minutes` | `minutes` / `owner_estimated_due_minutes` | Tasks due in the local day with actual owner-provided estimates. Unknown estimates or incomplete pagination are missing data, not zero. |
| `message_count` | `count` / `requires_owner_response_count` | Actual scoped messages identified as requiring the owner's response. Preserve selected account and responsibility state; unread count is not a substitute. |
| `physical_load` | `source_units` / `provider_load` or `trimp` | Actual supported provider/workout-derived load in a single method/source regime. Never silently swap provider units or equate load with work capacity. |

```text
each demand_component = directional(actual_day_demand, +1)
Weight = round(0.35*calendar + 0.30*tasks + 0.15*messages + 0.20*physical_load)
```

High load means a higher Weight score. It does not mean better health or better
performance. The suppliers belong in the existing calendar/task/email/health
planes and approval architecture; the calculator neither searches accounts nor
creates a parallel task/responsibility brain. Incomplete or unauthorized sources
keep Weight unavailable. Real observed zero can be used only with evidence of a
complete scoped query. This version does not estimate minutes per message,
invent task duration, infer productivity or automatically reschedule anything.

## Fourteen-night weighted shortfall

Input adds `nights`, `sleep_need` and `reference_history`. Nights cover exactly the
requested local date and preceding thirteen dates; age 0 is the most recent night.
They use one `sleep_minutes` source/method/context regime. History is never silently
relabeled across timezones. `reference_history` must end before this window begins.

```text
w_age = 1 - age / 26                        for age 0..13
total_weight = 10.5
shortfall_age = max(0, reference_minutes - actual_sleep_minutes_age)
observed_weighted_shortfall = sum(w_age * shortfall_age) over observed nights
coverage = sum(w_age) over observed nights / 10.5
```

The latest night has weight 1 and the oldest 0.5. These linear recency weights are
an explicit candidate product choice, not an empirically established decay model.
Surplus sleep receives no credit against other nights' deficits; it is not an
assumed physiological recovery rate. Calendar dates, rather than elapsed 24-hour
intervals, handle local DST boundaries.

With an owner-confirmed target the interpretation is `shortfall_from_owner_target`.
With a provisional reference, the mean is derived from at least fourteen distinct
non-null nights among the thirty dates **before** the fourteen-night window. It is
`shortfall_from_usual_sleep`, not proof of physiological debt. This separation
prevents the restricted nights being tested from setting their own reference.

All fourteen nights present produces `state: available`, `debt_minutes` and
coverage 1. A missing or latest-revision-null night produces `state: partial`,
`debt_minutes: null`, explicit missing dates, observed count and the weighted
observed subtotal. No missing-night imputation, scaling up or coverage threshold
manufactures a complete total. If all nights are absent, a confirmed target can
still return partial with zero observed coverage and a null total. Provisional
reference maturity, source/method conflicts or bad identity remain unavailable.

Output includes exact weights in age order, unrounded reference minutes, source,
method/context and provisional baseline count. Reported totals/coverage are rounded
to three decimal places. An observed subtotal of zero with gaps is not zero debt.

## Result states and integration requirements

Score results have `state: available`, integer `score`, `coverage: 1`, component
provenance and `sleep_reference_basis`. Debt results use the fields above.
Valid but insufficient requests return `state: unavailable` with metadata and a
typed `reason` plus component name: missing signal, identity/epoch mismatch,
source/method/context mismatch, time/freshness failure, conflicting observations,
immature/flat/ambiguous baseline or absent sleep reference. Malformed requests return
only a privacy-safe `kind: invalid`/`invalid_input` object, never validation messages
that echo raw health data.

The production adapter must supply real serving datasets and independently tested
epoch fences. It must preserve these candidate version/status fields instead of
advertising `recovery.v1`, `form.safte-fast.v1` or accepted/native parity. Form and
Weight need actual authorized input suppliers; their pure typed calculation paths
cannot stand in for missing providers. No accepted algorithm receipt is present in
this document. Code review, exact-head tests, configured service acceptance, native
HealthKit/provider acceptance and scientific validation are distinct evidence.

Synthetic tests cover known numeric vectors, actual Form/Weight changes, circular
midnight and ambiguous timing, null/gap handling, explicit versus provisional sleep
references, source/method/owner/epoch/timezone separation, distinct-day maturity,
flat variance, revision order/conflicts, timestamp freshness and privacy-safe schema
failures. They prove implementation behavior only.

## Exact activation review target

[HEALTH_PRODUCTION_INTEGRATION.md](HEALTH_PRODUCTION_INTEGRATION.md) records the
exact source/vector fingerprints and strict host review receipt prerequisite. The
producer rejects bare strings, wrong fingerprints and incompatible versions. Native
source/read-origin, actual asleep union, waking date and resting method must first
be admitted by the signed ingestion rail; absent legacy evidence remains unknown.
A host-supplied receipt does not upgrade these candidates to clinically accepted
algorithms. The local synthetic receipt fixtures deliberately retain unaccepted
status, including Recovery, Form, Weight and sleep debt.
