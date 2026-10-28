import { afterEach, describe, expect, it, vi } from 'vitest';
import { produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// The derived row with the Form curve switch on: today's measured curve and the stress word, written beside the scores. A
// synthetic owner with a steady wake, read at half past two in the afternoon.
const NOW = Date.parse('2026-03-20T14:30:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T14:30:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const dayOfReadings = (day: string, i: number, through: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 450 + wobble(i, 20), method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 180 + wobble(i, 15), method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 55 + wobble(i, 6), method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 + wobble(i, 2) }),
  ...Array.from({ length: through }, (_, h) => [
    sample('heart_rate_window', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 70 + wobble(h + i, 2) }),
    sample('hrv_window', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 50 + wobble(h + i, 3), method: 'rmssd' }),
    sample('daylight_duration', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 20 + wobble(h + i, 2) }),
    sample('movement_duration', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 12 + wobble(h + i, 2) }),
  ]).flat(),
];
// Today holds hours 0 to 14 (the last still filling at the read); every earlier day holds all twenty-four.
const series = (nights: number, source = 'apple', epoch = 3, todayThrough = 15, readAt = READ_AT) => ({
  access: 'granted', read_at: readAt,
  sources: [{ source, consent_epoch: epoch, truncated: false, samples: Array.from({ length: nights }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, i === 0 ? todayThrough : 24)).flat() }],
});
type Row = Record<string, any>;
type Switch = string | undefined;
const written = async (engine: Switch, formCurve: Switch, samples: unknown = series(20), extra: Partial<ProducerDeps> = {}, now = NOW): Promise<Row[]> => {
  const rows: Row[] = [];
  await produceHealthScores({
    readSeries: async range => { const s = samples as ReturnType<typeof series>; return { ...s, sources: s.sources.map(x => ({ ...x, samples: x.samples.filter(e => range.signals.includes(String(e.signal))) })) }; },
    writeContext: async payload => { rows.push(JSON.parse(payload) as Row); return { written: true }; },
    compute: dailyScoresFor(engine),
    ...(formCurve === undefined ? {} : { formCurve }),
    ...extra,
  }, { now, timezone: 'UTC' });
  return rows;
};
afterEach(() => vi.restoreAllMocks());

describe('the derived row with the Form curve switch on', () => {
  it('writes today\'s measured curve and the stress word, and the curve ends at the Form score of the row', async () => {
    const rows = await written('1', '1');
    const today = rows.find(r => r.day === TODAY)!;
    expect(Object.keys(today.form_curve).sort()).toEqual(['points', 'version']);
    expect(today.form_curve.version).toBe(today.form.algorithm_version);
    expect(today.form_curve.points.length).toBeGreaterThan(1);
    expect(today.form_curve.points.length).toBeLessThanOrEqual(96);
    for (const point of today.form_curve.points) expect(Object.keys(point).sort()).toEqual(['at', 'kind', 'score']);
    expect(today.form_curve.points.at(-1)).toEqual({ at: at(TODAY, 14), score: today.form.score, kind: 'measured' });
    expect(['rising', 'steady', 'easing']).toContain(today.stress_trend);
  });
  it('agrees with the row: the curve at an hour is the Form score the row had when that hour had just ended', async () => {
    const curve = (await written('1', '1')).find(r => r.day === TODAY)!.form_curve.points as Row[];
    for (const hour of [9, 12]) {
      const readAt = `${TODAY}T${String(hour).padStart(2, '0')}:00:00.000123Z`;
      const then = (await written('1', undefined, series(20, 'apple', 3, hour, readAt), {}, Date.parse(readAt))).find(r => r.day === TODAY)!;
      expect(curve.find(point => point.at === at(TODAY, hour))!.score, `hour ${hour}`).toBe(then.form.score);
    }
  });
  it('writes neither on yesterday\'s row nor on any backfilled row', async () => {
    const rows = await written('1', '1', series(20), { readHistory: async () => ({ unavailable: 'no_readings' }) });
    expect(rows.filter(r => r.backfilled === true).length).toBeGreaterThan(0);
    for (const row of rows.filter(r => r.day !== TODAY)) {
      expect('form_curve' in row || 'stress_trend' in row, String(row.day)).toBe(false);
    }
  });
  it('writes the curve beside a row from a source nothing has validated, which Form itself says is a candidate', async () => {
    const today = (await written('1', '1', series(20, 'fitbit'))).find(r => r.day === TODAY)!;
    expect(today.form.activation).toBe('candidate_unaccepted');
    expect(today.form_curve.points.length).toBeGreaterThan(1);
  });
  it('writes the earlier engine\'s curve under that engine\'s version', async () => {
    const today = (await written(undefined, '1')).find(r => r.day === TODAY)!;
    expect(today.form_curve.version).toBe('form.candidate.v8');
    expect(today.form_curve.points.at(-1).score).toBe(today.form.score);
  });
  it('writes no curve when Form is unavailable that day', async () => {
    const rows = await written('1', '1', series(2));
    const today = rows.find(r => r.day === TODAY);
    expect(today?.form.reason).toBeDefined();
    expect(today && ('form_curve' in today || 'stress_trend' in today)).toBe(false);
  });
  it('leaves each line the producer logs without a value, and logs nothing about the curve', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    await written('1', '1');
    expect(lines.join('\n')).not.toMatch(/form_curve|points|stress_trend|rising|easing|measured/);
  });
  it('keeps the row well inside what the database accepts in one write', async () => {
    const today = (await written('1', '1', series(31))).find(r => r.day === TODAY)!;
    expect(JSON.stringify(today).length).toBeLessThan(12_000);
  });
});

describe('the switch is the exact value "1"', () => {
  it.each([undefined, '', '0', 'true', 'on', ' 1', '01', '1 '])('with %j, every row is byte-identical to the row written with no switch at all', async flag => {
    for (const engine of ['1', undefined]) {
      expect(await written(engine, flag)).toEqual(await written(engine, undefined));
      expect(JSON.stringify(await written(engine, flag))).toBe(JSON.stringify(await written(engine, undefined)));
    }
  });
  it('turns it on for "1" only, and the rows differ from the earlier ones in exactly the two keys of today\'s', async () => {
    const off = await written('1', undefined), on = await written('1', '1');
    expect(on.length).toBe(off.length);
    const strip = (row: Row) => { const { form_curve: _c, stress_trend: _s, ...rest } = row; return rest; };
    expect(on.map(strip)).toEqual(off);
    expect(on.filter(r => 'form_curve' in r).map(r => r.day)).toEqual([TODAY]);
  });
});
