import { healthDailySummarySchema } from '../../../contracts/src/health/ingest';
import type { HealthDailySummary, HealthProducerDay, HealthSample } from '../../../contracts/src/health/ingest';
import { md5Hex } from '../channels/md5';
import { validHealthCalculationReview, type HealthCalculationReviewReceipt } from './calculation-review';
import { calculateCandidate, CANDIDATE_VERSIONS, CANDIDATE_BASELINE_DAYS } from './calculations';
import type { CandidateCalculationInput, CandidateCalculationResult, CandidateMetric, CandidateObservation, CandidateSeries } from './calculations';

type FormInput = Extract<CandidateCalculationInput, { kind: 'form' }>;
type WeightInput = Extract<CandidateCalculationInput, { kind: 'weight' }>;
type RecoveryInput = Extract<CandidateCalculationInput, { kind: 'recovery' }>;
export type HealthSupplementalInputs = Readonly<{
  form?: Pick<FormInput, 'intraday_context_ref' | 'sleep_midpoint' | 'daylight' | 'motion' | 'stress'>;
  weight?: Pick<WeightInput, 'calendar' | 'tasks' | 'messages' | 'physical_load'>;
}>;
export type HealthCalculationActivation = Readonly<{
  // This is host release configuration after exact algorithm/fixture review. It is
  // never accepted from an app payload or a model. Clinical validity is separate.
  review_ref: string;
  review_receipt: HealthCalculationReviewReceipt;
  versions: typeof CANDIDATE_VERSIONS;
  sleep_need?: RecoveryInput['sleep_need'];
  supplemental?: (request: Readonly<{ owner_ref: string; source: HealthProducerDay['source']; consent_epoch: number; day: string; timezone: string; as_of: string; physical_load: CandidateSeries }>) => Promise<HealthSupplementalInputs>;
}>;

const metricMapping: Readonly<Record<string, { metric: CandidateMetric; unit: string; method: string }>> = {
  sleep_duration: { metric: 'sleep_minutes', unit: 'minutes', method: 'unknown' },
  overnight_hrv: { metric: 'hrv_ms', unit: 'milliseconds', method: 'rmssd' },
  resting_heart_rate: { metric: 'resting_heart_rate', unit: 'beats_per_minute', method: 'unknown' },
  sleep_midpoint: { metric: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint' },
  daylight_duration: { metric: 'daylight_minutes', unit: 'minutes', method: 'daylight_duration' },
  movement_duration: { metric: 'movement_minutes', unit: 'minutes', method: 'active_minutes' },
  perceived_stress: { metric: 'stress_rating', unit: 'rating_0_10', method: 'self_report_0_10' },
  physical_load: { metric: 'physical_load', unit: 'source_units', method: 'provider_load' },
};
const originSource = (source: string, origin: HealthSample['origin']) => origin
  ? `${source}:${md5Hex(JSON.stringify(Object.fromEntries(Object.entries(origin).filter(([key]) => !['source_revision', 'client_record_version', 'sync_version'].includes(key)).sort(([left], [right]) => left.localeCompare(right)))))}`
  : `${source}:legacy_unknown_origin`;
const sampleMethod = (sample: HealthSample, fallback: string) => 'method' in sample ? sample.method ?? fallback : fallback;
const sampleContext = (sample: HealthSample) => 'context_ref' in sample ? sample.context_ref : 'overnight_daily';
const seriesFor = (data: HealthProducerDay, ownerRef: string, metric: keyof typeof metricMapping, historyDays = 30): CandidateSeries => {
  const mapping = metricMapping[metric]!;
  const observations: CandidateObservation[] = [];
  const blockedDays = new Set(data.aggregates.filter(day => day.conflicting_metrics.includes(metric as 'sleep_duration' | 'overnight_hrv' | 'resting_heart_rate')).map(day => day.day));
  const rawByDay = new Map<string, Set<string>>();
  for (const sample of data.samples) {
    if (sample.metric !== metric) continue;
    const values = rawByDay.get(sample.day) ?? new Set<string>();
    values.add(`${sample.value}:${sampleMethod(sample, mapping.method)}:${sampleContext(sample)}:${originSource(data.source, sample.origin)}`);
    rawByDay.set(sample.day, values);
  }
  for (const [day, values] of rawByDay) if (values.size > 1) blockedDays.add(day);
  for (const day of data.aggregates) {
    if (blockedDays.has(day.day) || !day.values || !day.observed_at || !day.timezone || day.values[metric as keyof typeof day.values] === undefined) continue;
    if (metric === 'overnight_hrv' && day.methods.length !== 1) continue;
    const evidence = day.observations?.[metric as keyof typeof day.observations];
    // A read API/vendor label or a legacy aggregate cannot establish overnight
    // attribution or physiological method. The ingest rail supplies this evidence.
    if (['sleep_duration', 'overnight_hrv'].includes(metric) && (!evidence?.origin || evidence.eligibility !== 'admitted_sleep_context')) continue;
    if (metric === 'resting_heart_rate' && (!evidence?.origin || !['admitted_sleep_context', 'admitted_resting_method'].includes(evidence.eligibility ?? 'unknown'))) continue;
    observations.push({
      owner_ref: ownerRef, consent_epoch: data.consent_epoch, source_ref: originSource(data.source, day.observations?.[metric as keyof typeof day.observations]?.origin),
      context_ref: day.observations?.[metric as keyof typeof day.observations]?.context_ref ?? 'overnight_daily', metric: mapping.metric,
      method: day.observations?.[metric as keyof typeof day.observations]?.method ?? (metric === 'overnight_hrv' ? day.methods[0]! : mapping.method),
      unit: mapping.unit, day: day.day, timezone: day.timezone, observed_at: day.observations?.[metric as keyof typeof day.observations]?.observed_at ?? day.observed_at,
      ...(evidence?.sleep_ended_at ? { sleep_ended_at: evidence.sleep_ended_at } : {}), revision: day.observations?.[metric as keyof typeof day.observations]?.revision ?? 0, value: day.values[metric as keyof typeof day.values]!,
    });
  }
  // Legacy/synthetic RPCs without aggregate values retain exact raw source data;
  // multiple source assertions for one day remain visible to conflict resolution.
  for (const sample of data.samples) {
    if (sample.metric !== metric || blockedDays.has(sample.day) || observations.some(observation => observation.day === sample.day)) continue;
    if (['sleep_duration', 'overnight_hrv'].includes(metric) && (!sample.origin || !sample.sleep_context)) continue;
    if (metric === 'resting_heart_rate' && (!sample.origin || sampleMethod(sample, mapping.method) === 'unknown')) continue;
    observations.push({ owner_ref: ownerRef, consent_epoch: data.consent_epoch, source_ref: originSource(data.source, sample.origin), context_ref: sampleContext(sample), metric: mapping.metric,
      method: sampleMethod(sample, mapping.method), unit: mapping.unit,
      day: sample.day, timezone: data.timezone, observed_at: sample.end_at, ...(sample.sleep_context?.intervals.some(interval => interval.kind === 'asleep') ? { sleep_ended_at: sample.sleep_context.intervals.filter(interval => interval.kind === 'asleep').map(interval => interval.end_at).sort().at(-1)! } : {}), revision: sample.revision, value: sample.value });
  }
  return { current: observations.find(observation => observation.day === data.day) ?? null, history: observations.filter(observation => observation.day < data.day && Date.parse(data.day) - Date.parse(observation.day) <= historyDays * 86400000) };
};
const zone = (kind: 'recovery' | 'form' | 'weight', score: number) => {
  const index = score >= 80 ? 0 : score >= 60 ? 1 : score >= 40 ? 2 : 3;
  return kind === 'recovery' ? ['excellent', 'solid', 'mixed', 'compromised'][index]
    : kind === 'form' ? ['energized', 'steady', 'flagging', 'depleted'][index]
      : ['peak', 'heavy', 'moderate', 'light'][index];
};
const publicPillar = (result: CandidateCalculationResult, reviewRef: string) => {
  if (result.state !== 'available' || result.kind === 'sleep_debt') {
    const reason = 'reason' in result ? result.reason : 'missing_signal';
    return { state: 'unavailable', reason: reason === 'owner_mismatch' || reason === 'epoch_mismatch' || reason === 'invalid_input' ? 'conflicting_inputs' : reason };
  }
  return {
    state: 'available', algorithm_version: result.algorithm_version,
    score: result.score, zone: zone(result.kind, result.score), review_ref: reviewRef,
    interpretation: 'personal_baseline_index', activation: result.activation, components: [...result.components], ...(result.sleep_reference_basis === null ? {} : { reference_basis: result.sleep_reference_basis }),
  };
};

// The actual Worker producer consumes current owner/source/epoch-bound Supabase
// data. It cannot enable a version by seeing a score or app/model claim.
export const produceReviewedHealthSummary = async (
  data: HealthProducerDay, summary: HealthDailySummary, ownerRef: string, asOf: string,
  activation: HealthCalculationActivation,
): Promise<HealthDailySummary> => {
  if (!validHealthCalculationReview(activation.review_receipt, activation.review_ref) || Object.entries(CANDIDATE_VERSIONS).some(([kind, version]) => activation.versions[kind as keyof typeof CANDIDATE_VERSIONS] !== version)) return summary;
  const common = { owner_ref: ownerRef, source: data.source, consent_epoch: data.consent_epoch, day: data.day, timezone: data.timezone, as_of: asOf, physical_load: seriesFor(data, ownerRef, 'physical_load') };
  const recovery = { sleep: seriesFor(data, ownerRef, 'sleep_duration'), hrv: seriesFor(data, ownerRef, 'overnight_hrv'), resting_heart_rate: seriesFor(data, ownerRef, 'resting_heart_rate'), sleep_need: activation.sleep_need ?? { basis: 'provisional_baseline' as const } };
  const recoveryResult = calculateCandidate({ owner_ref: ownerRef, consent_epoch: data.consent_epoch, day: data.day, timezone: data.timezone, as_of: asOf, kind: 'recovery', ...recovery });
  const extra = await activation.supplemental?.(common);
  const calculationCommon = { owner_ref: ownerRef, consent_epoch: data.consent_epoch, day: data.day, timezone: data.timezone, as_of: asOf };
  const daylight = seriesFor(data, ownerRef, 'daylight_duration');
  const storedForm = { intraday_context_ref: daylight.current?.context_ref ?? 'intraday_missing', sleep_midpoint: seriesFor(data, ownerRef, 'sleep_midpoint'), daylight, motion: seriesFor(data, ownerRef, 'movement_duration'), stress: seriesFor(data, ownerRef, 'perceived_stress') };
  const form = publicPillar(calculateCandidate({ ...calculationCommon, kind: 'form', ...(extra?.form ?? storedForm), recovery }), activation.review_ref);
  const weight = extra?.weight ? publicPillar(calculateCandidate({ ...calculationCommon, kind: 'weight', ...extra.weight }), activation.review_ref) : summary.weight;
  const debtSleep = seriesFor(data, ownerRef, 'sleep_duration', 43);
  const debt = calculateCandidate({ ...calculationCommon, kind: 'sleep_debt', nights: [...debtSleep.history.filter(night => Date.parse(data.day) - Date.parse(night.day) <= 13 * 86400000), ...(debtSleep.current ? [debtSleep.current] : [])], reference_history: debtSleep.history.filter(night => Date.parse(data.day) - Date.parse(night.day) >= 14 * 86400000), sleep_need: recovery.sleep_need });
  const debtSummary = debt.kind === 'sleep_debt' && (debt.state === 'available' || debt.state === 'partial') ? {
    state: debt.state, algorithm_version: 'sleep-debt.candidate.v1', debt_minutes: debt.debt_minutes,
    observed_nights: debt.observed_nights, coverage: debt.coverage, missing_nights: [...debt.missing_nights],
    reference_basis: debt.sleep_reference_basis, observed_weighted_shortfall_minutes: debt.observed_weighted_shortfall_minutes, reference_minutes: debt.sleep_reference_minutes, reference_baseline_days: debt.reference_baseline_days, activation: debt.activation, review_ref: activation.review_ref, interpretation: debt.interpretation,
  } : { state: 'unavailable', algorithm_version: 'sleep-debt.candidate.v1', debt_minutes: null, observed_nights: 0, coverage: 0, missing_nights: [], reference_basis: null, review_ref: activation.review_ref, interpretation: null };
  return healthDailySummarySchema.parse({ ...summary, recovery: publicPillar(recoveryResult, activation.review_ref), form, weight,
    baseline: { ...summary.baseline, state: recoveryResult.state === 'available' ? 'mature' : 'immature', required_days: CANDIDATE_BASELINE_DAYS },
    sleep_debt: debtSummary, calculation_review: { review_ref: activation.review_ref, clinical_validation: 'not_established' },
  });
};
