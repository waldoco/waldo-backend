import { describe, expect, it } from 'vitest';
import { welcomeSourceAvailable } from '../src/onboarding/welcome-sources';
import type { HealthReadBook } from '../src/tools/live/health';

// Whether the health stage's source is there now: consent for both purposes, health kept in memory, and a reading to build from,
// so a stage that settled empty before the phone's first upload is not spent before one lands. Every value here is synthetic.
const NOW = Date.parse('2026-10-31T06:00:00Z');
const sample = { signal: 'sleep_duration', day: '2026-10-30', value: 420, start_at: null, end_at: null, timezone: 'UTC', method: 'asleep_duration' };
const book = (consent: string, samples: unknown[] = [], ranges: unknown[] = []): HealthReadBook => ({
  consent: async () => (consent === 'granted' ? { kind: 'granted', sources: new Set(['apple']) } : { kind: consent as 'consent_required' }),
  series: async range => { ranges.push(range); return { access: 'granted', read_at: '2026-10-31T06:00:00.000Z', sources: [{ source: 'apple', consent_epoch: 1, samples }] }; },
});
const available = (healthRead: HealthReadBook, memory = true) => welcomeSourceAvailable({
  claims: {} as never, healthMemory: () => memory, healthRead, google: {} as never, findings: () => ({}) as never, now: () => NOW, timezone: () => 'UTC',
})('health');

describe('welcome: is the health source there now', () => {
  it('is there once a reading has landed under granted consent', async () => {
    const ranges: unknown[] = [];
    expect(await available(book('granted', [sample], ranges))).toBe(true);
    expect(ranges).toHaveLength(1);
  });
  it('is not there before the first reading, without consent, or when health stays out of memory', async () => {
    expect(await available(book('granted', []))).toBe(false);
    expect(await available(book('consent_required', [sample]))).toBe(false);
    expect(await available(book('granted', [sample]), false)).toBe(false);
  });
  it('is not there from a source the owner has not granted', async () => {
    const other: HealthReadBook = { ...book('granted'), series: async () => ({ access: 'granted', read_at: '2026-10-31T06:00:00.000Z', sources: [{ source: 'whoop', consent_epoch: 1, samples: [sample] }] }) };
    expect(await available(other)).toBe(false);
  });
});
