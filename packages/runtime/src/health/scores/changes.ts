import {
  HEALTH_CHANGE_PILLAR_OF_SIGNAL_V1, HEALTH_CHANGE_UNIT_OF_SIGNAL_V1, HEALTH_CHANGES_MAX_V1, type healthChangeV1Schema,
} from '../../../../contracts/src/app/health-ingest';
import type { z } from 'zod';
import { OUTSIDE } from './drivers';
import { GROUPS, PART_ORDER } from './parts';
import { BASELINE_DAYS, BASELINE_WINDOW_DAYS, bounded, circularDelta, mean } from './stats';
import { shiftDay } from './time';
import type { DailyScores, PartRow, TodayReading, UsualRow } from './types';

// What changed today, for the app's Body card and the model's health block alike, so the two never disagree (contract:
// healthChangesV1Schema). Pure: the day's and yesterday's scores from the same run, and the owner's stored days, in; the list out.
//
// - A pillar (tier 1) or one of its parts or groups (tier 2) against yesterday, only when both days were scored by the same source
//   and algorithm version. Its usual move is the root mean square of the owner's own day-to-day moves of it, over the stored days
//   of the last thirty; a move past one of those is significant, and with fewer than fourteen moves none is.
// - A reading (tier 3) against its usual band, only a personal one: from is the band's centre, and outside the band is significant.
//   It is judged the way the engine scored it (ReadToday.sense); a reading that feeds no score is neutral.
// - The direction of good: every score and part is higher-is-better except Weight's, which measure load, so a heavier day is
//   declined (the owner's ruling of 14 November 2026).
export type Change = z.infer<typeof healthChangeV1Schema>;
type Pillar = 'recovery' | 'form' | 'weight';
type Unit = Change['unit'];
type Verdict = Change['verdict'];

const PILLARS: readonly Pillar[] = ['recovery', 'form', 'weight'];
const SCORE_SENSE: Readonly<Record<Pillar, 'higher' | 'lower'>> = { recovery: 'higher', form: 'higher', weight: 'lower' };
const DECIMALS: Readonly<Record<Unit, number>> = {
  score: 0, milliseconds: 0, beats_per_minute: 1, local_minute: 0, minutes: 0, breaths_per_minute: 1, percent: 1, celsius: 2, count: 0, kilocalories: 0, ml_per_kg_min: 1,
};
const roundTo = (value: number, unit: Unit): number => {
  const step = 10 ** DECIMALS[unit];
  const rounded = Math.round(value * step) / step;
  return unit === 'local_minute' ? rounded % 1440 : rounded;
};
const verdictOf = (from: number, to: number, sense: TodayReading['sense']): Verdict => {
  if (from === to || sense === 'none') return 'neutral';
  if (sense === 'near') return 'declined';
  return (to > from) === (sense === 'higher') ? 'improved' : 'declined';
};

// A stored day as the history read answers it: each pillar's score and version, and the parts when the row carries them.
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const storedPillar = (day: Record<string, unknown>, pillar: Pillar): { score: number; version: string } | null => {
  const stored = record(day[pillar]);
  return stored && typeof stored.score === 'number' && Number.isFinite(stored.score) && typeof stored.algorithm_version === 'string'
    ? { score: stored.score, version: stored.algorithm_version } : null;
};
const scoreOfRow = (rows: unknown, key: string): number | null => {
  const row = Array.isArray(rows) ? rows.map(record).find(entry => entry?.key === key) : null;
  return row && row.state === 'available' && typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null;
};

// Tier 2's subjects: each fine part of each pillar, then the two groups the app's screens show.
const PART_SUBJECTS: readonly { key: string; pillar: Pillar; group: boolean }[] = [
  ...PILLARS.flatMap(pillar => PART_ORDER[pillar].map(key => ({ key, pillar, group: false }))),
  ...GROUPS.map(group => ({ key: group.key, pillar: group.pillar, group: true })),
];
const partScore = (components: unknown, subject: (typeof PART_SUBJECTS)[number]): number | null => {
  const parts = record(components);
  return parts ? scoreOfRow(subject.group ? parts.groups : parts[subject.pillar], subject.key) : null;
};
const liveScore = (scores: DailyScores, subject: (typeof PART_SUBJECTS)[number]): number | null => {
  const rows: readonly PartRow[] | readonly { key: string; state: string; score?: number }[] | undefined = subject.group ? scores.components?.groups : scores.components?.[subject.pillar];
  const row = rows?.find(entry => entry.key === subject.key);
  return row && row.state === 'available' && 'score' in row && typeof row.score === 'number' ? row.score : null;
};

type Ranked = Change & { size: number };

// The owner's own day-to-day moves of one subject, over the stored days of the last thirty before today, each between two
// consecutive days scored by the same version as today's. Values are whole points, as shown.
const movesOf = (history: readonly Record<string, unknown>[], day: string, pillar: Pillar, version: string, read: (stored: Record<string, unknown>) => number | null): number[] => {
  const from = shiftDay(day, -BASELINE_WINDOW_DAYS);
  const byDay = new Map<string, number>();
  for (const stored of history) {
    if (typeof stored.day !== 'string' || stored.day < from || stored.day >= day || storedPillar(stored, pillar)?.version !== version) continue;
    const value = read(stored);
    if (value !== null) byDay.set(stored.day, Math.round(value));
  }
  return [...byDay].flatMap(([at, value]) => { const before = byDay.get(shiftDay(at, -1)); return before === undefined ? [] : [value - before]; });
};
const sinceYesterday = (subject: Change['subject'], pillar: Pillar, yesterday: number, today: number, moves: readonly number[]): Ranked => {
  const [from, to] = [Math.round(yesterday), Math.round(today)];
  const usualMove = moves.length >= BASELINE_DAYS ? Math.sqrt(mean(moves.map(move => move ** 2))) : null;
  const size = usualMove === null || from === to ? 0 : Math.abs(bounded(to - from, usualMove));
  return { subject, pillar, from, to, unit: 'score', against: 'yesterday', verdict: verdictOf(from, to, SCORE_SENSE[pillar]), significant: size >= OUTSIDE, size };
};

// How far a reading sits from its band's centre, in half-widths of the band on its own side (a natural-log band is not
// symmetric, and a clock band may cross midnight). Past one is outside the band.
const againstUsual = (band: UsualRow, reading: TodayReading): Ranked | null => {
  const signal = band.signal as keyof typeof HEALTH_CHANGE_UNIT_OF_SIGNAL_V1;
  const unit = HEALTH_CHANGE_UNIT_OF_SIGNAL_V1[signal];
  if (!unit) return null;
  const clock = unit === 'local_minute';
  const offset = (value: number, centre: number) => (clock ? circularDelta(value, centre) : value - centre);
  const delta = offset(reading.value, band.centre);
  const half = delta >= 0 ? offset(band.high, band.centre) : offset(band.centre, band.low);
  const size = delta === 0 ? 0 : half > 0 ? Math.abs(delta) / half : Number.POSITIVE_INFINITY;
  const [from, to] = [roundTo(band.centre, unit), roundTo(reading.value, unit)];
  return {
    subject: { tier: 3, key: signal, method: band.method as Extract<Change['subject'], { tier: 3 }>['method'] }, pillar: HEALTH_CHANGE_PILLAR_OF_SIGNAL_V1[signal],
    from, to, unit, against: 'usual', verdict: verdictOf(from, to, reading.sense), significant: from !== to && size > OUTSIDE, size: Math.min(size, 2.5),
  };
};

export const changesOf = (input: Readonly<{
  day: string; today: DailyScores; yesterday: DailyScores | null;
  // Whether yesterday's row was scored from the same source as today's: two wearables' scores are never compared.
  sameSource: boolean;
  // The owner's stored days as the history read answers them (with parts); empty when it could not be read.
  history: readonly unknown[];
}>): Change[] => {
  const history = input.history.flatMap(entry => { const day = record(entry); return day ? [day] : []; });
  const ranked: Ranked[] = [];
  const comparable = (pillar: Pillar) => {
    const [today, yesterday] = [input.today[pillar], input.yesterday?.[pillar]];
    return input.sameSource && today.state === 'available' && yesterday?.state === 'available' && today.algorithm_version === yesterday.algorithm_version
      ? { today, yesterday } : null;
  };
  for (const pillar of PILLARS) {
    const pair = comparable(pillar);
    if (!pair) continue;
    const version = pair.today.algorithm_version;
    ranked.push(sinceYesterday({ tier: 1, key: pillar }, pillar, pair.yesterday.score, pair.today.score,
      movesOf(history, input.day, pillar, version, stored => storedPillar(stored, pillar)?.score ?? null)));
  }
  for (const subject of PART_SUBJECTS) {
    const pair = comparable(subject.pillar);
    const today = pair && liveScore(input.today, subject), yesterday = pair && input.yesterday && liveScore(input.yesterday, subject);
    if (!pair || today === null || yesterday === null || yesterday === undefined) continue;
    ranked.push(sinceYesterday({ tier: 2, key: subject.key as Extract<Change['subject'], { tier: 2 }>['key'] }, subject.pillar, yesterday, today,
      movesOf(history, input.day, subject.pillar, pair.today.algorithm_version, stored => partScore(stored.components, subject))));
  }
  for (const band of input.today.usual ?? []) {
    const reading = input.today.readings?.find(entry => entry.signal === band.signal && entry.method === band.method);
    const change = band.state === 'personal' && reading ? againstUsual(band, reading) : null;
    if (change) ranked.push(change);
  }
  return ranked
    .sort((a, b) => Number(b.significant) - Number(a.significant) || b.size - a.size || a.subject.tier - b.subject.tier)
    .slice(0, HEALTH_CHANGES_MAX_V1)
    .map(({ size: _size, ...change }) => change);
};
