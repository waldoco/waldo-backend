import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Scheduler } from '../src/scheduler/multiplexer';
import type { Deps } from '../src/seams/deps';

let seq = 0;
const freshStub = () => {
  seq += 1;
  const ns = (env as never as { TEST_STORAGE_DO: { idFromName(n: string): unknown; get(i: unknown): never } }).TEST_STORAGE_DO;
  return ns.get(ns.idFromName(`rearm-${seq}`));
};

// workerd's clock does not move while a handler runs without I/O, so an executor that re-arms its own entry before any
// await on I/O stamps it with the very millisecond the dispatch stamped the running row with.
const frozen = (at: number): Deps => ({ now: () => at, newRunId: () => 'run', newOutboxId: () => 'outbox', sha256Hex: async () => '0'.repeat(64) });
const AT = Date.parse('2026-10-21T08:00:00Z');
const HOUR = 3_600_000;

describe('an executor that arms its own entry again', () => {
  it('keeps the new entry when it re-arms within the millisecond the dispatch started', async () => {
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, frozen(AT));
      await scheduler.schedule({ id: 'held', kind: 'patrol', occurrenceAt: AT, dueAt: AT, payloadRefs: { id: 'held' } });
      await scheduler.dispatchDue({ patrol: async () => { await scheduler.schedule({ id: 'held', kind: 'patrol', occurrenceAt: AT + HOUR, dueAt: AT + HOUR, payloadRefs: { id: 'held' } }); } });
      expect(state.storage.sql.exec<{ due_at: number }>("SELECT due_at FROM schedule WHERE id = 'held'").toArray()).toEqual([{ due_at: AT + HOUR }]);
    });
  });

  it('still removes a one-shot entry that did not re-arm', async () => {
    await runInDurableObject(freshStub(), async (_instance, state) => {
      const scheduler = new Scheduler(state.storage.sql, state.storage, frozen(AT));
      await scheduler.schedule({ id: 'done', kind: 'patrol', occurrenceAt: AT, dueAt: AT, payloadRefs: { id: 'done' } });
      await scheduler.dispatchDue({ patrol: async () => undefined });
      expect(state.storage.sql.exec("SELECT id FROM schedule WHERE id = 'done'").toArray()).toEqual([]);
    });
  });
});
