import { expect, it } from 'vitest';
import type { ConversationEntry } from '@waldo/contracts';
import { appThreadReadV1Schema, appThreadSendV1Schema } from '../../contracts/src/app/threads';
import { surfaceOwnerAdmission } from '../src/identity/surface-owner-admission';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { canonicalOwnerConversationStore } from '../src/conversation/canonical-owner-store';
import { appThreads, appThreadsRequest, type AppThreadsHost } from '../src/channels/app-threads';
import { appReplayResultV1Schema } from '../../contracts/src/app/replay';
import type { RunEffectScope } from '../src/channels/run-effect-scope';

const op = () => crypto.randomUUID();
const setup = async (shared?: Map<string, unknown>, owner = '11111111-2222-4333-8444-555555555555') => {
  const data = shared ?? new Map<string, unknown>(); let revoked = false;
  const storage = {
    kv: { get: <T,>(key: string) => data.get(key) as T | undefined, put: (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
      delete: (key: string) => data.delete(key), list: <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T> },
    get: async <T,>(key: string) => data.get(key) as T | undefined,
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    put: async (rows: Record<string, unknown>) => { Object.entries(rows).forEach(([key, value]) => data.set(key, structuredClone(value))); },
  };
  const scope: RunEffectScope = { runId: 'thread-request', attempt: 'local', deadline: 999999,
    signal: new AbortController().signal, admit: () => { if (revoked) throw new Error('revoked'); },
    commit: work => { if (revoked) throw new Error('revoked'); const before = new Map(data); try { return work(); } catch (error) { data.clear(); before.forEach((value, key) => data.set(key, value)); throw error; } } };
  const context = createOwnerTurnContext(await surfaceOwnerAdmission({ scope, lookup: async () => ({ ownerId: owner, bindingRef: 'session', revision: '1', physicalDoId: 'owner-do' }),
    expectedPhysicalDoId: 'owner-do', surface: 'app', subject: owner, occurrenceKey: 'read-1', occurredAt: 1, text: 'Current read-only owner context', now: () => 2 }));
  const history = canonicalOwnerConversationStore(storage as never, context);
  const canceled: string[] = [], erased: string[] = [], admitted: Parameters<AppThreadsHost['admitMessage']>[0][] = [];
  const host: AppThreadsHost = { storage: storage as never, context, operationScope: () => scope, history: () => history,
    cancelConversation: ref => { canceled.push(ref); }, eraseConversation: ref => { erased.push(ref); }, now: () => 100,
    admitMessage: async input => { admitted.push(input); return { accepted: true, message_id: 'app-100', state: 'admitted' }; } };
  return { data, storage, scope, context, history, host, controller: appThreads(host), canceled, erased, admitted, revoke: () => { revoked = true; } };
};
const entry = (principal: string, chatId: string, id: string): ConversationEntry => ({
  id, ownerId: principal, chatId, parentId: null, threadAnchorId: null, surface: 'app', role: 'user', inputOrigin: 'owner',
  modelPayload: `Owner context ${id}`, appPayload: `Owner context ${id}`, modelProjection: { mode: 'include' },
});
const request = (path: string, body?: unknown) => new Request(`https://app.invalid/app/v1/threads${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('thread create survives restart, dedupes operation identity, and never accepts a client owner', async () => {
  const env = await setup(), operation_id = op();
  const first = await env.controller.create({ operation_id, title: 'Owner project' });
  expect(await appThreads((await setup(env.data)).host).create({ operation_id, title: 'Owner project' })).toEqual(first);
  expect((await env.controller.list()).threads).toHaveLength(1);
  await expect(env.controller.create({ operation_id, title: 'Changed title' })).rejects.toThrow('operation_conflict');
  const injected = await appThreadsRequest(request('', { operation_id: op(), title: 'Wrong owner', owner_id: 'foreign' }), env.host);
  expect(injected?.status).toBe(400);
  expect((await (await setup(env.data, '66666666-7777-4888-8999-aaaaaaaaaaaa')).controller.list()).threads).toEqual([]);
});

it('thread read reuses exact canonical history without main or another thread content', async () => {
  const env = await setup(), first = await env.controller.create({ operation_id: op(), title: 'First' }), second = await env.controller.create({ operation_id: op(), title: 'Second' });
  const principal = env.context.invocation.verified_authority.principal_ref;
  const rows = [entry(principal, `owner:${principal}`, 'main'), entry(principal, env.controller.conversationRef(first.thread_id), 'first'), entry(principal, env.controller.conversationRef(second.thread_id), 'second')];
  await env.history.save(rows, 'second', env.scope);
  const result = await env.controller.read(first.thread_id);
  expect(appThreadReadV1Schema.safeParse(result).success).toBe(true);
  expect(result.history.messages.map(row => row.id)).toEqual(['first']);
  expect(JSON.stringify(result)).not.toContain('Owner context main');
  expect(JSON.stringify(result)).not.toContain('Owner context second');
  expect((await appThreadsRequest(request(`/${first.thread_id}?limit=0`), env.host))?.status).toBe(400);
  expect((await appThreadsRequest(request(`/${first.thread_id}?cursor=1&cursor=2`), env.host))?.status).toBe(400);
});

it('archive and cancel close previous run revisions, preserve evidence, and dedupe exact receipts', async () => {
  const env = await setup(), created = await env.controller.create({ operation_id: op(), title: 'Work' });
  const archive = { operation_id: op(), expected_revision: 1, archived: true };
  const result = await env.controller.archive(created.thread_id, archive);
  expect(result).toMatchObject({ thread_state: 'archived', revision: 2 });
  expect(await env.controller.archive(created.thread_id, archive)).toEqual(result);
  expect(env.canceled).toHaveLength(1);
  expect(() => env.controller.assertThreadCurrent(created.thread_id, 1)).toThrow('closed');
  await expect(env.controller.archive(created.thread_id, { operation_id: op(), expected_revision: 1, archived: false })).rejects.toThrow('revision_conflict');
  await env.controller.archive(created.thread_id, { operation_id: op(), expected_revision: 2, archived: false });
  await env.controller.cancel(created.thread_id, { operation_id: op(), expected_revision: 3 });
  expect(() => env.controller.assertThreadCurrent(created.thread_id, 3)).toThrow('closed');
  expect(() => env.controller.assertThreadCurrent(created.thread_id, 4)).not.toThrow();
});

it('delete removes exact witnessed transcript and title, preserves main and unrelated custody', async () => {
  const env = await setup(), first = await env.controller.create({ operation_id: op(), title: 'Sensitive project title' }), second = await env.controller.create({ operation_id: op(), title: 'Second' });
  const principal = env.context.invocation.verified_authority.principal_ref, ref = env.controller.conversationRef(first.thread_id);
  await env.history.save([entry(principal, `owner:${principal}`, 'main'), entry(principal, ref, 'deleted-secret'), entry(principal, env.controller.conversationRef(second.thread_id), 'second')], 'deleted-secret', env.scope);
  env.data.set('conv:legacy', { untouched: true });
  const input = { operation_id: op(), expected_revision: 1 }, result = await env.controller.delete(first.thread_id, input);
  expect(result).toMatchObject({ thread_state: 'deleted', revision: 2, erased_messages: 1 });
  expect(await env.controller.delete(first.thread_id, input)).toEqual(result);
  expect(env.erased).toEqual([ref]);
  expect(JSON.stringify([...env.data])).not.toContain('Sensitive project title');
  expect(JSON.stringify([...env.data])).not.toContain('Owner context deleted-secret');
  expect((await env.history.load()).entries.map(row => row.id)).toEqual(['main', 'second']);
  expect(env.data.get('conv:legacy')).toEqual({ untouched: true });
  await expect(env.controller.read(first.thread_id)).rejects.toThrow('thread_deleted');
});

it('thread message admission carries server conversation and current reference provenance without granting source access', async () => {
  const env = await setup(), target = await env.controller.create({ operation_id: op(), title: 'Target' }), source = await env.controller.create({ operation_id: op(), title: 'Source' });
  const principal = env.context.invocation.verified_authority.principal_ref;
  await env.history.save([entry(principal, env.controller.conversationRef(source.thread_id), 'source-entry')], 'source-entry', env.scope);
  const message = appThreadSendV1Schema.parse({ client_message_id: 'client_message_1', expected_revision: 1, text: 'Continue this project',
    context_refs: [{ kind: 'thread', thread_id: source.thread_id, revision: 1 }, { kind: 'source', source_ref: 'src_observed_mail_17' }],
    attachment_refs: [{ file_id: op(), revision: 2 }] });
  const response = await appThreadsRequest(request(`/${target.thread_id}/messages`, message), env.host);
  expect(response?.status).toBe(202);
  expect(env.admitted[0]).toMatchObject({ threadId: target.thread_id, conversationRef: env.controller.conversationRef(target.thread_id), revision: 1, message });
  expect(env.admitted[0]?.threadContext[0]?.entries.map(row => row.id)).toEqual(['source-entry']);
  await env.controller.archive(source.thread_id, { operation_id: op(), expected_revision: 1, archived: true });
  expect((await appThreadsRequest(request(`/${target.thread_id}/messages`, message), env.host))?.status).toBe(409);
  expect(env.admitted).toHaveLength(1);
});

it('a session revoked during history resolution cannot admit, mutate, or read another result', async () => {
  const env = await setup(), target = await env.controller.create({ operation_id: op(), title: 'Target' });
  const host: AppThreadsHost = { ...env.host, history: () => ({ ...env.history, load: async () => { const result = await env.history.load(); env.revoke(); return result; } }) };
  const body = { client_message_id: 'client_message_2', expected_revision: 1, text: 'Read', context_refs: [{ kind: 'thread', thread_id: target.thread_id, revision: 1 }] };
  expect((await appThreadsRequest(request(`/${target.thread_id}/messages`, body), host))?.status).toBe(503);
  expect(env.admitted).toHaveLength(0);
  expect((await appThreadsRequest(request('/'), host))?.status).toBe(404);
  expect((await appThreadsRequest(request('', { operation_id: op(), title: 'After revoke' }), host))?.status).toBe(503);
});

it('reconciles exact thread mutations and admission receipts after a lost response, including after deletion', async () => {
  const env = await setup(), operation_id = op(), created = await env.controller.create({ operation_id, title: 'Receipts' });
  expect(await env.controller.operation(operation_id)).toEqual(created);
  const operationResponse = await appThreadsRequest(request(`/operations/${operation_id}`), env.host);
  expect(operationResponse?.status).toBe(200);
  expect(await operationResponse?.json()).toEqual(created);
  expect((await appThreadsRequest(request(`/operations/${op()}`), env.host))?.status).toBe(404);
  const host: AppThreadsHost = { ...env.host, lookupMessage: async (ref, id) => ref === env.controller.conversationRef(created.thread_id) && id === 'message-0001'
    ? { accepted: true, message_id: 'app-0001', state: 'interrupted', closed_reason: 'deleted', effects_unconfirmed: true } : null };
  await env.controller.delete(created.thread_id, { operation_id: op(), expected_revision: 1 });
  const response = await appThreadsRequest(request(`/${created.thread_id}/messages/message-0001`), host);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ state: 'interrupted', effects_unconfirmed: true });
  expect((await appThreadsRequest(request(`/${created.thread_id}/messages/unknown-0001`), host))?.status).toBe(404);
  expect((await appThreadsRequest(request(`/${created.thread_id}/messages/message-0001?owner_id=foreign`), host))?.status).toBe(400);
});

it('rechecks the complete thread reference set at publication after asynchronous artifact resolution', async () => {
  const env = await setup(), target = await env.controller.create({ operation_id: op(), title: 'Target' }), source = await env.controller.create({ operation_id: op(), title: 'Source' });
  let published = false;
  const host: AppThreadsHost = { ...env.host, admitMessage: async input => {
    // Resolving a file can yield while another request archives the referenced source.
    await env.controller.archive(source.thread_id, { operation_id: op(), expected_revision: 1, archived: true });
    input.assertThreadCurrent(); published = true;
    return { accepted: true, message_id: 'must-not-publish', state: 'admitted' };
  } };
  const body = { client_message_id: 'message-0001', expected_revision: 1, text: 'Read these together', context_refs: [{ kind: 'thread', thread_id: source.thread_id, revision: 1 }] };
  expect((await appThreadsRequest(request(`/${target.thread_id}/messages`, body), host))?.status).toBe(409);
  expect(published).toBe(false);
  expect(() => env.controller.assertContextReferencesCurrent(appThreadSendV1Schema.parse(body).context_refs)).toThrow('closed');
});

it('keeps immutable history cursors stable when a newer message arrives between pages', async () => {
  const env = await setup(), created = await env.controller.create({ operation_id: op(), title: 'Paged history' }), principal = env.context.invocation.verified_authority.principal_ref;
  const ref = env.controller.conversationRef(created.thread_id);
  const original = Array.from({ length: 4 }, (_, i) => entry(principal, ref, `row-${i + 1}`));
  await env.history.save(original, 'row-4', env.scope);
  const first = await env.controller.read(created.thread_id, null, 2);
  expect(first.history.messages.map(row => row.id)).toEqual(['row-4', 'row-3']);
  await env.history.save([...original, entry(principal, ref, 'new-row')], 'new-row', env.scope);
  const second = await env.controller.read(created.thread_id, first.history.next_cursor, 2);
  expect(second.history.messages.map(row => row.id)).toEqual(['row-2', 'row-1']);
});

it('rehydrates the admitted witnessed context checkpoint without silently substituting later thread entries', async () => {
  const env = await setup(), target = await env.controller.create({ operation_id: op(), title: 'Target' }), source = await env.controller.create({ operation_id: op(), title: 'Source' });
  const principal = env.context.invocation.verified_authority.principal_ref, ref = env.controller.conversationRef(source.thread_id);
  const original = [entry(principal, ref, 'source-1')];
  await env.history.save(original, 'source-1', env.scope);
  await env.controller.send(target.thread_id, appThreadSendV1Schema.parse({ client_message_id: 'snapshot-001', text: 'Use this context', expected_revision: 1,
    context_refs: [{ kind: 'thread', thread_id: source.thread_id, revision: 1 }] }));
  const checkpoints = env.admitted[0]!.contextSnapshots;
  expect(checkpoints).toEqual([expect.objectContaining({ threadId: source.thread_id, revision: 1, leafId: 'source-1', digest: expect.stringMatching(/^sha256:/) })]);
  expect(JSON.stringify(checkpoints)).not.toContain('Owner context source-1');
  await env.history.save([...original, entry(principal, ref, 'source-2')], 'source-2', env.scope);
  const restarted = await setup(env.data);
  expect((await restarted.controller.resolveContextSnapshots(checkpoints))[0]?.entries.map(row => row.id)).toEqual(['source-1']);
  await env.controller.delete(source.thread_id, { operation_id: op(), expected_revision: 1 });
  await expect(restarted.controller.resolveContextSnapshots(checkpoints)).rejects.toThrow('thread_deleted');
});

it('exposes canonical replay only through an authenticated thread lookup and rejects duplicate query keys', async () => {
  const env = await setup(), created = await env.controller.create({ operation_id: op(), title: 'Replay' });
  const received: unknown[] = [];
  const host: AppThreadsHost = { ...env.host, replay: (ref, cursor, limit) => {
    received.push({ ref, cursor, limit });
    return { version: 1, events: [{ sequence: 7, type: 'message', occurred_at: 100, approval_ids: ['approval_1'], message: { id: 'delivery-7', role: 'assistant', text: 'Review this proposal', channel: 'app', parent_id: 'app-1', parts: [{ type: 'text', text: 'Review this proposal' }] } }], next_cursor: '7' };
  } };
  const response = await appThreadsRequest(request(`/${created.thread_id}/events?cursor=3&limit=10`), host);
  expect(response?.status).toBe(200);
  expect(appReplayResultV1Schema.safeParse(await response?.json()).success).toBe(true);
  expect(received).toEqual([{ ref: env.controller.conversationRef(created.thread_id), cursor: '3', limit: 10 }]);
  expect((await appThreadsRequest(request(`/${created.thread_id}/events?cursor=3&cursor=7`), host))?.status).toBe(400);
  expect((await appThreadsRequest(request(`/${created.thread_id}/events`), env.host))?.status).toBe(503);
  env.revoke();
  expect((await appThreadsRequest(request(`/${created.thread_id}/events`), host))?.status).toBe(503);
  expect(received).toHaveLength(1);
});
