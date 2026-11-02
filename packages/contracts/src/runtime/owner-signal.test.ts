import { describe, expect, it } from 'vitest';
import { ownerSignalSchema } from './owner-signal';

describe('ownerSignalSchema', () => {
  it('accepts body-state moments from the closed health branch', () => {
    expect(ownerSignalSchema.parse({ source: 'health', event: 'woke_up' })).toEqual({ source: 'health', event: 'woke_up' });
    expect(ownerSignalSchema.parse({
      source: 'health', event: 'workout_ended', activity: 'Outdoor Run', context: { calendar: '14:00 Client call' },
    })).toMatchObject({ activity: 'Outdoor Run' });
  });

  it('accepts any named moment from any other source, normalising names', () => {
    expect(ownerSignalSchema.parse({ source: 'Location', event: 'arrived', detail: 'Arrived at St Mary School' })).toEqual({
      source: 'location', event: 'arrived', detail: 'Arrived at St Mary School',
    });
    expect(ownerSignalSchema.parse({
      source: 'granola', event: 'note_ready', id: 'not_8f2a', detail: '- Send deck by Friday',
      context: { calendar: '15:00 Investor call', weather: 'Rain' },
    }).event).toBe('note_ready');
    expect(ownerSignalSchema.parse({ source: 'shift', event: 'handover_done' }).source).toBe('shift');
  });

  it('rejects malformed names, empty detail and oversized context', () => {
    expect(ownerSignalSchema.safeParse({ source: 'calendar' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ source: 'my source', event: 'x' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ source: 'mail', event: 'received', detail: '   ' }).success).toBe(false);
    const context = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 'v']));
    expect(ownerSignalSchema.safeParse({ source: 'mail', event: 'received', context }).success).toBe(false);
  });

  it('refuses physiological readings and free-text health moments', () => {
    expect(ownerSignalSchema.safeParse({ source: 'health', event: 'workout_ended', calories: 420 }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ source: 'health', event: 'woke_up', detail: 'slept 6.5h' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ source: 'health', event: 'workout_ended', activity: 'Run 5km 420kcal' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ source: 'health', event: 'heart_rate_high' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ source: 'HEALTH', event: 'woke_up', detail: 'x' }).success).toBe(false);
  });
});
