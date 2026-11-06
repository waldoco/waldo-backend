import { describe, expect, it } from 'vitest';
import { reviewExperimentArgsSchema, reviewExperimentResultSchema, setExperimentArgsSchema, setExperimentResultSchema, setQuestArgsSchema, setQuestResultSchema } from './quests';

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

const experiment = {
  id: 'exp:c4d5e6', quest_id: 'quest:a1b2c3', change: 'No caffeine after noon', state: 'running', started_on: '2026-11-06', days: 14, ends_on: '2026-11-19', reason: null, decided_on: null,
} as const;
const counts = { recovery: { excellent: 1, solid: 6, mixed: 4, compromised: 1, none: 2 }, form: { energized: 0, steady: 3, flagging: 2, depleted: 0, none: 9 } };

describe('set_experiment', () => {
  it('starts one change inside a quest, and decides or stops one by id', () => {
    expect(setExperimentArgsSchema.safeParse({ quest_id: 'quest:a1b2c3', change: 'No caffeine after noon' }).success).toBe(true);
    expect(setExperimentArgsSchema.safeParse({ quest_id: 'quest:a1b2c3', change: 'Morning light walk', days: 21 }).success).toBe(true);
    expect(setExperimentArgsSchema.safeParse({ id: 'exp:c4d5e6', state: 'kept', reason: 'Recovery sat in solid more often than her usual' }).success).toBe(true);
    expect(setExperimentArgsSchema.safeParse({ id: 'exp:c4d5e6', state: 'stopped' }).success).toBe(true);
  });

  it('refuses a start without its change, a verdict without its reason, a mixed call, a bad length and unknown fields', () => {
    for (const bad of [
      {}, { quest_id: 'quest:a1b2c3' }, { change: 'x' }, { id: 'exp:c4d5e6' }, { id: 'exp:c4d5e6', state: 'kept' }, { id: 'exp:c4d5e6', state: 'dropped', reason: ' ' },
      { id: 'exp:c4d5e6', state: 'running' }, { quest_id: 'quest:a1b2c3', id: 'exp:c4d5e6', change: 'x', state: 'stopped' }, { quest_id: 'quest:a1b2c3', change: 'x', state: 'kept', reason: 'y' },
      { id: 'exp:c4d5e6', state: 'stopped', days: 14 }, { quest_id: 'quest:a1b2c3', change: 'x', days: 6 }, { quest_id: 'quest:a1b2c3', change: 'x', days: 29 },
      { quest_id: 'goal-1', change: 'x' }, { quest_id: 'quest:a1b2c3', change: 'x'.repeat(301) }, { quest_id: 'quest:a1b2c3', change: 'x', hrv_ms: 52 },
    ]) expect(setExperimentArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('answers with the experiment', () => {
    expect(setExperimentResultSchema.safeParse({ status: 'started', experiment }).success).toBe(true);
    expect(setExperimentResultSchema.safeParse({ status: 'decided', experiment: { ...experiment, state: 'kept', reason: 'Steadier', decided_on: '2026-11-20' } }).success).toBe(true);
    expect(setExperimentResultSchema.safeParse({ status: 'decided', experiment: { ...experiment, state: 'kept' } }).success).toBe(false);
    expect(setExperimentResultSchema.safeParse({ status: 'started', experiment: { ...experiment, ends_on: '2026-11-20' } }).success).toBe(false);
  });
});

describe('review_experiment', () => {
  it('reads an experiment by id', () => {
    expect(reviewExperimentArgsSchema.safeParse({ id: 'exp:c4d5e6' }).success).toBe(true);
    for (const bad of [{}, { id: 'quest:a1b2c3' }, { id: 'exp:c4d5e6', days: 14 }]) expect(reviewExperimentArgsSchema.safeParse(bad).success).toBe(false);
  });

  it('compares the trial with the days before it in zone-day counts only, or says the zones are not shared', () => {
    const comparison = { trial: { from: '2026-11-06', to: '2026-11-19', ...counts }, usual: { from: '2026-10-23', to: '2026-11-05', ...counts } };
    expect(reviewExperimentResultSchema.safeParse({ experiment, comparison }).success).toBe(true);
    expect(reviewExperimentResultSchema.safeParse({ experiment, comparison: null }).success).toBe(true);
    expect(reviewExperimentResultSchema.safeParse({ experiment, comparison: { ...comparison, trial: { ...comparison.trial, recovery: { ...counts.recovery, score: 61 } } } }).success).toBe(false);
    expect(reviewExperimentResultSchema.safeParse({ experiment, comparison: { ...comparison, usual: { ...comparison.usual, form: { ...counts.form, steady: -1 } } } }).success).toBe(false);
  });
});
