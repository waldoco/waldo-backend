import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { appDeliveryJournal, appOperationMessages } from '../src/channels/app-delivery';
import { appReplayResultV1Schema } from '../../contracts/src/app/replay';
import { AppInbox } from '../src/channels/app-inbox';

const main = 'owner:prn_owner', side = 'owner:prn_owner:thread:11111111-2222-4333-8444-555555555555';

it('acknowledges actual durable app custody, dedupes exact host delivery identity, and rejects changed payloads', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-delivery-custody')), async (_, state) => {
    const options = { conversationRef: () => side, deliveryKey: () => 'exact-host-operation', now: () => 100 };
    const journal = appDeliveryJournal(state.storage, () => 'app-1', 101, options);
    const first = await journal.call('sendMessage', { chat_id: 101, text: 'Ready for your review', reply_markup: { inline_keyboard: [[{ callback_data: 'a:approval_17' }, { callback_data: 's:approval_17' }, { callback_data: 'external:other' }]] } });
    expect(first).toMatchObject({ message_id: 1, custody: 'owner_app_inbox' });
    expect(journal.messages()[0]).toMatchObject({ conversationRef: side, approval_ids: ['approval_17'], parent_id: 'app-1' });
    const restarted = appDeliveryJournal(state.storage, () => 'app-1', 101, options);
    expect(await restarted.call('sendMessage', { chat_id: 101, text: 'Ready for your review', reply_markup: { inline_keyboard: [[{ callback_data: 'a:approval_17' }]] } })).toEqual(first);
    expect(restarted.messages()).toHaveLength(1);
    await expect(restarted.call('sendMessage', { chat_id: 101, text: 'Changed proposal' })).rejects.toThrow('identity conflict');
    await expect(restarted.call('sendMessage', { chat_id: 202, text: 'Foreign owner' })).rejects.toThrow('owner mismatch');
  });
});

it('replays only the selected conversation with stable sequence cursors across restart and new arrivals', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-delivery-replay')), async (_, state) => {
    const mainJournal = appDeliveryJournal(state.storage, () => null, 101, { conversationRef: () => main, now: () => 1 });
    const sideJournal = appDeliveryJournal(state.storage, () => 'side-1', 101, { conversationRef: () => side, now: () => 2 });
    await mainJournal.call('sendMessage', { chat_id: 101, text: 'Main only' });
    await sideJournal.call('sendMessage', { chat_id: 101, text: 'Side one' });
    await mainJournal.call('sendMessage', { chat_id: 101, text: 'Main later' });
    await sideJournal.call('sendMessage', { chat_id: 101, text: 'Side two' });
    const first = sideJournal.replay(null, 1, { conversationRef: side });
    expect(appReplayResultV1Schema.safeParse(first).success).toBe(true);
    expect(first.events.map(event => event.message.text)).toEqual(['Side one']);
    await sideJournal.call('sendMessage', { chat_id: 101, text: 'Side three' });
    const restarted = appDeliveryJournal(state.storage, () => null, 101);
    const second = restarted.replay(first.next_cursor, 100, { conversationRef: side });
    expect(second.events.map(event => event.message.text)).toEqual(['Side two', 'Side three']);
    expect(JSON.stringify(second)).not.toContain('Main');
    expect(restarted.replay(second.next_cursor, 100, { conversationRef: side }).events).toEqual([]);
    expect(() => restarted.replay('malformed', 20, { conversationRef: side })).toThrow();
    expect(() => restarted.replay(null, 101, { conversationRef: side })).toThrow();
  });
});

it('closes late local publication on cancellation and erases only the exact thread journal', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-delivery-cancel')), async (_, state) => {
    const book = new AppInbox(state.storage);
    const admitted = await book.admit('owner-a', 'session-hash', 'client-0001', 'Do work', { conversationRef: side, threadId: 'thr_11111111-2222-4333-8444-555555555555', threadRevision: 1 });
    if (admitted.kind !== 'admitted') throw new Error('fixture admission failed');
    const running = book.claim(admitted.record.id, true)!, scope = book.scope(running, new AbortController().signal);
    const sideJournal = appDeliveryJournal(state.storage, () => running.id, 101, { conversationRef: () => side, scope: () => scope, deliveryKey: () => 'reply-attempt' });
    await sideJournal.call('sendMessage', { chat_id: 101, text: 'Prior actual custody' });
    await appDeliveryJournal(state.storage, () => null, 101, { conversationRef: () => main }).call('sendMessage', { chat_id: 101, text: 'Main preserved' });
    book.cancelConversation(side);
    await expect(sideJournal.call('sendMessage', { chat_id: 101, text: 'Late publication' })).rejects.toThrow('closed');
    state.storage.transactionSync(() => { expect(sideJournal.eraseConversation(side)).toBe(1); book.eraseConversation(side); });
    expect(sideJournal.messages().map(row => row.text)).toEqual(['Main preserved']);
    expect(sideJournal.replay(null, 50, { conversationRef: side }).events).toEqual([]);
    expect([...state.storage.kv.list({ prefix: 'app:delivery-receipt:' })]).toHaveLength(0);
  });
});

it('keeps OAuth credentials out of journal custody and withholds erased or unrelated operation payloads', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-delivery-private-payload')), async (_, state) => {
    const journal = appDeliveryJournal(state.storage, () => null, 101, { conversationRef: () => main });
    await journal.call('sendMessage', { chat_id: 101, text: 'https://ordinary.example/manual https://accounts.google.com/o/oauth2/auth?state=private-state' });
    expect(JSON.stringify(journal.messages())).not.toContain('private-state');
    expect(journal.messages()[0]?.text).toContain('https://ordinary.example/manual');
    const book = new AppInbox(state.storage);
    await book.admit('owner-a', 'session', 'main-0000001', 'Main queued', { conversationRef: main });
    await book.admit('owner-a', 'session', 'side-0000001', 'Side private', { conversationRef: side, threadId: 'thr_11111111-2222-4333-8444-555555555555', threadRevision: 1 });
    expect(appOperationMessages([], book.records(), { conversationRef: main }).map(row => row.text)).toEqual(['Main queued']);
    book.eraseConversation(side);
    expect(appOperationMessages([], book.records(), { conversationRef: side })).toEqual([]);
  });
});

it('rejects host-marked volatile health payload custody without using content heuristics', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-delivery-volatile-health')), async (_, state) => {
    const journal = appDeliveryJournal(state.storage, () => null, 101, { conversationRef: () => main,
      assertPersistable: () => { throw new Error('volatile health-source payload'); } });
    await expect(journal.call('sendMessage', { chat_id: 101, text: 'An explicitly volatile source result' })).rejects.toThrow('volatile');
    expect(journal.messages()).toEqual([]);
    expect(state.storage.kv.get('app:delivery:sequence')).toBeUndefined();
  });
});
