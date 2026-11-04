import { it, expect } from 'vitest';
import { signRelayRequest } from '../src/relay';
import { MailboxStore } from '../src/connector/mailbox-store';
import { CommandMailbox } from '../src/connector/mailbox';
import { fixture, mailboxPolicy, storagePolicy, digest } from './connector-fixtures';
import { join } from 'node:path';
it('M1 signed capabilities enforce raw auth, freshness, replay, account, strict schema and size atomically', () => {
    const f = fixture(), r = f.signed(f.caps());
    f.mailbox.reportCapabilities(r.body, r.headers);
    const saved = f.mailboxStore.snapshot();
    const invalid = [{ body: r.body, headers: signRelayRequest(r.body, { ...r.headers, nonce: 'synthetic-wrong-key' }, 'synthetic-wrong-key') }, f.signed(f.caps(), { atMs: 0 }), f.signed(f.caps(), { atMs: 1001 }), r, f.signed({ ...f.caps(), accountId: 'synthetic-other' }), f.signed({ ...f.caps(), extra: true }), f.signed('x'.repeat(mailboxPolicy.maxRequestBytes + 1))];
    f.clock.now = 1001; // atMs 0 is now outside the signature window
    invalid[2] = f.signed(f.caps(), { atMs: 1002 });
    for (const request of invalid) {
        expect(() => f.mailbox.reportCapabilities(request.body, request.headers)).toThrow();
        expect(f.mailboxStore.snapshot()).toEqual(saved);
    }
});
it('M2 empty bounded pull, delivery repull increments attempt and isolates accounts', async () => {
    const f = fixture();
    let r = f.pullRequest();
    expect(await f.mailbox.pull(r.body, r.headers, { waitMs: 2 })).toEqual({ version: 1, delivery: null });
    const cmd = f.signed(f.command()), queued = f.mailbox.enqueue(cmd.body, cmd.headers);
    r = f.pullRequest();
    const a = await f.mailbox.pull(r.body, r.headers, { waitMs: 0 });
    r = f.pullRequest();
    const b = await f.mailbox.pull(r.body, r.headers, { waitMs: 0 });
    expect(a.delivery).toMatchObject({ deliveryId: queued.deliveryId, attempt: 1, body: cmd.body, headers: cmd.headers });
    expect(b.delivery).toMatchObject({ deliveryId: queued.deliveryId, attempt: 2 });
    expect(f.mailboxStore.snapshot().deliveries).toHaveLength(1);
    const otherAccount = {binding:{...f.account.binding,bridgeId:'synthetic-second-bridge',accountId:'synthetic-second-account'},key:'synthetic-second-key'};
    const scoped = new CommandMailbox(f.mailboxStore,mailboxPolicy,(bridge,account)=>bridge===otherAccount.binding.bridgeId&&account===otherAccount.binding.accountId?otherAccount:f.account,()=>f.clock.now);
    const otherBody=JSON.stringify({version:1,bridgeId:otherAccount.binding.bridgeId,accountId:otherAccount.binding.accountId});
    const otherHeaders=signRelayRequest(otherBody,{version:1,bridgeId:otherAccount.binding.bridgeId,accountId:otherAccount.binding.accountId,atMs:f.clock.now,nonce:'synthetic-other-nonce'},otherAccount.key);
    expect(await scoped.pull(otherBody,otherHeaders,{waitMs:0})).toEqual({version:1,delivery:null});
    const other = f.signed({ version: 1, bridgeId: 'synthetic-other', accountId: 'synthetic-other' }, { bridgeId: 'synthetic-other', accountId: 'synthetic-other' });
    await expect(f.mailbox.pull(other.body, other.headers, { waitMs: 0 })).rejects.toThrow();
});
it('M3 exact terminal result identity/digest/target, idempotence and durable conflicting evidence', async () => {
    const f = fixture(), cmd = f.command(), r = f.signed(cmd), d = f.mailbox.enqueue(r.body, r.headers);
    const pull = f.pullRequest();
    await f.mailbox.pull(pull.body, pull.headers, { waitMs: 0 });
    const result = { version: 1, commandId: cmd.commandId, target: cmd.target, state: 'local_recorded', messageGuid: 'synthetic-message', evidence: { kind: 'local_database', reference: 'synthetic-row' } };
    const envelope = { version: 1, bridgeId: cmd.binding.bridgeId, accountId: cmd.binding.accountId, deliveryId: d.deliveryId, commandId: cmd.commandId, commandDigest: digest(r.body), result };
    for (const patch of [{ commandDigest: '0'.repeat(64) }, { commandId: 'synthetic-other' }, { deliveryId: 'synthetic-unknown' }, { result: { ...result, target: { ...cmd.target, chatGuid: 'synthetic-other' } } }, { result: { version: 1, commandId: cmd.commandId, target: cmd.target, state: 'queued' } }, { result: { version: 1, commandId: cmd.commandId, target: cmd.target, state: 'started' } }]) {
        const request = f.signed({ ...envelope, ...patch });
        expect(() => f.mailbox.postResult(request.body, request.headers)).toThrow();
    }
    let request = f.signed(envelope);
    expect(f.mailbox.postResult(request.body, request.headers)).toEqual({ version: 1, accepted: true });
    expect(f.mailbox.postResult(request.body, request.headers)).toEqual({ version: 1, accepted: true });
    request = f.signed(envelope);
    f.mailbox.postResult(request.body, request.headers);
    request = f.signed({ ...envelope, result: { ...result, messageGuid: 'synthetic-conflict' } });
    expect(() => f.mailbox.postResult(request.body, request.headers)).toThrow('conflict');
    expect(f.mailboxStore.snapshot().deliveries[0]?.result).toEqual(result);
    expect(f.mailboxStore.snapshot().conflicts).toHaveLength(1);
    expect(f.mailboxStore.snapshot().sentMessages[0]?.commandId).toBe(cmd.commandId);
});
it('M4 delivered identity, attempt and nonces survive actual reopen', async () => {
    const f = fixture(), r = f.signed(f.command());
    f.mailbox.enqueue(r.body, r.headers);
    const p = f.pullRequest();
    await f.mailbox.pull(p.body, p.headers, { waitMs: 0 });
    f.mailboxStore.close();
    const store = new MailboxStore(join(f.dir, 'mailbox.sqlite'), storagePolicy);
    try {
        const mailbox = new CommandMailbox(store, mailboxPolicy, f.resolve, () => f.clock.now);
        await expect(mailbox.pull(p.body, p.headers, { waitMs: 0 })).rejects.toThrow('nonce');
        const request = f.pullRequest();
        expect((await mailbox.pull(request.body, request.headers, { waitMs: 0 })).delivery).toMatchObject({ attempt: 2, body: r.body });
        expect(store.snapshot().deliveries).toHaveLength(1);
    }
    finally {
        store.close();
    }
});
it('M5 record/byte bounds roll back nonce and delivery with no silent eviction', () => {
    for (const policy of [{ ...storagePolicy, maxRecords: 1 }, { ...storagePolicy, maxBytes: 1 }]) {
        const f = fixture(policy), r = f.signed(f.command());
        expect(() => f.mailbox.enqueue(r.body, r.headers)).toThrow('backpressure');
        expect(f.mailboxStore.snapshot().deliveries).toEqual([]);
        expect(f.mailboxStore.snapshot().nonces).toEqual([]);
    }
});
it('M6 withdrawal only before delivery; one outstanding account command even across IDs', async () => {
    const f = fixture();
    let r = f.signed(f.command('synthetic-a')), d = f.mailbox.enqueue(r.body, r.headers);
    expect(f.mailbox.withdraw(d.deliveryId)).toBe(true);
    r = f.signed(f.command('synthetic-b'));
    d = f.mailbox.enqueue(r.body, r.headers);
    const extra = f.signed(f.command('synthetic-c'));
    expect(() => f.mailbox.enqueue(extra.body, extra.headers)).toThrow('outstanding');
    const p = f.pullRequest();
    await f.mailbox.pull(p.body, p.headers, { waitMs: 0 });
    expect(f.mailbox.withdraw(d.deliveryId)).toBe(false);
});
