import { describe, expect, it } from 'vitest';
import { WORKOUT_FRESH_MS, workoutJustEnded, workoutStillFresh } from '../src/health/wake-notice';
import { healthTriggerPrompt, type HealthTriggerView } from '../src/health/trigger';

// A finished workout as the phone uploads it: only "a workout just ended" leaves the detector, never its time or detail.
const now = Date.parse('2026-11-06T18:00:00Z');
const workout = (endMs: number, extra: Record<string, unknown> = {}) => ({
  sample_id: 'HK:run-1', revision: 0, signal: 'workout', unit: 'minutes', activity: 'running', value: 45,
  start_at: new Date(endMs - 45 * 60_000).toISOString(), end_at: new Date(endMs).toISOString(), day: '2026-11-06', utc_offset_minutes: 0, ...extra,
});

describe('a workout that just ended', () => {
  it('is one that ended within the window, allowing a few minutes of clock drift', () => {
    expect(workoutJustEnded([workout(now - 10 * 60_000)], now)).toBe(true);
    expect(workoutJustEnded([workout(now - WORKOUT_FRESH_MS + 60_000)], now)).toBe(true);
    expect(workoutJustEnded([workout(now + 2 * 60_000)], now)).toBe(true);
  });

  it('is not an old workout, one still to end, another signal or a malformed sample', () => {
    expect(workoutJustEnded([workout(now - WORKOUT_FRESH_MS - 60_000)], now)).toBe(false);
    expect(workoutJustEnded([workout(now + 30 * 60_000)], now)).toBe(false);
    expect(workoutJustEnded([{ ...workout(now - 60_000), signal: 'mindful_duration' }], now)).toBe(false);
    expect(workoutJustEnded([0, null, { signal: 'workout' }], now)).toBe(false);
    expect(workoutJustEnded([], now)).toBe(false);
  });
});

describe('a workout the owner object noted', () => {
  it('is handed only to a recompute that started after it was noted, and only while it is fresh', () => {
    const noted = now;
    expect(workoutStillFresh(noted, now)).toBe(true);
    expect(workoutStillFresh(noted, now + WORKOUT_FRESH_MS)).toBe(true);
    expect(workoutStillFresh(noted, now + WORKOUT_FRESH_MS + 1)).toBe(false);
    // A recompute already running when the upload landed may have read the rows before the workout was in them.
    expect(workoutStillFresh(noted, now - 1)).toBe(false);
    expect(workoutStillFresh(undefined, now)).toBe(false);
    expect(workoutStillFresh('2026-11-06', now)).toBe(false);
  });
});

describe('the health trigger on a finished workout', () => {
  const view: HealthTriggerView = { day: '2026-11-06', freshness: 'fresh', now: { recovery: 'solid', form: 'steady', load: 'heavy' }, before: null, drivers: [] };
  it('tells the model a workout just ended and leaves the change, or none, to it', () => {
    const prompt = healthTriggerPrompt({ view, items: [], now, timezone: 'UTC', feedback: {}, reasons: ['workout_ended'] });
    expect(prompt).toContain('The owner just finished a workout.');
    expect(prompt).toContain('with recovery in mind');
    expect(healthTriggerPrompt({ view, items: [], now, timezone: 'UTC', feedback: {}, reasons: ['sleep_debt_building'] })).not.toContain('finished a workout');
  });
});
