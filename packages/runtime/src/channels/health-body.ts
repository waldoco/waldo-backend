import { derivedBodySchema, type DerivedBody } from '@waldo/contracts';
import {
  healthChangesV1Schema, healthDayLoadV1Schema, healthPartsV1Schema, healthStressCurveV1Schema, healthUsualListV1Schema,
} from '../../../contracts/src/app/health-ingest';
import type { z } from 'zod';
import { FAR, OUTSIDE } from '../health/scores/drivers';
import { circularDelta } from '../health/scores/stats';

// The model's body read: today's stored row, as the score engine wrote it, turned into closed words. Which way each reading and each
// part of a score stood against the owner's usual band, whether far from it, the sleep part against the need in tenths, the day's load
// so far against the owner's usual day, and the settled hours of high strain at rest as clock ranges. Every figure stays here: the
// view carries words and clock times only, and the model judges what, if anything, is worth saying.
type Usual = z.infer<typeof healthUsualListV1Schema>[number];
type Standing = DerivedBody['readings'][number]['standing'];
type Part = DerivedBody['parts'][number];

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Each stored piece is read on its own: one that is not the contract's shape is left out and named, never repaired.
const pieceOf = <T>(schema: z.ZodType<T>, value: unknown, name: string, onError?: (error: Error) => void): T | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) onError?.(new Error(`health body read: stored ${name} is not the contract's shape`));
  return parsed.success ? parsed.data : undefined;
};

// Where a reading lies against its band. The band is one spread either side of the centre (the cut a driver and a part's direction
// begin at), so a reading beyond an edge has a direction, and one at two spreads or more from the centre is far. Each side is read
// against its own edge, so a band that is not symmetric (a back-transformed log band) is read as stored. A band with no width is
// the owner's flat history: any other reading is beyond it and far, as the engine's own bound treats it.
export const standingOf = (band: Usual, reading: number): Standing => {
  const circular = band.signal === 'sleep_midpoint';
  const offset = circular ? circularDelta(reading, band.centre) : reading - band.centre;
  const up = circular ? circularDelta(band.high, band.centre) : band.high - band.centre;
  const down = circular ? -circularDelta(band.low, band.centre) : band.centre - band.low;
  // A band's half-width is already OUTSIDE spreads, so FAR spreads is FAR / OUTSIDE half-widths.
  const beyond = (distance: number, width: number) => (width === 0 ? distance > 0 : distance > width);
  const far = (distance: number, width: number) => width === 0 || distance >= width * FAR / OUTSIDE;
  if (beyond(offset, up)) return { state: 'compared', direction: circular ? 'later' : 'above', ...(far(offset, up) ? { far: true } : {}) };
  if (beyond(-offset, down)) return { state: 'compared', direction: circular ? 'earlier' : 'below', ...(far(-offset, down) ? { far: true } : {}) };
  return { state: 'compared', direction: 'within' };
};

// The model calls the Weight pillar Load, and a part's direction by the reading's own sense: sleep timing is later or earlier.
export const PILLARS = { recovery: 'recovery', form: 'form', weight: 'load' } as const;
type Parts = z.infer<typeof healthPartsV1Schema>;
export type StoredPart = NonNullable<Parts['recovery' | 'form' | 'weight']>[number];
const PART_DIRECTION = { above_usual: 'above', below_usual: 'below', usual: 'within' } as const;
const CLOCK_DIRECTION = { above_usual: 'later', below_usual: 'earlier', usual: 'within' } as const;
export const partDirection = (key: string, direction: keyof typeof PART_DIRECTION) => (key === 'sleep_midpoint' ? CLOCK_DIRECTION : PART_DIRECTION)[direction];

// A part's standing: its own direction, which the engine read against the same band, and far when today's reading of that band lies
// far; a band still short of the owner's fourteen days is forming. The sleep part stands against the need: its score is time asleep
// as a share of the need, which the engine caps at all of it. A part made of other parts (Form's night share) has no standing of its own.
const partOf = (pillar: keyof typeof PILLARS, part: StoredPart, readings: ReadonlyMap<string, Standing>): Part | null => {
  const named = { pillar: PILLARS[pillar], key: part.key };
  if (part.state === 'unavailable') return { ...named, unavailable: part.reason } as Part;
  if (part.key === 'sleep') return { pillar: 'recovery', key: 'sleep', need_tenths: Math.round(part.score / 10) };
  if (part.direction === null) return null;
  if (part.baseline?.state === 'provisional') return { ...named, standing: { state: 'forming' } } as Part;
  const direction = partDirection(part.key, part.direction);
  const reading = part.signals.length === 1 ? readings.get(part.signals[0]!) : undefined;
  const far = reading?.state === 'compared' && reading.direction === direction && reading.far === true;
  // Movement with no band of its own was read on steps: the engine links a steps stand-in to no band.
  const via = part.key === 'movement' && part.signals.length === 0 ? { via: 'steps' as const } : {};
  return { ...named, standing: { state: 'compared', direction, ...(far ? { far: true as const } : {}) }, ...via } as Part;
};

// Today's load so far against the owner's usual whole day, read off the stored band.
const dayLoadOf = (load: z.infer<typeof healthDayLoadV1Schema>): DerivedBody['day_load'] => {
  if (load.state !== 'available') return undefined;
  if (load.band.state === 'provisional') return { state: 'forming', approximate: load.approximate };
  const { low, centre, high } = load.band;
  const standing = standingOf({ signal: 'active_energy', low, centre, high } as Usual, load.score);
  const direction = standing.state === 'compared' && standing.direction !== 'later' && standing.direction !== 'earlier' ? standing.direction : 'within';
  return { state: 'compared', direction, ...(standing.state === 'compared' && standing.far && direction !== 'within' ? { far: true as const } : {}), approximate: load.approximate };
};

// The settled hours whose strain at rest stood high, as clock ranges in the owner's zone, an hour after another joined into one.
const clockOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const HOUR_MS = 3_600_000;
const strainHoursOf = (curve: z.infer<typeof healthStressCurveV1Schema>, timezone: string): NonNullable<DerivedBody['strain_hours']> => {
  const ranges: { from: number; to: number }[] = [];
  for (const hour of curve.hours) {
    if (hour.band !== 'high') continue;
    const from = Date.parse(hour.at), last = ranges.at(-1);
    if (last && last.to === from) last.to = from + HOUR_MS;
    else ranges.push({ from, to: from + HOUR_MS });
  }
  return ranges.slice(0, 12).map((range) => ({ start: clockOf(range.from, timezone), end: clockOf(range.to, timezone) }));
};

// The body read's answer for the owner's own today, or null: no answer, another day's row, or nothing to say. A piece that is not the
// contract's shape is left out on its own; the rest still reaches the model.
export const bodyViewOf = (raw: unknown, today: string, timezone: string, onError?: (error: Error) => void): DerivedBody | null => {
  const body = isRecord(raw) ? raw['body'] : undefined;
  if (!isRecord(body)) {
    if (raw !== null && raw !== undefined && !(isRecord(raw) && raw['error'] === 'not_linked')) onError?.(new Error('health body read answered an unknown shape'));
    return null;
  }
  if (body['day'] !== today) return null;
  const usual = pieceOf(healthUsualListV1Schema, body['usual'], 'usual bands', onError) ?? [];
  const changes = pieceOf(healthChangesV1Schema, body['changes'], 'changes', onError) ?? [];
  const parts = pieceOf(healthPartsV1Schema, body['components'], 'parts', onError);
  const load = pieceOf(healthDayLoadV1Schema, body['day_load'], 'day load', onError);
  const curve = pieceOf(healthStressCurveV1Schema, body['stress_curve'], 'stress curve', onError);

  // Today's reading of each band, from the engine's own list of what changed: a reading is listed against its personal band.
  const readingOf = new Map(changes.flatMap((change) => (change.subject.tier === 3 ? [[change.subject.key, change.to] as const] : [])));
  const standings = new Map<string, Standing>(usual.flatMap((band): [string, Standing][] => {
    if (band.state === 'provisional') return [[band.signal, { state: 'forming' }]];
    const reading = readingOf.get(band.signal);
    return reading === undefined ? [] : [[band.signal, standingOf(band, reading)]];
  }));
  const partRows = (Object.keys(PILLARS) as (keyof typeof PILLARS)[]).flatMap((pillar) =>
    (parts?.[pillar] ?? []).flatMap((part) => { const row = partOf(pillar, part as StoredPart, standings); return row === null ? [] : [row]; }));
  // A band a part already stands for is said once, with the part.
  const partSignals = new Set((Object.keys(PILLARS) as (keyof typeof PILLARS)[]).flatMap((pillar) =>
    (parts?.[pillar] ?? []).flatMap((part) => (part.state === 'available' ? (part as Extract<StoredPart, { state: 'available' }>).signals : []))));
  const readings = usual.flatMap((band) => {
    const standing = standings.get(band.signal);
    return standing === undefined || partSignals.has(band.signal) ? [] : [{ signal: band.signal, standing }];
  });
  const dayLoad = load === undefined ? undefined : dayLoadOf(load);
  const view = {
    readings, parts: partRows,
    ...(dayLoad === undefined ? {} : { day_load: dayLoad }),
    ...(curve === undefined ? {} : { strain_hours: strainHoursOf(curve, timezone) }),
  };
  if (readings.length === 0 && partRows.length === 0 && dayLoad === undefined && curve === undefined) return null;
  const parsed = derivedBodySchema.safeParse(view);
  if (!parsed.success) {
    onError?.(new Error('health body view failed contract validation'));
    return null;
  }
  return parsed.data;
};
