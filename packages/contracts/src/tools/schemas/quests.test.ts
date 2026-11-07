import { describe, expect, it } from 'vitest';
import { setQuestArgsSchema, setQuestResultSchema } from './quests';

const quest = {
  id: 'quest:a1b2c3', title: 'Sub-4 marathon in March', state: 'active', plan: 'Three runs a week, long run on Sunday',
  usual: 'Two easy runs a week', target: 'Under four hours', progress: null, deadline: '2027-03-14', check_in_days: 7, next_check_in: '2026-11-13',
} as const;

describe('set_quest', () => {
  it('starts a quest from a title and changes one by id, with null clearing a field', () => {
    expect(setQuestArgsSchema.safeParse({ title: 'Sleep by 11 on weeknights', check_in_days: 1 }).success).toBe(true);
    expect(setQuestArgsSchema.safeParse({ id: 'quest:a1b2c3', state: 'ambient', check_in_days: null, deadline: null }).success).toBe(true);
  });

  it('refuses a new quest without a title, a bad id, pace, state or day, and unknown fields', () => {
    for (const bad of [
      {}, { plan: 'run more' }, { id: 'goal-1', title: 'x' }, { title: 'x', check_in_days: 0 }, { title: 'x', check_in_days: 29 },
      { title: 'x', state: 'paused' }, { title: 'x', deadline: '14 March' }, { title: ' ' }, { title: 'x'.repeat(501) }, { title: 'x', hrv_ms: 52 },
    ]) expect(setQuestArgsSchema.safeParse(bad).success).toBe(false);
  });

  it('answers with the quest as the app shows it', () => {
    expect(setQuestResultSchema.safeParse({ status: 'started', quest }).success).toBe(true);
    expect(setQuestResultSchema.safeParse({ status: 'started', quest: { ...quest, state: 'ambient' } }).success).toBe(false);
    expect(setQuestResultSchema.safeParse({ status: 'stored', quest }).success).toBe(false);
  });
});
