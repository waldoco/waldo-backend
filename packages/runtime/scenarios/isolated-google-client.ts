// Test-only Google adapter over the isolated, per-owner source world. Provider methods are
// intentionally narrow: unimplemented reads and all effects fail closed, never touch Google.
import type { CalendarItem, GoogleClient, MailItem, TaskItem, TaskStatusFilter, ThreadMessage } from '../src/connectors/google';
import { IsolatedSourceWorld } from './isolated-source-world';

const copy = <T>(value: unknown): T => structuredClone(value) as T;
const day = (date: string): number => Date.parse(date);
const rejectEffect = (): never => { throw new Error('fixture effect requires a separate intercepted approval path'); };
const rejectRead = (): never => { throw new Error('fixture source not implemented'); };

export const isolatedGoogleClient = (world: IsolatedSourceWorld, owner: string): GoogleClient => ({
  events: async (from, to, limit, includeDeclined) => world.list(owner, 'calendar')
    .filter((row) => day(String(row.start)) < day(to) && day(String(row.end)) >= day(from) && (includeDeclined || row.status !== 'declined'))
    .slice(0, limit).map((row) => copy<CalendarItem>(row)),
  event: async (id) => { const row = world.read(owner, 'calendar', id); return row ? copy<CalendarItem>(row) : rejectRead(); },
  changedEvents: async () => rejectRead(),
  newMail: async (since, limit) => world.list(owner, 'mail').filter((row) => day(String(row.at)) >= since)
    .sort((a, b) => day(String(b.at)) - day(String(a.at))).slice(0, limit).map((row) => copy<MailItem>(row)),
  searchMail: async () => rejectRead(),
  readThread: async (threadId, limit) => world.list(owner, 'mail').filter((row) => row.thread_id === threadId)
    .slice(0, limit).map((row) => copy<ThreadMessage>(row)),
  tasks: async (status: TaskStatusFilter, limit) => world.list(owner, 'tasks')
    .filter((row) => status === 'all' || (status === 'done' ? row.status === 'done' : row.status === 'todo'))
    .slice(0, limit).map((row) => copy<TaskItem>(row)),
  draft: async () => rejectEffect(), sendRaw: async () => rejectEffect(), findSentByMessageId: async () => rejectRead(),
  createEvent: async () => rejectEffect(), moveEvent: async () => rejectEffect(), cancelEvent: async () => rejectEffect(),
});

// Explicit test-only effect opt-in. The regular adapter above continues to reject every
// mutation; an approval test must choose this wrapper and inspect the world outbox.
export const isolatedCalendarEffectClient = (world: IsolatedSourceWorld, owner: string): GoogleClient => {
  let callNumber = 0;
  return {
    ...isolatedGoogleClient(world, owner),
    createEvent: async (input) => {
      const effect = world.intercept({ owner_id: owner, kind: 'calendar.create', target: 'primary', payload: input,
        idempotency_key: `fixture-create-call-${++callNumber}` });
      return { id: `fixture-event-${world.outbox(owner).length}`, ...input, all_day: false, etag: effect.idempotency_key };
    },
  };
};
