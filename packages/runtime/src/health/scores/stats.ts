export const BASELINE_DAYS = 14;
export const BASELINE_WINDOW_DAYS = 30;
const Z_LIMIT = 2.5;

export const clampScore = (value: number): number => Math.max(0, Math.min(100, value));
export const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const deviation = (values: readonly number[], center: number): number => Math.sqrt(mean(values.map(value => (value - center) ** 2)));

// A z-score against the owner's own history, limited to +-2.5 so one outlier cannot dominate.
// A flat history has no spread: the same value scores 0, any other value takes the limit.
const bounded = (delta: number, spread: number): number => {
  if (spread === 0) return delta === 0 ? 0 : Math.sign(delta) * Z_LIMIT;
  return Math.max(-Z_LIMIT, Math.min(Z_LIMIT, delta / spread));
};
export const zScore = (value: number, history: readonly number[]): number => {
  const center = mean(history);
  return bounded(value - center, deviation(history, center));
};
export const logZScore = (value: number, history: readonly number[]): number =>
  zScore(Math.log(value), history.map(entry => Math.log(entry)));

// Minutes around a 1440-minute clock, so 23:50 and 00:10 are 20 minutes apart.
const circularDelta = (value: number, center: number): number => ((value - center + 2160) % 1440) - 720;
export const circularZScore = (value: number, history: readonly number[]): number | null => {
  const sine = mean(history.map(entry => Math.sin(entry * Math.PI / 720)));
  const cosine = mean(history.map(entry => Math.cos(entry * Math.PI / 720)));
  if (Math.hypot(sine, cosine) < 1e-8) return null;
  const center = ((Math.atan2(sine, cosine) * 720 / Math.PI) + 1440) % 1440;
  return bounded(circularDelta(value, center), Math.sqrt(mean(history.map(entry => circularDelta(entry, center) ** 2))));
};

export const higherIsBetter = (z: number): number => clampScore(50 + 20 * z);
export const lowerIsBetter = (z: number): number => clampScore(50 - 20 * z);
// Closer to the owner's usual scores higher, in either direction.
export const nearUsual = (z: number): number => clampScore(100 - 20 * Math.abs(z));

export interface Component { readonly name: string; readonly score: number; readonly weight: number }
// Components that had usable inputs, renormalised; coverage is the share of weight present.
export const combine = (components: readonly Component[]): { score: number; coverage: number } => {
  const weight = components.reduce((sum, component) => sum + component.weight, 0);
  const total = components.reduce((sum, component) => sum + component.score * component.weight, 0);
  return { score: Math.round(clampScore(total / weight)), coverage: Math.min(1, Math.round(weight * 1e6) / 1e6) };
};
