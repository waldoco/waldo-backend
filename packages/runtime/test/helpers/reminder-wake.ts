import { expect } from 'vitest';
import { reminderBook } from '../../src/channels/reminders';
import { Scheduler } from '../../src/scheduler/multiplexer';
import { productionDeps } from '../../src/seams/deps';
import { ensureSchema } from '../../src/tracer/schema';

// A one-off reminder two hours out, set through the scheduler as the set_reminder tool sets one. Returns its due time, which
// the owner alarm holds once the reminder is set, while nothing sooner is due.
export async function remindInTwoHours(state: DurableObjectState): Promise<number> {
  ensureSchema(state.storage);
  state.storage.kv.put('timezone', 'UTC');
  state.storage.kv.put('timezone_confirmed', true);
  const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
  await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID())
    .set({ note: 'water plants', at: new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 16), repeat: 'none' });
  const due = reminderDue(state);
  expect(await state.storage.getAlarm()).toBe(due);
  return due;
}

export function reminderDue(state: DurableObjectState): number {
  const rows = state.storage.sql.exec<{ due_at: number }>("SELECT due_at FROM schedule WHERE kind = 'reminder'").toArray();
  expect(rows).toHaveLength(1);
  return rows[0]!.due_at;
}
