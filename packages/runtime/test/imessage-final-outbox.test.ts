import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { IMESSAGE_BUSY_RETRY_MS, IMESSAGE_OUTBOX_MAX_RECORDS, IMessageFinalOutbox, targetOf } from '../src/channels/imessage/final-outbox';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { drainIMessageOutbox } from '../src/channels/imessage/owner-runtime';
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

it('a failed turn\'s notice has one identity per turn, apart from its reply: closing the turn again freezes the same record', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    const frozen = outbox.freezeFailure(turn('a'), 'This run did not finish.');
    expect(frozen).toMatchObject({ replyRef: 'failure:a', commandId: 'wfn_cmd-a', bridgeDoName: 'bridge', ownerDoName: 'owner', state: 'frozen' });
    expect(outbox.freezeFailure(turn('a'), 'This run did not finish.')).toEqual(frozen);
    expect(outbox.records()).toHaveLength(1);
    expect(outbox.freeze(turn('a'), 'the reply').commandId).not.toBe(frozen.commandId);
  });
});

it('only a turn that closes as interrupted, and only the call that closes it, hears about it', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage), heard: string[] = [];
    const admit = async (key: string) => (await inbox.admit({ dedupKey: key, digest: '0'.repeat(64), text: 'hi', conversationRef: 'c', binding: {} as never,
      bindingDigest: 'b', revision: '1', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner', commandId: `cmd-${key}`, occurredAt: 1 }) as { record: IMessageInboxRecord }).record;
    const done = inbox.claim((await admit('done')).id, true)!, failed = inbox.claim((await admit('failed')).id, true)!, lost = inbox.claim((await admit('lost')).id, true)!;
    inbox.settle(done, true, r => heard.push(r.commandId));
    inbox.settle(failed, false, r => heard.push(r.commandId));
    inbox.settle(failed, false, r => heard.push(r.commandId));
    inbox.recover(new Set(), r => heard.push(r.commandId));
    inbox.recover(new Set(), r => heard.push(r.commandId));
    expect(heard).toEqual(['cmd-failed', 'cmd-lost']);
    expect(inbox.get(lost.id)).toMatchObject({ state: 'interrupted', effectsUnconfirmed: true });
  });
});

it('a message Waldo starts is frozen to the sender of the latest turn, under its own id and command, and a retry refreezes it', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    const latest = { ...turn('a'), binding: { subject: 'o@example.invalid' } as never };
    const frozen = outbox.freezeProactive('job-1', 'wpc_job-1', targetOf(latest), 'Time to call Sam.');
    expect(frozen).toMatchObject({ replyRef: 'proactive:job-1', commandId: 'wpc_job-1', text: 'Time to call Sam.', subject: 'o@example.invalid', revision: '1', bindingDigest: 'b', bridgeDoName: 'bridge', ownerDoName: 'owner', state: 'frozen' });
    expect(outbox.freezeProactive('job-1', 'wpc_job-1', targetOf(latest), 'Time to call Sam.')).toEqual(frozen);
    expect(() => outbox.freezeProactive('job-1', 'wpc_other', targetOf(latest), 'Time to call Sam.')).toThrow('imessage_reply_conflict');
  });
});

it('the latest iMessage names where Waldo may write first, until its sender\'s authority was revoked', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage);
    expect(inbox.latest()).toBeNull();
    const admit = (key: string) => inbox.admit({ dedupKey: key, digest: '0'.repeat(64), text: 'hi', conversationRef: 'c', binding: { subject: 'o@example.invalid' } as never,
      bindingDigest: 'b', revision: '1', environment: 'test', bridgeDoName: 'bridge', ownerDoName: 'owner', commandId: `cmd-${key}`, occurredAt: 1 });
    await admit('one');
    await admit('two');
    expect(inbox.latest()?.commandId).toBe('cmd-two');
    inbox.revokeBridge('bridge');
    expect(inbox.latest()).toBeNull();
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

it('a waiting turn\'s file names are owner words too: forget reaches them, and a closed turn keeps no files', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const inbox = new IMessageOwnerInbox(state.storage);
    const media = { messageGuid: 'm', files: [{ id: 'f1', name: 'secret plan.pdf', mimeType: 'application/pdf', size: 4 }, { id: 'f2', name: 'IMG_1.png', mimeType: 'image/png', size: 4 }] };
    state.storage.kv.put('imessage:inbox-record:waiting', { ...turn('waiting', '', 'admitted'), media });
    expect(redactIMessageEntries(state.storage, ['secret plan'], '[forgotten]')).toEqual({ rewritten: 1, remaining: 0 });
    expect(inbox.get('waiting')?.media?.files.map(f => f.name)).toEqual(['[forgotten].pdf', 'IMG_1.png']);
    const running = inbox.claim('waiting', true)!;
    inbox.settle(running, true);
    expect(inbox.get('waiting')).not.toHaveProperty('media');
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

it('a progress note wakes nothing: drains skip it, and dropping one settles only that turn\'s frozen notes', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    let now = 5_000;
    const outbox = new IMessageFinalOutbox(state.storage, () => now);
    const note = outbox.freezeProgress(turn('a', 'hello', 'running'), 1, 'Checking your calendar now.');
    expect(note).toMatchObject({ replyRef: 'progress:a:1', commandId: 'wpn1_cmd-a', state: 'frozen', text: 'Checking your calendar now.' });
    outbox.freezeProgress(turn('b', 'hello', 'running'), 1, 'Looking at places near you.');
    expect(outbox.due()).toEqual([]);
    expect(outbox.dueAt()).toBeNull();
    expect(state.storage.kv.get('imessage_final_outbox_due_v1')).toBeNull();
    outbox.freeze(turn('a'), 'the reply');
    expect(outbox.due().map(r => r.replyRef)).toEqual(['reply:a']);
    // A frozen note's handoff had started, so dropping it claims no proof that it was not sent.
    outbox.dropProgress('progress_superseded', 'a');
    expect(outbox.get('progress:a:1')).toMatchObject({ state: 'settled', text: '', result: { state: 'unknown', disposition: 'may_have_completed', reason: 'progress_superseded' } });
    expect(outbox.get('progress:b:1')?.state).toBe('frozen');
    outbox.dropProgress('progress_unsent', 'b', true);
    expect(outbox.get('progress:b:1')?.result).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'progress_unsent' });
    expect(outbox.get('reply:a')?.state).toBe('frozen');
  });
});

it('the last message sent on the chat is the newest record not proved unsent', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    let now = 1_000;
    const outbox = new IMessageFinalOutbox(state.storage, () => now);
    expect(outbox.lastSentAt()).toBeNull();
    outbox.freeze(turn('a'), 'the reply');
    now = 2_000; outbox.freezeProgress(turn('b', 'hello', 'running'), 1, 'Checking your calendar now.');
    expect(outbox.lastSentAt()).toBe(2_000);
    outbox.dropProgress('progress_unsent', 'b', true);
    expect(outbox.lastSentAt()).toBe(1_000);
  });
});

it('a reply the bridge found busy tries again in a second, not five', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const now = 10_000;
    const outbox = new IMessageFinalOutbox(state.storage, () => now);
    outbox.freeze(turn('a'), 'the reply');
    outbox.retryLater('reply:a', 600_000, IMESSAGE_BUSY_RETRY_MS);
    expect(outbox.get('reply:a')).toMatchObject({ state: 'frozen', attempts: 1, nextAttemptAt: now + 1_000 });
    outbox.retryLater('reply:a', 600_000);
    expect(outbox.get('reply:a')?.nextAttemptAt).toBe(now + 5_000);
  });
});

it('a drain waits once for a busy bridge: the replies behind it there keep their order and wait for the same retry, and another bridge is still tried', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage), calls: string[] = [];
    outbox.freeze(turn('a'), 'first'); outbox.freeze(turn('b'), 'second'); outbox.freeze({ ...turn('c'), bridgeDoName: 'bridge-2' }, 'third');
    const bridges = { idFromName: (name: string) => name, get: (name: string) => ({ enqueueReply: async ({ replyRef }: { replyRef: string }) => {
      calls.push(`${name} ${replyRef}`); return name === 'bridge' ? { kind: 'busy' } : { kind: 'queued' };
    } }) };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const drained = drainIMessageOutbox({ storage: state.storage, id: state.id, env: { IMESSAGE_BRIDGE_DO: bridges } as never }, 600_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await drained;
    } finally { vi.useRealTimers(); }
    expect(calls).toEqual([...Array<string>(9).fill('bridge reply:a'), 'bridge-2 reply:c']);
    expect(outbox.get('reply:a')).toMatchObject({ state: 'frozen', attempts: 1 });
    expect(outbox.get('reply:b')).toMatchObject({ state: 'frozen', attempts: 1 });
    expect(outbox.get('reply:c')).toMatchObject({ state: 'queued' });
    expect(outbox.due()).toEqual([]);
    expect(outbox.dueAt()).toBeLessThanOrEqual(Date.now() + IMESSAGE_BUSY_RETRY_MS);
  });
});

it('a drain settles a note its evicted turn left frozen as possibly sent, and never hands it to the bridge', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage), calls: string[] = [];
    outbox.freezeProgress(turn('a', 'hello', 'running'), 1, 'Looking now.');
    const bridges = { idFromName: (name: string) => name, get: () => ({ enqueueReply: async ({ replyRef }: { replyRef: string }) => { calls.push(replyRef); return { kind: 'queued' }; } }) };
    await drainIMessageOutbox({ storage: state.storage, id: state.id, env: { IMESSAGE_BRIDGE_DO: bridges } as never }, 600_000);
    expect(calls).toEqual([]);
    expect(outbox.get('progress:a:1')).toMatchObject({ state: 'settled', text: '', result: { state: 'unknown', disposition: 'may_have_completed', reason: 'progress_stale' } });
  });
});

// A reply threaded onto the owner's message: the owner wrote again (or threaded) before Waldo answered.
const threadedTurn = (id: string) => ({ ...turn(id), ownerThreaded: true as const, messageRef: { messageGuid: `g-owner-${id}`, partIndex: 0 },
  binding: { chatGuid: 'iMessage;-;o@example.invalid', subject: 'o@example.invalid' } as never });
const refused = (commandId: string, reason: string) => ({ version: 1, commandId, target: { bridgeId: 'imb', accountId: 'ima', chatGuid: 'iMessage;-;o@example.invalid' },
  state: 'rejected', disposition: 'not_started', reason });
const uncertain = (commandId: string) => ({ version: 1, commandId, target: { bridgeId: 'imb', accountId: 'ima', chatGuid: 'iMessage;-;o@example.invalid' },
  state: 'unknown', disposition: 'may_have_completed', reason: 'photon_send_uncertain' });

it('a threaded reply the host refused before sending goes out once more, plain, under its own command keyed to the turn', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    expect(outbox.freeze(threadedTurn('a'), 'the reply').replyTo).toBeDefined();
    expect(outbox.settle('reply:a', 'cmd-a', refused('cmd-a', 'photon_target_unavailable'))).toBe(true);
    expect(outbox.get('reply:a')).toMatchObject({ state: 'settled', text: '', result: { state: 'rejected', reason: 'photon_target_unavailable' } });
    const plain = outbox.get('plain:a');
    expect(plain).toMatchObject({ state: 'frozen', text: 'the reply', commandId: 'wpl_cmd-a', bridgeDoName: 'bridge', ownerDoName: 'owner' });
    expect(plain).not.toHaveProperty('replyTo');
    expect(outbox.due().map(row => row.replyRef)).toEqual(['plain:a']);
    expect(state.storage.kv.get('imessage_final_outbox_due_v1')).not.toBeNull();
    // The same result again, or a different later one, changes nothing and resends nothing.
    outbox.settle('reply:a', 'cmd-a', refused('cmd-a', 'photon_target_unavailable'));
    outbox.settle('reply:a', 'cmd-a', refused('cmd-a', 'capability_unverified'));
    expect(outbox.records().map(row => row.replyRef).sort()).toEqual(['plain:a', 'reply:a']);
    expect(outbox.get('reply:a')?.conflicts).toBe(1);
  });
});

it('nothing is resent after an uncertain result, an unthreaded refusal, a refused tapback or a refused plain resend', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    outbox.freeze(threadedTurn('maybe'), 'maybe sent');
    outbox.settle('reply:maybe', 'cmd-maybe', uncertain('cmd-maybe'));
    outbox.freeze(turn('flat'), 'never threaded');
    outbox.settle('reply:flat', 'cmd-flat', refused('cmd-flat', 'photon_refused_5'));
    outbox.freezeReaction({ ...threadedTurn('tap'), messageRef: { messageGuid: 'g-tap', partIndex: 0 } }, 'like');
    const tap = outbox.get('react:tap')!;
    outbox.settle('react:tap', tap.commandId, refused(tap.commandId, 'photon_target_unavailable'));
    outbox.freeze(threadedTurn('twice'), 'second try');
    outbox.settle('reply:twice', 'cmd-twice', refused('cmd-twice', 'photon_target_unavailable'));
    outbox.settle('plain:twice', 'wpl_cmd-twice', refused('wpl_cmd-twice', 'photon_not_connected'));
    expect(outbox.records().map(row => row.replyRef).sort()).toEqual(['plain:twice', 'react:tap', 'reply:flat', 'reply:maybe', 'reply:twice']);
    expect(outbox.due()).toEqual([]);
  });
});

it('a plain resend keeps its reply\'s place: it goes to the bridge before a later turn\'s reply', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    let now = 1_000;
    const outbox = new IMessageFinalOutbox(state.storage, () => now);
    outbox.freeze(threadedTurn('a'), 'first answer');
    now = 2_000;
    outbox.freeze(turn('b'), 'second answer');
    now = 3_000;
    outbox.settle('reply:a', 'cmd-a', refused('cmd-a', 'photon_target_unavailable'));
    expect(outbox.due().map(row => row.replyRef)).toEqual(['plain:a', 'reply:b']);
  });
});

it('a full outbox of live replies still records the refusal; it only has no room to resend', async () => {
  await runInDurableObject(stub(), async (_i, state) => {
    const outbox = new IMessageFinalOutbox(state.storage);
    outbox.freeze(threadedTurn('a'), 'the reply');
    for (let i = 1; i < IMESSAGE_OUTBOX_MAX_RECORDS; i++) outbox.freeze(turn(`f${i}`), 'r');
    expect(outbox.settle('reply:a', 'cmd-a', refused('cmd-a', 'photon_target_unavailable'))).toBe(true);
    expect(outbox.get('reply:a')).toMatchObject({ state: 'settled', result: { state: 'rejected' } });
    expect(outbox.get('plain:a')).toBeNull();
  });
});
