import { describe, expect, it } from 'vitest';
import { derivedHealthDestinationViewSchema } from '@waldo/contracts';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { renderHealth } from '../src/context-composer/prompt';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';
import { WRITER_USED_SIGNALS } from './support/migration-lists';

// Scores degrade, they do not gate (ADR-0081 amendment, rulings of 16 Nov): the provisional engine stands Recovery on the
// night's sleep without an overnight heart signal and Form on the day's own parts without Recovery, each a candidate at its
// lower coverage. Rows come from the real producer; every value is synthetic, a Health Connect owner in Kolkata read at 18:00,
// when today has the eight hours of steps Form's day parts need.
const TZ = 'Asia/Kolkata', OFFSET = 330, HOUR = 3_600_000;
const TODAY = '2026-11-01';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const local = (day: string, hour: number, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR + minute * 60_000 - OFFSET * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const wobble = (i: number, span: number) => ((i * 7919) % (2 * span + 1)) - span;
const NOW = local(TODAY, 18);
const clock = { timezone: TZ, now: () => new Date(NOW) };

type Kinds = Readonly<{ sleep?: boolean; hrv?: boolean; heart?: boolean; steps?: boolean }>;
type Sample = Record<string, unknown>;
const reading = (signal: string, day: string, from: number, to: number, extra: Sample): Sample =>
  ({ signal, day, start_at: iso(from), end_at: iso(to), utc_offset_minutes: OFFSET, timezone: TZ, samsung_writer: true, ...extra });
const dayOf = (day: string, i: number, lastHour: number, kinds: Kinds): Sample[] => {
  const from = local(addDays(day, -1), 23), to = local(day, 6, 30);
  const hours = Array.from({ length: lastHour + 1 }, (_, h) => h);
  return [
    ...(kinds.sleep ? [
      reading('sleep_duration', day, from, to, { method: 'asleep_duration', value: 435 + wobble(i, 20) }),
      reading('sleep_midpoint', day, from, to, { method: 'sleep_midpoint', value: 165 + wobble(i, 12) }),
    ] : []),
    ...(kinds.hrv ? [reading('overnight_hrv', day, from, to, { method: 'rmssd', value: 42 + wobble(i, 6) })] : []),
    ...(kinds.heart ? hours.map(h => reading('heart_rate_window', day, local(day, h), local(day, h) + HOUR, { value: h < 7 || h === 23 ? 53 + wobble(h + i, 3) : 76 + wobble(h + i, 4) })) : []),
    ...(kinds.steps ? hours.filter(h => h >= 7 && h <= 21).map(h => reading('steps_window', day, local(day, h), local(day, h) + HOUR, { value: 400 + wobble(h + i, 150) })) : []),
  ];
};

// Today's row as the producer writes it, through a writer that refuses a used name its newest migration does not admit.
const todaysRow = async (kinds: Kinds, provisional: '1' | '0' = '1', scoreParts = false): Promise<Record<string, unknown>> => {
  const samples = Array.from({ length: 20 }, (_, i) => dayOf(addDays(TODAY, -i), i, i === 0 ? 17 : 23, kinds)).flat();
  const written: Record<string, unknown>[] = [];
  const outcome = await produceHealthScores({
    readSeries: async (range: { signals: readonly string[] }) => ({ access: 'granted', read_at: iso(NOW).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: samples.filter(s => range.signals.includes(String(s.signal))) }] }),
    writeContext: async (payload: string) => {
      const row = JSON.parse(payload) as Record<string, { used?: { signals: string[] } }>;
      const used = (['recovery', 'form', 'weight'] as const).flatMap(pillar => row[pillar]?.used?.signals ?? []);
      if (!used.every(name => WRITER_USED_SIGNALS.includes(name))) return { error: 'invalid_request' };
      written.push(row);
      return { written: true };
    },
    compute: dailyScoresFor(provisional), scoreParts,
    readDemand: async () => ({ state: 'unavailable' }),
  } as never, { now: NOW, timezone: TZ });
  expect(outcome).toBe('written');
  const today = written.find(r => r.day === TODAY);
  if (!today) throw new Error('the producer wrote no row for today');
  return today;
};
const asRead = (stored: Record<string, unknown>): HealthContextRow => {
  const { timezone: _tz, read_at: _readAt, ...kept } = stored;
  return { context: { ...kept, id: 'ctx-degrade', compiled_at: iso(NOW - HOUR) } as never, previous: null };
};
const pillar = (row: Record<string, unknown>, name: string) => row[name] as Record<string, unknown>;

describe('scores degrade, they do not gate', () => {
  it('steps only: Form stands on the day\'s steps as a candidate, where the earlier engine gives none', async () => {
    expect(pillar(await todaysRow({ steps: true }, '0'), 'form')).toEqual({ reason: 'missing_sleep' });
    const form = pillar(await todaysRow({ steps: true }), 'form');
    expect(form).toMatchObject({ algorithm_version: 'form.v11', activation: 'candidate_unaccepted', used: { signals: ['steps'] } });
    // Its confidence is its coverage, steps' share of Form, times the source's confidence: well below a full day's.
    expect(form.confidence).toBeLessThanOrEqual(0.2);
  });

  it('sleep and steps without an overnight heart signal: Recovery stands on the night\'s sleep, and Form on it and the day', async () => {
    const on = await todaysRow({ sleep: true, steps: true });
    expect(pillar(on, 'recovery')).toMatchObject({ algorithm_version: 'recovery.v6', activation: 'candidate_unaccepted', used: { signals: ['sleep'] } });
    expect(pillar(on, 'form')).toMatchObject({ algorithm_version: 'form.v11', activation: 'candidate_unaccepted', used: { signals: ['sleep', 'sleep_midpoint', 'steps'] } });
  });

  it('heart rate and steps without sleep: Recovery keeps its reason, and Form reads the day\'s heart rate and steps', async () => {
    const on = await todaysRow({ heart: true, steps: true });
    expect(pillar(on, 'recovery')).toEqual({ reason: 'missing_sleep' });
    expect(pillar(on, 'form')).toMatchObject({ algorithm_version: 'form.v11', used: { signals: ['steps', 'stress'] } });
  });

  it('shows a Form without Recovery its night part as missing, and the parts it stood on as the whole score', async () => {
    const row = await todaysRow({ heart: true, steps: true }, '1', true);
    const parts = (row['components'] as Record<string, readonly Record<string, unknown>[]>)['form']!;
    expect(parts[0]).toEqual({ key: 'from_the_night', state: 'unavailable', reason: 'no_reading' });
    const shares = parts.flatMap(part => (part['state'] === 'available' ? [part['share'] as number] : []));
    expect(shares.length).toBeGreaterThan(0);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 5);
    expect(JSON.stringify(parts)).not.toContain('null,"share"');
  });

  it('leaves an owner with every input on the accepted versions', async () => {
    const row = await todaysRow({ sleep: true, hrv: true, heart: true, steps: true });
    expect(pillar(row, 'recovery')).toMatchObject({ algorithm_version: 'recovery.v5', activation: 'accepted', used: { signals: ['sleep', 'hrv', 'resting_heart_rate'] } });
    expect(pillar(row, 'form')).toMatchObject({ algorithm_version: 'form.v10', activation: 'accepted' });
  });

  it('tells the model a Form that stands without Recovery, with its parts and confidence, and no reading on the night', async () => {
    const material = toContextHealthMaterial(asRead(await todaysRow({ heart: true, steps: true })), clock, undefined, { partial: true });
    expect(material && derivedHealthDestinationViewSchema.safeParse(material.view).success).toBe(true);
    const block = renderHealth(material);
    expect(block.split('\n').slice(0, 2)).toEqual([
      'Partial health context: Recovery was not computed for this day, so there is no reading on the night; Form stands on the day alone.',
      expect.stringMatching(/^Form: (energized|steady|flagging|depleted), from steps, heart rate through the day without last night; confidence low\.$/),
    ]);
    expect(block).toContain('Not computed: Recovery (no sleep has arrived for the night, either unrecorded or not synced yet)');
    expect(block).not.toMatch(/Not computed:[^\n]*Form/);
    expect(block).not.toMatch(/\d/);
  });
});
