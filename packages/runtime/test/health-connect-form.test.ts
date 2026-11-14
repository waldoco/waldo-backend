import { describe, expect, it, vi } from 'vitest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// Form for a Galaxy Watch through Health Connect, as the series read returns it: Samsung Health's night, heart-rate hours and
// hourly steps, and no daylight or movement minutes, which Health Connect does not have. Every value is synthetic.
const TZ = 'Asia/Kolkata', OFFSET = 330, HOUR = 3_600_000;
const TODAY = '2026-11-01';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const local = (day: string, hour: number, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR + minute * 60_000 - OFFSET * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const wobble = (i: number, span: number) => ((i * 7919) % (2 * span + 1)) - span;

type Sample = Record<string, unknown>;
const read = (day: string, from: number, to: number, samsung = true) => ({ day, start_at: iso(from), end_at: iso(to), timezone: TZ, ...(samsung ? { samsung_writer: true } : {}) });
const hourOf = (day: string, h: number, signal: string, value: number, samsung = true): Sample => ({ ...read(day, local(day, h), local(day, h) + HOUR, samsung), signal, value });
// One local day: the night ending that morning (23:00 to 06:30), heart rate every hour up to lastHour, and steps in the waking hours.
// movement adds an hour's movement minutes, as an Apple Watch's would come.
const dayOf = (day: string, i: number, lastHour: number, opts: { steps?: boolean; movement?: boolean } = {}): Sample[] => {
  const from = local(addDays(day, -1), 23), to = local(day, 6, 30);
  const hours = Array.from({ length: lastHour + 1 }, (_, h) => h);
  return [
    { ...read(day, from, to), signal: 'sleep_duration', method: 'asleep_duration', value: 435 + wobble(i, 20) },
    { ...read(day, from, to), signal: 'sleep_midpoint', method: 'sleep_midpoint', value: 165 + wobble(i, 12) },
    ...hours.map(h => hourOf(day, h, 'heart_rate_window', h < 7 || h === 23 ? 53 + wobble(h + i, 3) : 76 + wobble(h + i, 4))),
    ...(opts.steps === false ? [] : hours.filter(h => h >= 7 && h <= 22).map(h => hourOf(day, h, 'steps_window', 400 + 37 * ((h * 13 + i * 7) % 11)))),
    ...(opts.movement ? hours.filter(h => h >= 7 && h <= 22).map(h => hourOf(day, h, 'movement_duration', 4 + ((h + i) % 5))) : []),
  ];
};
const history = (days: number, atHour: number, opts: { steps?: boolean; movement?: boolean } = {}) =>
  Array.from({ length: days }, (_, i) => dayOf(addDays(TODAY, -i), i, i === 0 ? atHour - 1 : 23, opts)).flat();

type Row = Record<string, any>;
const produce = async (samples: readonly Sample[], atHour: number): Promise<{ rows: Row[]; payloads: string[] }> => {
  const rows: Row[] = [], payloads: string[] = [];
  await produceHealthScores({
    readSeries: async range => ({ access: 'granted', read_at: iso(local(TODAY, atHour)).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: samples.filter(s => range.signals.includes(String(s.signal))) }] }),
    writeContext: async payload => { payloads.push(payload); rows.push(JSON.parse(payload)); return { written: true }; },
    compute: dailyScoresFor('1'),
    readDemand: async () => ({ state: 'available', days: Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: 240, partial: false })) }),
  }, { now: local(TODAY, atHour), timezone: TZ });
  return { rows, payloads };
};
const formAt = async (samples: readonly Sample[], atHour: number): Promise<Row> => (await produce(samples, atHour)).rows.find(r => r.day === TODAY)!.form;

describe('Form on Android, where Health Connect has no daylight or movement minutes', () => {
  it('appears in the morning from the day\'s steps against the owner\'s own days, before stress has its hours', async () => {
    const form = await formAt(history(25, 9), 9);
    expect(form).toMatchObject({ algorithm_version: 'form.v10', activation: 'accepted' });
    expect(form.used.signals).toContain('steps');
    expect(form.used.signals).not.toContain('stress');
  });

  it('takes stress too once the day has its eight waking hours', async () => {
    expect((await formAt(history(25, 18), 18)).used.signals).toEqual(expect.arrayContaining(['steps', 'stress']));
  });

  it('waits for seven earlier days of steps: steps have no prior', async () => {
    expect(await formAt(history(7, 9), 9)).toEqual({ reason: 'baseline_immature' });
    expect((await formAt(history(8, 9), 9)).used.signals).toContain('steps');
  });

  it('without steps, is still learning until the afternoon, as before', async () => {
    expect(await formAt(history(25, 9, { steps: false }), 9)).toEqual({ reason: 'baseline_immature' });
  });

  it('reads movement minutes, never steps, on a day that has them, so a watch that counts movement is unchanged', async () => {
    const signals = (await formAt(history(25, 9, { movement: true }), 9)).used.signals;
    expect(signals).toContain('movement');
    expect(signals).not.toContain('steps');
  });

  it('computes the same but never accepts it when steps came from another app', async () => {
    const samples = history(25, 9);
    const stray = samples.map((s, i) => (i === samples.findIndex(x => x.signal === 'steps_window') ? { ...s, samsung_writer: undefined } : s));
    const [mixed, own] = [await formAt(stray, 9), await formAt(samples, 9)];
    expect(mixed).toMatchObject({ activation: 'candidate_unaccepted', score: own.score });
  });

  it('keeps every step count out of the logs and out of the row it writes, which holds the score and the signals used, never a reading', async () => {
    const needle = 48_271;
    const samples = history(25, 9).map(s => (s.signal === 'steps_window' ? { ...s, value: needle } : s));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      const { rows, payloads } = await produce(samples, 9);
      expect(rows.find(r => r.day === TODAY)!.form.used.signals).toContain('steps');
      // An hour's count, or any day's total of them.
      const leaked = (text: string) => Array.from({ length: 24 }, (_, k) => String(needle * (k + 1))).some(value => text.includes(value));
      expect(leaked(payloads.join('\n'))).toBe(false);
      const logged = spies.flatMap(spy => spy.mock.calls.flat().map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))).join('\n');
      expect(leaked(logged)).toBe(false);
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it('never counts an hour of steps twice when the phone sent it again on another hour grid', async () => {
    const samples = history(25, 9);
    const moved = samples.filter(s => s.day === TODAY && s.signal === 'steps_window').slice(0, 1)
      .map(s => ({ ...s, start_at: iso(Date.parse(String(s.start_at)) + 30 * 60_000), end_at: iso(Date.parse(String(s.end_at)) + 30 * 60_000) }));
    const form = await formAt([...samples, ...moved], 9);
    expect(form.used?.signals ?? []).not.toContain('steps');
  });
});
