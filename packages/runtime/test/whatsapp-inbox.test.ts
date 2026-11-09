import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ClosedRunError } from '../src/channels/run-effect-scope';
import { WA_UPDATE_BASE } from '../src/channels/whatsapp-api';
import { WHATSAPP_FINISHED_RETENTION_MS, WHATSAPP_INBOX_DUE_KEY, WHATSAPP_INBOX_MAX_OPEN, WHATSAPP_RUNNING_CHECK_MS, WHATSAPP_TURN_DEADLINE_MS, WhatsAppInboxFull, WhatsAppOwnerInbox, type WhatsAppInboxRecord } from '../src/channels/whatsapp-inbox';

const SUBJECT = '15550001111';
const text = (seq: number, body: string, extra: object = {}) => ({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: Number(SUBJECT), is_bot: false }, chat: { id: Number(SUBJECT), type: 'private' }, text: body, ...extra } });
const withInbox = (work: (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, clock: { now: number }) => void | Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`whatsapp-inbox-${crypto.randomUUID()}`)), async (_instance, state) => {
    const clock = { now: 1_000_000 };
    try { await work(new WhatsAppOwnerInbox(state.storage, () => clock.now), state.storage, clock); } finally { await state.storage.deleteAlarm(); }
  });
const admit = (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, rows: readonly { wamid: string; body: string }[]) =>
  storage.transactionSync(() => inbox.admit(rows.map((row, index) => ({ update: text(inbox.seq() + 1 + index, row.body), wamid: row.wamid })), SUBJECT));

// Rows that must stay separate turns (recovery, revoking, claim order): messages in a row would join, so each message after
// the first is a quoted reply, which names its own target and never joins.
const admitApart = (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, rows: readonly { wamid: string; body: string }[]) =>
  storage.transactionSync(() => inbox.admit(rows.map((row, index) => ({ update: text(inbox.seq() + 1 + index, row.body, index ? { reply_to_message: { text: 'An earlier reply' } } : {}), wamid: row.wamid })), SUBJECT));

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
  admitApart(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }, { wamid: 'wamid.B', body: 'Is it raining in Pune?' }]);
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
  admitApart(inbox, storage, [{ wamid: 'wamid.A', body: 'Find me flights to Goa.' }, { wamid: 'wamid.B', body: 'Is it raining in Pune?' }]);
  const a = inbox.claimNext(clock.now + 60_000)!;
  const scope = inbox.scope(a, new AbortController().signal, () => true);
  expect(storage.transactionSync(() => inbox.revokeOpen())).toBe(2);
  expect(inbox.records().map(row => [row.state, row.update])).toEqual([['revoked', null], ['revoked', null]]);
  expect(() => scope.admit()).toThrow(ClosedRunError);
  expect(inbox.next()).toBeNull();
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBeUndefined();
}));

it('forget redacts a waiting row\'s text, caption, quoted reply and file name, and a running row\'s too, and reports nothing left', () => withInbox((inbox, storage, clock) => {
  storage.transactionSync(() => inbox.admit([
    { update: text(1, 'my passport number is X123'), wamid: 'wamid.A' },
    { update: { update_id: WA_UPDATE_BASE + 2, message: { caption: 'X123 scan', document: { file_id: 'm1', file_name: 'X123.pdf' }, reply_to_message: { text: 'you said X123' } } }, wamid: 'wamid.B' },
    { update: text(3, 'nothing to see'), wamid: 'wamid.C' },
  ], SUBJECT));
  const holds = (value: string) => value.includes('X123'), redact = (value: string) => value.replaceAll('X123', '[forgotten]');
  // The first row is running: its turn holds its own copy, and the stored row is redacted all the same.
  const running = inbox.claimNext(clock.now + 60_000)!;
  expect(inbox.forget(redact, holds)).toEqual({ rewritten: 2, remaining: 0 });
  expect(JSON.stringify(inbox.records().map(row => row.update))).not.toContain('X123');
  expect(inbox.get(running.id)?.update).toMatchObject({ message: { text: 'my passport number is [forgotten]' } });
  expect(inbox.get(inbox.records()[1]!.id)?.update).toMatchObject({ message: { caption: '[forgotten] scan', document: { file_id: 'm1', file_name: '[forgotten].pdf' }, reply_to_message: { text: 'you said [forgotten]' } } });
  expect(inbox.forget(redact, holds)).toEqual({ rewritten: 0, remaining: 0 });
}));

it('only waiting and running rows count toward the cap; finished rows go a day after they close', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, Array.from({ length: WHATSAPP_INBOX_MAX_OPEN }, (_, index) => ({ wamid: `wamid.${index}`, body: `message ${index}` })));
  for (let row = inbox.claimNext(clock.now + 60_000); row; row = inbox.claimNext(clock.now + 60_000)) inbox.settle(row, true);
  admit(inbox, storage, [{ wamid: 'wamid.after', body: 'after a full day of messages' }]);
  expect(inbox.records()).toHaveLength(WHATSAPP_INBOX_MAX_OPEN + 1);
  clock.now += WHATSAPP_FINISHED_RETENTION_MS + 1;
  admit(inbox, storage, [{ wamid: 'wamid.next', body: 'next day' }]);
  expect(inbox.records().map(row => row.wamid)).toEqual(['wamid.after', 'wamid.next']);
}));

it('claimNext returns null only when nothing waits: a drain that stops on null takes every waiting row once, in order', () => withInbox((inbox, storage, clock) => {
  expect(inbox.claimNext(clock.now + 60_000)).toBeNull();
  admitApart(inbox, storage, [{ wamid: 'wamid.A', body: 'a' }, { wamid: 'wamid.B', body: 'b' }, { wamid: 'wamid.C', body: 'c' }]);
  // A row someone else closed meanwhile is never handed out.
  storage.transactionSync(() => { const b = inbox.records()[1]!; storage.kv.put(`whatsapp:inbox-record:${b.id}`, { ...b, state: 'revoked', update: null }); });
  const taken: string[] = [];
  for (let row = inbox.claimNext(clock.now + 60_000); row; row = inbox.claimNext(clock.now + 60_000)) { taken.push(row.wamid); inbox.settle(row, true); }
  expect(taken).toEqual(['wamid.A', 'wamid.C']);
  expect(inbox.next()).toBeNull();
}));

it('deferWake moves the wake of open rows later, waiting or running, and does nothing when none is open', () => withInbox((inbox, storage, clock) => {
  inbox.deferWake(30_000);
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBeUndefined();
  admit(inbox, storage, [{ wamid: 'wamid.A', body: 'a' }]);
  inbox.deferWake(30_000);
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + 30_000);
  // A row cut off while running is open too: its wake moves, rather than staying due at the floor.
  inbox.claimNext(clock.now + 60_000);
  storage.kv.put(WHATSAPP_INBOX_DUE_KEY, clock.now - 1);
  inbox.deferWake(60_000);
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + 60_000);
}));

// Text the owner types in a row is one thought, so it is one turn: the claim takes the plain owner texts waiting behind the
// oldest one and joins them under the newest message. A command, an approval reply, a forward, a quoted reply or media stays
// its own turn.
const withQuiet = (quietMs: number, work: (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, clock: { now: number }) => void | Promise<void>, merge = true) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`whatsapp-inbox-${crypto.randomUUID()}`)), async (_instance, state) => {
    const clock = { now: 1_000_000 };
    try { await work(new WhatsAppOwnerInbox(state.storage, () => clock.now, quietMs, merge), state.storage, clock); } finally { await state.storage.deleteAlarm(); }
  });
const admitUpdates = (inbox: WhatsAppOwnerInbox, storage: DurableObjectStorage, rows: readonly { wamid: string; update: (seq: number) => Record<string, unknown> }[]) =>
  storage.transactionSync(() => inbox.admit(rows.map((row, index) => ({ update: row.update(inbox.seq() + 1 + index), wamid: row.wamid })), SUBJECT));
const textOf = (record: WhatsAppInboxRecord | null) => (record?.update as { message?: { text?: string } } | null)?.message?.text;

it('claims plain texts in a row as one turn under the newest message; the joined rows close', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.hey', body: 'Hey Waldo' }, { wamid: 'wamid.card', body: 'I have lost my axis bank debit card' }]);
  const record = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(textOf(record)).toBe('Hey Waldo\nI have lost my axis bank debit card');
  expect(record.wamid).toBe('wamid.card');
  expect((record.update as { update_id: number }).update_id).toBe(WA_UPDATE_BASE + 2);
  expect(inbox.next()).toBeNull();
  expect(inbox.records().map(row => [row.wamid, row.state])).toEqual([['wamid.card', 'running'], ['wamid.card', 'completed']]);
}));

const forwarded = (body: string) => (seq: number) => text(seq, body, { forward_origin: { type: 'hidden_user', date: 0 } });
const fileFrom = (name: string, extra: object = {}) => (seq: number) => ({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: Number(SUBJECT), is_bot: false }, chat: { id: Number(SUBJECT), type: 'private' }, document: { file_id: `m${seq}`, file_name: name }, ...extra } });
const earlierOf = (record: WhatsAppInboxRecord | null) => (record?.earlier ?? []).map(update => (update as { update_id: number }).update_id - WA_UPDATE_BASE);

it('claims a burst of forwards, files and text as one turn: the newest message runs, the others ride with it in order', () => withInbox((inbox, storage, clock) => {
  admitUpdates(inbox, storage, [
    { wamid: 'w1', update: forwarded('Found both saved workout references') }, { wamid: 'w2', update: fileFrom('workout-info.md', { forward_origin: { type: 'hidden_user', date: 0 } }) },
    { wamid: 'w3', update: fileFrom('5k-plan.txt') }, { wamid: 'w4', update: seq => text(seq, 'I had asked Instinct to save these') },
  ]);
  const record = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(record.wamid).toBe('w4');
  expect(textOf(record)).toBe('I had asked Instinct to save these');
  expect(earlierOf(record)).toEqual([1, 2, 3]);
  expect(inbox.next()).toBeNull();
  expect(inbox.records().map(row => row.state)).toEqual(['running', 'completed', 'completed', 'completed']);
  inbox.settle(record, true);
  expect(inbox.get(record.id)?.earlier).toBeUndefined();
}));

it('never joins a command, an approval reply or a quoted reply, and each one ends the burst before it', () => withInbox((inbox, storage, clock) => {
  const quoted = (seq: number) => text(seq, 'that one', { reply_to_message: { text: 'An earlier reply' } });
  const approval = (seq: number) => ({ update_id: WA_UPDATE_BASE + seq, callback_query: { id: 'cb', from: { id: Number(SUBJECT), is_bot: false }, data: 'a:p1', message: { message_id: 0, chat: { id: Number(SUBJECT) } } } });
  admitUpdates(inbox, storage, [
    { wamid: 'w1', update: seq => text(seq, 'one') }, { wamid: 'w2', update: seq => text(seq, '/stop') }, { wamid: 'w3', update: forwarded('Meeting moved to 4pm') },
    { wamid: 'w4', update: quoted }, { wamid: 'w5', update: fileFrom('notes.md') }, { wamid: 'w6', update: approval }, { wamid: 'w7', update: seq => text(seq, 'two') },
  ]);
  const claimed: string[] = [];
  for (let record = inbox.claimNext(clock.now + 1); record; record = inbox.claimNext(clock.now + 1)) { claimed.push(`${record.wamid}:${earlierOf(record).length}`); inbox.settle(record, true); }
  expect(claimed).toEqual(['w1:0', 'w2:0', 'w3:0', 'w4:0', 'w5:0', 'w6:0', 'w7:0']);
}));

it('forget redacts the words and file names of the messages riding with a running burst', () => withInbox((inbox, storage, clock) => {
  admitUpdates(inbox, storage, [{ wamid: 'w1', update: forwarded('my secret plan') }, { wamid: 'w2', update: fileFrom('secret plan.md') }, { wamid: 'w3', update: seq => text(seq, 'thoughts?') }]);
  const record = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(earlierOf(record)).toEqual([1, 2]);
  const result = inbox.forget(value => value.replaceAll('secret plan', '[forgotten]'), value => value.includes('secret plan'));
  expect(result).toEqual({ rewritten: 1, remaining: 0 });
  expect(JSON.stringify(inbox.get(record.id)?.earlier)).not.toContain('secret plan');
}));

it('waits for the owner to go quiet before claiming text, never past the cap after the first message', () => withQuiet(3_000, (inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.hey', body: 'Hey Waldo' }]);
  expect(inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)).toBeNull();
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + 3_000);
  clock.now += 2_000;
  admit(inbox, storage, [{ wamid: 'wamid.card', body: 'I have lost my card' }]);
  expect(storage.kv.get(WHATSAPP_INBOX_DUE_KEY)).toBe(clock.now + 3_000);
  clock.now += 2_999;
  expect(inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)).toBeNull();
  clock.now += 1;
  expect(textOf(inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS))).toBe('Hey Waldo\nI have lost my card');
}));

it('a stream of texts is claimed at the cap after the first, even while more keep coming', () => withQuiet(3_000, (inbox, storage, clock) => {
  for (let n = 0; n < 5; n += 1) { admit(inbox, storage, [{ wamid: `w${n}`, body: `part ${n}` }]); if (n < 4) clock.now += 2_000; }
  expect(textOf(inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS))).toBe('part 0\npart 1\npart 2\npart 3\npart 4');
}));

it('a running burst member that a newer one overtook goes back to wait, and the next claim answers both', () => withInbox((inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.hey', body: 'Hey Waldo' }]);
  const running = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(inbox.overtaken(running.id)).toBe(false);
  admitUpdates(inbox, storage, [{ wamid: 'wamid.cmd', update: seq => text(seq, '/stop') }]);
  expect(inbox.overtaken(running.id)).toBe(false);
  inbox.settle(inbox.claimNext(clock.now + 1)!, true);
  admit(inbox, storage, [{ wamid: 'wamid.card', body: 'I have lost my card' }]);
  expect(inbox.overtaken(running.id)).toBe(true);
  expect(inbox.requeue(running)).toBe(true);
  expect(inbox.requeue(running)).toBe(false);
  const merged = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(textOf(merged)).toBe('Hey Waldo\nI have lost my card');
  expect(inbox.settle(running, false)).toBe(false);
}));

it('with merging off, plain texts in a row are separate turns, claimed at once, and none is overtaken', () => withQuiet(0, (inbox, storage, clock) => {
  admit(inbox, storage, [{ wamid: 'wamid.hey', body: 'Hey Waldo' }, { wamid: 'wamid.card', body: 'I have lost my card' }]);
  const first = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(textOf(first)).toBe('Hey Waldo');
  expect(inbox.overtaken(first.id)).toBe(false);
  inbox.settle(first, true);
  expect(textOf(inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS))).toBe('I have lost my card');
}, false));

it('a running forward is overtaken by a newer file, and the next claim carries the forward with it', () => withInbox((inbox, storage, clock) => {
  admitUpdates(inbox, storage, [{ wamid: 'w1', update: forwarded('Found both saved workout references') }]);
  const running = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  admitUpdates(inbox, storage, [{ wamid: 'w2', update: fileFrom('workout-info.md') }]);
  expect(inbox.overtaken(running.id)).toBe(true);
  expect(inbox.requeue(running)).toBe(true);
  const merged = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect(merged.wamid).toBe('w2');
  expect(earlierOf(merged)).toEqual([1]);
}));

it('a burst carries at most as many files as the model takes; the next file starts the next turn', () => withInbox((inbox, storage, clock) => {
  admitUpdates(inbox, storage, [1, 2, 3, 4, 5].map(n => ({ wamid: `w${n}`, update: fileFrom(`part-${n}.md`) })));
  const first = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect([first.wamid, earlierOf(first)]).toEqual(['w4', [1, 2, 3]]);
  // The fifth file could not ride with these four, so the running turn is not overtaken by it and keeps its reply.
  expect(inbox.overtaken(first.id)).toBe(false);
  inbox.settle(first, true);
  const second = inbox.claimNext(clock.now + WHATSAPP_TURN_DEADLINE_MS)!;
  expect([second.wamid, earlierOf(second)]).toEqual(['w5', []]);
}));
