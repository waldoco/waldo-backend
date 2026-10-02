import { OWNER_INBOX_KEY, type InboxBinding, type InboxRecord } from '../src/channels/telegram-owner-inbox';
import { FINAL_OUTBOX_KEY, type FinalRecord } from '../src/channels/telegram-final-outbox';

type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
type Transport = { settle(): Promise<void>; pending(): number };
// Fixture-only: admission is durable work for an alarm, not the private queue.
// Advance only the exact admitted turn's delivery wake; never rewrite occurrence history.
export const settleNativeOwnerTurn = async (
  owner: { alarm(): Promise<void> }, kv: Kv, transport: Transport,
  target: InboxBinding & { updateId: number }, now: () => number, maxSteps = 8,
): Promise<void> => {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) throw new Error('invalid native settlement step bound');
  const id = `${target.bot}:telegram:${target.updateId}`;
  const read = () => {
    const row = (kv.get<InboxRecord[]>(OWNER_INBOX_KEY) ?? []).find(r => r.id === id);
    if (!row || row.updateId !== target.updateId || row.bot !== target.bot || row.subject !== target.subject || row.doName !== target.doName)
      throw new Error(`native settlement admission missing or mismatched: ${id}`);
    const finals = (kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []).filter(r => r.inbox?.id === id);
    if (finals.some(r => r.inbox?.runId !== row.runId || r.inbox?.attempt !== row.attempt || (r.bot !== undefined && r.bot !== row.bot) || r.ownerSubject !== row.subject || r.doName !== row.doName))
      throw new Error(`native settlement final custody mismatch: ${id}`);
    if (row.state === 'quarantined' || finals.some(r => r.status === 'quarantined' || r.status === 'blocked'))
      throw new Error(`native settlement failed: ${id} (${row.reason ?? finals.find(r => r.reason)?.reason ?? row.state})`);
    return { row, finals };
  };
  for (let step = 0; step <= maxSteps; step++) {
    await transport.settle();
    const { row, finals } = read();
    if (row.state === 'completed' && row.closedAt !== undefined && finals.length > 0
      && finals.every(r => r.status === 'delivered' && r.settled === true) && transport.pending() === 0) return;
    if (step === maxSteps) throw new Error(`native settlement exhausted ${maxSteps} alarm steps: ${id} (${row.state})`);
    if (finals.some(r => r.status === 'pending')) {
      const rows = kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY)!;
      for (const final of rows) if (final.inbox?.id === id && final.status === 'pending') final.dueAt = Math.min(now(), Date.now());
      kv.put(FINAL_OUTBOX_KEY, rows);
    }
    // The real alarm initializes runtime/schema and dispatches the persisted inbox/outbox.
    await owner.alarm();
  }
};
