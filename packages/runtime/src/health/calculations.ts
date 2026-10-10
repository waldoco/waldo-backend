import { z } from 'zod';
import { iso8601Schema } from '../../../contracts/src/core/error';
import { healthDaySchema, healthTimezoneSchema } from '../../../contracts/src/health/ingest';

// These are proposed product indexes. Calling this module never grants serving,
// clinical, diagnostic, effect or model-processing authority.
export const CANDIDATE_BASELINE_DAYS = 14;
export const CANDIDATE_BASELINE_WINDOW_DAYS = 30;
export const CANDIDATE_VERSIONS = {
  recovery: 'recovery.candidate.v1', form: 'form.candidate.v1',
  weight: 'weight.candidate.v1', sleep_debt: 'sleep-debt.candidate.v1',
} as const;
export const CANDIDATE_WEIGHTS = {
  recovery: { sleep: 0.5, hrv: 0.3, resting_heart_rate: 0.2 },
  form: { recovery: 0.4, circadian: 0.2, motion: 0.2, stress: 0.2 },
  weight: { calendar: 0.35, tasks: 0.3, messages: 0.15, physical_load: 0.2 },
} as const;

const metricSpecifications = {
  sleep_minutes: { unit: 'minutes', methods: ['asleep_duration'], maximum: 1440, positive: false },
  hrv_ms: { unit: 'milliseconds', methods: ['rmssd', 'sdnn'], maximum: 1000, positive: true },
  resting_heart_rate: { unit: 'beats_per_minute', methods: ['overnight_resting', 'provider_resting_daily', 'resting_measurement'], maximum: 300, positive: true },
  sleep_midpoint: { unit: 'local_minute', methods: ['sleep_midpoint'], maximum: 1439.999999, positive: false },
  daylight_minutes: { unit: 'minutes', methods: ['daylight_duration'], maximum: 1440, positive: false },
  movement_minutes: { unit: 'minutes', methods: ['active_minutes'], maximum: 1440, positive: false },
  stress_rating: { unit: 'rating_0_10', methods: ['self_report_0_10'], maximum: 10, positive: false },
  calendar_minutes: { unit: 'minutes', methods: ['union_busy_minutes'], maximum: 2880, positive: false },
  task_minutes: { unit: 'minutes', methods: ['owner_estimated_due_minutes'], maximum: 10080, positive: false },
  message_count: { unit: 'count', methods: ['requires_owner_response_count'], maximum: 100000, positive: false },
  physical_load: { unit: 'source_units', methods: ['provider_load', 'trimp'], maximum: 1000000, positive: false },
} as const;
export type CandidateMetric = keyof typeof metricSpecifications;
const metricSchema = z.enum(Object.keys(metricSpecifications) as [CandidateMetric, ...CandidateMetric[]]);
const referenceSchema = z.string().min(1).max(128);
const epochSchema = z.int().positive();
export const candidateObservationSchema = z.strictObject({
  owner_ref: referenceSchema, consent_epoch: epochSchema, source_ref: referenceSchema,
  context_ref: referenceSchema, metric: metricSchema, method: z.string().min(1).max(64),
  unit: z.string().min(1).max(40), day: healthDaySchema, timezone: healthTimezoneSchema,
  observed_at: iso8601Schema, sleep_ended_at: iso8601Schema.optional(), revision: z.int().nonnegative(), value: z.number().finite().nullable(),
}).superRefine((observation, context) => {
  const specification = metricSpecifications[observation.metric];
  if (observation.unit !== specification.unit || !(specification.methods as readonly string[]).includes(observation.method)) {
    context.addIssue({ code: 'custom', message: 'unsupported metric method or unit' });
  }
  if (observation.value !== null && (observation.value < 0 || observation.value > specification.maximum || (specification.positive && observation.value === 0) || (observation.metric === 'message_count' && !Number.isInteger(observation.value)))) {
    context.addIssue({ code: 'custom', message: 'invalid metric value' });
  }
});
export type CandidateObservation = z.infer<typeof candidateObservationSchema>;
const seriesSchema = z.strictObject({ current: candidateObservationSchema.nullable(), history: z.array(candidateObservationSchema).max(256) });
export type CandidateSeries = z.infer<typeof seriesSchema>;
const sleepNeedSchema = z.discriminatedUnion('basis', [
  z.strictObject({ basis: z.literal('owner_confirmed'), owner_ref: referenceSchema, consent_epoch: epochSchema, minutes: z.number().finite().positive().max(1440), confirmed_at: iso8601Schema }),
  z.strictObject({ basis: z.literal('provisional_baseline') }),
]);
const commonShape = {
  owner_ref: referenceSchema, consent_epoch: epochSchema, day: healthDaySchema,
  timezone: healthTimezoneSchema, as_of: iso8601Schema,
};
const recoveryShape = {
  sleep: seriesSchema.nullable(), hrv: seriesSchema.nullable(),
  resting_heart_rate: seriesSchema.nullable(), sleep_need: sleepNeedSchema.nullable(),
};
export const candidateCalculationInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...commonShape, kind: z.literal('recovery'), ...recoveryShape }),
  z.strictObject({ ...commonShape, kind: z.literal('form'), recovery: z.strictObject(recoveryShape), intraday_context_ref: referenceSchema,
    sleep_midpoint: seriesSchema.nullable(), daylight: seriesSchema.nullable(), motion: seriesSchema.nullable(), stress: seriesSchema.nullable() }),
  z.strictObject({ ...commonShape, kind: z.literal('weight'), calendar: seriesSchema.nullable(), tasks: seriesSchema.nullable(), messages: seriesSchema.nullable(), physical_load: seriesSchema.nullable() }),
  z.strictObject({ ...commonShape, kind: z.literal('sleep_debt'), nights: z.array(candidateObservationSchema).max(64),
    sleep_need: sleepNeedSchema.nullable(), reference_history: z.array(candidateObservationSchema).max(256) }),
]);
export type CandidateCalculationInput = z.infer<typeof candidateCalculationInputSchema>;
type Common = Pick<CandidateCalculationInput, keyof typeof commonShape>;
type RecoveryInput = Extract<CandidateCalculationInput, { kind: 'recovery' }>;
type CandidateKind = CandidateCalculationInput['kind'];
export type CandidateUnavailableReason = 'invalid_input' | 'missing_signal' | 'owner_mismatch' | 'epoch_mismatch' |
  'source_method_context_mismatch' | 'time_mismatch' | 'stale_signal' | 'conflicting_observations' |
  'baseline_immature' | 'baseline_variance_zero' | 'baseline_ambiguous' | 'sleep_reference_required';
type Failure = Readonly<{ reason: CandidateUnavailableReason; component: string }>;
type Metadata = Readonly<{
  kind: CandidateKind; algorithm_version: typeof CANDIDATE_VERSIONS[CandidateKind];
  activation: 'candidate_unaccepted'; clinical_validation: 'not_established';
  owner_ref: string; consent_epoch: number; day: string; timezone: string;
}>;
export type CandidateComponent = Readonly<{
  component: string; score: number; weight: number; baseline_days: number;
  source_ref: string; method: string; context_ref: string; metric: CandidateMetric; unit: string;
  observed_at: string; revision: number;
}>;
export type CandidateScore = Metadata & Readonly<{
  state: 'available'; kind: 'recovery' | 'form' | 'weight'; score: number; coverage: 1;
  components: readonly CandidateComponent[]; sleep_reference_basis: 'owner_confirmed' | 'provisional_baseline' | null;
}>;
export type CandidateDebt = Metadata & Readonly<{
  state: 'available' | 'partial'; kind: 'sleep_debt'; debt_minutes: number | null;
  observed_weighted_shortfall_minutes: number; observed_nights: number; coverage: number;
  missing_nights: readonly string[]; weights: readonly number[];
  sleep_reference_minutes: number; sleep_reference_basis: 'owner_confirmed' | 'provisional_baseline';
  source_ref: string | null; method: string | null; context_ref: string | null; reference_baseline_days: number | null;
  interpretation: 'shortfall_from_owner_target' | 'shortfall_from_usual_sleep';
}>;
export type CandidateCalculationResult = CandidateScore | CandidateDebt |
  (Metadata & Failure & Readonly<{ state: 'unavailable' }>) |
  Readonly<{ state: 'unavailable'; kind: 'invalid'; activation: 'candidate_unaccepted'; reason: 'invalid_input'; component: 'request' }>;

const DAY_MS = 86400000;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const bounded = (value: number) => Math.max(0, Math.min(100, value));
const dateAge = (day: string, reference: string) => (Date.parse(reference) - Date.parse(day)) / DAY_MS;
const shiftedDay = (day: string, offset: number) => new Date(Date.parse(day) + offset * DAY_MS).toISOString().slice(0, 10);
const localDay = (at: string, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const part = (type: string) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const metadata = (input: CandidateCalculationInput): Metadata => ({
  kind: input.kind, algorithm_version: CANDIDATE_VERSIONS[input.kind], activation: 'candidate_unaccepted',
  clinical_validation: 'not_established', owner_ref: input.owner_ref, consent_epoch: input.consent_epoch,
  day: input.day, timezone: input.timezone,
});
const failure = (reason: CandidateUnavailableReason, component: string): Failure => ({ reason, component });
const isFailure = (value: CheckedSignal | Failure): value is Failure => 'reason' in value;
const identityFailure = (observation: CandidateObservation, owner: Common): CandidateUnavailableReason | null => {
  if (observation.owner_ref !== owner.owner_ref) return 'owner_mismatch';
  if (observation.consent_epoch !== owner.consent_epoch) return 'epoch_mismatch';
  const sleepAttributed = observation.sleep_ended_at !== undefined && ['sleep_minutes', 'hrv_ms', 'resting_heart_rate'].includes(observation.metric)
    && localDay(observation.sleep_ended_at, observation.timezone) === observation.day
    && Date.parse(observation.observed_at) <= Date.parse(observation.sleep_ended_at)
    && Date.parse(observation.sleep_ended_at) - Date.parse(observation.observed_at) <= 36 * 3600000
    && Date.parse(observation.sleep_ended_at) <= Date.parse(owner.as_of);
  // Supplied sleep attribution is an invariant, never an optional shortcut that
  // can fall back to the measurement date when its waking end is invalid.
  if (observation.sleep_ended_at !== undefined && !sleepAttributed) return 'time_mismatch';
  if (observation.timezone !== owner.timezone || (observation.sleep_ended_at === undefined && localDay(observation.observed_at, observation.timezone) !== observation.day) || Date.parse(observation.observed_at) > Date.parse(owner.as_of)) return 'time_mismatch';
  return null;
};
const sameMeasurement = (left: CandidateObservation, right: CandidateObservation): boolean =>
  left.source_ref === right.source_ref && left.metric === right.metric && left.method === right.method && left.unit === right.unit && left.context_ref === right.context_ref;
const resolveDays = (observations: readonly CandidateObservation[]): Map<string, CandidateObservation> | null => {
  const days = new Map<string, CandidateObservation>();
  const conflicts = new Set<string>();
  for (const observation of observations) {
    const existing = days.get(observation.day);
    if (!existing || observation.revision > existing.revision) {
      days.set(observation.day, observation);
      conflicts.delete(observation.day);
    } else if (observation.revision === existing.revision && (observation.value !== existing.value || observation.observed_at !== existing.observed_at)) conflicts.add(observation.day);
  }
  return conflicts.size ? null : days;
};
const circularDelta = (value: number, center: number) => ((value - center + 2160) % 1440) - 720;
type CheckedSignal = Readonly<{ current: CandidateObservation & { value: number }; values: readonly number[]; baseline_days: number; center: number; deviation: number; transformed: number }>;
const checkedSignal = (owner: Common, series: CandidateSeries | null, metric: CandidateMetric, ageHours: number, windowEnd = owner.day): CheckedSignal | Failure => {
  if (!series?.current || series.current.value === null) return failure('missing_signal', metric);
  const current = series.current as CandidateObservation & { value: number };
  if (current.metric !== metric) return failure('source_method_context_mismatch', metric);
  const problem = identityFailure(current, owner);
  if (problem) return failure(problem, metric);
  if (current.day !== owner.day) return failure('time_mismatch', metric);
  if (Date.parse(owner.as_of) - Date.parse(current.observed_at) > ageHours * 3600000) return failure('stale_signal', metric);
  for (const observation of series.history) {
    const identityProblem = identityFailure(observation, owner);
    if (identityProblem) return failure(identityProblem, metric);
    if (!sameMeasurement(current, observation)) return failure('source_method_context_mismatch', metric);
    if (observation.day >= windowEnd) return failure('time_mismatch', metric);
  }
  const days = resolveDays(series.history);
  if (!days) return failure('conflicting_observations', metric);
  const values = [...days.values()].filter(observation => observation.value !== null && dateAge(observation.day, windowEnd) >= 1 && dateAge(observation.day, windowEnd) <= CANDIDATE_BASELINE_WINDOW_DAYS).map(observation => observation.value!);
  if (values.length < CANDIDATE_BASELINE_DAYS) return failure('baseline_immature', metric);
  const transform = metric === 'hrv_ms' ? Math.log : (value: number) => value;
  // Repeated floating-point summation can manufacture tiny variance for an
  // exactly constant log/circular baseline and change its score by a full z unit.
  const first = values[0]!;
  if (values.every(value => value === first)) {
    const center = transform(first);
    return { current, values, baseline_days: values.length, center, deviation: 0,
      transformed: metric === 'sleep_midpoint' ? center + circularDelta(current.value, center) : transform(current.value) };
  }
  const transformedValues = values.map(transform);
  let center = transformedValues.reduce((sum, value) => sum + value, 0) / values.length;
  if (metric === 'sleep_midpoint') {
    const sine = values.reduce((sum, value) => sum + Math.sin(value * Math.PI / 720), 0) / values.length;
    const cosine = values.reduce((sum, value) => sum + Math.cos(value * Math.PI / 720), 0) / values.length;
    if (Math.hypot(sine, cosine) < 1e-8) return failure('baseline_ambiguous', metric);
    center = ((Math.atan2(sine, cosine) * 720 / Math.PI) + 1440) % 1440;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + circularDelta(value, center) ** 2, 0) / values.length);
    return { current, values, baseline_days: values.length, center, deviation, transformed: center + circularDelta(current.value, center) };
  }
  const deviation = Math.sqrt(transformedValues.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length);
  return { current, values, baseline_days: values.length, center, deviation, transformed: transform(current.value) };
};
const normalizedScore = (signal: CheckedSignal, direction: 1 | -1 | 'fit'): number | Failure => {
  const delta = signal.transformed - signal.center;
  if (signal.deviation === 0 && delta !== 0) return failure('baseline_variance_zero', signal.current.metric);
  const zScore = signal.deviation === 0 ? 0 : delta / signal.deviation;
  return bounded(direction === 'fit' ? 100 - 20 * Math.abs(zScore) : 50 + direction * 20 * zScore);
};
const component = (name: string, signal: CheckedSignal, score: number, weight: number): CandidateComponent => ({
  component: name, score: round3(score), weight, baseline_days: signal.baseline_days,
  source_ref: signal.current.source_ref, method: signal.current.method, context_ref: signal.current.context_ref,
  metric: signal.current.metric, unit: signal.current.unit, observed_at: signal.current.observed_at, revision: signal.current.revision,
});
const sleepReference = (owner: Common, need: RecoveryInput['sleep_need'], baselineMinutes: number | null): { minutes: number; basis: 'owner_confirmed' | 'provisional_baseline' } | Failure => {
  if (!need) return failure('sleep_reference_required', 'sleep_need');
  if (need.basis === 'provisional_baseline') return baselineMinutes !== null && baselineMinutes > 0 ? { minutes: baselineMinutes, basis: need.basis } : failure('baseline_immature', 'sleep_need');
  if (need.owner_ref !== owner.owner_ref) return failure('owner_mismatch', 'sleep_need');
  if (need.consent_epoch !== owner.consent_epoch) return failure('epoch_mismatch', 'sleep_need');
  if (Date.parse(need.confirmed_at) > Date.parse(owner.as_of)) return failure('time_mismatch', 'sleep_need');
  return { minutes: need.minutes, basis: need.basis };
};
const recoveryComponents = (input: RecoveryInput): { components: CandidateComponent[]; basis: 'owner_confirmed' | 'provisional_baseline' } | Failure => {
  const sleep = checkedSignal(input, input.sleep, 'sleep_minutes', 36);
  if (isFailure(sleep)) return sleep;
  const reference = sleepReference(input, input.sleep_need, sleep.center);
  if ('reason' in reference) return reference;
  if (reference.minutes <= 0) return failure('sleep_reference_required', 'sleep_need');
  const hrv = checkedSignal(input, input.hrv, 'hrv_ms', 36);
  if (isFailure(hrv)) return hrv;
  const resting = checkedSignal(input, input.resting_heart_rate, 'resting_heart_rate', 36);
  if (isFailure(resting)) return resting;
  const hrvScore = normalizedScore(hrv, 1);
  if (typeof hrvScore !== 'number') return hrvScore;
  const restingScore = normalizedScore(resting, -1);
  if (typeof restingScore !== 'number') return restingScore;
  return { basis: reference.basis, components: [
    component('sleep', sleep, bounded(sleep.current.value / reference.minutes * 100), CANDIDATE_WEIGHTS.recovery.sleep),
    component('hrv', hrv, hrvScore, CANDIDATE_WEIGHTS.recovery.hrv),
    component('resting_heart_rate', resting, restingScore, CANDIDATE_WEIGHTS.recovery.resting_heart_rate),
  ] };
};
const score = (components: readonly CandidateComponent[]) => Math.round(bounded(components.reduce((sum, value) => sum + value.score * value.weight, 0)));

export const calculateCandidate = (untrusted: unknown): CandidateCalculationResult => {
  const parsed = candidateCalculationInputSchema.safeParse(untrusted);
  if (!parsed.success) return { state: 'unavailable', kind: 'invalid', activation: 'candidate_unaccepted', reason: 'invalid_input', component: 'request' };
  const input = parsed.data;
  const meta = metadata(input);
  if (localDay(input.as_of, input.timezone) !== input.day) return { ...meta, state: 'unavailable', ...failure('time_mismatch', 'request') };
  if (input.kind === 'recovery') {
    const calculation = recoveryComponents(input);
    if ('reason' in calculation) return { ...meta, state: 'unavailable', ...calculation };
    return { ...meta, kind: 'recovery', state: 'available', score: score(calculation.components), coverage: 1, components: calculation.components, sleep_reference_basis: calculation.basis };
  }
  if (input.kind === 'form') {
    const recovery = recoveryComponents({ ...input.recovery, ...commonFrom(input), kind: 'recovery' });
    if ('reason' in recovery) return { ...meta, state: 'unavailable', ...recovery };
    const components = recovery.components.map(value => ({ ...value, component: `recovery.${value.component}`, weight: value.weight * CANDIDATE_WEIGHTS.form.recovery }));
    const signals = [
      ['sleep_midpoint', input.sleep_midpoint, 'fit', CANDIDATE_WEIGHTS.form.circadian / 2, 36],
      ['daylight_minutes', input.daylight, 'fit', CANDIDATE_WEIGHTS.form.circadian / 2, 6],
      ['movement_minutes', input.motion, 'fit', CANDIDATE_WEIGHTS.form.motion, 6],
      ['stress_rating', input.stress, -1, CANDIDATE_WEIGHTS.form.stress, 6],
    ] as const;
    for (const [metric, series, direction, weight, maxAge] of signals) {
      const signal = checkedSignal(input, series, metric, maxAge);
      if (isFailure(signal)) return { ...meta, state: 'unavailable', ...signal };
      if (metric !== 'sleep_midpoint' && signal.current.context_ref !== input.intraday_context_ref) return { ...meta, state: 'unavailable', ...failure('source_method_context_mismatch', metric) };
      const value = normalizedScore(signal, direction);
      if (typeof value !== 'number') return { ...meta, state: 'unavailable', ...value };
      components.push(component(metric, signal, value, weight));
    }
    return { ...meta, kind: 'form', state: 'available', score: score(components), coverage: 1, components, sleep_reference_basis: recovery.basis };
  }
  if (input.kind === 'weight') {
    const components: CandidateComponent[] = [];
    const signals = [
      ['calendar_minutes', input.calendar, CANDIDATE_WEIGHTS.weight.calendar],
      ['task_minutes', input.tasks, CANDIDATE_WEIGHTS.weight.tasks],
      ['message_count', input.messages, CANDIDATE_WEIGHTS.weight.messages],
      ['physical_load', input.physical_load, CANDIDATE_WEIGHTS.weight.physical_load],
    ] as const;
    for (const [metric, series, weight] of signals) {
      const signal = checkedSignal(input, series, metric, 6);
      if (isFailure(signal)) return { ...meta, state: 'unavailable', ...signal };
      const value = normalizedScore(signal, 1);
      if (typeof value !== 'number') return { ...meta, state: 'unavailable', ...value };
      components.push(component(metric, signal, value, weight));
    }
    return { ...meta, kind: 'weight', state: 'available', score: score(components), coverage: 1, components, sleep_reference_basis: null };
  }
  const windowStart = shiftedDay(input.day, -13);
  const anchor = input.nights[0] ?? input.reference_history[0];
  for (const observation of [...input.nights, ...input.reference_history]) {
    const problem = identityFailure(observation, input);
    if (problem) return { ...meta, state: 'unavailable', ...failure(problem, 'sleep_minutes') };
    if (observation.metric !== 'sleep_minutes' || (anchor && !sameMeasurement(anchor, observation))) return { ...meta, state: 'unavailable', ...failure('source_method_context_mismatch', 'sleep_minutes') };
  }
  if (input.nights.some(observation => observation.day < windowStart || observation.day > input.day) || input.reference_history.some(observation => observation.day >= windowStart)) return { ...meta, state: 'unavailable', ...failure('time_mismatch', 'sleep_minutes') };
  const nights = resolveDays(input.nights);
  const referenceDays = resolveDays(input.reference_history);
  if (!nights || !referenceDays) return { ...meta, state: 'unavailable', ...failure('conflicting_observations', 'sleep_minutes') };
  let baselineMinutes: number | null = null, referenceBaselineDays: number | null = null;
  if (input.sleep_need?.basis === 'provisional_baseline') {
    const baseline = [...referenceDays.values()].filter(observation => observation.value !== null && dateAge(observation.day, windowStart) >= 1 && dateAge(observation.day, windowStart) <= CANDIDATE_BASELINE_WINDOW_DAYS);
    if (baseline.length < CANDIDATE_BASELINE_DAYS) return { ...meta, state: 'unavailable', ...failure('baseline_immature', 'sleep_need') };
    referenceBaselineDays = baseline.length;
    baselineMinutes = baseline.reduce((sum, observation) => sum + observation.value!, 0) / baseline.length;
  }
  const reference = sleepReference(input, input.sleep_need, baselineMinutes);
  if ('reason' in reference) return { ...meta, state: 'unavailable', ...reference };
  const weights = Array.from({ length: 14 }, (_, age) => 1 - age / 26);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let observedWeight = 0, shortfall = 0, observedNights = 0;
  const missingNights: string[] = [];
  for (const [age, weight] of weights.entries()) {
    const nightDay = shiftedDay(input.day, -age);
    const observation = nights.get(nightDay);
    if (!observation || observation.value === null) { missingNights.push(nightDay); continue; }
    observedNights += 1;
    observedWeight += weight;
    shortfall += Math.max(0, reference.minutes - observation.value) * weight;
  }
  return { ...meta, kind: 'sleep_debt', state: missingNights.length ? 'partial' : 'available',
    debt_minutes: missingNights.length ? null : round3(shortfall), observed_weighted_shortfall_minutes: round3(shortfall),
    observed_nights: observedNights, coverage: round3(observedWeight / totalWeight), missing_nights: missingNights,
    weights, sleep_reference_minutes: reference.minutes, sleep_reference_basis: reference.basis,
    source_ref: anchor?.source_ref ?? null, method: anchor?.method ?? null, context_ref: anchor?.context_ref ?? null, reference_baseline_days: referenceBaselineDays,
    interpretation: reference.basis === 'owner_confirmed' ? 'shortfall_from_owner_target' : 'shortfall_from_usual_sleep' };
};

const commonFrom = (input: Common): Common => ({ owner_ref: input.owner_ref, consent_epoch: input.consent_epoch, day: input.day, timezone: input.timezone, as_of: input.as_of });
