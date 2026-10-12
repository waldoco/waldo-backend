import type { FormZone, LoadZone, RecoveryZone } from '../../../../contracts/src/health/crs';

// Reasons come from the H1 contract's healthScoreUnavailableReasonV1Schema. Only those the math
// itself can produce appear here; the producer decides link and consent state and passes it in.
export type UnavailableReason =
  | 'not_linked' | 'consent_required' | 'consent_withdrawn' | 'no_readings' | 'baseline_immature'
  | 'missing_sleep' | 'missing_resting_signal' | 'stale_inputs' | 'conflicting_inputs'
  | 'intraday_inputs_unavailable' | 'calendar_demand_unavailable';

export type HealthAccess = 'granted' | 'not_linked' | 'consent_required' | 'consent_withdrawn';
export type HrvMethod = 'rmssd' | 'sdnn';

export interface HourlyBucket {
  readonly startAt: string;
  readonly heartRate: number | null;
  readonly hrv: number | null;
  readonly hrvMethod: HrvMethod | null;
  readonly daylightMinutes: number | null;
  readonly movementMinutes: number | null;
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
  readonly overnightHrv: Readonly<{ value: number; method: HrvMethod }> | null;
  readonly restingHeartRate: number | null;
  readonly hourly: readonly HourlyBucket[];
  readonly workouts: readonly Span[];
  readonly demand: DemandInputs | null;
}
// One reading source's days, for Form's per-pillar source choice.
export interface FormSourceDays { readonly source: string; readonly days: readonly DayRecord[] }
export interface DailyScoresInput {
  readonly access: HealthAccess;
  readonly targetDay: string;
  // The target day and the days before it. Order does not matter; a day appears at most once.
  readonly days: readonly DayRecord[];
  // An owner-confirmed sleep need. When null, the owner's own 14-day average stands in.
  readonly sleepNeedMinutes: number | null;
  // When the inputs were read. Form judges the age of the night's sleep against it.
  readonly asOf: string | null;
  // The source of `days`. Form counts only sources in its confidence table.
  readonly source?: string | null;
  // Every source's days. When present, Form picks the best source per pillar from these instead of `days`.
  readonly formSources?: readonly FormSourceDays[];
}

export interface Unavailable { readonly state: 'unavailable'; readonly reason: UnavailableReason }
export interface UsedBasis {
  readonly signals: readonly string[];
  readonly days: readonly string[];
}
export interface Available<Zone> {
  readonly state: 'available';
  readonly score: number;
  readonly zone: Zone;
  readonly algorithm_version: string;
  readonly activation: 'candidate_unaccepted';
  // Share of the pillar's total weight that had usable inputs, 0 to 1.
  readonly coverage: number;
  readonly hrv_method: HrvMethod | null;
  readonly used: UsedBasis;
}
export type RecoveryResult = Available<RecoveryZone> | Unavailable;
// Confidence: coverage x share-weighted source confidence x freshness factor, to three places. `sources` are
// the sources whose pillars made the score.
export type FormResult = (Available<FormZone> & { readonly confidence: number; readonly sources: readonly string[] }) | Unavailable;
export type WeightResult = Available<LoadZone> | Unavailable;
export interface SleepDebtResult {
  readonly state: 'available' | 'partial';
  readonly algorithm_version: string;
  readonly activation: 'candidate_unaccepted';
  // Null while any of the 14 nights is missing.
  readonly debt_minutes: number | null;
  readonly observed_weighted_shortfall_minutes: number;
  readonly observed_nights: number;
  readonly coverage: number;
  readonly missing_nights: readonly string[];
  readonly sleep_need_minutes: number;
  readonly need_basis: 'owner_confirmed' | 'own_average';
}
export interface DailyScores {
  readonly recovery: RecoveryResult;
  readonly sleep_debt: SleepDebtResult | Unavailable;
  readonly form: FormResult;
  readonly weight: WeightResult;
}
