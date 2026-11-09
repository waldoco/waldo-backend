import { describe, expect, it } from 'vitest';
import {
  activeGoalRecords,
  canWriteGoalFromTrigger,
  goalRecordSchema,
  goalState,
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

describe('quest fields', () => {
  const quest = { ...goal, description: 'Sub-4 marathon in March', plan: 'Three runs a week, long run on Sunday', state: 'active', check_in_days: 7, last_check_in_at: '2026-11-01T21:30:00Z' };

  it('carries a plan, a state, a check-in pace and the last check-in', () => {
    expect(goalRecordSchema.safeParse(quest).success).toBe(true);
    expect(goalRecordSchema.safeParse({ ...quest, state: 'ambient', check_in_days: undefined }).success).toBe(true);
    expect(goalRecordSchema.safeParse({ ...quest, state: 'completed', active: false }).success).toBe(true);
  });

  it('rejects an unknown state, a pace outside 1 to 28 days and a plan over 500 characters', () => {
    expect(goalRecordSchema.safeParse({ ...quest, state: 'paused' }).success).toBe(false);
    for (const days of [0, 29, 1.5]) expect(goalRecordSchema.safeParse({ ...quest, check_in_days: days }).success).toBe(false);
    expect(goalRecordSchema.safeParse({ ...quest, plan: 'p'.repeat(501) }).success).toBe(false);
  });

  it('keeps active and state saying the same thing', () => {
    expect(goalRecordSchema.safeParse({ ...quest, state: 'completed' }).success).toBe(false);
    expect(goalRecordSchema.safeParse({ ...quest, state: 'ambient', active: false }).success).toBe(false);
  });

  it('reads a goal written before quests by its active flag', () => {
    expect(goalState(goalRecordSchema.parse(goal))).toBe('active');
    expect(goalState(goalRecordSchema.parse({ ...goal, active: false }))).toBe('completed');
    expect(goalState(goalRecordSchema.parse({ ...quest, state: 'ambient' }))).toBe('ambient');
  });
});
