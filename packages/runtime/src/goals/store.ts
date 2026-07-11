import { goalRecordSchema, type GoalRecord } from '@waldo/contracts';

type GoalRow = {
  id: string;
  user_id: string;
  description: string;
  baseline: string | null;
  target: string | null;
  progress: string | null;
  deadline: string | null;
  active: number;
  created_at: string;
  updated_at: string;
};

export class GoalStore {
  constructor(private readonly sql: SqlStorage) {}

  readActive(ownerId: string): GoalRecord[] {
    const rows = this.sql
      .exec<GoalRow>(
        `SELECT id, user_id, description, baseline, target, progress, deadline, active, created_at, updated_at
           FROM goals
          WHERE user_id = ? AND active = 1
          ORDER BY id`,
        ownerId,
      )
      .toArray();
    const goals: GoalRecord[] = [];

    for (const row of rows) {
      const parsed = goalRecordSchema.safeParse({
        id: row.id,
        user_id: row.user_id,
        description: row.description,
        baseline: row.baseline ?? undefined,
        target: row.target ?? undefined,
        progress: row.progress ?? undefined,
        deadline: row.deadline ?? undefined,
        active: row.active === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });

      if (parsed.success) {
        goals.push(parsed.data);
      }
    }

    return goals;
  }
}
