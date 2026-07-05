import { describe, expect, it } from 'vitest';
import { hallTypeSchema } from '../memory/hall';
import { goalRecordSchema } from './goal';

const baseGoal = {
  id: 'goal-1',
  user_id: 'user-1',
  description: 'protect deep work before lunch',
  baseline: 'currently fragmented mornings',
  target: 'three focused mornings per week',
  progress: 'one focused morning this week',
  deadline: '2026-08-01T00:00:00Z',
  created_at: 1_000,
  updated_at: 1_000,
};

describe('goalRecord', () => {
  it('accepts an active persistent goal and defaults active to true', () => {
    expect(goalRecordSchema.parse(baseGoal)).toEqual({ ...baseGoal, active: true });
  });

  it('accepts stated numeric aspirations as user text', () => {
    expect(
      goalRecordSchema.safeParse({
        ...baseGoal,
        target: 'get my HRV above 50',
        progress: 'I feel closer to that target',
      }).success,
    ).toBe(true);
  });

  it('rejects an unbounded description', () => {
    expect(
      goalRecordSchema.safeParse({
        ...baseGoal,
        description: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid deadline', () => {
    expect(
      goalRecordSchema.safeParse({
        ...baseGoal,
        deadline: 'tomorrow',
      }).success,
    ).toBe(false);
  });

  it("does not turn goals into a sixth memory hall", () => {
    expect(hallTypeSchema.safeParse('goals').success).toBe(false);
  });
});
