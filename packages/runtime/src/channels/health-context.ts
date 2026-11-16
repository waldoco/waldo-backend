import {
  derivedBaselineStateSchema,
  derivedEnergyWindowsSchema,
  derivedHealthDestinationViewSchema,
  derivedMissingPillarReasonSchema,
  HEALTH_SIGNAL_NAMES,
  HEALTH_SIGNALS,
  healthInventorySchema,
  derivedSleepDebtTrendSchema,
  formHealthViewSchema,
  fromRowZone,
  narrativeContextSchema,
  partialHealthNarrativeSchema,
  partialHealthSourceSchema,
  recoveryHealthViewSchema,
  type DerivedBaselineState,
  type DerivedHealthDestinationView,
  type DerivedMissingPillars,
  type DerivedSleepDebt,
  type FormHealthView,
  type HealthInventoryEntry,
  type PartialHealthPresent,
  type PartialHealthView,
  type RecoveryHealthView,
} from '@waldo/contracts';
import { isPartialHealth } from '../context-composer/prompt';
import type { ContextHealthMaterial, ZoneHealthMaterial } from '../context-composer/types';
import { TRAINING_LOAD_PHRASES } from '../health/scores/training-load';
import { shiftDay } from '../health/scores/time';
import { STEADY_SCORE_MOVE } from '../health/scores/zones';
import type { OwnerClock } from '../tools/live/get-context';
import { localIso } from './reminders';
import { md5Hex } from './md5';

// D5 health context read (Art-9 read-only slice): derived pillar results are stored in the
// read model; this channel reads them over the signed router rail and redacts them to the
// zone-word material the composer threads into the system prompt. Every string that could
// carry a number (drivers/tags) is dropped before it can ride the narrative. Absence is
// truthful: no rows, no link, or no readable Recovery compose as "no derived health context".

// ADR-0081 §2, aged when read because a row never changes once the phone stops sending: fresh for six hours after it
// was compiled while its day is still today or yesterday in its zone, expired three days after it was compiled, stale
// between. The row is recompiled when its inputs arrive, so its compile time stands in for their age; a compile time
// that cannot be read is expired, never fresh.
const HOUR_MS = 3_600_000;
export const rowFreshness = (compiledAt: unknown, day: string, timezone: string, now: number): 'fresh' | 'stale' | 'expired' => {
  const age = now - (typeof compiledAt === 'string' ? Date.parse(compiledAt) : Number.NaN);
  if (!(age <= 72 * HOUR_MS)) return 'expired';
  const recent = day === localIso(now, timezone).slice(0, 10) || day === localIso(now - 24 * HOUR_MS, timezone).slice(0, 10);
  return age <= 6 * HOUR_MS && recent ? 'fresh' : 'stale';
};

type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;

// The waldo.health_context_read RPC payload (supabase/migrations/20260928160000_waldo_health_context.sql).
export type HealthContextRow = Readonly<{
  context: Readonly<{
    id: string;
    day: string;
    form: unknown;
    recovery: unknown;
    weight: unknown;
    drivers: unknown;
    confidence: unknown;
    freshness: unknown;
    tags: unknown;
    // Read only when the row carries them: sleep debt as stored, and today's energy windows as clock ranges. The row's sleep
    // debt, its minutes included, reaches the Worker with the rest of this read only under live model-use consent; the prompt
    // is given a word for the amount and, when the row names one, a word for the direction, never the minutes.
    sleep_debt?: unknown;
    windows?: unknown;
    // The candidate training load: a closed phrase and method, or a closed reason, never a figure.
    training_load?: unknown;
    // The row's updated_at: when the app last compiled this derived context. It becomes the
    // narrative's compiled_at - the truthful as-of the prepareHealth provenance bound checks
    // against the turn's snapshot time, which a read-time stamp would always violate.
    compiled_at: unknown;
    // The consent basis the row was computed under: each source and its consent epoch. Only the source names are read.
    basis?: unknown;
  }> | null;
  previous: Readonly<{ day: string; form_score: unknown }> | null;
}>;

// Stored zone words map through the contracts bridge (one table for writer and reader). An
// unknown or foreign word is absence for that pillar, never a guess. Recovery is the spine:
// without it there is no material. Form and Load are added when readable and stated as
// unavailable otherwise, so a Recovery-first day still reaches the prompt.

// App-authored strings (drivers, tags) join the narrative only when they are pure words: no
// digits and no URLs, so a raw metric value can never reach the prompt through a label.
const wordOnly = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 80 && !/\d/.test(value) && !/https?:/i.test(value);

const wordList = (value: unknown, cap: number): readonly string[] => {
  if (!Array.isArray(value)) return [];
  const words = value.filter(wordOnly);
  return [...new Set(words)].slice(0, cap);
};

const pillarScore = (value: unknown): number | null => {
  if (value === null || typeof value !== 'object') return null;
  const score = (value as Record<string, unknown>)['score'];
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
};

const pillarZone = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object') return null;
  const zone = (value as Record<string, unknown>)['zone'];
  return typeof zone === 'string' ? zone : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// A row written before pillars named their version carries none; those read as the names the view used then. A version the
// row names that is not a version name makes the pillar unreadable, never another version.
const LEGACY_VERSION = { form: 'form.safte-fast.v1', recovery: 'recovery.v1' } as const;
const pillarVersion = (value: unknown, pillar: 'form' | 'recovery'): string | null => {
  const named = isRecord(value) ? value['algorithm_version'] : undefined;
  if (named === undefined) return LEGACY_VERSION[pillar];
  const schema = pillar === 'form' ? formHealthViewSchema.shape.algorithm_version : recoveryHealthViewSchema.shape.algorithm_version;
  const parsed = schema.safeParse(named);
  return parsed.success ? parsed.data : null;
};

const pillarBaselineState = (value: unknown): DerivedBaselineState | undefined => {
  const baseline = isRecord(value) ? value['baseline'] : undefined;
  const parsed = derivedBaselineStateSchema.safeParse(isRecord(baseline) ? baseline['state'] : undefined);
  return parsed.success ? parsed.data : undefined;
};

// Sleep debt is a recency-weighted shortfall in minutes. It becomes words here and the figure goes no further. The line is
// where the weighted shortfall starts to read as a habit rather than one short night (about twenty minutes under on an average
// night across the fortnight). The size says how much is owed and nothing about direction: a direction is stated only when the
// stored row names one, in the one vocabulary every reader of the row shares, and a word outside it is not a direction.
const SOME_DEBT_FROM_WEIGHTED_MINUTES = 240;
const MAX_WEIGHTED_MINUTES = 20_160;
const sleepDebtWords = (value: unknown): DerivedSleepDebt | undefined => {
  if (!isRecord(value)) return undefined;
  if (value['state'] === 'unavailable') return typeof value['reason'] === 'string' ? { amount: 'unknown' } : undefined;
  if (value['state'] === 'partial') return { amount: 'partial' };
  const owed = value['debt_minutes'];
  if (value['state'] !== 'available' || typeof owed !== 'number' || !Number.isFinite(owed) || owed < 0 || owed > MAX_WEIGHTED_MINUTES) return undefined;
  const trend = derivedSleepDebtTrendSchema.safeParse(value['trend']);
  return { amount: owed >= SOME_DEBT_FROM_WEIGHTED_MINUTES ? 'some' : 'little', ...(trend.success ? { trend: trend.data } : {}) };
};

// Windows carry clock times, so they are never admitted through the word filter: the whole list is validated as clock ranges
// and one malformed entry drops the list, since a partial list could name the wrong best window.
const energyWindows = (value: unknown): DerivedHealthDestinationView['energy_windows'] => {
  const parsed = derivedEnergyWindowsSchema.safeParse(value);
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
};

// The candidate training load as one sentence, from the closed vocabulary only; anything else is absence, never passed on.
const LOAD_METHOD_WORDS: Readonly<Record<string, string>> = {
  hr_zones: 'time in heart-rate zones',
  hr_zones_observed_peak: 'time in approximate heart-rate zones, set from the highest heart rate seen in a workout rather than a measured maximum',
  effort: 'session effort', minutes: 'workout minutes',
};
const LOAD_UNAVAILABLE_WORDS: Readonly<Record<string, string>> = { baseline_immature: 'not enough days yet', no_readings: 'no workouts in the last four weeks' };
const trainingLoadWords = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (value['state'] === 'unavailable') return typeof value['reason'] === 'string' && Object.hasOwn(LOAD_UNAVAILABLE_WORDS, value['reason']) ? `Training load: ${LOAD_UNAVAILABLE_WORDS[value['reason']]}.` : null;
  const { phrase, method } = value;
  if (value['state'] !== 'available' || value['activation'] !== 'candidate_unaccepted' || typeof method !== 'string' || !Object.hasOwn(LOAD_METHOD_WORDS, method)
    || !(TRAINING_LOAD_PHRASES as readonly unknown[]).includes(phrase)) return null;
  return `Training load this week (candidate, from ${LOAD_METHOD_WORDS[method]}): ${String(phrase)} against your own usual.`;
};

const pillarDrivers = (value: unknown): readonly string[] =>
  value !== null && typeof value === 'object' ? wordList((value as Record<string, unknown>)['drivers'], 4) : [];

// The reason a stored pillar names for not being computed. A pillar written unavailable is { reason } alone, sleep debt
// { state, reason }; a reason outside the engine's words is no reason.
const LINK_OR_CONSENT = new Set(['not_linked', 'consent_required', 'consent_withdrawn']);
const storedReason = (value: unknown): unknown => (isRecord(value) ? value['reason'] : undefined);
const missingReason = (value: unknown) => {
  const parsed = derivedMissingPillarReasonSchema.safeParse(storedReason(value));
  return parsed.success ? parsed.data : undefined;
};
type RowContext = NonNullable<HealthContextRow['context']>;
// A pillar stored without link or consent means the row speaks for no live consent, so nothing of it is read. The read RPC
// already returns no row without a live basis; this holds even if a row says otherwise.
const consentAbsent = (context: RowContext): boolean =>
  [context.recovery, context.form, context.weight, context.sleep_debt].some((pillar) => LINK_OR_CONSENT.has(String(storedReason(pillar))));
const missingPillarsOf = (context: RowContext): DerivedMissingPillars => {
  const pillars: [keyof DerivedMissingPillars, unknown][] = [['recovery', context.recovery], ['form', context.form], ['load', context.weight], ['sleep_debt', context.sleep_debt]];
  return Object.fromEntries(pillars.flatMap(([pillar, value]) => { const reason = missingReason(value); return reason === undefined ? [] : [[pillar, reason]]; }));
};

// The signals a computed pillar says it used. Only a provisional pillar names them; any other has none to read.
const usedSignals = (value: unknown): readonly string[] | null => {
  const used = isRecord(value) ? value['used'] : undefined;
  const signals = isRecord(used) ? used['signals'] : undefined;
  return Array.isArray(signals) && signals.every((signal) => typeof signal === 'string') ? signals : null;
};
// The ADR-0081 components a pillar went without, read from the signals it used: HRV, the circadian timing of sleep or
// daylight, and motion as movement or steps. Without a used list nothing is claimed either way.
const recoveryMissing = (value: unknown): RecoveryHealthView['missing_components'] => {
  const signals = usedSignals(value);
  return signals === null || signals.includes('hrv') ? [] : ['hrv'];
};
const formMissing = (value: unknown): FormHealthView['missing_components'] => {
  const signals = usedSignals(value);
  if (signals === null) return [];
  const has = (...names: string[]) => names.some((name) => signals.includes(name));
  return [
    ...(has('hrv') ? [] : ['hrv' as const]),
    ...(has('sleep_midpoint', 'daylight') ? [] : ['circadian' as const]),
    ...(has('movement', 'steps') ? [] : ['motion' as const]),
  ];
};

const sourcesOf = (basis: unknown): PartialHealthView['sources'] => {
  if (!Array.isArray(basis)) return [];
  const names = basis.flatMap((entry) => { const parsed = partialHealthSourceSchema.safeParse(isRecord(entry) ? entry['source'] : undefined); return parsed.success ? [parsed.data] : []; });
  return [...new Set(names)];
};

// What a stored row shows arrived. A Recovery that failed for its resting signal or its baseline had last night's sleep (the
// engine checks sleep first), a sleep debt with a figure or a share had recent nights, a computed Load names its calendar or
// activity, and a computed training load had workouts. Nothing the row does not record is named.
const presentOf = (context: RowContext): PartialHealthPresent[] => {
  const loadSignals = usedSignals(context.weight) ?? [];
  const debtState = isRecord(context.sleep_debt) ? context.sleep_debt['state'] : undefined;
  return [
    ...(['missing_resting_signal', 'baseline_immature'].includes(String(storedReason(context.recovery))) ? ['last_night_sleep' as const] : []),
    ...(debtState === 'available' || debtState === 'partial' ? ['recent_sleep' as const] : []),
    ...(loadSignals.includes('calendar') ? ['calendar' as const] : []),
    ...(loadSignals.includes('physical_load') ? ['activity' as const] : []),
    ...(isRecord(context.training_load) && context.training_load['state'] === 'available' ? ['workouts' as const] : []),
  ];
};

// A Form computed without Recovery (the degraded rule): its zone, the day's parts it stood on and its confidence, in words.
const FORM_BASIS = { sleep_midpoint: 'sleep_timing', daylight: 'daylight', movement: 'movement', steps: 'steps', stress: 'stress' } as const;
const bandOf = (confidence: number | null): 'high' | 'medium' | 'low' => (confidence === null ? 'low' : confidence >= 0.66 ? 'high' : confidence >= 0.33 ? 'medium' : 'low');
const formWithoutRecovery = (form: unknown): PartialHealthView['form_without_recovery'] => {
  const zone = fromRowZone('form', pillarZone(form));
  const basis = (usedSignals(form) ?? []).flatMap((signal) => (Object.hasOwn(FORM_BASIS, signal) ? [FORM_BASIS[signal as keyof typeof FORM_BASIS]] : []));
  if (zone === null || basis.length === 0) return undefined;
  const confidence = isRecord(form) && typeof form['confidence'] === 'number' && Number.isFinite(form['confidence']) ? form['confidence'] : null;
  return { zone, basis, confidence_band: bandOf(confidence) };
};

const daySummaryParts = (context: RowContext): string[] => {
  const parts: string[] = [];
  const drivers = [...new Set([...pillarDrivers(context.form), ...wordList(context.drivers, 4)])].slice(0, 4);
  const tags = wordList(context.tags, 4);
  if (drivers.length > 0) parts.push(`Drivers: ${drivers.join('; ')}.`);
  if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}.`);
  const trainingLoad = trainingLoadWords(context.training_load);
  if (trainingLoad !== null) parts.push(trainingLoad);
  return parts;
};

type RowStamp = Readonly<{ compiledAt: string; freshness: 'fresh' | 'stale' | 'expired' }>;
// compiled_at is the row's own compilation time (app updated_at), never the read time:
// prepareHealth requires it at or before the turn's snapshot time, and a read-time stamp
// is always after the fixture snapshot created at responder construction. An unparseable
// stamp degrades to absence rather than guessing one.
const rowStamp = (context: RowContext, clock: OwnerClock, onError?: (error: unknown) => void): RowStamp | null => {
  const now = clock.now().getTime();
  const compiledAt =
    typeof context.compiled_at === 'string' && Number.isSafeInteger(Date.parse(context.compiled_at))
      ? new Date(Date.parse(context.compiled_at)).toISOString()
      : null;
  if (compiledAt === null) {
    onError?.(new Error('health context row has no valid compiled_at'));
    return null;
  }
  // A stamp ahead of this read (clock skew) cannot be attested before the turn's snapshot.
  if (Date.parse(compiledAt) > now) {
    onError?.(new Error('health context row compiled_at is in the future'));
    return null;
  }
  return { compiledAt, freshness: rowFreshness(compiledAt, context.day, clock.timezone, now) };
};

const sourceOf = (context: RowContext, compiledAt: string): ContextHealthMaterial['source'] => ({
  source_key: `health-context:${context.day}`,
  source_kind: 'derived_health_view',
  scope: 'principal',
  source_taint: null,
  // When the app produced it. The read happens during composition, after the turn's
  // snapshot, and the composer rejects a source produced after its snapshot.
  produced_at: Date.parse(compiledAt),
});

// A day whose body data made no Recovery, or whose newest row is over three days old. It says only what the row records, in
// words; an expired row gives nothing of its old day but its age and sources.
const partialMaterial = (context: RowContext, clock: OwnerClock, stamp: RowStamp, onError?: (error: unknown) => void): ContextHealthMaterial | null => {
  const now = clock.now().getTime();
  const asOfDay: PartialHealthView['as_of_day'] = context.day === localIso(now, clock.timezone).slice(0, 10) ? 'today'
    : context.day === localIso(now - 24 * HOUR_MS, clock.timezone).slice(0, 10) ? 'yesterday' : 'earlier';
  const shared = {
    authority: 'backend' as const, availability: 'partial' as const, freshness: stamp.freshness, as_of_day: asOfDay,
    sources: sourcesOf(context.basis),
    provenance_refs: [`hpr_${md5Hex(`health-context.${context.id}`)}`], destination_eligibility: ['trigger_prompt' as const],
  };
  let view: PartialHealthView;
  let summary: string[] = [];
  if (stamp.freshness === 'expired') view = { ...shared, present: [], missing_pillars: {} };
  else {
    const load = fromRowZone('weight', pillarZone(context.weight)) ?? undefined;
    const loadState = load === undefined ? undefined : pillarBaselineState(context.weight);
    // A sleep debt the row could not compute is named among the missing pillars, not again as an unknown amount.
    const sleepDebt = missingReason(context.sleep_debt) === undefined ? sleepDebtWords(context.sleep_debt) : undefined;
    const windows = energyWindows(context.windows);
    const form = formWithoutRecovery(context.form);
    view = {
      ...shared, present: presentOf(context), missing_pillars: missingPillarsOf(context),
      ...(form === undefined ? {} : { form_without_recovery: form }),
      ...(load === undefined ? {} : { load_zone: load }),
      ...(loadState === undefined ? {} : { baseline_state: { load: loadState } }),
      ...(sleepDebt === undefined ? {} : { sleep_debt: sleepDebt }),
      ...(windows === undefined ? {} : { energy_windows: windows }),
    };
    summary = daySummaryParts(context);
  }
  const viewParsed = derivedHealthDestinationViewSchema.safeParse(view);
  const narrativeParsed = partialHealthNarrativeSchema.safeParse({ day_summary: summary.join(' '), active_goals: [], upcoming_high_stakes: [], compiled_at: stamp.compiledAt });
  if (!viewParsed.success || !('availability' in viewParsed.data) || !narrativeParsed.success) {
    onError?.(new Error('partial health context failed contract validation'));
    return null;
  }
  return { view: viewParsed.data, narrative: narrativeParsed.data, source: sourceOf(context, stamp.compiledAt) };
};

// The inventory: each kind of body data the owner's live sources sent in the last thirty local days, merged across sources, in
// words. The read answers each source's kinds with their newest reading time and their days; a source or kind this side does not
// know is left out, and an answer of any other shape is no inventory.
export const INVENTORY_DAYS = 30;
type InventoryKind = Readonly<{ signal: string; newest_at: string; days: number }>;
const inventoryKinds = (raw: unknown): { source: string; kind: InventoryKind }[] | null => {
  const sources = isRecord(raw) ? raw['sources'] : undefined;
  if (!Array.isArray(sources)) return null;
  return sources.flatMap((entry) => {
    const source = partialHealthSourceSchema.safeParse(isRecord(entry) ? entry['source'] : undefined);
    const kinds = isRecord(entry) ? entry['kinds'] : undefined;
    if (!source.success || !Array.isArray(kinds)) return [];
    return kinds.flatMap((kind) => isRecord(kind) && typeof kind['signal'] === 'string' && typeof kind['newest_at'] === 'string'
      && Number.isSafeInteger(Date.parse(kind['newest_at'])) && Number.isInteger(kind['days']) && (kind['days'] as number) > 0
      ? [{ source: source.data, kind: kind as InventoryKind }] : []);
  });
};
const newestWord = (at: number, now: number, timezone: string): HealthInventoryEntry['newest'] => {
  const day = (ms: number) => localIso(ms, timezone).slice(0, 10);
  if (now - at <= 3 * HOUR_MS) return 'within_hours';
  if (day(at) === day(now)) return 'today';
  if (day(at) === day(now - 24 * HOUR_MS)) return 'yesterday';
  return now - at <= 7 * 24 * HOUR_MS ? 'this_week' : 'this_month';
};
const regularityWord = (days: number): HealthInventoryEntry['regularity'] =>
  days >= 26 ? 'nearly_every_day' : days >= 15 ? 'most_days' : days >= 4 ? 'some_days' : 'a_few_days';
export type HealthInventory = Readonly<{ entries: readonly HealthInventoryEntry[]; newestAt: number }>;
export const toHealthInventory = (raw: unknown, clock: OwnerClock): HealthInventory | null => {
  const kinds = inventoryKinds(raw);
  if (kinds === null) return null;
  const now = clock.now().getTime();
  const merged = new Map<string, { newestAt: number; days: number; sources: Set<PartialHealthView['sources'][number]> }>();
  for (const { source, kind } of kinds) {
    if (!(HEALTH_SIGNAL_NAMES as readonly string[]).includes(kind.signal)) continue;
    const at = Math.min(Date.parse(kind.newest_at), now);
    const held = merged.get(kind.signal) ?? { newestAt: at, days: 0, sources: new Set() };
    merged.set(kind.signal, { newestAt: Math.max(held.newestAt, at), days: Math.max(held.days, kind.days), sources: held.sources.add(source as PartialHealthView['sources'][number]) });
  }
  const entries = HEALTH_SIGNAL_NAMES.flatMap((signal) => {
    const held = merged.get(signal);
    return held === undefined ? [] : [{ signal, grain: HEALTH_SIGNALS[signal].grain, newest: newestWord(held.newestAt, now, clock.timezone), regularity: regularityWord(held.days), sources: [...held.sources].sort() }];
  });
  const parsed = healthInventorySchema.safeParse(entries);
  return parsed.success ? { entries: parsed.data, newestAt: Math.max(...[...merged.values()].map((held) => held.newestAt), Number.NEGATIVE_INFINITY) } : null;
};

// The view for an owner with readings and no score row at all: the inventory alone, aged by its newest reading.
const inventoryMaterial = (inventory: HealthInventory, clock: OwnerClock): ContextHealthMaterial | null => {
  if (inventory.entries.length === 0) return null;
  const now = clock.now().getTime();
  const age = now - inventory.newestAt;
  const compiledAt = new Date(inventory.newestAt).toISOString();
  const day = localIso(inventory.newestAt, clock.timezone).slice(0, 10);
  const view = {
    authority: 'backend' as const, availability: 'partial' as const, no_score_row: true as const,
    freshness: age <= 36 * HOUR_MS ? 'fresh' as const : age <= 72 * HOUR_MS ? 'stale' as const : 'expired' as const,
    as_of_day: day === localIso(now, clock.timezone).slice(0, 10) ? 'today' as const : day === localIso(now - 24 * HOUR_MS, clock.timezone).slice(0, 10) ? 'yesterday' as const : 'earlier' as const,
    sources: [...new Set(inventory.entries.flatMap((entry) => entry.sources))].sort(), present: [], missing_pillars: {}, inventory: inventory.entries,
    provenance_refs: [`hpr_${md5Hex(`health-inventory.${compiledAt}`)}`], destination_eligibility: ['trigger_prompt' as const],
  };
  const viewParsed = derivedHealthDestinationViewSchema.safeParse(view);
  const narrativeParsed = partialHealthNarrativeSchema.safeParse({ day_summary: '', active_goals: [], upcoming_high_stakes: [], compiled_at: compiledAt });
  if (!viewParsed.success || !('availability' in viewParsed.data) || !narrativeParsed.success) return null;
  return {
    view: viewParsed.data, narrative: narrativeParsed.data,
    source: { source_key: `health-inventory:${day}`, source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: inventory.newestAt },
  };
};

// The inventory beside a view the row gave, re-checked whole; a view that cannot carry it is given without it.
export const withInventory = (material: ContextHealthMaterial | null, inventory: HealthInventory | null, clock: OwnerClock): ContextHealthMaterial | null => {
  if (inventory === null) return material;
  if (material === null) return inventoryMaterial(inventory, clock);
  if (inventory.entries.length === 0) return material;
  const parsed = derivedHealthDestinationViewSchema.safeParse({ ...material.view, inventory: inventory.entries });
  return parsed.success ? ({ ...material, view: parsed.data } as ContextHealthMaterial) : material;
};

// partial: the switch that gives the model a block for a row without Recovery, or too old to score, and fills the missing
// lists from the row. Off, the reader is as it was.
// inventory: with partial, also read which body data exists and put it in the block, and give an owner who has readings but no
// score row a block made of that alone.
export type HealthContextOptions = Readonly<{ partial?: boolean; inventory?: boolean }>;

// Without the partial switch the material is always a zone one.
export function toContextHealthMaterial(row: HealthContextRow, clock: OwnerClock, onError?: (error: unknown) => void, options?: Readonly<{ partial?: false }>): ZoneHealthMaterial | null;
export function toContextHealthMaterial(row: HealthContextRow, clock: OwnerClock, onError?: (error: unknown) => void, options?: HealthContextOptions): ContextHealthMaterial | null;
export function toContextHealthMaterial(
  row: HealthContextRow,
  clock: OwnerClock,
  onError?: (error: unknown) => void,
  options: HealthContextOptions = {},
): ContextHealthMaterial | null {
  try {
    const context = row.context;
    if (context === null) return null;
    const partial = options.partial === true;
    const recovery = fromRowZone('recovery', pillarZone(context.recovery));
    if (partial) {
      if (consentAbsent(context)) return null;
      // A Recovery that is neither a zone nor a stored reason is unreadable, and stays absence.
      if (recovery === null && missingReason(context.recovery) === undefined) return null;
      const stamp = rowStamp(context, clock, onError);
      if (stamp === null) return null;
      if (recovery === null || stamp.freshness === 'expired') return partialMaterial(context, clock, stamp, onError);
    }
    if (recovery === null) return null;
    const recoveryVersion = pillarVersion(context.recovery, 'recovery');
    if (recoveryVersion === null) {
      onError?.(new Error('health context recovery names no valid version'));
      return null;
    }
    // Form's zone is the word the backend stored, which holds through a steady move, so the prompt and the app say the
    // same; a row whose Form score or version is unreadable has no Form.
    const formScore = pillarScore(context.form);
    const formVersion = formScore === null ? null : pillarVersion(context.form, 'form');
    const zone = formVersion === null ? undefined : fromRowZone('form', pillarZone(context.form)) ?? undefined;
    const load = fromRowZone('weight', pillarZone(context.weight)) ?? undefined;

    const previousScore =
      row.previous !== null && typeof row.previous.form_score === 'number' && Number.isFinite(row.previous.form_score)
        ? row.previous.form_score
        : null;
    const trend: FormHealthView['trend'] =
      previousScore === null || formScore === null
        ? 'insufficient'
        : formScore - previousScore > STEADY_SCORE_MOVE
          ? 'improving'
          : formScore - previousScore < -STEADY_SCORE_MOVE
            ? 'declining'
            : 'steady';

    const stamp = rowStamp(context, clock, onError);
    if (stamp === null) return null;
    const { compiledAt, freshness } = stamp;
    // An expired row is absence for the prompt, as no row is, unless the partial block says how old it is.
    if (freshness === 'expired') return null;

    const confidence = typeof context.confidence === 'number' && Number.isFinite(context.confidence) ? context.confidence : null;
    const confidenceBand: FormHealthView['confidence_band'] =
      confidence === null ? 'low' : confidence >= 0.66 ? 'high' : confidence >= 0.33 ? 'medium' : 'low';

    // Only the pillars the prompt names are labelled, and only when the row labels them.
    const states = [
      ['recovery', pillarBaselineState(context.recovery)],
      ...(zone === undefined ? [] : [['form', pillarBaselineState(context.form)] as const]),
      ...(load === undefined ? [] : [['load', pillarBaselineState(context.weight)] as const]),
    ].flatMap(([pillar, state]) => state === undefined ? [] : [[pillar, state] as const]);
    const sleepDebt = sleepDebtWords(context.sleep_debt);
    const windows = energyWindows(context.windows);
    const formShown = zone !== undefined && formVersion !== null;
    // With the switch, the pillars this view does not show say why, from the row; a Form view shows Recovery's day too.
    const { recovery: _recovery, ...notShown } = partial ? missingPillarsOf(context) : {};
    const { form: _form, ...notShownBesideForm } = notShown;
    const missingPillars = formShown ? notShownBesideForm : notShown;
    const common = {
      authority: 'backend' as const, trend, freshness, confidence_band: confidenceBand,
      provenance_refs: [`hpr_${md5Hex(`health-context.${context.id}`)}`], destination_eligibility: ['trigger_prompt' as const],
      ...(states.length === 0 ? {} : { baseline_state: Object.fromEntries(states) }),
      ...(sleepDebt === undefined ? {} : { sleep_debt: sleepDebt }),
      ...(windows === undefined ? {} : { energy_windows: windows }),
      ...(Object.keys(missingPillars).length === 0 ? {} : { missing_pillars: missingPillars }),
    };
    const view: DerivedHealthDestinationView = !formShown
      ? { ...common, algorithm_version: recoveryVersion, recovery_zone: recovery, missing_components: partial ? recoveryMissing(context.recovery) : [] }
      : { ...common, algorithm_version: formVersion, form_zone: zone, missing_components: partial ? formMissing(context.form) : [] };

    const summaryParts = [`${zone === undefined ? '' : `Form ${zone}; `}${zone === undefined ? 'Recovery' : 'recovery'} ${recovery}; load ${load ?? 'unavailable'}.`, ...daySummaryParts(context)];

    const viewParsed = derivedHealthDestinationViewSchema.safeParse(view);
    const narrativeParsed = narrativeContextSchema.safeParse({
      ...(zone === undefined ? {} : { zone }),
      recovery_descriptor: recovery,
      ...(load === undefined ? {} : { load_descriptor: load }),
      day_summary: summaryParts.join(' '),
      active_goals: [],
      upcoming_high_stakes: [],
      compiled_at: compiledAt,
    });
    // A material that violates the contracts schemas degrades to absence here (logged) instead of throwing
    // 'health_context_invalid' inside the composer and killing the owner's turn. Parsing also stamps the branded
    // ISO8601 compiled_at type.
    if (!viewParsed.success || !narrativeParsed.success) {
      onError?.(new Error('health context material failed contract validation'));
      return null;
    }

    if ('availability' in viewParsed.data) {
      onError?.(new Error('health context material failed contract validation'));
      return null;
    }
    return { view: viewParsed.data, narrative: narrativeParsed.data, source: sourceOf(context, compiledAt) };
  } catch (error) {
    onError?.(error);
    return null;
  }
}

// The zone words a rendered health block shows the model (renderHealth), for checks that keep them out of what leaves.
export const healthZoneWords = (material: ContextHealthMaterial | null): readonly string[] => {
  if (material === null) return [];
  if (isPartialHealth(material)) return [material.view.form_without_recovery?.zone, material.view.load_zone].filter((word): word is NonNullable<typeof word> => word !== undefined);
  return [
    'form_zone' in material.view ? material.view.form_zone : material.view.recovery_zone,
    material.narrative.recovery_descriptor, ...(material.narrative.load_descriptor ? [material.narrative.load_descriptor] : []),
  ];
};

export type HealthContextBook = Readonly<{
  linked(): boolean;
  latest(trace?: string): Promise<ContextHealthMaterial | null>;
  // As latest, but a read that failed is 'unknown' rather than none shared, for a caller that must not take an outage for a revoke.
  read(trace?: string): Promise<ContextHealthMaterial | null | 'unknown'>;
}>;

export const healthContextBook = (
  call: SignedCall | null,
  doName: string | null,
  clock: OwnerClock,
  onReadError?: (error: unknown, trace?: string) => void,
  // partial: the block given is a partial one, so a staging log can tell partial reads from full ones.
  onReadSuccess?: (present: boolean, trace?: string, partial?: boolean) => void,
  options: HealthContextOptions = {},
): HealthContextBook => {
  // A failed inventory read leaves the block as the row alone makes it, and says so in the log; it never fails the turn.
  const readInventory = async (trace?: string): Promise<HealthInventory | null> => {
    if (!call || !doName || options.partial !== true || options.inventory !== true) return null;
    const today = localIso(clock.now().getTime(), clock.timezone).slice(0, 10);
    const payload = JSON.stringify({ from: shiftDay(today, -(INVENTORY_DAYS - 1)), to: today });
    try {
      const answer = await call('health_inventory_read', `health.inventory_read.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload });
      if (isRecord(answer) && answer['error'] === 'not_linked') return null;
      const inventory = toHealthInventory(answer, clock);
      if (inventory === null) onReadError?.(new Error('health inventory read answered an unknown shape'), trace);
      return inventory;
    } catch (error) {
      onReadError?.(new Error(`health inventory read failed: ${String(error)}`), trace);
      return null;
    }
  };
  const read: HealthContextBook['read'] = async (trace) => {
    if (!call || !doName) return null;
    const inventoryRead = readInventory(trace);
    let row: unknown;
    try {
      row = await call('health_context_read', `healthctx.read.${doName}`, { p_do_name: doName });
    } catch (error) {
      onReadError?.(error, trace);
      return 'unknown';
    }
    let invalid = false;
    const fromRow = row === null || typeof row !== 'object' ? null
      : toContextHealthMaterial(row as HealthContextRow, clock, (error) => { invalid = true; onReadError?.(error, trace); }, options);
    if (invalid) return 'unknown';
    const material = withInventory(fromRow, await inventoryRead, clock);
    onReadSuccess?.(material !== null, trace, material !== null && isPartialHealth(material));
    return material;
  };
  return {
    linked: () => call !== null && doName !== null,
    latest: async (trace) => { const found = await read(trace); return found === 'unknown' ? null : found; },
    read,
  };
};
