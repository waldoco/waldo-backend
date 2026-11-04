import type { DerivedSleepDebtTrend, FormZone, LoadZone, RecoveryZone } from '../../../../contracts/src/health/crs';

// Reasons come from the H1 contract's healthScoreUnavailableReasonV1Schema. Only those the math
// itself can produce appear here; the producer decides link and consent state and passes it in.
export type UnavailableReason =
  | 'not_linked' | 'consent_required' | 'consent_withdrawn' | 'no_readings' | 'baseline_immature'
  | 'missing_sleep' | 'missing_resting_signal' | 'stale_inputs' | 'conflicting_inputs'
  | 'intraday_inputs_unavailable' | 'calendar_demand_unavailable';

export type HealthAccess = 'granted' | 'not_linked' | 'consent_required' | 'consent_withdrawn';
export type HrvMethod = 'rmssd' | 'sdnn';
// asleep_hours_low is the producer's own, for a night with no measured resting rate; no phone or provider sends it.
export type RestingMethod = 'overnight_resting' | 'provider_resting_daily' | 'resting_measurement' | 'unknown' | 'asleep_hours_low';
export type TemperatureMethod = 'absolute' | 'baseline_delta';
// A reading is compared only with earlier readings of its own method: two methods measure two quantities.
export interface MethodReading<Method extends string> { readonly value: number; readonly method: Method }

export interface HourlyBucket {
  readonly startAt: string;
  readonly heartRate: number | null;
  // At most one reading per method: an hour can hold SDNN and RMSSD side by side.
  readonly hrvReadings: readonly MethodReading<HrvMethod>[];
  readonly daylightMinutes: number | null;
  readonly movementMinutes: number | null;
  readonly activeEnergyKcal: number | null;
}
export interface Span { readonly startAt: string; readonly endAt: string }
export interface SleepRecord extends Span {
  readonly asleepMinutes: number;
  // Local minute of day of the midpoint of the sleep, in that day's own time zone.
  readonly midpointMinute: number;
}
export interface DemandInputs {
  readonly meetingMinutes: number | null;
  readonly messageCount: number | null;
  readonly openTaskMinutes: number | null;
  readonly physicalLoad: number | null;
}
export interface DayRecord {
  readonly day: string;
  readonly timezone: string;
  readonly sleep: SleepRecord | null;
  // At most one reading per method: the night's newest of each.
  readonly overnightHrv: readonly MethodReading<HrvMethod>[];
  readonly restingHeartRate: readonly MethodReading<RestingMethod>[];
  readonly hourly: readonly HourlyBucket[];
  readonly workouts: readonly Span[];
  readonly demand: DemandInputs | null;
  // Signals that feed no score, only the drivers. Absent when the day was read without them.
  readonly vitals?: DayVitals;
}
// The night's readings belong to the day it ended on: breathing rate and blood oxygen are the mean of the readings inside
// that night's asleep span, wrist temperature the night's reading of each method, awake minutes the night's waking time.
export interface DayVitals {
  readonly breathingRate: number | null;
  readonly bloodOxygen: number | null;
  readonly wristTemperature: readonly MethodReading<TemperatureMethod>[];
  readonly awakeMinutes: number | null;
  readonly walkingHeartRate: number | null;
}
export interface DailyScoresInput {
  readonly access: HealthAccess;
  readonly targetDay: string;
  // The target day and the days before it. Order does not matter; a day appears at most once.
  readonly days: readonly DayRecord[];
  // An owner-confirmed sleep need. When null, the owner's own 14-day average stands in.
  readonly sleepNeedMinutes: number | null;
  // The newest instant the inputs were read, used only to judge freshness of intraday data.
  readonly asOf: string | null;
  // Off unless true. On, each component reads against the shared baseline from the owner's first day.
  readonly provisional?: boolean;
  // Off unless true, and only with provisional. On, the result also carries the parts of each available pillar (parts) and the
  // owner's usual bands (usual); every score, zone and coverage in it is the same as with them off.
  readonly parts?: boolean;
  readonly usual?: boolean;
}

export interface Unavailable { readonly state: 'unavailable'; readonly reason: UnavailableReason }
export interface UsedBasis {
  readonly signals: readonly string[];
  readonly days: readonly string[];
}
// Whether the owner's own days carry the pillar yet. Present only on a pillar computed provisionally.
export interface BaselineLabel {
  readonly state: 'provisional' | 'personal';
  // The fewest own days among the components the pillar used.
  readonly personal_days: number;
  readonly needed: number;
  // Whether a population prior took part in any used component.
  readonly prior: 'adults' | 'none';
}
export interface Available<Zone> {
  readonly state: 'available';
  readonly score: number;
  readonly zone: Zone;
  readonly algorithm_version: string;
  readonly activation: 'candidate_unaccepted' | 'accepted';
  // Share of the pillar's total weight that had usable inputs, 0 to 1.
  readonly coverage: number;
  readonly hrv_method: HrvMethod | null;
  readonly used: UsedBasis;
  readonly baseline?: BaselineLabel;
  // Provisional and asked for only. Carried to the day's result, which removes them from the pillar.
  readonly parts?: readonly PartRow[];
  readonly usual?: readonly UsualRow[];
}
export type RecoveryResult = Available<RecoveryZone> | Unavailable;
export type FormResult = Available<FormZone> | Unavailable;
export type WeightResult = Available<LoadZone> | Unavailable;
export interface SleepDebtResult {
  readonly state: 'available' | 'partial';
  readonly algorithm_version: string;
  readonly activation: 'candidate_unaccepted' | 'accepted';
  // Null while fewer nights than the version requires are observed.
  readonly debt_minutes: number | null;
  readonly observed_weighted_shortfall_minutes: number;
  readonly observed_nights: number;
  readonly coverage: number;
  readonly missing_nights: readonly string[];
  readonly sleep_need_minutes: number;
  // blended_average is the owner's own mean shrunk toward a prior, which is not their own average.
  readonly need_basis: 'owner_confirmed' | 'own_average' | 'blended_average';
  // Which way the debt has been going over the last two steps. Only on a provisionally computed debt.
  readonly trend?: DerivedSleepDebtTrend;
}
export interface DailyScores {
  readonly recovery: RecoveryResult;
  // Closed phrases naming signals outside the owner's usual range today, strongest first. Never a score weight.
  readonly drivers: readonly string[];
  readonly sleep_debt: SleepDebtResult | Unavailable;
  readonly form: FormResult;
  readonly weight: WeightResult;
  // Today's energy windows, clock times in the target day's zone. Only on a provisional computation; empty when there are none.
  readonly windows?: readonly { readonly start: string; readonly end: string; readonly kind: 'peak' | 'dip' }[];
  // Only on a provisional computation asked for them (DailyScoresInput.parts, .usual): the parts of each available pillar and
  // the owner's usual bands. They describe the scores above and change none of them.
  readonly components?: PartsByPillar;
  readonly usual?: readonly UsualRow[];
}

// What a component stood on, carried out of the computation that scored it: the signed distance from the owner's usual in
// spreads (null for a part judged against a need), the own days and the share of the centre that is the owner's own data
// (null when no baseline stands under it), the usual-signals it reads against, and the sleep need for the sleep part.
export interface PartBasis {
  readonly z: number | null;
  readonly own: number | null;
  readonly ownShare: number | null;
  readonly signals: readonly string[];
  readonly need?: Readonly<{ minutes: number; basis: 'owner_confirmed' | 'blended_average' }>;
}
export type Absent = 'no_reading' | 'baseline_immature';
// days_until_personal is the days short of the fourteen that make the usual the owner's own, so no client does the subtraction.
export type PartBaseline = Readonly<{ state: 'provisional' | 'personal'; own_days: number; own_share: number; days_until_personal: number }>;
export type PartDirection = 'above_usual' | 'usual' | 'below_usual';
export type PartRow =
  | Readonly<{
    key: string; state: 'available'; score: number; share: number; points: number; direction: PartDirection | null; signals: readonly string[];
    baseline: PartBaseline | null;
    need_minutes?: number; need_basis?: 'owner_confirmed' | 'blended_average';
  }>
  | Readonly<{ key: string; state: 'unavailable'; reason: Absent }>;
// One row of the app's screens made of two parts of a pillar: Resting State (HRV and resting heart rate, in Recovery) and
// Circadian (sleep midpoint and daylight, in Form). The fine parts stay as they are; a group is their sum.
export type GroupRow =
  | Readonly<{ key: 'resting_state' | 'circadian'; pillar: 'recovery' | 'form'; state: 'available'; score: number; share: number; points: number; direction: PartDirection | null; parts: readonly string[]; signals: readonly string[]; baseline: PartBaseline | null }>
  | Readonly<{ key: 'resting_state' | 'circadian'; pillar: 'recovery' | 'form'; state: 'unavailable'; reason: Absent }>;
export type PartsByPillar = Readonly<{ recovery?: readonly PartRow[]; form?: readonly PartRow[]; weight?: readonly PartRow[]; groups?: readonly GroupRow[] }>;
// One band of the owner's usual for a reading, in the shape the contract serves.
export interface UsualRow {
  readonly signal: string;
  readonly method: string | null;
  readonly state: 'provisional' | 'personal';
  readonly low: number;
  readonly centre: number;
  readonly high: number;
  readonly own_days: number;
  readonly own_share: number;
  readonly days_until_personal: number;
  readonly window_days: 30;
  readonly estimator: 'shrunk_predictive' | 'own_mean_sd';
}
