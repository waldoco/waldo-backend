import {
  derivedBaselineStateSchema,
  derivedEnergyWindowsSchema,
  derivedHealthDestinationViewSchema,
  derivedSleepDebtTrendSchema,
  formHealthViewSchema,
  fromRowZone,
  narrativeContextSchema,
  recoveryHealthViewSchema,
  type DerivedBaselineState,
  type DerivedHealthDestinationView,
  type DerivedSleepDebt,
} from '@waldo/contracts';
import type { ContextHealthMaterial } from '../context-composer/types';
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
    // The row's updated_at: when the app last compiled this derived context. It becomes the
    // narrative's compiled_at - the truthful as-of the prepareHealth provenance bound checks
    // against the turn's snapshot time, which a read-time stamp would always violate.
    compiled_at: unknown;
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

const pillarDrivers = (value: unknown): readonly string[] =>
  value !== null && typeof value === 'object' ? wordList((value as Record<string, unknown>)['drivers'], 4) : [];

export const toContextHealthMaterial = (
  row: HealthContextRow,
  clock: OwnerClock,
  onError?: (error: unknown) => void,
): ContextHealthMaterial | null => {
  try {
    const context = row.context;
    if (context === null) return null;
    const recovery = fromRowZone('recovery', pillarZone(context.recovery));
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
    const trend: DerivedHealthDestinationView['trend'] =
      previousScore === null || formScore === null
        ? 'insufficient'
        : formScore - previousScore > STEADY_SCORE_MOVE
          ? 'improving'
          : formScore - previousScore < -STEADY_SCORE_MOVE
            ? 'declining'
            : 'steady';

    const now = clock.now().getTime();
    // compiled_at is the row's own compilation time (app updated_at), never the read time:
    // prepareHealth requires it at or before the turn's snapshot time, and a read-time stamp
    // is always after the fixture snapshot created at responder construction. An unparseable
    // stamp degrades to absence rather than guessing one.
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
    // An expired row is absence for the prompt, as no row is.
    const freshness = rowFreshness(compiledAt, context.day, clock.timezone, now);
    if (freshness === 'expired') return null;

    const confidence = typeof context.confidence === 'number' && Number.isFinite(context.confidence) ? context.confidence : null;
    const confidenceBand: DerivedHealthDestinationView['confidence_band'] =
      confidence === null ? 'low' : confidence >= 0.66 ? 'high' : confidence >= 0.33 ? 'medium' : 'low';

    // Only the pillars the prompt names are labelled, and only when the row labels them.
    const states = [
      ['recovery', pillarBaselineState(context.recovery)],
      ...(zone === undefined ? [] : [['form', pillarBaselineState(context.form)] as const]),
      ...(load === undefined ? [] : [['load', pillarBaselineState(context.weight)] as const]),
    ].flatMap(([pillar, state]) => state === undefined ? [] : [[pillar, state] as const]);
    const sleepDebt = sleepDebtWords(context.sleep_debt);
    const windows = energyWindows(context.windows);
    const common = {
      authority: 'backend' as const, trend, freshness, missing_components: [], confidence_band: confidenceBand,
      provenance_refs: [`hpr_${md5Hex(`health-context.${context.id}`)}`], destination_eligibility: ['trigger_prompt' as const],
      ...(states.length === 0 ? {} : { baseline_state: Object.fromEntries(states) }),
      ...(sleepDebt === undefined ? {} : { sleep_debt: sleepDebt }),
      ...(windows === undefined ? {} : { energy_windows: windows }),
    };
    const view: DerivedHealthDestinationView = zone === undefined || formVersion === null
      ? { ...common, algorithm_version: recoveryVersion, recovery_zone: recovery }
      : { ...common, algorithm_version: formVersion, form_zone: zone };

    const drivers = [...new Set([...pillarDrivers(context.form), ...wordList(context.drivers, 4)])].slice(0, 4);
    const tags = wordList(context.tags, 4);
    const summaryParts = [`${zone === undefined ? '' : `Form ${zone}; `}${zone === undefined ? 'Recovery' : 'recovery'} ${recovery}; load ${load ?? 'unavailable'}.`];
    if (drivers.length > 0) summaryParts.push(`Drivers: ${drivers.join('; ')}.`);
    if (tags.length > 0) summaryParts.push(`Tags: ${tags.join(', ')}.`);

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

    return {
      view: viewParsed.data,
      narrative: narrativeParsed.data,
      source: {
        source_key: `health-context:${context.day}`,
        source_kind: 'derived_health_view',
        scope: 'principal',
        source_taint: null,
        // When the app produced it. The read happens during composition, after the turn's
        // snapshot, and the composer rejects a source produced after its snapshot.
        produced_at: Date.parse(compiledAt),
      },
    };
  } catch (error) {
    onError?.(error);
    return null;
  }
};

export type HealthContextBook = Readonly<{
  linked(): boolean;
  latest(trace?: string): Promise<ContextHealthMaterial | null>;
}>;

export const healthContextBook = (
  call: SignedCall | null,
  doName: string | null,
  clock: OwnerClock,
  onReadError?: (error: unknown, trace?: string) => void,
  onReadSuccess?: (present: boolean, trace?: string) => void,
): HealthContextBook => ({
  linked: () => call !== null && doName !== null,
  async latest(trace) {
    if (!call || !doName) return null;
    let row: unknown;
    try {
      row = await call('health_context_read', `healthctx.read.${doName}`, { p_do_name: doName });
    } catch (error) {
      onReadError?.(error, trace);
      return null;
    }
    if (row === null || typeof row !== 'object') { onReadSuccess?.(false, trace); return null; }
    let invalid = false;
    const material = toContextHealthMaterial(row as HealthContextRow, clock, (error) => { invalid = true; onReadError?.(error, trace); });
    if (!invalid) onReadSuccess?.(material !== null, trace);
    return material;
  },
});
