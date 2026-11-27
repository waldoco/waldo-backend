import { healthSignalV1Schema } from '../app/health-ingest';

// The one list of the kinds of body data Waldo stores. The kinds themselves are the app contract's healthSignalV1Schema; this
// file adds what every other list needs to know about each kind, so the score engine, the database's closed lists, the read
// tool and the model's inventory all derive from, or are checked against, one place.
export type HealthSignal = (typeof healthSignalV1Schema.options)[number];

// How often a kind carries a value: one local hour, one night, one day, one session (a workout or a mindful session), or one
// reading at whatever time the device took it. An hourly kind is exactly the app contract's window signals.
export const HEALTH_SIGNAL_GRAINS = ['hour', 'night', 'day', 'session', 'reading'] as const;
export type HealthSignalGrain = (typeof HEALTH_SIGNAL_GRAINS)[number];

type Entry = Readonly<{ grain: HealthSignalGrain; words: string }>;
// words: how the model's inventory names the kind. Plain words, never a value.
export const HEALTH_SIGNALS = {
  sleep_duration: { grain: 'night', words: 'time asleep' },
  sleep_efficiency: { grain: 'night', words: 'sleep efficiency' },
  sleep_midpoint: { grain: 'night', words: 'sleep timing' },
  overnight_hrv: { grain: 'night', words: 'overnight heart rate variability' },
  resting_heart_rate: { grain: 'day', words: 'resting heart rate' },
  daylight_duration: { grain: 'hour', words: 'time in daylight' },
  movement_duration: { grain: 'hour', words: 'movement minutes' },
  heart_rate_window: { grain: 'hour', words: 'heart rate through the day' },
  hrv_window: { grain: 'hour', words: 'heart rate variability through the day' },
  spo2: { grain: 'reading', words: 'blood oxygen' },
  respiratory_rate: { grain: 'reading', words: 'breathing rate' },
  steps_window: { grain: 'hour', words: 'steps' },
  active_energy_window: { grain: 'hour', words: 'active energy' },
  workout: { grain: 'session', words: 'workouts' },
  wrist_temperature: { grain: 'night', words: 'wrist temperature' },
  walking_heart_rate_average: { grain: 'day', words: 'walking heart rate' },
  vo2_max: { grain: 'reading', words: 'cardio fitness' },
  heart_rate_recovery: { grain: 'reading', words: 'heart rate recovery after exercise' },
  mindful_duration: { grain: 'session', words: 'mindful minutes' },
  body_mass: { grain: 'reading', words: 'body weight' },
  body_fat_percentage: { grain: 'reading', words: 'body fat' },
  lean_body_mass: { grain: 'reading', words: 'lean body mass' },
  stand_hour: { grain: 'hour', words: 'stand hours' },
  nutrition: { grain: 'reading', words: 'food logged' },
  heart_rate_bins_window: { grain: 'hour', words: 'time in heart rate ranges through the day' },
  provider_recovery: { grain: 'night', words: "WHOOP's own recovery score" },
  provider_day_strain: { grain: 'day', words: "WHOOP's own day strain" },
  provider_sleep_need: { grain: 'night', words: "the sleep WHOOP said a night needed" },
  provider_sleep_performance: { grain: 'night', words: "WHOOP's own sleep performance" },
  provider_sleep_consistency: { grain: 'night', words: "WHOOP's own sleep consistency" },
  nap: { grain: 'session', words: 'naps' },
  skin_temperature: { grain: 'night', words: 'skin temperature in sleep' },
  height: { grain: 'reading', words: 'height' },
  max_heart_rate: { grain: 'reading', words: 'maximum heart rate estimate' },
} as const satisfies Readonly<Record<HealthSignal, Entry>>;

export const HEALTH_SIGNAL_NAMES = healthSignalV1Schema.options;
// Kinds only the score engine reads. An hour's heart-rate bins are the day load's raw input: the model reads the load they make
// and the hour's heart rate, so neither the read tool nor the inventory offers them.
export const HEALTH_ENGINE_ONLY_SIGNALS = ['heart_rate_bins_window'] as const satisfies readonly HealthSignal[];

// What a score names in a pillar's used signals, and the stored kinds each name stands on. The database's derived-row writer
// admits exactly these names, so a name joins here and in the writer's migration together; calendar, tasks and messages are
// demand the owner's connected apps give, not body data, so they stand on no stored kind.
export const HEALTH_SCORE_INPUTS = {
  sleep: ['sleep_duration'],
  hrv: ['overnight_hrv'],
  resting_heart_rate: ['resting_heart_rate'],
  sleep_midpoint: ['sleep_midpoint'],
  daylight: ['daylight_duration'],
  movement: ['movement_duration'],
  steps: ['steps_window'],
  stress: ['heart_rate_window', 'hrv_window'],
  calendar: [],
  tasks: [],
  messages: [],
  physical_load: ['active_energy_window', 'movement_duration', 'workout'],
} as const satisfies Readonly<Record<string, readonly HealthSignal[]>>;
export type HealthScoreInput = keyof typeof HEALTH_SCORE_INPUTS;
export const HEALTH_SCORE_INPUT_NAMES = Object.keys(HEALTH_SCORE_INPUTS) as readonly HealthScoreInput[];
