import {
  derivedHealthDestinationViewSchema,
  formZoneOf,
  narrativeContextSchema,
  type DerivedHealthDestinationView,
  type NarrativeContext,
} from '@waldo/contracts';
import type { ContextHealthMaterial } from '../context-composer/types';
import type { OwnerClock } from '../tools/live/get-context';
import { localIso } from './reminders';
import { md5Hex } from './md5';

// D5 health context read (Art-9 read-only slice): the app computes Form/Recovery/Load and
// stores derived pillar results; this channel reads them over the signed router rail and
// redacts them to the zone-word material the composer threads into the system prompt
// (ADR-0024: zones cross the boundary, raw biometric values never do). Every string that
// could carry a number (app-authored drivers/tags) is dropped before it can ride the
// narrative. Absence is truthful: no rows, no link, or an unmapped pillar all compose as
// "no derived health context", exactly as turns did before this slice.

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
    // The row's updated_at: when the app last compiled this derived context. It becomes the
    // narrative's compiled_at - the truthful as-of the prepareHealth provenance bound checks
    // against the turn's snapshot time, which a read-time stamp would always violate.
    compiled_at: unknown;
  }> | null;
  previous: Readonly<{ day: string; form_score: unknown }> | null;
}>;

// The app's PillarScore vocabulary (supabase/functions/_shared/contracts.ts): zone words are
// low/moderate/good/high/unknown - a different vocabulary from the backend's CRS enums. The
// backend never maps numbers for Recovery/Load (no ADR-pinned bands exist); it bridges the
// app's own zone words, and an 'unknown' zone means the app itself declined to call it, so
// the whole material degrades to absence rather than inventing a descriptor.
const RECOVERY_DESCRIPTOR: Readonly<Record<string, NarrativeContext['recovery_descriptor']>> = {
  high: 'excellent',
  good: 'solid',
  moderate: 'mixed',
  low: 'compromised',
};
const LOAD_DESCRIPTOR: Readonly<Record<string, NarrativeContext['load_descriptor']>> = {
  low: 'light',
  moderate: 'moderate',
  good: 'heavy',
  high: 'peak',
};

// The material builds only from a complete pillar set (Recovery/Load descriptors require the
// app's own zone words; an absent or 'unknown' pillar degrades the whole material to truthful
// absence rather than an invented descriptor), so an emitted view always reports no missing
// components. Finer per-pillar absence needs the app to publish pillar coverage explicitly -
// a contracts change, deliberately not guessed here.

// A previous-day Form swing beyond this delta is a trend; smaller moves are steady. Pinned
// here (single owner) rather than derived per turn.
const TREND_DELTA = 5;

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
    // Form score is the material's spine: the backend owns the ADR-0024 bands, so the zone
    // comes from formZoneOf(score), never from the app's zone word. No score, no material.
    const formScore = pillarScore(context.form);
    if (formScore === null) return null;
    const zone = formZoneOf(formScore);
    const recovery = RECOVERY_DESCRIPTOR[pillarZone(context.recovery) ?? ''];
    const load = LOAD_DESCRIPTOR[pillarZone(context.weight) ?? ''];
    if (recovery === undefined || load === undefined) return null;

    const previousScore =
      row.previous !== null && typeof row.previous.form_score === 'number' && Number.isFinite(row.previous.form_score)
        ? row.previous.form_score
        : null;
    const trend: DerivedHealthDestinationView['trend'] =
      previousScore === null
        ? 'insufficient'
        : formScore - previousScore > TREND_DELTA
          ? 'improving'
          : formScore - previousScore < -TREND_DELTA
            ? 'declining'
            : 'steady';

    const now = clock.now().getTime();
    const today = localIso(now, clock.timezone).slice(0, 10);
    const yesterday = localIso(now - 86_400_000, clock.timezone).slice(0, 10);
    const freshness: DerivedHealthDestinationView['freshness'] =
      context.day === today || context.day === yesterday ? 'fresh' : 'stale';


    const confidence = typeof context.confidence === 'number' && Number.isFinite(context.confidence) ? context.confidence : null;
    const confidenceBand: DerivedHealthDestinationView['confidence_band'] =
      confidence === null ? 'low' : confidence >= 0.66 ? 'high' : confidence >= 0.33 ? 'medium' : 'low';

    const view: DerivedHealthDestinationView = {
      authority: 'backend',
      algorithm_version: 'form.safte-fast.v1',
      form_zone: zone,
      trend,
      freshness,
      missing_components: [],
      confidence_band: confidenceBand,
      provenance_refs: [`hpr_${md5Hex(`health-context.${context.id}`)}`],
      destination_eligibility: ['trigger_prompt'],
    };

    const drivers = [...new Set([...pillarDrivers(context.form), ...wordList(context.drivers, 4)])].slice(0, 4);
    const tags = wordList(context.tags, 4);
    const summaryParts = [`Form ${zone}; recovery ${recovery}; load ${load}.`];
    if (drivers.length > 0) summaryParts.push(`Drivers: ${drivers.join('; ')}.`);
    if (tags.length > 0) summaryParts.push(`Tags: ${tags.join(', ')}.`);

    // Fail closed before compose: a material that violates the contracts schemas degrades to
    // absence here (logged) instead of throwing 'health_context_invalid' inside the composer
    // and killing the owner's turn. Parsing also stamps the branded ISO8601 compiled_at type.
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
    const viewParsed = derivedHealthDestinationViewSchema.safeParse(view);
    const narrativeParsed = narrativeContextSchema.safeParse({
      zone,
      recovery_descriptor: recovery,
      load_descriptor: load,
      day_summary: summaryParts.join(' '),
      active_goals: [],
      upcoming_high_stakes: [],
      compiled_at: compiledAt,
    });
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
