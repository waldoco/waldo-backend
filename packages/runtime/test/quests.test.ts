import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setQuestResultSchema } from '@waldo/contracts';
import { applyDoMigration, GOAL_QUESTS_MIGRATION, HEY144_GOALS_SCHEMA_MIGRATION } from '../src/do-schema';
import { questBook, questCardContext, questHandler, questsPrompt, QUESTS_OPEN_MAX } from '../src/channels/quests';
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

  it('lists completed quests to the app for 30 days', async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const clock = clockAt('2026-11-06T10:00:00Z'), book = questBook(state.storage.sql, clock, ids());
      book.set({ title: 'Done', state: 'completed' }, 'owner-1');
      book.set({ title: 'Open' }, 'owner-1');
      expect(book.shown().map(quest => quest.title)).toEqual(['Done', 'Open']);
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

