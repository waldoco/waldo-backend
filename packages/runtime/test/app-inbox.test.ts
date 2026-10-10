import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppInbox, type AppInboxAdmission } from '../src/channels/app-inbox';

const firstThread = 'thr_11111111-2222-4333-8444-555555555555';
const secondThread = 'thr_66666666-7777-4888-8999-aaaaaaaaaaaa';
const binding = (id = firstThread): AppInboxAdmission => ({ conversationRef: `owner:prn_owner:thread:${id.slice(4)}`, threadId: id, threadRevision: 1,
  contextRefs: [{ kind: 'thread', thread_id: secondThread, revision: 3 }, { kind: 'source', source_ref: 'mail:account:message', revision: 7 }],
  attachmentRefs: [{ file_id: '01234567-1234-4567-89ab-0123456789ab', revision: 2 }],
});

it('durably binds duplicate payloads, recovers admitted work and fences interrupted execution', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-inbox-regression')), async (_, state) => {
    const book = new AppInbox(state.storage);
    const first = await book.admit('owner-a', 'session-hash', 'client-0001', 'inspect the document');
    expect(first.kind).toBe('admitted');
    expect(await state.storage.getAlarm()).not.toBeNull();
    expect((await book.admit('owner-a', 'session-hash', 'client-0001', 'changed goal')).kind).toBe('conflict');
    expect((await book.admit('owner-b', 'session-hash', 'client-0001', 'inspect the document')).kind).toBe('conflict');
    const restarted = new AppInbox(state.storage);
    restarted.recover(new Set());
    const admitted = restarted.records()[0]!;
    expect(admitted.state).toBe('admitted');
    const running = restarted.claim(admitted.id, true)!;
    const scope = restarted.scope(running, new AbortController().signal);
    scope.commit(() => state.storage.kv.put('app-test-result', 'saved'));
    restarted.recover(new Set());
    expect(() => scope.commit(() => state.storage.kv.put('app-test-result', 'late'))).toThrow();
    expect(state.storage.kv.get('app-test-result')).toBe('saved');
    expect(restarted.records()[0]).toMatchObject({ state: 'interrupted', text: '' });
    expect(restarted.claim(admitted.id, true)).toBeNull();
  });
});

it('binds durable admission and idempotency to the full server conversation, source, and artifact revision', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-inbox-thread-envelope')), async (_, state) => {
    const book = new AppInbox(state.storage), context = binding();
    const first = await book.admit('owner-a', 'session-hash', 'client-0001', 'Continue', context);
    expect(first.kind).toBe('admitted');
    expect(new AppInbox(state.storage).records()[0]).toMatchObject({ ...context, text: 'Continue', digestVersion: 2 });
    expect((await book.admit('owner-a', 'new-session', 'client-0001', 'Continue', binding())).kind).toBe('duplicate');
    expect((await book.admit('owner-a', 'session-hash', 'client-0001', 'Continue', binding(secondThread))).kind).toBe('conflict');
    expect((await book.admit('owner-a', 'session-hash', 'client-0001', 'Continue', { ...context, attachmentRefs: [{ ...context.attachmentRefs![0]!, revision: 3 }] })).kind).toBe('conflict');
    expect((await book.admit('owner-a', 'session-hash', 'client-0001', 'Continue', { ...context, contextRefs: [] })).kind).toBe('conflict');
    expect(book.receipt('owner-b', 'client-0001', { conversationRef: context.conversationRef })).toBeNull();
    expect(book.receipt('owner-a', 'client-0001', { conversationRef: binding(secondThread).conversationRef })).toBeNull();
    expect(book.receipt('owner-a', 'client-0001', { conversationRef: context.conversationRef })).toMatchObject({ accepted: true, state: 'admitted' });
  });
});

it('cancellation closes queued and running attempts without claiming rollback or disturbing another thread', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-inbox-thread-cancellation')), async (_, state) => {
    const book = new AppInbox(state.storage), context = binding();
    const first = await book.admit('owner-a', 'session-hash', 'running-0001', 'Try approved work', context);
    const queued = await book.admit('owner-a', 'session-hash', 'queued-00001', 'Queued work', context);
    const other = await book.admit('owner-a', 'session-hash', 'other-000001', 'Other project', binding(secondThread));
    if (first.kind !== 'admitted' || queued.kind !== 'admitted' || other.kind !== 'admitted') throw new Error('fixture admission failed');
    const running = book.claim(first.record.id, true)!, scope = book.scope(running, new AbortController().signal);
    scope.commit(() => state.storage.kv.put('attempted-effect', 'receipt-observed'));
    expect(book.cancelConversation(context.conversationRef)).toBe(2);
    expect(() => scope.commit(() => state.storage.kv.put('attempted-effect', 'late'))).toThrow('closed');
    book.settle(running, true);
    expect(book.receipt('owner-a', 'running-0001')).toMatchObject({ state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: true });
    expect(book.receipt('owner-a', 'queued-00001')).toMatchObject({ state: 'interrupted', closed_reason: 'cancelled', effects_unconfirmed: false });
    expect(book.records().filter(row => row.conversationRef === context.conversationRef)).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '', contextRefs: [], attachmentRefs: [] }),
    ]));
    expect(state.storage.kv.get('attempted-effect')).toBe('receipt-observed');
    expect(book.claim(other.record.id, true)?.text).toBe('Other project');
  });
});

it('thread erasure leaves a bounded receipt, clears payload, and never restarts the deleted turn', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-inbox-thread-erasure')), async (_, state) => {
    const book = new AppInbox(state.storage), context = binding();
    const first = await book.admit('owner-a', 'session-hash', 'deleted-0001', 'private original', context);
    if (first.kind !== 'admitted') throw new Error('fixture admission failed');
    // Mirrors cancellation and erasure inside the thread revision transaction.
    state.storage.transactionSync(() => { book.cancelConversation(context.conversationRef, 'deleted'); book.eraseConversation(context.conversationRef); });
    const restarted = new AppInbox(state.storage); restarted.recover(new Set());
    expect(restarted.records()[0]).toMatchObject({ state: 'interrupted', text: '', contextRefs: [], attachmentRefs: [], erased: true, closedReason: 'deleted' });
    expect(restarted.claim(first.record.id, true)).toBeNull();
    expect((await restarted.admit('owner-a', 'session-hash', 'deleted-0001', 'private original', context)).kind).toBe('duplicate');
    expect(JSON.stringify(restarted.receipt('owner-a', 'deleted-0001'))).not.toContain('private original');
  });
});

it('rechecks thread publication and run references, and does not preserve OAuth credentials in queued text', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-inbox-current-fences')), async (_, state) => {
    const book = new AppInbox(state.storage), context = binding(); let revisionCurrent = true, checks = 0;
    await expect(book.admit('owner-a', 'session-hash', 'denied-00001', 'Not admitted', context, () => { if (++checks === 2) throw new Error('revision changed'); })).rejects.toThrow('revision changed');
    expect(book.records()).toHaveLength(0);
    const first = await book.admit('owner-a', 'session-hash', 'allowed-0001', 'Use https://ordinary.example/manual and https://accounts.google.com/o/oauth2/auth?state=secret-value', context);
    if (first.kind !== 'admitted') throw new Error('fixture admission failed');
    expect(first.record.text).toContain('https://ordinary.example/manual');
    expect(first.record.text).not.toContain('secret-value');
    const running = book.claim(first.record.id, true)!;
    const scope = book.scope(running, new AbortController().signal, () => { if (!revisionCurrent) throw new Error('source changed'); });
    revisionCurrent = false;
    expect(() => scope.commit(() => state.storage.kv.put('late-publication', true))).toThrow('source changed');
    expect(state.storage.kv.get('late-publication')).toBeUndefined();
    book.settle(running, false);
  });
});

it('stores full-sized admissions in separate durable values and migrates legacy custody without losing its receipt', async () => {
  await runInDurableObject(env.TRACER_DO.get(env.TRACER_DO.idFromName('app-inbox-large-value')), async (_, state) => {
    const book = new AppInbox(state.storage), text = '文'.repeat(4000);
    // This accepted envelope is larger in aggregate than one DO value can hold.
    for (let i = 0; i < 40; i++) expect((await book.admit('owner-a', 'session', `large-${String(i).padStart(6, '0')}`, text, { conversationRef: 'owner:prn_owner' })).kind).toBe('admitted');
    expect(new AppInbox(state.storage).records()).toHaveLength(40);
    expect([...state.storage.kv.list({ prefix: 'app:inbox-record:' })]).toHaveLength(40);
    expect(state.storage.kv.get('app_inbox_v1')).toBeUndefined();
    const legacy = { id: 'legacy-app', clientId: 'legacy-0001', updateId: 1, digest: 'old-digest', text: '', owner: 'owner-a', sessionHash: 'old-session', admittedAt: Date.now(), state: 'interrupted' as const };
    state.storage.kv.put('app_inbox_v1', [legacy]);
    expect(book.records()).toHaveLength(41);
    book.recover(new Set());
    expect(state.storage.kv.get('app_inbox_v1')).toBeUndefined();
    expect(book.receipt('owner-a', 'legacy-0001')).toMatchObject({ message_id: 'legacy-app', state: 'interrupted' });
  });
});
