import { describe, expect, it } from 'vitest';
import {
  activeGoalRecords,
  canWriteGoalFromTrigger,
  goalRecordSchema,
  goalWriteSourceSchema,
} from './goal';

const goal = {
  id: 'goal-1',
  user_id: 'user-1',
  description: 'Improve my aerobic base',
  created_at: '2026-07-03T08:00:00Z',
  updated_at: '2026-07-03T08:00:00Z',
};

describe('goalRecord', () => {
  it('accepts a minimal active goal and defaults active to true', () => {
    expect(goalRecordSchema.parse(goal)).toEqual({ ...goal, active: true });
  });

  it('accepts user-stated health aspirations as text, not measured health facts', () => {
    expect(
      goalRecordSchema.safeParse({
        ...goal,
        description: 'Get my HRV above 50',
        baseline: 'I feel recovered after 8h sleep',
        target: 'get my HRV above 50',
        progress: 'two consistent workouts this week',
        deadline: '2026-09-01T00:00:00+05:30',
      }).success,
    ).toBe(true);
  });

  it('rejects descriptions over 500 chars', () => {
    expect(goalRecordSchema.safeParse({ ...goal, description: 'g'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('rejects raw measured health fields in the goal record', () => {
    expect(goalRecordSchema.safeParse({ ...goal, hrv_ms: 52 }).success).toBe(false);
  });

  it('rejects non-ISO deadlines and reversed update timestamps', () => {
    expect(goalRecordSchema.safeParse({ ...goal, deadline: '2026-09-01' }).success).toBe(false);
    expect(
      goalRecordSchema.safeParse({
        ...goal,
        created_at: '2026-07-03T08:00:00Z',
        updated_at: '2026-07-03T07:59:59Z',
      }).success,
    ).toBe(false);
  });
});

describe('goal write authority', () => {
  it('names the two canonical write sources without widening trigger authority', () => {
    expect(goalWriteSourceSchema.options).toEqual(['onboarding', 'user_message']);
  });

  it('allows trigger-origin goal writes only from user_message', () => {
    expect(canWriteGoalFromTrigger('user_message')).toBe(true);
    expect(canWriteGoalFromTrigger('brief')).toBe(false);
    expect(canWriteGoalFromTrigger('patrol')).toBe(false);
    expect(canWriteGoalFromTrigger('pre_brief_sweep')).toBe(false);
  });

  it('filters active goals after contract parsing', () => {
    expect(activeGoalRecords([goal, { ...goal, id: 'goal-2', active: false }])).toEqual([
      { ...goal, active: true },
    ]);
  });
});
