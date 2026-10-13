import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { IMESSAGE_OUTBOX_MAX_RECORDS, IMessageFinalOutbox } from '../src/channels/imessage/final-outbox';
import { redactIMessageEntries } from '../src/channels/imessage/forget';
import type { IMessageInboxRecord } from '../src/channels/imessage/owner-inbox';

const stub = () => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`imsg-outbox-${crypto.randomUUID()}`));
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
