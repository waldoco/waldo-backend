import { describe, expect, it } from 'vitest';
import { scheduleEntrySchema } from './schedule';

const baseEntry = {
  id: 'sched-1',
  kind: 'tracer' as const,
  occurrence_at: 1_000,
  due_at: 1_000,
  status: 'armed' as const,
  attempts: 0,
  created_at: 1_000,
  updated_at: 1_000,
};

describe('scheduleEntry', () => {
  it('accepts an armed one-shot tracer entry', () => {
    expect(scheduleEntrySchema.safeParse(baseEntry).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, kind: 'brief' }).success).toBe(false);
  });

  it('rejects negative attempts', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, attempts: -1 }).success).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(scheduleEntrySchema.safeParse({ ...baseEntry, status: 'firing' }).success).toBe(false);
  });
});
