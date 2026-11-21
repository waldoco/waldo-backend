import { describe, expect, it } from 'vitest';
import { getCrsResultSchema } from '../../contracts/src/tools/schemas/reads';
import { getCrsHandler, type BodyHistoryBook } from '../src/tools/live/crs';
import { EVERY_KIND_NOW, EVERY_KIND_TODAY, everyKindDailyRows } from './support/health-every-kind';

// get_crs reads the owner's scores, their parts, the usual bands and today's readings from the rows the engine wrote, under the
// read's own model-use check. Synthetic owners and values only.
const clock = { timezone: 'UTC', now: () => new Date(EVERY_KIND_NOW) };
const run = async (answer: unknown | (() => Promise<unknown>), days = 30, errors: string[] = []) => {
  const asked: number[] = [];
  const book: BodyHistoryBook = { history: async (n) => { asked.push(n); return typeof answer === 'function' ? (answer as () => Promise<unknown>)() : answer; } };
  const result = await getCrsHandler(book, clock, (code) => { errors.push(code); }).handle({ range_days: days }, {} as never);
  return { result, asked, errors };
};
const band = { signal: 'overnight_hrv', method: 'rmssd', state: 'personal', low: 50, centre: 60, high: 70, own_days: 24, own_share: 0.8, days_until_personal: 0, window_days: 30, estimator: 'shrunk_predictive' };
const change = { subject: { tier: 3, key: 'overnight_hrv', method: 'rmssd' }, pillar: 'recovery', from: 60, to: 39.5, unit: 'milliseconds', against: 'usual', verdict: 'declined', significant: true };
const pillars = { recovery: { score: 61.25, zone: 'moderate', algorithm_version: 'recovery.v5' }, form: { reason: 'stale_inputs' }, weight: { reason: 'not_linked' } };

describe('get_crs', () => {
  it('gives each day\'s pillars in the model\'s zone words, why one was not computed, and the parts with their direction', async () => {
    const components = { recovery: [
      { key: 'sleep', state: 'available', score: 83, share: 0.5, points: 41.5, direction: null, signals: [], baseline: null, need_minutes: 480, need_basis: 'owner_confirmed' },
      { key: 'hrv', state: 'available', score: 40, share: 0.5, points: 20, direction: 'below_usual', signals: ['overnight_hrv'], baseline: { state: 'personal', own_days: 24, own_share: 0.8, days_until_personal: 0 } },
    ] };
    const { result, asked } = await run({ history: { from: '2026-02-19', to: EVERY_KIND_TODAY, days: [
      { day: '2026-03-19', ...pillars, backfilled: true },
      { day: EVERY_KIND_TODAY, ...pillars, components, usual: [band], changes: [change] },
    ] } });
    expect(asked).toEqual([30]);
    if (!result.ok || result.data.state !== 'available') throw new Error('expected an available read');
    expect(getCrsResultSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.days[0]).toEqual({ day: '2026-03-19', recovery: { score: 61.3, zone: 'mixed' }, form: { reason: 'stale_inputs' }, backfilled: true });
    expect(result.data.days[1]!.parts).toEqual([
      { pillar: 'recovery', key: 'sleep', score: 83, direction: null, need_minutes: 480 },
      { pillar: 'recovery', key: 'hrv', score: 40, direction: 'below' },
    ]);
    expect(result.data.usual).toEqual([{ signal: 'overnight_hrv', words: 'overnight heart rate variability', unit: 'milliseconds', span: 'night', state: 'personal', low: 50, centre: 60, high: 70, own_days: 24 }]);
    expect(result.data.today).toEqual([{ signal: 'overnight_hrv', unit: 'milliseconds', value: 39.5, direction: 'below', far: true }]);
  });
  it('gives no readings as today\'s when the newest row is an earlier day\'s', async () => {
    const { result } = await run({ history: { from: '2026-02-19', to: EVERY_KIND_TODAY, days: [{ day: '2026-03-19', ...pillars, usual: [band], changes: [change] }] } });
    if (!result.ok || result.data.state !== 'available') throw new Error('expected an available read');
    expect(result.data.today).toBeUndefined();
    expect(result.data.usual).toHaveLength(1);
  });
  it('passes on why nothing was read, with what to do, and never a value', async () => {
    for (const [answer, reason] of [
      [{ unavailable: 'consent_withdrawn' }, 'consent_withdrawn'], [{ unavailable: 'consent_required' }, 'consent_required'], [{ unavailable: 'no_readings' }, 'no_readings'],
      [{ error: 'not_linked' }, 'not_linked'], [{ error: 'invalid_request' }, 'read_failed'], [null, 'read_failed'],
      [() => Promise.reject(new Error('down')), 'read_failed'],
    ] as const) {
      const { result } = await run(answer);
      expect(result.ok && result.data, JSON.stringify(answer)).toMatchObject({ state: 'unavailable', reason });
      expect(result.ok && result.data.state === 'unavailable' && result.data.next).toMatch(/\S/);
    }
  });
  it('names a malformed answer by a fixed code, never its content', async () => {
    const errors: string[] = [];
    const { result } = await run({ history: { from: 'x', days: 'Recovery 61' } }, 30, errors);
    expect(result.ok && result.data).toMatchObject({ state: 'unavailable', reason: 'read_failed' });
    expect(errors).toEqual(['get_crs_shape']);
  });
  it('answers "how has my Recovery and its parts moved this month, and is last night unusual for me" from one call', async () => {
    // The rows the producer wrote, one run each evening, for a synthetic owner whose phone sends every kind, answered as the
    // history read would.
    const rows = await everyKindDailyRows();
    const { result } = await run({ history: { from: '2026-02-19', to: EVERY_KIND_TODAY, days: rows.map(row => ({ day: row.day, recovery: row.recovery, form: row.form, weight: row.weight, ...(row.components ? { components: row.components } : {}), ...(row.usual ? { usual: row.usual } : {}), ...(row.day === EVERY_KIND_TODAY && row.changes ? { changes: row.changes } : {}) })) } });
    if (!result.ok || result.data.state !== 'available') throw new Error('expected an available read');
    const withRecovery = result.data.days.filter(day => day.recovery && 'score' in day.recovery);
    expect(withRecovery.length).toBeGreaterThanOrEqual(20);
    const recoveryParts = (day: (typeof result.data.days)[number]) => (day.parts ?? []).filter(part => part.pillar === 'recovery').map(part => part.key);
    expect(recoveryParts(result.data.days.at(-1)!)).toEqual(['sleep', 'hrv', 'resting_heart_rate']);
    expect(result.data.days.filter(day => recoveryParts(day).length > 0).length).toBeGreaterThanOrEqual(20);
    // Last night against the owner's usual: the night's readings, each with its band and which way it stood.
    const night = (result.data.today ?? []).filter(reading => result.data.state === 'available' && result.data.usual?.find(entry => entry.signal === reading.signal)?.span === 'night');
    expect(night.map(reading => reading.signal)).toEqual(expect.arrayContaining(['overnight_hrv', 'breathing_rate', 'spo2', 'wrist_temperature', 'awake_time']));
    expect(night.every(reading => reading.direction !== 'within')).toBe(true);
  });
});
