import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { IMESSAGE_OUTBOX_MAX_RECORDS, IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { redactIMessageEntries } from '../src/channels/imessage/forget';
import type { IMessageInboxRecord } from '../src/channels/imessage/owner-inbox';
import { HEARTBEAT_EVERY_MS } from '../src/channels/heartbeat';
import { IMessageBridgeDO } from '../src/channels/imessage/bridge-do';
import { OwnerDO } from '../src/channels/owner-do';
import { alarmRetryDelay, rearmSharedAlarm, WAKE_DUE_KEYS } from '../src/scheduler/alarm-slot';

const stub = () => env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`imsg-outbox-${crypto.randomUUID()}`));
const turn = (id: string, text = 'hello', state: IMessageInboxRecord['state'] = 'completed') => ({ id, updateId: 1, dedupKey: id, digest: '0'.repeat(64), text, conversationRef: 'c',
  binding: {} as never, bindingDigest: 'b', revision: '1', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner', commandId: `cmd-${id}`,
  occurredAt: 1, admittedAt: 1, state }) as IMessageInboxRecord;
const result = (commandId: string) => ({ version: 1, commandId, target: { bridgeId: 'imb', accountId: 'ima', chatGuid: 'iMessage;-;o@example.invalid' }, state: 'local_recorded',
  messageGuid: `g-${commandId}`, evidence: { kind: 'local_database', reference: 'r' } });

it('settling prunes the reply text; the settled identity still dedups and still detects a changed commandId', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    outbox.freeze(turn('a'), 'the reply');
    expect(outbox.get('reply:a')?.text).toBe('the reply');
    outbox.settle('reply:a', 'cmd-a', result('cmd-a'));
    expect(outbox.get('reply:a')).toMatchObject({ state: 'settled', text: '', result: { state: 'local_recorded' } });
    expect(outbox.freeze(turn('a'), 'the reply').state).toBe('settled'); // identical refreeze stays a no-op
    expect(() => outbox.freeze({ ...turn('a'), commandId: 'other' }, 'the reply')).toThrow('imessage_reply_conflict');
  });
});

it('the outbox is bounded: only settled records are evicted (oldest first); a full outbox of live replies refuses', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    let now = 1_000;
    const outbox = new IMessageFinalOutbox(state.storage, () => now++);
    for (let i = 0; i < IMESSAGE_OUTBOX_MAX_RECORDS; i++) { outbox.freeze(turn(`s${i}`), 'r'); outbox.settle(`reply:s${i}`, `cmd-s${i}`, result(`cmd-s${i}`)); }
    outbox.freeze(turn('next'), 'r');
    expect(outbox.records()).toHaveLength(IMESSAGE_OUTBOX_MAX_RECORDS);
    expect(outbox.get('reply:s0')).toBeNull(); // the oldest settled record went
    expect(outbox.get('reply:next')?.state).toBe('frozen');
  });
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    for (let i = 0; i < IMESSAGE_OUTBOX_MAX_RECORDS; i++) outbox.freeze(turn(`f${i}`), 'r');
    expect(() => outbox.freeze(turn('over'), 'r')).toThrow('imessage_outbox_capacity');
    expect(outbox.records().every((r) => r.state === 'frozen')).toBe(true); // no live reply was dropped
  });
});

it('literal owner forget reaches the iMessage inbox and outbox records', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    outbox.freeze(turn('frozen'), 'Your Secret Plan is ready');
    outbox.freeze(turn('queued'), 'about the secret plan'); outbox.markQueued('reply:queued');
    outbox.freeze(turn('other'), 'nothing to forget here');
    const put = (r: IMessageInboxRecord) => state.storage.kv.put(`imessage:inbox-record:${r.id}`, r);
    put(turn('waiting', 'tell me the secret plan', 'admitted'));
    put(turn('current', 'forget the secret plan', 'running'));
    expect(redactIMessageEntries(state.storage, ['secret plan'], '[forgotten]')).toEqual({ rewritten: 3, remaining: 0 });
    expect(outbox.get('reply:frozen')).toMatchObject({ state: 'settled', text: '', result: { state: 'rejected', disposition: 'not_started', reason: 'owner_forget' } });
    expect(outbox.get('reply:queued')).toMatchObject({ state: 'queued', text: 'about the [forgotten]' });
    expect(outbox.get('reply:other')?.text).toBe('nothing to forget here');
    expect(state.storage.kv.get<IMessageInboxRecord>('imessage:inbox-record:waiting')?.text).toBe('tell me the [forgotten]');
    expect(state.storage.kv.get<IMessageInboxRecord>('imessage:inbox-record:current')?.text).toBe('forget the secret plan'); // the running forget turn itself
    expect(redactIMessageEntries(state.storage, ['  '], '[forgotten]')).toEqual({ rewritten: 0, remaining: 0 });
  });
});

// During another lane's streak the iMessage lane's wake is not held: a reply frozen during an app-lane streak of 10 reaches
// the bridge at the floor, not at that lane's retry 17 or more minutes out.
it('during an app-lane streak of 10, an iMessage reply reaches the bridge at the floor, not at the app lane\'s retry', async () => {
  const owner = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('imsg-lane-streak')), id = owner.id.toString();
  const FAILURES = 'owner_alarm_failures_v1', LANE = 'owner_alarm_failed_lane_v1', RETRY_DUE = 'owner_alarm_retry_due_v1';
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const record = (state: DurableObjectState) => ({ streak: state.storage.kv.get(FAILURES), lane: state.storage.kv.get(LANE), retryDue: state.storage.kv.get<number>(RETRY_DUE) });
  type Lanes = { alarm(): Promise<void>; drainApp(): Promise<void> };
  type Owner = Lanes & { ctx: DurableObjectState };
  const proto = OwnerDO.prototype as unknown as Lanes, real = { alarm: proto.alarm, drainApp: proto.drainApp };
  const handed: string[] = [], appRan: number[] = [], passes: ReturnType<typeof record>[] = [];
  const alarm = vi.spyOn(proto, 'alarm').mockImplementation(async function (this: Owner) {
    if (this.ctx.id.toString() !== id) return real.alarm.call(this);
    try { await real.alarm.call(this); } finally { passes.push(record(this.ctx)); }
  });
  const app = vi.spyOn(proto, 'drainApp').mockImplementation(async function (this: Owner) {
    if (this.ctx.id.toString() !== id) return real.drainApp.call(this);
    appRan.push(Date.now());
  });
  const bridge = vi.spyOn(IMessageBridgeDO.prototype, 'enqueueReply').mockImplementation(async input => { handed.push(input.replyRef); return { kind: 'queued' }; });
  try {
    const retryDue = await runInDurableObject(owner, async (_i, state) => {
      const due = Date.now() + alarmRetryDelay(10, id, HEARTBEAT_EVERY_MS);
      state.storage.kv.put(FAILURES, 10); state.storage.kv.put(LANE, 'app'); state.storage.kv.put(RETRY_DUE, due);
      new IMessageFinalOutbox(state.storage).freeze(turn('streak'), 'reply during the streak');
      await rearmSharedAlarm(state.storage, null, Date.now());
      return due;
    });
    expect(retryDue - Date.now()).toBeGreaterThan(15 * 60_000);
    for (const deadline = Date.now() + 1_500; !passes.length && Date.now() < deadline;) await sleep(25);
    const row = await runInDurableObject(owner, (_i, state) => new IMessageFinalOutbox(state.storage).get('reply:streak')?.state);
    expect(passes, `the bridge got [${handed.join(', ')}]`).toEqual([{ streak: 10, lane: 'app', retryDue }]);
    expect(handed).toEqual(['reply:streak']);
    expect(row).toBe('queued');
    expect(appRan).toHaveLength(0);
  } finally {
    await runInDurableObject(owner, (_i, state) => state.storage.deleteAlarm());
    await sleep(300);
    await runInDurableObject(owner, async (_i, state) => { await state.storage.delete([...WAKE_DUE_KEYS, FAILURES, LANE, RETRY_DUE]); await state.storage.deleteAlarm(); });
    const left = await runInDurableObject(owner, (_i, state) => state.storage.getAlarm());
    alarm.mockRestore(); app.mockRestore(); bridge.mockRestore();
    expect(left).toBeNull();
  }
}, 20_000);
