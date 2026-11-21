import {
  fromRowZone, getCrsArgsSchema, getCrsResultSchema, HEALTH_USUAL_WORDS, TOOL_PERMISSIONS, triggerTypeSchema, derivedMissingPillarReasonSchema,
  type GetCrsArgs, type GetCrsResult, type ToolHandler,
} from '@waldo/contracts';
import { HEALTH_CHANGE_UNIT_OF_SIGNAL_V1, healthChangesV1Schema, healthPartsV1Schema, healthUsualListV1Schema } from '../../../../contracts/src/app/health-ingest';
import { PILLARS, partDirection, standingOf, type StoredPart } from '../../channels/health-body';
import { md5Hex } from '../../channels/md5';
import { USUAL_SPAN } from '../../health/scores/usual';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';
import { localDayOf } from './health';

// get_crs: the owner's scores over days or weeks, read from the derived rows the score engine wrote, under live storage and model-use
// grants for each row (waldo.health_body_history). Each figure is the engine's: a part's direction, a band and today's reading
// against it are one statistic, so the model never compares a whole-day value with a band that covers the day's hours so far. The
// result lives in the turn that asked (turn_only_output): nothing reaches the tool ledger, memory, logs or storage.
type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type BodyHistoryBook = Readonly<{ history(days: number): Promise<unknown> }>;
export const bodyHistoryBook = (call: SignedCall | null, doName: string | null): BodyHistoryBook => ({
  async history(days) {
    if (!call || !doName) return { error: 'not_linked' };
    const payload = JSON.stringify({ days });
    return call('health_body_history', `health.body_history.${doName}.${md5Hex(payload)}`, { p_do_name: doName, p_payload: payload });
  },
});

type Available = Extract<GetCrsResult, { state: 'available' }>;
type Unavailable = Extract<GetCrsResult, { state: 'unavailable' }>;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const round1 = (value: number) => Math.round(value * 10) / 10;

// A stored pillar as the model's own zone words and its score, or the engine's reason it was not computed; anything else is absence.
const pillarOf = <P extends 'recovery' | 'form' | 'weight'>(pillar: P, stored: unknown) => {
  if (!isRecord(stored)) return undefined;
  const reason = derivedMissingPillarReasonSchema.safeParse(stored['reason']);
  if (reason.success) return { reason: reason.data };
  const zone = fromRowZone(pillar, stored['zone']);
  const score = stored['score'];
  return zone !== null && typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100 ? { score: round1(score), zone } : undefined;
};

const partsOf = (stored: unknown): Available['days'][number]['parts'] => {
  const parsed = healthPartsV1Schema.safeParse(stored);
  if (!parsed.success) return undefined;
  const rows = (Object.keys(PILLARS) as (keyof typeof PILLARS)[]).flatMap((pillar) => (parsed.data[pillar] ?? []).map((part: StoredPart) => {
    if (part.state === 'unavailable') return { pillar: PILLARS[pillar], key: part.key, unavailable: part.reason };
    const direction = part.direction === null ? null : partDirection(part.key, part.direction);
    return {
      pillar: PILLARS[pillar], key: part.key, score: round1(part.score), direction,
      ...('need_minutes' in part ? { need_minutes: part.need_minutes } : {}),
      ...(part.key === 'movement' && part.signals.length === 0 ? { steps: true as const } : {}),
    };
  }));
  return rows.length === 0 ? undefined : rows;
};

const UNAVAILABLE_NEXT: Readonly<Record<Unavailable['reason'], string>> = {
  consent_required: 'The owner has not turned on health sharing with Waldo for model use, so nothing was read. Answer without their scores and say so.',
  consent_withdrawn: 'The owner turned health sharing off, so nothing was read. Answer without their scores, and do not ask them to turn it back on unless they bring it up.',
  not_linked: 'No phone or wearable has sent health data to Waldo for this owner yet, so there are no scores. They can share health from the Waldo app.',
  no_readings: 'Sharing is on, but no day in this window has a score. Try a longer window once; if there is still none, say the scores have not been computed yet, and never invent one.',
  read_failed: 'The scores could not be read just now. Try once more; if it fails again, tell the owner their scores could not be checked right now.',
};
const unavailable = (reason: Unavailable['reason']) => ({ ok: true as const, data: { state: 'unavailable' as const, reason, next: UNAVAILABLE_NEXT[reason] }, source_taint: null });

const allowlist = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_crs'));

export const getCrsHandler = (book: BodyHistoryBook, clock: OwnerClock, onError?: (code: string) => void): ToolHandler<GetCrsArgs, GetCrsResult, ToolDispatcherContext> => ({
  name: 'get_crs',
  description:
    "The owner's Recovery, Form and Load by local day over the last range_days (1 to 90, ending today), as Waldo's score engine computed them: each day's score and zone, or why it was not computed, and the parts of each score with which way each stood against the owner's usual. Also the owner's usual bands now, with what each covers (the night, the day's one reading, the day's hours so far against the same hours of earlier days, or the day's total so far against earlier whole days), and today's readings against them. Use it to say how the body has moved over days or weeks, or whether today or last night is unusual for this owner; get_health reads the raw readings. The numbers stay in this turn and are never stored or logged.",
  schema: getCrsArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  turn_only_output: true,
  async handle(args) {
    let raw: unknown;
    try {
      raw = await book.history(args.range_days);
    } catch {
      return unavailable('read_failed');
    }
    if (!isRecord(raw)) return unavailable('read_failed');
    if (raw['error'] === 'not_linked') return unavailable('not_linked');
    const reason = raw['unavailable'];
    if (reason === 'consent_required' || reason === 'consent_withdrawn' || reason === 'no_readings') return unavailable(reason);
    const history = raw['history'];
    if (!isRecord(history) || !Array.isArray(history['days']) || typeof history['from'] !== 'string' || typeof history['to'] !== 'string') {
      onError?.('get_crs_shape');
      return unavailable('read_failed');
    }
    const stored = history['days'].filter(isRecord);
    const days = stored.flatMap((row) => {
      if (typeof row['day'] !== 'string') return [];
      const recovery = pillarOf('recovery', row['recovery']), form = pillarOf('form', row['form']), load = pillarOf('weight', row['weight']);
      const parts = partsOf(row['components']);
      return [{
        day: row['day'], ...(recovery ? { recovery } : {}), ...(form ? { form } : {}), ...(load ? { load } : {}),
        ...(row['backfilled'] === true ? { backfilled: true as const } : {}), ...(parts ? { parts } : {}),
      }];
    });
    // The newest day's bands, and today's readings against them when that day is today.
    const newest = stored.at(-1);
    const bands = healthUsualListV1Schema.safeParse(newest?.['usual']);
    const usual = bands.success ? bands.data.map((band) => ({
      signal: band.signal, words: HEALTH_USUAL_WORDS[band.signal], unit: HEALTH_CHANGE_UNIT_OF_SIGNAL_V1[band.signal], span: USUAL_SPAN[band.signal],
      state: band.state, low: band.low, centre: band.centre, high: band.high, own_days: band.own_days,
    })) : [];
    const today = localDayOf(clock.now(), clock.timezone);
    const changes = newest?.['day'] === today ? healthChangesV1Schema.safeParse(newest['changes']) : null;
    const readings = changes?.success && bands.success ? changes.data.flatMap((change) => {
      if (change.subject.tier !== 3) return [];
      const band = bands.data.find((entry) => entry.signal === change.subject.key);
      if (band === undefined || band.state !== 'personal') return [];
      const standing = standingOf(band, change.to);
      return standing.state === 'compared' ? [{ signal: band.signal, unit: change.unit, value: change.to, direction: standing.direction, far: standing.far === true }] : [];
    }) : [];
    const parsed = getCrsResultSchema.safeParse({
      state: 'available', timezone: clock.timezone, from: history['from'], to: history['to'], days,
      ...(usual.length > 0 ? { usual } : {}), ...(readings.length > 0 ? { today: readings } : {}),
    });
    if (!parsed.success) {
      onError?.('get_crs_result_shape');
      return unavailable('read_failed');
    }
    return { ok: true as const, data: parsed.data, source_taint: null };
  },
});
