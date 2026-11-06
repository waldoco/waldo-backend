import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { reviewExperimentResultSchema, setExperimentResultSchema, setQuestResultSchema } from '@waldo/contracts';
import { applyDoMigration, GOAL_QUESTS_MIGRATION, HEY144_GOALS_SCHEMA_MIGRATION } from '../src/do-schema';
import { compareExperiment, experimentHandlers, questBook, questCardContext, questHandler, questsPrompt, QUESTS_OPEN_MAX, type ReadZones } from '../src/channels/quests';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

let seq = 0;
const stub = () => env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`quests-${seq++}`));
// The owner's clock, moved by the test: London, starting on a Friday evening.
const clockAt = (iso: string) => { const clock = { timezone: 'Europe/London', at: Date.parse(iso), now: () => new Date(clock.at) }; return clock; };
const ids = () => { let n = 0; return () => `q${++n}`; };
const DAY = 86_400_000;
const ownerTurn = { trigger: 'user_message', authenticatedUserId: 'owner-1' } as ToolDispatcherContext;

describe('quest book', () => {
  it('starts a quest in the goals table and shows it with its next check-in in the owner\'s local days', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T20:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      const started = book.set({ title: 'Sub-4  marathon\nin March', plan: 'Three runs a week', usual: 'Two easy runs a week', deadline: '2027-03-14', check_in_days: 7 }, 'owner-1');
      expect(setQuestResultSchema.parse(started)).toEqual({ status: 'started', quest: {
        id: 'quest:q1', title: 'Sub-4 marathon in March', state: 'active', plan: 'Three runs a week', usual: 'Two easy runs a week', target: null, progress: null,
        deadline: '2027-03-14', check_in_days: 7, next_check_in: '2026-11-13' } });
      expect(state.storage.sql.exec<{ active: number; user_id: string }>('SELECT active, user_id FROM goals').one()).toEqual({ active: 1, user_id: 'owner-1' });
    });
  });

  it('changes a quest by id: a left-out field stays, null clears, completed sets active false', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const book = questBook(state.storage.sql, clockAt('2026-11-06T20:00:00Z'), ids());
      book.set({ title: 'Sleep by 11', plan: 'Screens off at 10:30', check_in_days: 1, deadline: '2026-12-01' }, 'owner-1');
      expect(book.set({ id: 'quest:q1', progress: 'Four nights out of five', deadline: null }, 'owner-1')).toMatchObject({ status: 'changed', quest: { plan: 'Screens off at 10:30', progress: 'Four nights out of five', deadline: null, check_in_days: 1 } });
      expect(book.set({ id: 'quest:q1', state: 'completed' }, 'owner-1')).toMatchObject({ quest: { state: 'completed', next_check_in: null } });
      expect(state.storage.sql.exec<{ active: number }>('SELECT active FROM goals').one().active).toBe(0);
      expect(book.open()).toEqual([]);
      expect(book.set({ id: 'quest:nope', progress: 'x' }, 'owner-1')).toMatch(/No quest has that id/);
    });
  });

  it('bounds the open quests, while a completed one can still be changed', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const book = questBook(state.storage.sql, clockAt('2026-11-06T20:00:00Z'), ids());
      for (let n = 0; n < QUESTS_OPEN_MAX; n += 1) book.set({ title: `Quest ${n}` }, 'owner-1');
      expect(book.set({ title: 'One more' }, 'owner-1')).toMatch(/already has 12 open quests/);
      expect(book.set({ title: 'Already done', state: 'completed' }, 'owner-1')).toMatchObject({ status: 'started' });
      expect(book.set({ id: `quest:q${QUESTS_OPEN_MAX + 1}`, state: 'active' }, 'owner-1')).toMatch(/already has 12 open quests/);
    });
  });

  it('is due on its pace, never before, and the check-in moves the next one', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Weekly', check_in_days: 7 }, 'owner-1');
      book.set({ title: 'Ambient', state: 'ambient', check_in_days: 1 }, 'owner-1');
      book.set({ title: 'No pace' }, 'owner-1');
      clock.at += 6 * DAY;
      expect(book.due()).toEqual([]);
      clock.at += DAY;
      expect(book.due().map(quest => quest.id)).toEqual(['quest:q1']);
      book.checkedIn(['quest:q1']);
      expect(book.due()).toEqual([]);
      expect(book.open()[0]!.next_check_in).toBe('2026-11-20');
    });
  });

  it('keeps the deadline on the owner\'s day when they move to another zone', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = { ...clockAt('2026-11-06T20:00:00Z'), timezone: 'America/New_York' };
      const book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Race day', deadline: '2027-03-14' }, 'owner-1');
      clock.timezone = 'Asia/Tokyo';
      expect(book.open()[0]!.deadline).toBe('2027-03-14');
    });
  });

  it('lists every open quest to the app before any completed one', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const book = questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids());
      for (let n = 0; n < 10; n += 1) book.set({ title: `Done ${n}`, state: 'completed' }, 'owner-1');
      for (let n = 0; n < QUESTS_OPEN_MAX; n += 1) book.set({ title: `Open ${n}` }, 'owner-1');
      const shown = book.shown();
      expect(shown).toHaveLength(20);
      expect(shown.slice(0, QUESTS_OPEN_MAX).every(quest => quest.state === 'active')).toBe(true);
    });
  });

  it('lists completed quests to the app for 30 days', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Done', state: 'completed' }, 'owner-1');
      book.set({ title: 'Open' }, 'owner-1');
      expect(book.shown().map(quest => quest.title)).toEqual(['Open', 'Done']);
      clock.at += 31 * DAY;
      expect(book.shown().map(quest => quest.title)).toEqual(['Open']);
    });
  });

  it('upgrades a goals table made by the ADR-0064 migration, and migration 18 adds the same columns', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      state.storage.sql.exec("INSERT INTO goals (id, user_id, description, active, created_at, updated_at) VALUES ('goal-1', 'owner-1', 'Older goal', 0, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')");
      const book = questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids());
      expect(book.shown()).toEqual([]);
      expect(state.storage.sql.exec<{ id: string; state: string | null }>('SELECT id, state FROM goals').one()).toEqual({ id: 'goal-1', state: null });
    });
    await runInDurableObject(stub(), (_instance, state) => {
      applyDoMigration(state.storage, HEY144_GOALS_SCHEMA_MIGRATION);
      applyDoMigration(state.storage, GOAL_QUESTS_MIGRATION);
      const columns = state.storage.sql.exec<{ name: string }>('PRAGMA table_info(goals)').toArray().map(row => row.name);
      expect(columns).toEqual(expect.arrayContaining(['plan', 'state', 'check_in_days', 'last_check_in_at']));
      questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids());
      applyDoMigration(state.storage, GOAL_QUESTS_MIGRATION, 'down');
      expect(state.storage.sql.exec<{ name: string }>('PRAGMA table_info(goals)').toArray().map(row => row.name)).not.toContain('plan');
    });
  });
});

describe('set_quest', () => {
  it('writes on the owner\'s own chat turn only', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const handler = questHandler(questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids()));
      expect(handler.trigger_allowlist).toEqual(['user_message']);
      expect(await handler.handle({ title: 'Sleep by 11' }, { ...ownerTurn, trigger: 'intervention' })).toMatchObject({ ok: false, code: 'rejected' });
      expect(await handler.handle({ title: 'Sleep by 11' }, ownerTurn)).toMatchObject({ ok: true, data: { status: 'started' } });
    });
  });

  it('keeps an owner-stated number, and refuses a reading once the turn read outside content', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const handler = questHandler(questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids()));
      expect(await handler.handle({ title: 'Resting HR down to 55 bpm' }, ownerTurn)).toMatchObject({ ok: true });
      expect(await handler.handle({ title: 'Resting HR down to 55 bpm' }, { ...ownerTurn, toolArgSourceTaint: 'external' } as ToolDispatcherContext)).toMatchObject({ ok: false, code: 'rejected' });
      expect(await handler.handle({ title: 'Recover after the flu' }, { ...ownerTurn, toolArgSourceTaint: 'external' } as ToolDispatcherContext)).toMatchObject({ ok: true });
    });
  });
});

describe('what the model reads', () => {
  it('owner turns list open quests by id; nothing when there are none', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const book = questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids());
      expect(questsPrompt(book)).toBe('');
      book.set({ title: 'Sleep by 11', plan: 'Screens off at 10:30', check_in_days: 1 }, 'owner-1');
      book.set({ title: 'Old one', state: 'completed' }, 'owner-1');
      const prompt = questsPrompt(book);
      expect(prompt).toContain('- [quest:q1] Sleep by 11 (active; check-ins every day; plan: Screens off at 10:30)');
      expect(prompt).not.toContain('Old one');
    });
  });

  it('the Brief plans around quests, the Close marks the ones due, the Check-in reads none', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      expect(questCardContext('card:brief', book)).toBeNull();
      book.set({ title: 'Weekly long run', check_in_days: 7 }, 'owner-1');
      book.set({ title: 'Daily light', check_in_days: 1 }, 'owner-1');
      clock.at += DAY;
      const close = questCardContext('card:close', book)!;
      expect(close).toContain('silence is the check-in');
      expect(close).toContain('[quest:q2] Daily light (active; check-ins every day; check-in due tonight)');
      expect(close).toContain('[quest:q1] Weekly long run (active; check-ins every 7 days)');
      expect(questCardContext('card:brief', book)).not.toContain('check-in due');
      expect(questCardContext('card:midday', book)).toBeNull();
    });
  });
});

describe('experiments inside a quest', () => {
  // Zones as the health plane answers them: row words, a day with no row absent.
  const plane = (days: Readonly<Record<string, [string | null, string | null]>>) => {
    const asked: string[][] = [];
    const read: ReadZones = async (from, to) => { asked.push([from, to]); return { zones: { from, to, days: Object.entries(days).map(([day, [recovery, form]]) => ({ day, recovery, form })) } }; };
    return { read, asked };
  };

  it('starts one change in an open quest for 14 days by default, one running at a time', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const book = questBook(state.storage.sql, clockAt('2026-11-06T20:00:00Z'), ids());
      book.set({ title: 'Steadier sleep' }, 'owner-1');
      expect(setExperimentResultSchema.parse(book.startExperiment('quest:q1', 'No  caffeine\nafter noon', 14))).toEqual({ status: 'started', experiment: {
        id: 'exp:q2', quest_id: 'quest:q1', change: 'No caffeine after noon', state: 'running', started_on: '2026-11-06', days: 14, ends_on: '2026-11-19', reason: null, decided_on: null } });
      expect(book.startExperiment('quest:q1', 'Morning light', 14)).toMatch(/already has a running experiment/);
      expect(book.startExperiment('quest:nope', 'Morning light', 14)).toMatch(/No open quest/);
      book.set({ id: 'quest:q1', state: 'completed' }, 'owner-1');
      book.set({ title: 'Another' }, 'owner-1');
      expect(book.startExperiment('quest:q1', 'Morning light', 14)).toMatch(/No open quest/);
    });
  });

  it('records a verdict once, with its day, and the quest keeps its two latest verdicts', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T20:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Steadier sleep' }, 'owner-1');
      for (const [change, verdict] of [['No caffeine after noon', 'kept'], ['Morning light', 'dropped'], ['Earlier dinner', 'kept']] as const) {
        const started = book.startExperiment('quest:q1', change, 7);
        clock.at += 8 * DAY;
        expect(book.decideExperiment((started as { experiment: { id: string } }).experiment.id, verdict, 'Recovery sat in solid more often than usual')).toMatchObject({ status: 'decided', experiment: { state: verdict } });
      }
      expect(book.decideExperiment('exp:q2', 'dropped', 'Changed my mind')).toMatch(/already kept/);
      const stopped = book.startExperiment('quest:q1', 'Cold shower', 14) as { experiment: { id: string } };
      expect(book.decideExperiment(stopped.experiment.id, 'stopped', null)).toMatchObject({ experiment: { state: 'stopped', reason: null, decided_on: null } });
      expect(book.experimentsIn('quest:q1').map(note => `${note.experiment.state}: ${note.experiment.change}`)).toEqual(['kept: Earlier dinner', 'dropped: Morning light']);
      book.startExperiment('quest:q1', 'Reading before bed', 7);
      clock.at += 8 * DAY;
      book.set({ id: 'quest:q1', state: 'completed' }, 'owner-1');
      expect(book.verdictsDue()).toEqual([]);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM experiments WHERE change = 'Reading before bed'").one().state).toBe('stopped');
    });
  });

  it('is due for a verdict the day after its trial ends, apart from the quest\'s own pace, and counts as offered only for the verdicts the Close offered', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Steadier sleep' }, 'owner-1');
      book.set({ title: 'Run more' }, 'owner-1');
      book.startExperiment('quest:q1', 'No caffeine after noon', 7);
      clock.at += 6 * DAY;
      expect(book.verdictsDue()).toEqual([]);
      expect(book.due()).toEqual([]);
      clock.at += DAY;
      expect(book.verdictsDue().map(experiment => experiment.id)).toEqual(['exp:q3']);
      expect(book.due()).toEqual([]);
      book.startExperiment('quest:q2', 'Run at lunch', 7);
      clock.at += 7 * DAY;
      book.checkedIn(['quest:q1'], ['exp:q3']);
      expect(book.verdictsDue().map(experiment => experiment.id)).toEqual(['exp:q4']);
      expect(book.experimentsIn('quest:q1')).toEqual([expect.objectContaining({ offered: true })]);
    });
  });

  it('compares the trial with the same number of days before it in zone days only, Recovery read from the morning after', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Steadier sleep' }, 'owner-1');
      const { experiment } = book.startExperiment('quest:q1', 'No caffeine after noon', 7) as { experiment: Parameters<typeof compareExperiment>[0] };
      const { read, asked } = plane({
        '2026-10-30': ['moderate', null], '2026-11-01': ['low', 'moderate'], '2026-11-05': ['moderate', 'unknown'],
        '2026-11-06': ['good', 'good'], '2026-11-08': ['high', null], '2026-11-12': ['good', 'high'], '2026-11-13': ['good', null],
      });
      const comparison = await compareExperiment(experiment, '2026-11-20', read);
      expect(asked).toEqual([['2026-10-30', '2026-11-13']]);
      expect(reviewExperimentResultSchema.parse({ experiment, comparison }).comparison).toEqual({
        trial: {
          recovery: { from: '2026-11-07', to: '2026-11-13', days: { excellent: 1, solid: 2, mixed: 0, compromised: 0, none: 4 } },
          form: { from: '2026-11-06', to: '2026-11-12', days: { energized: 1, steady: 1, flagging: 0, depleted: 0, none: 5 } },
        },
        usual: {
          recovery: { from: '2026-10-31', to: '2026-11-06', days: { excellent: 0, solid: 1, mixed: 1, compromised: 1, none: 4 } },
          form: { from: '2026-10-30', to: '2026-11-05', days: { energized: 0, steady: 0, flagging: 1, depleted: 0, none: 6 } },
        },
      });
      // Mid-trial, the days before it are as many as the trial has had so far.
      expect(await compareExperiment(experiment, '2026-11-08', read)).toEqual({
        trial: { recovery: { from: '2026-11-07', to: '2026-11-08', days: expect.objectContaining({ excellent: 1, none: 1 }) }, form: { from: '2026-11-06', to: '2026-11-08', days: expect.objectContaining({ steady: 1, none: 2 }) } },
        usual: { recovery: { from: '2026-11-05', to: '2026-11-06', days: expect.objectContaining({ mixed: 1, solid: 1, none: 0 }) }, form: { from: '2026-11-03', to: '2026-11-05', days: expect.objectContaining({ none: 3 }) } },
      });
      expect(await compareExperiment(experiment, '2026-11-06', read)).toMatchObject({ trial: { recovery: null, form: { from: '2026-11-06', to: '2026-11-06' } }, usual: { recovery: null, form: { from: '2026-11-05', to: '2026-11-05' } } });
      expect(await compareExperiment(experiment, '2026-11-20', async () => null)).toBeNull();
      expect(await compareExperiment(experiment, '2026-11-20', async () => ({ error: 'not_linked' }))).toBeNull();
      expect(await compareExperiment(experiment, '2026-11-20', plane({}).read)).toBeNull();
    });
  });

  it('set_experiment writes on the owner\'s chat turn only and stores no reading from outside content; review_experiment stays in the turn', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const book = questBook(state.storage.sql, clockAt('2026-11-06T10:00:00Z'), ids());
      book.set({ title: 'Steadier sleep' }, 'owner-1');
      const [set, review] = experimentHandlers(book, plane({ '2026-11-06': ['good', null] }).read);
      expect(set.trigger_allowlist).toEqual(['user_message']);
      expect(review.trigger_allowlist).toEqual(['user_message']);
      expect(review.turn_only_output).toBe(true);
      expect(await set.handle({ quest_id: 'quest:q1', change: 'No caffeine after noon' }, { ...ownerTurn, trigger: 'intervention' })).toMatchObject({ ok: false, code: 'rejected' });
      const outside = { ...ownerTurn, toolArgSourceTaint: 'external' } as ToolDispatcherContext;
      expect(await set.handle({ quest_id: 'quest:q1', change: 'Keep HRV above 60 ms' }, outside)).toMatchObject({ ok: false, code: 'rejected' });
      expect(await set.handle({ quest_id: 'quest:q1', change: 'No caffeine after noon' }, ownerTurn)).toMatchObject({ ok: true, data: { status: 'started', experiment: { id: 'exp:q2', days: 14 } } });
      expect(await set.handle({ quest_id: 'quest:q1', change: 'Morning light' }, ownerTurn)).toMatchObject({ ok: false, code: 'invalid_args' });
      expect(await review.handle({ id: 'exp:q2' }, ownerTurn)).toMatchObject({ ok: true, data: { comparison: { trial: { recovery: null, form: { days: { none: 1 } } } } } });
      expect(await review.handle({ id: 'exp:nope' }, ownerTurn)).toMatchObject({ ok: false, code: 'invalid_args' });
      expect(await set.handle({ id: 'exp:q2', state: 'kept', reason: 'Resting heart rate fell to 52 bpm' }, ownerTurn)).toMatchObject({ ok: false, code: 'rejected' });
      expect(await set.handle({ id: 'exp:q2', state: 'kept', reason: 'Recovery sat in solid more often than usual' }, ownerTurn)).toMatchObject({ ok: true, data: { status: 'decided' } });
    });
  });

  it('owner turns read each experiment on its quest line; the Close offers a due verdict with its zone days', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Steadier sleep', check_in_days: 7 }, 'owner-1');
      book.set({ title: 'Run more' }, 'owner-1');
      book.startExperiment('quest:q1', 'No caffeine after noon', 7);
      clock.at += 2 * DAY;
      expect(questsPrompt(book)).toContain('- [quest:q1] Steadier sleep (active; check-ins every 7 days; experiment [exp:q3] No caffeine after noon, day 3 of 7)');
      expect(questCardContext('card:close', book)).not.toContain('verdict is due');
      clock.at += 5 * DAY;
      const unformed = { energized: 0, steady: 0, flagging: 0, depleted: 0, none: 7 };
      const comparison = {
        trial: { recovery: { from: '2026-11-07', to: '2026-11-13', days: { excellent: 0, solid: 5, mixed: 2, compromised: 0, none: 0 } }, form: { from: '2026-11-06', to: '2026-11-12', days: unformed } },
        usual: { recovery: { from: '2026-10-31', to: '2026-11-06', days: { excellent: 0, solid: 2, mixed: 4, compromised: 1, none: 0 } }, form: { from: '2026-10-30', to: '2026-11-05', days: unformed } },
      };
      const close = questCardContext('card:close', book, new Map([['exp:q3', comparison]]))!;
      expect(close).toContain('verdict is due has finished its trial');
      expect(close).toContain('[quest:q1] Steadier sleep (active; check-ins every 7 days; check-in due tonight; experiment [exp:q3] No caffeine after noon, ended 2026-11-12, verdict due)');
      expect(close).toContain('  - [exp:q3] trial: Recovery (mornings 2026-11-07 to 2026-11-13) solid 5, mixed 2; Form (days 2026-11-06 to 2026-11-12) no zone 7');
      expect(close).toContain('    before it: Recovery (mornings 2026-10-31 to 2026-11-06) solid 2, mixed 4, compromised 1; Form (days 2026-10-30 to 2026-11-05) no zone 7');
      expect(close).toContain('- [quest:q2] Run more (active; no check-ins on a schedule)');
      expect(questCardContext('card:close', book)).toContain("  - [exp:q3] the owner's zones are not available for these days");
      expect(questCardContext('card:brief', book)).not.toContain('verdict is due');
      book.checkedIn(['quest:q1'], ['exp:q3']);
      expect(questsPrompt(book)).toContain('experiment [exp:q3] No caffeine after noon, ended 2026-11-12, verdict offered, waiting for the owner)');
      expect(questCardContext('card:close', book)).not.toContain('verdict is due');
    });
  });
});
