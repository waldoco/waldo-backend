import { describe, expect, it } from 'vitest';
import { ownerSignalSchema } from './owner-signal';

describe('ownerSignalSchema', () => {
  it('accepts each signal kind with optional device context', () => {
    expect(ownerSignalSchema.parse({ kind: 'woke_up' })).toEqual({ kind: 'woke_up' });
    expect(ownerSignalSchema.parse({
      kind: 'woke_up',
      context: { weather: 'Light rain, 14°C', calendar: '10:00 Design review\n15:00 Investor call' },
    }).kind).toBe('woke_up');
    expect(ownerSignalSchema.parse({ kind: 'winding_down' }).kind).toBe('winding_down');
    expect(ownerSignalSchema.parse({ kind: 'workout_ended', activity: 'Outdoor Run' })).toEqual({
      kind: 'workout_ended', activity: 'Outdoor Run',
    });
    expect(ownerSignalSchema.parse({
      kind: 'meeting_notes', id: 'not_8f2a', title: 'Investor call', notes: '- Send deck by Friday',
    }).kind).toBe('meeting_notes');
  });

  it('rejects unknown kinds, empty notes and missing kind', () => {
    expect(ownerSignalSchema.safeParse({ kind: 'heartbeat' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ kind: 'meeting_notes', notes: '   ' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({}).success).toBe(false);
  });

  it('refuses physiological readings in any shape', () => {
    expect(ownerSignalSchema.safeParse({ kind: 'workout_ended', calories: 420 }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ kind: 'woke_up', sleep_minutes: 412 }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ kind: 'workout_ended', activity: 'Run 5km 420kcal' }).success).toBe(false);
    expect(ownerSignalSchema.safeParse({ kind: 'woke_up', context: { heart_rate: '52' } }).success).toBe(false);
  });
});
