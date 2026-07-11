import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { goalRecordSchema, type GoalRecord } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { provisionDoSchema } from '../src/do-schema';
import { GoalStore } from '../src/goals/store';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;

type StoredGoal = {
  id: string;
  user_id: string;
  description: string;
  baseline?: string;
  target?: string;
  progress?: string;
  deadline?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

function freshRuntimeStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`goals-store-${sequence}`));
}

function storedGoal(ownerId: string, overrides: Partial<StoredGoal> = {}): StoredGoal {
  return {
    id: `goal-${ownerId}`,
    user_id: ownerId,
    description: 'Build a small, steady creative practice.',
    active: true,
    created_at: '2026-07-11T08:00:00.000Z',
    updated_at: '2026-07-11T08:00:00.000Z',
    ...overrides,
  };
}

function validGoal(ownerId: string, overrides: Partial<StoredGoal> = {}): GoalRecord {
  return goalRecordSchema.parse(storedGoal(ownerId, overrides));
}

function seedGoalRow(sql: SqlStorage, goal: StoredGoal): void {
  sql.exec(
    `INSERT INTO goals (
      id, user_id, description, baseline, target, progress, deadline, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    goal.id,
    goal.user_id,
    goal.description,
    goal.baseline ?? null,
    goal.target ?? null,
    goal.progress ?? null,
    goal.deadline ?? null,
    goal.active ? 1 : 0,
    goal.created_at,
    goal.updated_at,
  );
}

describe('GoalStore', () => {
  it('reads each populated owner\'s contract-valid committed goal without cross-owner leakage', async () => {
    const runtime = freshRuntimeStub();
    const ownerA = 'owner-a';
    const ownerB = "owner-b' OR 1=1 --";
    const ownerAGoal = validGoal(ownerA, { id: 'goal-owner-a' });
    const ownerBGoal = validGoal(ownerB, { id: 'goal-owner-b' });
    const rows = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      const store = new GoalStore(sql);

      seedGoalRow(sql, ownerAGoal);
      seedGoalRow(sql, ownerBGoal);

      return {
        ownerA: store.readActive(ownerA),
        ownerB: store.readActive(ownerB),
      };
    });

    expect(rows.ownerA).toEqual([ownerAGoal]);
    expect(rows.ownerB).toEqual([ownerBGoal]);
    expect(rows.ownerA).not.toContainEqual(ownerBGoal);
    expect(rows.ownerB).not.toContainEqual(ownerAGoal);
  });

  it('round-trips nullable optional fields in deterministic id order', async () => {
    const runtime = freshRuntimeStub();
    const first = validGoal('owner-a', {
      id: 'goal-a',
    });
    const second = validGoal('owner-a', {
      id: 'goal-z',
      baseline: 'Spend ten focused minutes each weekday.',
      target: 'Finish one small illustration this month.',
      progress: 'Outlined the first illustration.',
      deadline: '2026-08-01T17:00:00.000Z',
    });

    const activeGoals = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      const store = new GoalStore(sql);

      seedGoalRow(sql, second);
      seedGoalRow(sql, first);

      return store.readActive('owner-a');
    });

    expect(activeGoals).toEqual([first, second]);
  });

  it('omits malformed, legacy, and inactive storage rows without returning their content', async () => {
    const runtime = freshRuntimeStub();
    const valid = validGoal('owner-a', { id: 'goal-valid' });
    const malformed = storedGoal('owner-a', {
      id: '',
      description: 'A malformed stored aspiration that must remain hidden.',
    });
    const legacyDeadline = storedGoal('owner-a', {
      id: 'goal-legacy-deadline',
      description: 'A legacy deadline aspiration that must remain hidden.',
      deadline: '2026-08-01',
    });
    const reversedTimestamps = storedGoal('owner-a', {
      id: 'goal-reversed-timestamps',
      description: 'A reversed-time aspiration that must remain hidden.',
      created_at: '2026-07-11T09:00:00.000Z',
      updated_at: '2026-07-11T08:00:00.000Z',
    });
    const inactive = storedGoal('owner-a', {
      id: 'goal-inactive',
      active: false,
      description: 'An inactive aspiration that must remain hidden.',
    });

    const activeGoals = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      const store = new GoalStore(sql);

      seedGoalRow(sql, malformed);
      seedGoalRow(sql, legacyDeadline);
      seedGoalRow(sql, reversedTimestamps);
      seedGoalRow(sql, inactive);
      seedGoalRow(sql, valid);

      return store.readActive('owner-a');
    });

    expect(activeGoals).toEqual([valid]);
    const returned = JSON.stringify(activeGoals);
    for (const omitted of [
      malformed.description,
      legacyDeadline.description,
      reversedTimestamps.description,
      inactive.description,
    ]) {
      expect(returned).not.toContain(omitted);
    }
  });

  it('has no public raw-goal writer or Scribe bypass', () => {
    expect(GoalStore.length).toBe(1);
    expect(Object.getOwnPropertyNames(GoalStore.prototype)).toEqual(['constructor', 'readActive']);
  });

  it('survives eviction and reconstructs the same active owner rows', async () => {
    const runtime = freshRuntimeStub();
    const goal = validGoal('owner-a', {
      id: 'goal-after-eviction',
      target: 'Complete a small creative project.',
    });

    const beforeEviction = await runInDurableObject(runtime, (_instance, state) => {
      provisionDoSchema(state.storage);
      const sql = state.storage.sql;
      seedGoalRow(sql, goal);
      return new GoalStore(sql).readActive('owner-a');
    });

    await evictDurableObject(runtime);

    const afterEviction = await runInDurableObject(runtime, (_instance, state) =>
      new GoalStore(state.storage.sql).readActive('owner-a'),
    );

    expect(beforeEviction).toEqual([goal]);
    expect(afterEviction).toEqual([goal]);
  });
});
