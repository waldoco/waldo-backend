import { afterEach, describe, expect, it, vi } from 'vitest';
import { produceHealthScores, type ProducerDeps, type ProducerFailure } from '../src/health/producer';
import { HealthRecomputeFailed, healthRecompute } from '../src/health/recompute';
import { dailyScoresFor } from '../src/health/scores';

// A recompute that fails says which step failed and the database's closed answer to it, and nothing else. Synthetic owners.
const NOW = Date.parse('2026-03-20T12:00:00Z');
const TODAY = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const night = (day: string, i: number) => [
  { signal: 'sleep_duration', day, timezone: 'UTC', utc_offset_minutes: 0, start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 440 + (i % 5) * 4, method: 'asleep_duration' },
  { signal: 'overnight_hrv', day, timezone: 'UTC', utc_offset_minutes: 0, start_at: at(addDays(day, -1), 23), end_at: at(day, 7), value: 50 + (i % 4), method: 'rmssd' },
  { signal: 'resting_heart_rate', day, timezone: 'UTC', utc_offset_minutes: 0, start_at: at(day, 3), end_at: at(day, 4), value: 57 + (i % 3) },
];
const series = { access: 'granted', read_at: '2026-03-20T12:00:00.000123Z', sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: 20 }, (_, i) => night(addDays(TODAY, -i), i)).flat() }] };
const SETTINGS = { sleep_need_minutes: null };

const run = async (over: Partial<ProducerDeps>) => {
  const told: ProducerFailure[] = [];
  const outcome = await produceHealthScores({
    readSeries: async range => ({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => range.signals.includes(e.signal)) })) }),
    writeContext: async () => ({ written: true, changed: [] }),
    compute: dailyScoresFor('1'),
    onFailure: failure => told.push(failure),
    ...over,
  }, { now: NOW, timezone: 'UTC' });
  return { outcome, told };
};
afterEach(() => vi.restoreAllMocks());

describe('a failed recompute names its step and the database\'s answer', () => {
  it('tells nothing when the rows are written', async () => {
    expect(await run({})).toEqual({ outcome: 'written', told: [] });
  });

  it('names the series read, with the closed code it answered, no_answer for nothing and malformed for any other shape', async () => {
    for (const [answer, code] of [[{ error: 'invalid_request' }, 'invalid_request'], [null, 'no_answer'], [{ access: 'granted' }, 'malformed']] as const) {
      expect(await run({ readSeries: async () => answer }), JSON.stringify(answer)).toEqual({ outcome: 'failed', told: [{ step: 'series_read', code }] });
    }
  });

  it('names the settings read, at the start of the run and at the re-read before today\'s row', async () => {
    expect(await run({ readSettings: async () => ({ error: 'invalid_request' }) })).toEqual({ outcome: 'failed', told: [{ step: 'settings_read', code: 'invalid_request' }] });
    let reads = 0;
    const { outcome, told } = await run({ readSettings: async () => (reads++ === 0 ? SETTINGS : null) });
    expect(outcome).toBe('failed');
    expect(told).toEqual([{ step: 'settings_read', code: 'no_answer' }]);
  });

  it('names the context write the database refused, so a closed-list refusal reads as context_write:invalid_request', async () => {
    expect(await run({ writeContext: async () => ({ error: 'invalid_request' }) })).toEqual({ outcome: 'failed', told: [{ step: 'context_write', code: 'invalid_request' }] });
    expect(await run({ writeContext: async () => null })).toEqual({ outcome: 'failed', told: [{ step: 'context_write', code: 'no_answer' }] });
  });

  it('tells only the first failure of a run, and nothing for a refusal the run reports as refused', async () => {
    const answers = [{ error: 'invalid_request' }, { error: 'unavailable' }];
    expect((await run({ writeContext: async () => answers.shift() ?? null })).told).toEqual([{ step: 'context_write', code: 'invalid_request' }]);
    expect(await run({ writeContext: async () => ({ error: 'consent_required' }) })).toEqual({ outcome: 'refused', told: [] });
  });

  it('never lets text the database wrote into an error reach the code', async () => {
    const { told } = await run({ writeContext: async () => ({ error: 'row for 2026-03-20 refused: signal steps' }) });
    expect(told).toEqual([{ step: 'context_write', code: 'malformed' }]);
  });

  it('names the producer itself when a step throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run({ compute: () => { throw new Error('boom'); } })).toEqual({ outcome: 'failed', told: [{ step: 'producer', code: 'threw' }] });
  });
});

describe('the recompute run', () => {
  const recompute = (producer: Partial<ProducerDeps>) => healthRecompute({
    // run() never asks the scheduler for anything.
    scheduler: { lookup: () => { throw new Error('unused'); }, schedule: () => { throw new Error('unused'); } },
    now: () => NOW, ownerZone: () => 'UTC',
    producer: { readSeries: async () => series, writeContext: async () => ({ written: true, changed: [] }), compute: dailyScoresFor('1'), ...producer },
  });

  it('throws the step and the database\'s code as one typed code, with no digit, owner or payload in it', async () => {
    const error = await recompute({ writeContext: async () => ({ error: 'invalid_request' }) }).run().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HealthRecomputeFailed);
    expect((error as HealthRecomputeFailed).errorCode).toBe('context_write:invalid_request');
    expect((error as HealthRecomputeFailed).message).toBe('health recompute failed');
  });

  it('carries no code when the producer named none', async () => {
    expect(new HealthRecomputeFailed(undefined).errorCode).toBeNull();
  });
});
