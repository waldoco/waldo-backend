import { derivedSleepDebtTrendSchema, type DerivedSleepDebtTrend } from '@waldo/contracts';
import { DRIVER_SUBJECTS } from './scores/drivers';
import { shiftDay } from './scores/time';
import { STEADY_SCORE_MOVE } from './scores/zones';

// What changed in the owner's stored derived rows, decided from the rows alone and never recomputed. Code answers only
// "did something change that is worth the model's look"; whether it is worth telling the owner stays the model's call.
// Nothing here keeps a reading, a driver phrase or a figure: a result is a reason code.
export type HealthWakeReason = 'zone_change' | 'sleep_debt_building' | 'driver_appeared' | 'driver_far' | 'load_jump';
export const HEALTH_WAKE_REASONS: readonly HealthWakeReason[] = ['zone_change', 'driver_appeared', 'driver_far', 'load_jump', 'sleep_debt_building'];

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The derived-row writer admits exactly these phrases, so a driver that does not read as one is not one.
const PHRASE = new RegExp(`^(${DRIVER_SUBJECTS.join('|')})( far)? (above|below) usual$`);

// The sources a row was computed from, as one comparable word; empty when it names none.
export const basisSources = (basis: unknown): string =>
  (Array.isArray(basis) ? basis.flatMap(entry => (typeof record(entry)?.source === 'string' ? [record(entry)!.source as string] : [])).sort().join(',') : '');

// A row's drivers as the closed phrases only; null when the row carries none that can be read as a list.
export const driverPhrases = (raw: unknown): readonly string[] | null =>
  (Array.isArray(raw) ? raw.filter((phrase): phrase is string => typeof phrase === 'string' && PHRASE.test(phrase)) : null);

type Pillar = 'recovery' | 'form' | 'weight';
export type HealthSnapshot = Readonly<{
  day: string; sources: string; drivers: readonly string[] | null;
  zones: Readonly<Record<Pillar, string | null>>;
  load: Readonly<{ score: number; version: string }> | null;
}>;

// The model-use read of the newest row, reduced to what a wake compares. A row that does not read as one is nothing.
export const healthSnapshot = (raw: unknown): HealthSnapshot | null => {
  const context = record(record(raw)?.context);
  if (!context || typeof context.day !== 'string' || !DAY.test(context.day)) return null;
  const zoneOf = (pillar: Pillar) => { const zone = record(context[pillar])?.zone; return typeof zone === 'string' ? zone : null; };
  const weight = record(context.weight);
  const load = weight && typeof weight.score === 'number' && Number.isFinite(weight.score) && weight.score >= 0 && weight.score <= 100 && typeof weight.algorithm_version === 'string'
    ? { score: weight.score, version: weight.algorithm_version } : null;
  return { day: context.day, sources: basisSources(context.basis), drivers: driverPhrases(context.drivers), zones: { recovery: zoneOf('recovery'), form: zoneOf('form'), weight: zoneOf('weight') }, load };
};

// Two rows are comparable when they come from the same wearables and the earlier is today's or yesterday's, so a switch of
// wearable or a stale row never reads as a change.
const comparable = (before: HealthSnapshot | null, after: HealthSnapshot, today: string): before is HealthSnapshot =>
  before !== null && before.sources !== '' && before.sources === after.sources && (before.day === today || before.day === shiftDay(today, -1));

const plain = (phrase: string) => phrase.replace(' far ', ' ');
const driverWakes = (before: HealthSnapshot | null, after: HealthSnapshot, today: string): HealthWakeReason[] => {
  if (!comparable(before, after, today) || !before.drivers || !after.drivers) return [];
  const known = new Set(before.drivers.map(plain));
  return [
    ...(after.drivers.some(phrase => !known.has(plain(phrase))) ? ['driver_appeared' as const] : []),
    ...(after.drivers.some(phrase => phrase !== plain(phrase) && before.drivers!.includes(plain(phrase))) ? ['driver_far' as const] : []),
  ];
};

// A move of Weight inside its zone that is more than a steady move since the last upload today. A zone that moved is
// already a zone-change wake, and a score from another algorithm version is not a move.
const loadJump = (before: HealthSnapshot | null, after: HealthSnapshot, today: string): boolean =>
  comparable(before, after, today) && before.day === today && after.day === today
  && (['recovery', 'form', 'weight'] as const).every(pillar => before.zones[pillar] === after.zones[pillar])
  && before.load !== null && after.load !== null && before.load.version === after.load.version
  && Math.abs(after.load.score - before.load.score) > STEADY_SCORE_MOVE;

type Debt = Readonly<{ minutes: number; version: string; trend: DerivedSleepDebtTrend | undefined }>;
const debtOf = (answer: unknown, day: string): Debt | null => {
  const scores = record(record(answer)?.scores), debt = record(scores?.sleep_debt);
  return scores?.day === day && debt?.state === 'available' && typeof debt.debt_minutes === 'number' && Number.isFinite(debt.debt_minutes) && debt.debt_minutes >= 0
    && typeof debt.algorithm_version === 'string' ? { minutes: debt.debt_minutes, version: debt.algorithm_version, trend: derivedSleepDebtTrendSchema.safeParse(debt.trend).data } : null;
};
const rising = (newest: Debt | null, middle: Debt | null, oldest: Debt | null): boolean =>
  newest !== null && middle !== null && oldest !== null && newest.version === middle.version && middle.version === oldest.version && newest.minutes > middle.minutes && middle.minutes > oldest.minutes;

// Sleep debt is building the day the row's own direction word first says so. A row with no readable word, from before the
// producer wrote one, is judged by its figures: they have risen on each of the last two steps and were not already doing so
// a day earlier, so a long run of worse nights is one wake. Only whole days of one method on consecutive local days count; a
// missing, partial or figureless row ends the question. Rows are read by calendar day and only as far as the answer needs.
const debtBuilding = async (today: string, read: (day: string) => Promise<unknown>): Promise<boolean> => {
  const at = async (back: number) => { const day = shiftDay(today, -back); return debtOf(await read(day), day); };
  const latest = await at(0);
  if (!latest) return false;
  if (latest.trend !== undefined) return latest.trend === 'building' && (await at(1))?.trend !== 'building';
  const middle = await at(1);
  if (!middle || middle.version !== latest.version || latest.minutes <= middle.minutes) return false;
  const oldest = await at(2);
  if (!rising(latest, middle, oldest)) return false;
  return !rising(middle, oldest, await at(3));
};

export const detectHealthWakes = async (input: Readonly<{
  before: HealthSnapshot | null; after: HealthSnapshot; today: string; readDebt: (day: string) => Promise<unknown>;
}>): Promise<HealthWakeReason[]> => [
  ...driverWakes(input.before, input.after, input.today),
  ...(loadJump(input.before, input.after, input.today) ? ['load_jump' as const] : []),
  ...(await debtBuilding(input.today, input.readDebt) ? ['sleep_debt_building' as const] : []),
];
