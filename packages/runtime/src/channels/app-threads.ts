import type { ConversationEntry } from '@waldo/contracts';
import {
  appThreadArchiveV1Schema, appThreadCreateV1Schema, appThreadDeleteV1Schema, appThreadIdV1Schema,
  appThreadListQueryV1Schema, appThreadReadQueryV1Schema, appThreadSendV1Schema, appThreadV1Schema, appThreadMessageIdV1Schema, appThreadMessageReceiptV1Schema,
  type AppThreadOperationResultV1, type AppThreadSendV1, type AppThreadV1, type AppThreadMessageReceiptV1,
} from '../../../contracts/src/app/threads';
import { APP_SEND_MAX_WIRE_BYTES } from '../../../contracts/src/app/core';
import { appReplayQueryV1Schema, appReplayResultV1Schema, type AppReplayResultV1 } from '../../../contracts/src/app/replay';
import type { OwnerContextCapability } from '../context-composer/owner-turn';
import { sha256Prefixed, stableJson } from '../context-composer/canonical';
import { eraseCanonicalOwnerConversation } from '../conversation/canonical-owner-store';
import type { ConversationStore } from './conversation-store';
import { appTranscriptPage } from './app-api';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import type { AppThreadContextSnapshot } from './app-inbox';

export type AppThreadsHost = Readonly<{
  storage: Pick<DurableObjectStorage, 'kv'>;
  context: Pick<OwnerContextCapability, 'invocation' | 'assertCurrent'>;
  operationScope(): RunEffectScope;
  history(): ConversationStore;
  // These synchronous callbacks run in the same host transaction as revision/CAS.
  // Cancellation closes inbox attempts; erasure removes correlated delivery/episode custody.
  cancelConversation(conversationRef: string): void;
  eraseConversation(conversationRef: string): void;
  admitMessage(input: Readonly<{ threadId: string; conversationRef: string; revision: number; message: AppThreadSendV1;
    threadContext: readonly Readonly<{ reference: Extract<AppThreadSendV1['context_refs'][number], { kind: 'thread' }>; entries: readonly ConversationEntry[] }>[];
    contextSnapshots: readonly AppThreadContextSnapshot[];
    assertThreadCurrent(): void;
  }>): Promise<Readonly<{ accepted: true; message_id: string; state?: 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked' }>>;
  lookupMessage?(conversationRef: string, clientMessageId: string): Promise<AppThreadMessageReceiptV1 | null>;
  replay?(conversationRef: string, cursor: string | null, limit: number): AppReplayResultV1;
  now?(): number;
}>;
type OperationReceipt = Readonly<{ digest: string; result: AppThreadOperationResultV1 }>;
class ThreadFault extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

// Metadata selects a canonical conversation; it never becomes a separate transcript or effect brain.
export function appThreads(host: AppThreadsHost) {
  const { principal_ref: principal, tenant_ref: tenant } = host.context.invocation.verified_authority;
  const prefix = `app-thread-v1:${principal}:${tenant}:`, now = host.now ?? Date.now;
  const conversationRef = (id: string) => `owner:${principal}:thread:${id.slice(4)}`;
  const key = (id: string) => `${prefix}thread:${id}`;
  const operationKey = (id: string) => `${prefix}operation:${id}`;
  const read = (id: string, allowDeleted = false): AppThreadV1 => {
    const raw = host.storage.kv.get<unknown>(key(id));
    if (!raw) throw new ThreadFault(404, 'thread_not_found');
    const parsed = appThreadV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.thread_id !== id || parsed.data.conversation_ref !== conversationRef(id)) throw new ThreadFault(409, 'thread_custody_conflict');
    if (!allowDeleted && parsed.data.state === 'deleted') throw new ThreadFault(410, 'thread_deleted');
    return parsed.data;
  };
  const current = (id: string, revision: number) => {
    const thread = read(id);
    if (thread.revision !== revision) throw new ThreadFault(409, 'thread_revision_conflict');
    if (thread.state !== 'active') throw new ThreadFault(409, 'thread_archived');
    return thread;
  };
  const recorded = (operationId: string, digest: string) => {
    const receipt = host.storage.kv.get<OperationReceipt>(operationKey(operationId));
    if (receipt && receipt.digest !== digest) throw new ThreadFault(409, 'operation_conflict');
    return receipt?.result;
  };
  const mutate = async (operationId: string, payload: unknown, change: () => AppThreadOperationResultV1) => {
    await host.context.assertCurrent();
    const digest = await sha256Prefixed(stableJson(payload));
    await host.context.assertCurrent();
    const result = host.operationScope().commit(() => {
      const previous = recorded(operationId, digest);
      if (previous) return previous;
      const result = change();
      host.storage.kv.put(operationKey(operationId), { digest, result } satisfies OperationReceipt);
      return result;
    });
    await host.context.assertCurrent(); return result;
  };
  const receipt = (operationId: string, thread: AppThreadV1, erased?: number): AppThreadOperationResultV1 => ({
    operation_id: operationId, state: 'recorded', thread_id: thread.thread_id, revision: thread.revision, thread_state: thread.state,
    ...(erased !== undefined ? { erased_messages: erased } : {}),
  });
  return {
    conversationRef,
    // Root joins this local fence to the session/source fence on every inbox run commit.
    assertThreadCurrent(id: string, revision: number) { try { current(id, revision); } catch { throw new ClosedRunError(); } },
    assertContextReferencesCurrent(references: AppThreadSendV1['context_refs']) {
      for (const reference of references) if (reference.kind === 'thread') {
        try { if (read(reference.thread_id).revision !== reference.revision) throw new ClosedRunError(); }
        catch { throw new ClosedRunError(); }
      }
    },
    async resolveContextSnapshots(snapshots: readonly AppThreadContextSnapshot[]) {
      await host.context.assertCurrent();
      const history = snapshots.length ? await host.history().load() : null;
      const context = [];
      for (const snapshot of snapshots) {
        const referenced = read(snapshot.threadId);
        if (referenced.revision !== snapshot.revision) throw new ThreadFault(409, 'context_revision_conflict');
        const all = history!.entries.filter(entry => entry.ownerId === principal && entry.chatId === referenced.conversation_ref);
        const index = snapshot.leafId === null ? -1 : all.findIndex(entry => entry.id === snapshot.leafId);
        if (snapshot.leafId !== null && index < 0) throw new ThreadFault(409, 'context_custody_conflict');
        const entries = snapshot.leafId === null ? [] : all.slice(0, index + 1);
        if (await sha256Prefixed(stableJson(entries)) !== snapshot.digest) throw new ThreadFault(409, 'context_custody_conflict');
        context.push({ reference: { kind: 'thread' as const, thread_id: snapshot.threadId, revision: snapshot.revision }, entries });
      }
      await host.context.assertCurrent();
      for (const snapshot of snapshots) if (read(snapshot.threadId).revision !== snapshot.revision) throw new ThreadFault(409, 'context_revision_conflict');
      return context;
    },
    async operation(operationId: string) {
      await host.context.assertCurrent();
      const result = host.storage.kv.get<OperationReceipt>(operationKey(operationId))?.result;
      if (!result) throw new ThreadFault(404, 'operation_not_found');
      await host.context.assertCurrent(); return result;
    },
    async messageReceipt(id: string, clientMessageId: string) {
      await host.context.assertCurrent(); const thread = read(id, true);
      if (!host.lookupMessage) throw new ThreadFault(503, 'unavailable');
      const result = await host.lookupMessage(thread.conversation_ref, clientMessageId);
      if (!result) throw new ThreadFault(404, 'message_not_found');
      await host.context.assertCurrent(); return appThreadMessageReceiptV1Schema.parse(result);
    },
    async replay(id: string, cursor: string | null = null, limit = 50) {
      await host.context.assertCurrent(); const thread = read(id);
      if (!host.replay) throw new ThreadFault(503, 'unavailable');
      const result = appReplayResultV1Schema.parse(host.replay(thread.conversation_ref, cursor, limit));
      await host.context.assertCurrent();
      if (read(id).revision !== thread.revision) throw new ThreadFault(409, 'thread_revision_conflict');
      return result;
    },
    async list(state: 'active' | 'archived' | 'all' = 'active') {
      await host.context.assertCurrent();
      const threads = [...host.storage.kv.list<AppThreadV1>({ prefix: `${prefix}thread:` })].map(([, thread]) => read(thread.thread_id, true))
        .filter(thread => thread.state !== 'deleted' && (state === 'all' || thread.state === state))
        .sort((a, b) => b.updated_at - a.updated_at || a.thread_id.localeCompare(b.thread_id));
      await host.context.assertCurrent(); return { threads };
    },
    async read(id: string, cursor: string | null = null, limit = 20) {
      await host.context.assertCurrent(); const thread = read(id);
      const snapshot = await host.history().load();
      await host.context.assertCurrent();
      if (read(id).revision !== thread.revision) throw new ThreadFault(409, 'thread_revision_conflict');
      return { thread, history: appTranscriptPage(snapshot.entries.filter(entry => entry.ownerId === principal && entry.chatId === thread.conversation_ref), cursor, limit) };
    },
    create(input: { operation_id: string; title: string }) {
      const id = `thr_${crypto.randomUUID()}`;
      return mutate(input.operation_id, { action: 'create', ...input }, () => {
        const live = [...host.storage.kv.list<AppThreadV1>({ prefix: `${prefix}thread:` })].filter(([, row]) => row.state !== 'deleted');
        if (live.length >= 256) throw new ThreadFault(429, 'thread_capacity');
        const at = now(); const thread: AppThreadV1 = { thread_id: id, title: input.title, revision: 1, state: 'active', created_at: at, updated_at: at, conversation_ref: conversationRef(id) };
        host.storage.kv.put(key(id), thread); return receipt(input.operation_id, thread);
      });
    },
    archive(id: string, input: { operation_id: string; expected_revision: number; archived: boolean }) {
      return mutate(input.operation_id, { action: 'archive', thread_id: id, ...input }, () => {
        const previous = read(id);
        if (previous.revision !== input.expected_revision) throw new ThreadFault(409, 'thread_revision_conflict');
        host.cancelConversation(previous.conversation_ref);
        const thread: AppThreadV1 = { ...previous, revision: previous.revision + 1, state: input.archived ? 'archived' : 'active', updated_at: now() };
        host.storage.kv.put(key(id), thread); return receipt(input.operation_id, thread);
      });
    },
    cancel(id: string, input: { operation_id: string; expected_revision: number }) {
      return mutate(input.operation_id, { action: 'cancel', thread_id: id, ...input }, () => {
        const previous = read(id);
        if (previous.revision !== input.expected_revision) throw new ThreadFault(409, 'thread_revision_conflict');
        host.cancelConversation(previous.conversation_ref);
        const thread = { ...previous, revision: previous.revision + 1, updated_at: now() };
        host.storage.kv.put(key(id), thread); return receipt(input.operation_id, thread);
      });
    },
    delete(id: string, input: { operation_id: string; expected_revision: number }) {
      return mutate(input.operation_id, { action: 'delete', thread_id: id, ...input }, () => {
        const previous = read(id, true);
        if (previous.revision !== input.expected_revision || previous.state === 'deleted') throw new ThreadFault(409, 'thread_revision_conflict');
        host.cancelConversation(previous.conversation_ref);
        host.eraseConversation(previous.conversation_ref);
        const removed = eraseCanonicalOwnerConversation(host.storage, host.context, previous.conversation_ref);
        const thread: AppThreadV1 = { ...previous, title: '', revision: previous.revision + 1, state: 'deleted', updated_at: now() };
        host.storage.kv.put(key(id), thread); return receipt(input.operation_id, thread, removed);
      });
    },
    async send(id: string, message: AppThreadSendV1) {
      await host.context.assertCurrent(); const thread = current(id, message.expected_revision);
      const references = message.context_refs.filter((ref): ref is Extract<typeof ref, { kind: 'thread' }> => ref.kind === 'thread');
      const history = references.length ? await host.history().load() : null;
      const threadContext = references.map(reference => {
        const referenced = read(reference.thread_id);
        if (referenced.revision !== reference.revision) throw new ThreadFault(409, 'context_revision_conflict');
        return { reference, entries: history!.entries.filter(entry => entry.ownerId === principal && entry.chatId === referenced.conversation_ref) };
      });
      const contextSnapshots = await Promise.all(threadContext.map(async item => ({ threadId: item.reference.thread_id, revision: item.reference.revision,
        leafId: item.entries.at(-1)?.id ?? null, digest: await sha256Prefixed(stableJson(item.entries)) })));
      await host.context.assertCurrent(); current(id, thread.revision);
      for (const reference of references) if (read(reference.thread_id).revision !== reference.revision) throw new ThreadFault(409, 'context_revision_conflict');
      // The host resolves source/file refs under current owner access before durable admission.
      // It must stamp conversation and thread revision in the inbox; refs never grant access.
      const assertThreadCurrent = () => {
        current(id, thread.revision);
        for (const reference of references) if (read(reference.thread_id).revision !== reference.revision) throw new ThreadFault(409, 'context_revision_conflict');
      };
      const result = await host.admitMessage({ threadId: id, conversationRef: thread.conversation_ref, revision: thread.revision, message, threadContext, contextSnapshots, assertThreadCurrent });
      await host.context.assertCurrent(); current(id, thread.revision); return result;
    },
  };
}

const boundedJson = async (request: Request): Promise<unknown> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new ThreadFault(400, 'invalid_body');
  if (!request.body) throw new ThreadFault(400, 'invalid_body');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength;
    if (count > APP_SEND_MAX_WIRE_BYTES) { await reader.cancel(); throw new ThreadFault(413, 'body_too_large'); } chunks.push(part.value); }
  const bytes = new Uint8Array(count); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ThreadFault(400, 'invalid_body'); }
};
export async function appThreadsRequest(request: Request, host: AppThreadsHost): Promise<Response | null> {
  const url = new URL(request.url);
  const operationMatch = /^\/app\/v1\/threads\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
  const match = /^\/app\/v1\/threads(?:\/(thr_[0-9a-f-]+)(?:\/(archive|delete|cancel|messages|events)(?:\/([A-Za-z0-9_-]+))?)?)?$/.exec(url.pathname);
  if (operationMatch) {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    if ([...url.searchParams.keys()].length || !appThreadCreateV1Schema.shape.operation_id.safeParse(operationMatch[1]).success) return reply({ error: 'invalid_query' }, 400);
    try { return reply(await appThreads(host).operation(operationMatch[1]!)); }
    catch (error) { return error instanceof ThreadFault ? reply({ error: error.code }, error.status) : reply({ error: 'unavailable' }, 503); }
  }
  if (!match) return url.pathname === '/app/v1/threads' || url.pathname.startsWith('/app/v1/threads/') ? reply({ error: 'not_found' }, 404) : null;
  try {
    await host.context.assertCurrent(); const controller = appThreads(host), id = match[1], action = match[2], messageId = match[3];
    if (id && !appThreadIdV1Schema.safeParse(id).success) throw new ThreadFault(404, 'thread_not_found');
    if (request.method === 'GET' && id && action === 'messages' && messageId) {
      if ([...url.searchParams.keys()].length || !appThreadMessageIdV1Schema.safeParse(messageId).success) throw new ThreadFault(400, 'invalid_query');
      return reply(await controller.messageReceipt(id, messageId));
    }
    if (messageId) throw new ThreadFault(404, 'not_found');
    if (request.method === 'GET' && id && action === 'events') {
      if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new ThreadFault(400, 'invalid_query');
      const query = appReplayQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) throw new ThreadFault(400, 'invalid_query');
      return reply(await controller.replay(id, query.data.cursor ?? null, query.data.limit ?? 50));
    }
    if (request.method === 'GET' && !action) {
      const raw = Object.fromEntries(url.searchParams);
      if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new ThreadFault(400, 'invalid_query');
      if (!id) { const parsed = appThreadListQueryV1Schema.safeParse(raw); if (!parsed.success) throw new ThreadFault(400, 'invalid_query'); return reply(await controller.list(parsed.data.state)); }
      const parsed = appThreadReadQueryV1Schema.safeParse(raw); if (!parsed.success) throw new ThreadFault(400, 'invalid_query');
      return reply(await controller.read(id, parsed.data.cursor ?? null, parsed.data.limit));
    }
    if (request.method !== 'POST' || (id && (!action || action === 'events'))) throw new ThreadFault(405, 'method_not_allowed');
    if ([...url.searchParams.keys()].length) throw new ThreadFault(400, 'invalid_query');
    const raw = await boundedJson(request);
    if (!id) { const parsed = appThreadCreateV1Schema.safeParse(raw); if (!parsed.success) throw new ThreadFault(400, 'invalid_body'); return reply(await controller.create(parsed.data)); }
    if (action === 'archive') { const parsed = appThreadArchiveV1Schema.safeParse(raw); if (!parsed.success) throw new ThreadFault(400, 'invalid_body'); return reply(await controller.archive(id, parsed.data)); }
    if (action === 'messages') { const parsed = appThreadSendV1Schema.safeParse(raw); if (!parsed.success) throw new ThreadFault(400, 'invalid_body'); return reply(await controller.send(id, parsed.data), 202); }
    const parsed = appThreadDeleteV1Schema.safeParse(raw); if (!parsed.success) throw new ThreadFault(400, 'invalid_body');
    return reply(await (action === 'delete' ? controller.delete(id, parsed.data) : controller.cancel(id, parsed.data)));
  } catch (error) { if (error instanceof ThreadFault) return reply({ error: error.code }, error.status); return reply({ error: 'unavailable' }, 503); }
}
