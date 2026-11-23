import { describe, expect, it } from 'vitest';
import { healthRecompute } from '../src/health/recompute';
import { dailyScoresFor } from '../src/health/scores';

// The recompute tells its caller once a run has written the owner's first row for today, so a Brief already sent can be
// revised. A fake plane that answers like the database functions; synthetic readings, a Kolkata owner read at 18:00.
const TZ = 'Asia/Kolkata', OFFSET = 330, HOUR = 3_600_000, TODAY = '2026-11-01';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const local = (day: string, hour: number) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR - OFFSET * 60_000;
const NOW = local(TODAY, 18);
const steps = Array.from({ length: 20 }, (_, i) => addDays(TODAY, -i)).flatMap(day => Array.from({ length: 11 }, (_, h) => ({
  signal: 'steps_window', day, start_at: new Date(local(day, h + 7)).toISOString(), end_at: new Date(local(day, h + 8)).toISOString(), utc_offset_minutes: OFFSET, timezone: TZ, value: 380 + h * 7,
})));

const plane = (stored: Set<string>, options: { readFails?: boolean } = {}) => {
  const told: string[] = [];
  const recompute = healthRecompute({
    scheduler: { lookup: () => ({ state: 'none' }), schedule: async () => undefined } as never,
    now: () => NOW, ownerZone: () => TZ,
    producer: {
      readSeries: async () => ({ access: 'granted', read_at: new Date(NOW).toISOString(), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: steps }] }),
      writeContext: async (payload: string) => { stored.add(String((JSON.parse(payload) as { day: string }).day)); return { written: true }; },
      readScores: async (day: string) => { if (options.readFails) throw new Error('synthetic outage'); return stored.has(day) ? { scores: { day } } : { scores: null }; },
      compute: dailyScoresFor('1'),
      readDemand: async () => ({ state: 'unavailable' }),
    } as never,
    firstRowToday: async day => { told.push(day); },
  });
  return { recompute, told };
};

describe('the recompute\'s first row for today', () => {
  it('tells its caller once, on the run that wrote today\'s first row', async () => {
    const { recompute, told } = plane(new Set());
    expect(await recompute.run()).toBe('written');
    expect(told).toEqual([TODAY]);
    await recompute.run();
    expect(told).toEqual([TODAY]);
  });

  it('says nothing when today already had a row, or when today\'s row cannot be read', async () => {
    const held = plane(new Set([TODAY]));
    await held.recompute.run();
    expect(held.told).toEqual([]);
    const unreadable = plane(new Set(), { readFails: true });
    await unreadable.recompute.run().catch(() => undefined);
    expect(unreadable.told).toEqual([]);
  });
});
