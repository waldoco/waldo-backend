import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import { WA_UPDATE_BASE } from '../src/channels/whatsapp-api';
import { WHATSAPP_INBOX_DUE_KEY, WHATSAPP_INBOX_MAX_OPEN, WHATSAPP_RUNNING_CHECK_MS, WHATSAPP_TURN_DEADLINE_MS, WhatsAppInboxFull, WhatsAppOwnerInbox } from '../src/channels/whatsapp-inbox';

const SUBJECT = '15550001111';
const text = (seq: number, body: string, extra: object = {}) => ({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: Number(SUBJECT), is_bot: false }, chat: { id: Number(SUBJECT), type: 'private' }, text: body, ...extra } });
const withInbox = (work: (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, clock: { now: number }) => void | Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`whatsapp-inbox-${crypto.randomUUID()}`)), async (_instance, state) => {
    const clock = { now: 1_000_000 };
    try { await work(new WhatsAppOwnerInbox(state.storage, () => clock.now), state.storage, clock); } finally { await state.storage.deleteAlarm(); }
  });
const admit = (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, rows: readonly { wamid: string; body: string }[]) =>
  storage.transactionSync(() => inbox.admit(rows.map((row, index) => ({ update: text(inbox.seq() + 1 + index, row.body), wamid: row.wamid })), SUBJECT));

it('admits one durable row per message in order, keeps the update id and wa_seq, and wakes the drain at once', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }, { wamid: 'wamid.B', body: 'Is it raining in Pune?' }]);
  expect(inbox.records().map(row => [row.wamid, row.state, row.updateId])).toEqual([['wamid.A', 'admitted', WA_UPDATE_BASE + 1], ['wamid.B', 'admitted', WA_UPDATE_BASE + 2]]);
  expect(inbox.seq()).toBe(2);
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + 250);
  expect(inbox.next()?.wamid).toBe('wamid.A');
}));

it('a full inbox throws inside the admitting transaction, so nothing it was given is kept', () => withInbox((inbox, storage) => {
  const many = Array.from({ length: WHATSAPP_INBOX_MAX_OPEN }, (_, index) => ({ wamid: `wamid.${index}`, body: `message ${index}` }));
  admit(inbox, storage, many);
  expect(() => storage.transactionSync(() => { storage.kv.put('claimed', true); inbox.admit([{ update: text(inbox.seq() + 1, 'one more'), wamid: 'wamid.extra' }], SUBJECT); })).toThrow(WhatsAppInboxFull);
  expect(storage.kv.get('claimed')).toBeUndefined();
  expect(inbox.records()).toHaveLength(WHATSAPP_INBOX_MAX_OPEN);
}));

it('claims the oldest waiting row with a deadline and an attempt, then settles it; text is gone once it closes', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }]);
  const record = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(record).toMatchObject({ state: 'running', deadline: clock.now + WHATSAPP_TURN_DEADLINE_MS });
  expect(record.attempt).toEqual(expect.any(String));
  expect(inbox.next()).toBeNull();
  // A running row with nothing queued behind it keeps a slower wake, so a turn cut off by an eviction is found.
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + WHATSAPP_RUNNING_CHECK_MS);
  expect(inbox.settle(record, true)).toBe(false);
  expect(inbox.get(record.id)).toMatchObject({ state: 'completed', update: null });
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBeUndefined();
}));

it('a failed turn settles interrupted once; a second settle of the same attempt changes nothing', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }]);
  const record = inbox.claimNext(clock.now + 60_000)!;
  expect(inbox.settle(record, false)).toBe(true);
  expect(inbox.get(record.id)).toMatchObject({ state: 'interrupted', update: null });
  expect(inbox.settle(record, false)).toBe(false);
}));

it('the scope holds while the row runs under its attempt, before its deadline and while authority stands', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }]);
  const record = inbox.claimNext(clock.now + 60_000)!;
  let authority = true;
  const abort = new AbortController(), scope = inbox.scope(record, abort.signal, () => authority);
  expect(scope.commit(() => 'kept')).toBe('kept');
  authority = false;
  expect(() => scope.admit()).toThrow(ClosedRunError);
  authority = true;
  clock.now += 60_000;
  expect(() => scope.admit()).toThrow(ClosedRunError);
  clock.now -= 60_000;
  abort.abort();
  expect(() => scope.admit()).toThrow(ClosedRunError);
}));

it('recovery closes a running row whose attempt is not live and returns it for its notice; a live one is left running', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }, { wamid: 'wamid.B', body: 'Is it raining in Pune?' }]);
  const a = inbox.claimNext(clock.now + 60_000)!;
  expect(storage.transactionSync(() => inbox.recover(new Set([a.attempt!])))).toEqual([]);
  expect(inbox.get(a.id)?.state).toBe('running');
  const cut = storage.transactionSync(() => inbox.recover(new Set()));
  expect(cut.map(row => [row.wamid, row.state])).toEqual([['wamid.A', 'interrupted']]);
  expect(inbox.get(a.id)?.update).toBeNull();
  // B never started, so it is still queued: it runs on the next drain rather than being lost.
  expect(inbox.next()?.wamid).toBe('wamid.B');
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + 250);
}));

it('revoking closes queued and running rows, and a running turn stops at its next scope check', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }, { wamid: 'wamid.B', body: 'Is it raining in Pune?' }]);
  const a = inbox.claimNext(clock.now + 60_000)!;
  const scope = inbox.scope(a, new AbortController().signal, () => true);
  expect(storage.transactionSync(() => inbox.revokeOpen())).toBe(2);
  expect(inbox.records().map(row => [row.state, row.update])).toEqual([['revoked', null], ['revoked', null]]);
  expect(() => scope.admit()).toThrow(ClosedRunError);
  expect(inbox.next()).toBeNull();
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBeUndefined();
}));

it('forget redacts a queued row\'s text, caption, quoted reply and file name, and counts what a running row still holds', () => withInbox((inbox, storage, clock) => {
  storage.transactionSync(() => inbox.admit([
    { update: text(1, 'my passport number is X123'), wamid: 'wamid.A' },
    { update: { update_id: WA_UPDATE_BASE + 2, message: { caption: 'X123 scan', document: { file_id: 'm1', file_name: 'X123.pdf' }, reply_to_message: { text: 'you said X123' } } }, wamid: 'wamid.B' },
    { update: text(3, 'nothing to see'), wamid: 'wamid.C' },
  ], SUBJECT));
  const holds = (value: string) => value.includes('X123'), redact = (value: string) => value.replaceAll('X123', '[forgotten]');
  expect(inbox.forget(redact, holds)).toEqual({ rewritten: 2, remaining: 0 });
  expect(JSON.stringify(inbox.records().map(row => row.update))).not.toContain('X123');
  expect(inbox.get(inbox.records()[1]!.id)?.update).toMatchObject({ message: { caption: '[forgotten] scan', document: { file_id: 'm1', file_name: '[forgotten].pdf' }, reply_to_message: { text: 'you said [forgotten]' } } });
  for (let row = inbox.claimNext(clock.now + 60_000); row; row = inbox.claimNext(clock.now + 60_000)) inbox.settle(row, true);
  storage.transactionSync(() => inbox.admit([{ update: text(4, 'X123 again'), wamid: 'wamid.D' }], SUBJECT));
  const running = inbox.claimNext(clock.now + 60_000)!;
  // The running row is usually the forget request itself: it is left alone and its text goes when it closes.
  expect(inbox.forget(redact, holds)).toEqual({ rewritten: 0, remaining: 0 });
  expect(inbox.get(running.id)?.update).toMatchObject({ message: { text: 'X123 again' } });
}));

it('finished rows past the wamid retention are dropped at the next admission', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.old', body: 'old' }]);
  inbox.settle(inbox.claimNext(clock.now + 60_000)!, true);
  clock.now += 8 * 24 * 60 * 60_000;
  admit(inbox, storage, [{ wamid: 'wamid.new', body: 'new' }]);
  expect(inbox.records().map(row => row.wamid)).toEqual(['wamid.new']);
}));

it('claimNext returns null only when nothing waits: a drain that stops on null takes every waiting row once, in order', () => withInbox((inbox, storage, clock) => {
  expect(inbox.claimNext(clock.now + 60_000)).toBeNull();
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'a' }, { wamid: 'wamid.B', body: 'b' }, { wamid: 'wamid.C', body: 'c' }]);
  // A row someone else closed meanwhile is never handed out.
  storage.transactionSync(() => { const b = inbox.records()[1]!; storage.kv.put(`whatsapp:inbox-record:${b.id}`, { ...b, state: 'revoked', update: null }); });
  const taken: string[] = [];
  for (let row = inbox.claimNext(clock.now + 60_000); row; row = inbox.claimNext(clock.now + 60_000)) { taken.push(row.wamid); inbox.settle(row, true); }
  expect(taken).toEqual(['wamid.A', 'wamid.C']);
  expect(inbox.next()).toBeNull();
}));
