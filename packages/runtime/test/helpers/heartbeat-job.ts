import type { TaskResult } from '@waldo/contracts';
import type { HeartbeatDeps } from '../../src/channels/heartbeat';
import { heartbeatApplier, heartbeatJobSpec, type HeartbeatApplyDeps } from '../../src/channels/heartbeat-job';
import type { Loop, LoopBook } from '../../src/channels/loops';
import type { TaskHost } from '../../src/tasks/brain';
import { isMachine, jobBook } from '../../src/tasks/jobs';
import { runJobsLane } from '../../src/tasks/lane';
import { enqueueMachine } from '../../src/tasks/machine';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../../src/channels/telegram-final-outbox';

// The heartbeat check-back is a reader job: the tick writes it, a worker reads, and the jobs lane applies what the worker
// found. These stand in for the worker and the lane over a real job book, so a test can drive a tick to its message.
export const CHECKED: TaskResult = { status: 'done', summary: 'Checked the loops.', findings: [{ text: 'Nothing has moved on these yet.' }], proposals: [], left: [] };
const refuse = async (): Promise<never> => { throw new Error('a heartbeat job took the owner task path'); };

export const heartbeatJobs = (storage: DurableObjectStorage, options: Readonly<{
  loops: LoopBook; timezone: string; now(): number;
  // The apply turn's reply for the loops it was given; the default reports which loops it saw.
  reply?(loops: readonly Loop[]): Promise<string>;
  deliver: HeartbeatApplyDeps['deliver'];
}>) => {
  let n = 0;
  const book = jobBook(storage.sql, { now: options.now, newId: () => `hb${(n += 1)}`, newToken: () => `tok-${(n += 1)}` });
  const tickDeps: Pick<HeartbeatDeps, 'transaction' | 'providerDown' | 'enqueue' | 'checked'> = {
    transaction: work => storage.transactionSync(work), providerDown: () => false, checked: () => undefined,
    enqueue: (due, tick) => enqueueMachine(book, heartbeatJobSpec(due, { ...tick, surface: 'app', timezone: options.timezone })).code,
  };
  const applier = heartbeatApplier({
    sql: storage.sql, loops: options.loops, timezone: options.timezone, now: options.now, enabled: () => true,
    transaction: work => storage.transactionSync(work),
    turn: async (_trace, due) => options.reply ? options.reply(due) : `Checked ${due.map(loop => loop.title).join(', ')}`,
    deliver: options.deliver,
  });
  // Every queued check-back job reports `result` as its worker would, and the lane applies it once.
  const runJobs = async (result: TaskResult = CHECKED) => {
    for (const row of book.open()) {
      if (row.status !== 'queued' || !isMachine(row)) continue;
      book.report(book.startAttempt(row.id)!, result, { rounds: 1, costUsd: 0 });
    }
    await runJobsLane({
      book, host: { fence: () => undefined, cancelled: () => undefined, busy: () => new Set<string>() } as unknown as TaskHost,
      now: options.now, timezone: options.timezone, surface: 'app', quiet: () => false, log: () => undefined, startWorker: async () => undefined,
      turn: refuse, applyTools: () => { throw new Error('a heartbeat job reached applyTools()'); }, deliver: refuse,
      room: () => true, heldTopics: () => [], machine: { heartbeat: applier },
    });
  };
  return { book, tickDeps, runJobs };
};

// In an owner object: every queued machine job (a check-back, an update sweep) reports `result` the way its worker would, so the owner's next alarm pass
// applies it. Answers the ids it reported.
export const reportMachineJobs = (sql: SqlStorage, result: TaskResult = CHECKED): string[] => {
  const book = jobBook(sql, { now: Date.now, newId: () => crypto.randomUUID().slice(0, 12), newToken: () => crypto.randomUUID() });
  return book.open().filter(row => row.status === 'queued' && isMachine(row)).map(row => {
    book.report(book.startAttempt(row.id)!, result, { rounds: 1, costUsd: 0 });
    return row.id;
  });
};

// The owner's next two alarm passes: the jobs lane applies what the workers reported, then the outbox sends what the apply
// queued, once it falls due.
export const applyAndSend = async (owner: { alarm(): Promise<void> }, kv: DurableObjectStorage['kv']): Promise<void> => {
  await owner.alarm();
  kv.put(FINAL_OUTBOX_KEY, (kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).map(record => ({ ...record, dueAt: Math.min(record.dueAt, Date.now() - 1) })));
  await owner.alarm();
};
