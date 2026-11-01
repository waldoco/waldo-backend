import { describe, expect, it } from 'vitest';
import { produceHealthScores, type ProducerDeps } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// The night-recorded signal (ADR-0081 amendment of 1 November 2026). With the switch on, today's row carries a digest of the
// night chosen for it, and the writer says whether that night changed; the owner is told the day, and nothing else. Yesterday's
// row and backfilled rows never carry it. Synthetic owners and values.
const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const READ_AT = '2026-03-20T12:00:00.000123Z';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number, minute = 0) => `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const night = (day: string, end = at(day, 7)): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 23), end_at: end, value: 450, method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 23), end_at: end, value: 180, method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 23), end_at: end, value: 55, method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 }),
];
const nights = (count: number, todayEnd?: string): Sample[] =>
  Array.from({ length: count }, (_, i) => night(addDays(TODAY, -i), i === 0 ? todayEnd : undefined)).flat();
type Row = Record<string, unknown>;
const run = async (samples: Sample[], over: Partial<ProducerDeps> & { answer?: (row: Row) => unknown; source?: string } = {}) => {
  const rows: Row[] = [], told: string[] = [];
  const outcome = await produceHealthScores({
    readSeries: async range => ({ access: 'granted', read_at: READ_AT,
      sources: [{ source: over.source ?? 'apple', consent_epoch: 3, truncated: false, samples: samples.filter(e => range.signals.includes(String(e.signal))) }] }),
    writeContext: async payload => { const row = JSON.parse(payload) as Row; rows.push(row); return over.answer?.(row) ?? { written: true, changed: [] }; },
    readHistory: async () => ({ unavailable: 'no_readings' }),
    compute: dailyScoresFor('1'),
    onNightRecorded: async day => { told.push(day); },
    ...over,
  }, { now: NOW, timezone: 'UTC' });
  return { rows, told, outcome, today: rows.find(r => r.day === TODAY && r.backfilled === undefined) };
};

describe('the night digest on the derived row', () => {
  it('golden: with the switch on, only today\'s live row carries it, as a digest with no time in it', async () => {
    const { rows, today } = await run(nights(20), { nightRef: true });
    expect(today?.night_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.filter(r => r !== today).every(r => !('night_ref' in r))).toBe(true);
    expect(rows.some(r => r.backfilled === true)).toBe(true);
    expect(JSON.stringify(today?.night_ref)).not.toMatch(/T\d\d:|2026/);
  });

  it('with the switch off no row carries it, and the owner is never told', async () => {
    const { rows, told } = await run(nights(20), { answer: () => ({ written: true, changed: [], night_changed: true }) });
    expect(rows.every(r => !('night_ref' in r))).toBe(true);
    expect(told).toEqual([]);
  });

  it('names the night: the same night gives the same digest; a later end or another source gives another', async () => {
    const first = (await run(nights(20), { nightRef: true })).today?.night_ref;
    expect((await run(nights(20), { nightRef: true })).today?.night_ref).toBe(first);
    expect((await run(nights(20, at(TODAY, 7, 10)), { nightRef: true })).today?.night_ref).not.toBe(first);
    expect((await run(nights(20), { nightRef: true, source: 'whoop' })).today?.night_ref).not.toBe(first);
  });

  it('a today with no night yet carries none', async () => {
    const { today } = await run(nights(20).filter(s => !(s.day === TODAY && String(s.signal).startsWith('sleep'))), { nightRef: true });
    expect(today === undefined || !('night_ref' in today)).toBe(true);
  });
});

describe('telling the owner the night is recorded', () => {
  it('tells today, and only when the writer wrote the row and says the night changed', async () => {
    expect((await run(nights(20), { nightRef: true, answer: row => ({ written: true, changed: [], night_changed: row.day === TODAY }) })).told).toEqual([TODAY]);
    expect((await run(nights(20), { nightRef: true, answer: () => ({ written: true, changed: [], night_changed: false }) })).told).toEqual([]);
    expect((await run(nights(20), { nightRef: true, answer: () => ({ written: false, stale: true, night_changed: true }) })).told).toEqual([]);
  });

  it('a backfilled or yesterday\'s row the writer answered with a change tells nothing', async () => {
    const { told } = await run(nights(20), { nightRef: true, answer: row => ({ written: true, changed: [], night_changed: row.day !== TODAY }) });
    expect(told).toEqual([]);
  });

  it('a notice that fails never fails the write', async () => {
    const { outcome } = await run(nights(20), { nightRef: true, answer: () => ({ written: true, changed: [], night_changed: true }),
      onNightRecorded: async () => { throw new Error('owner object away'); } });
    expect(outcome).toBe('written');
  });
});
