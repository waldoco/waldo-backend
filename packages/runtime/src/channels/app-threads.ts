import {
  APP_THREAD_MAX_V1, appThreadArchiveV1Schema, appThreadCreateV1Schema, appThreadDeleteV1Schema, appThreadIdV1Schema, appThreadListQueryV1Schema,
  appThreadReadQueryV1Schema, appThreadRenameV1Schema, appThreadSendV1Schema, type AppThreadOperationResultV1, type AppThreadV1,
} from '../../../contracts/src/app/threads';
import { sha256Hex, stableJson } from '../context-composer/canonical';
import { APP_THREADS_PATH, type appTranscriptPage } from './app-api';

// The owner's chats beside main, held in the owner object: one KV record per thread and one per operation. A deleted
// thread keeps its record as a tombstone, so a read answers 410 and its operations still replay.
const THREAD = 'app:thread:', OPERATION = 'app:thread-op:';
type ThreadState = AppThreadV1['state'];
export type ThreadRecord = Readonly<{ thread_id: string; title: string | null; revision: number; title_revision: number; state: ThreadState; created_at: number; last_activity_at: number }>;
type OperationRecord = Readonly<{ digest: string; result: AppThreadOperationResultV1 }>;
type Admitted = Readonly<{ kind: 'admitted' | 'duplicate'; record: Readonly<{ id: string; state: string }> }> | Readonly<{ kind: 'conflict' | 'capacity' }>;

// A thread's conversation is its own chain, owner:<principal>:<thread id>; main's is owner:<principal>.
export const threadChainRef = (principal: string, thread: string) => `owner:${principal}:${thread}`;
export const threadOfChain = (conversationRef: string): string | null => {
  const [owner, principal, thread, ...rest] = conversationRef.split(':');
  return owner === 'owner' && principal && rest.length === 0 && appThreadIdV1Schema.safeParse(thread).success ? thread! : null;
};
export const threadRecord = (kv: Pick<DurableObjectStorage['kv'], 'get'>, thread: string) => kv.get<ThreadRecord>(THREAD + thread);
// A thread's canonical rows: its conv rows and their witnesses.
export const threadRowsPrefix = (principal: string, thread: string) => `canonical-owner-v1:${principal}:ten_${principal.slice('prn_'.length)}:thread:${thread}:`;
// Which past messages per-turn recall may bring into a chain's turn: a thread's turn only those written on that thread, any
// other turn none written on a thread. A row's witness names the chain it was written on. Without an app principal there are
// no threads.
export const recallReach = (kv: Pick<DurableObjectStorage['kv'], 'get' | 'list'>, principal: string | undefined, thread: string | null): (entryId: string) => boolean => {
  const onThread = (id: string, rows: string) => kv.get(`${rows}witness:${id}`) !== undefined;
  if (!principal) return () => thread === null;
  if (thread) return id => onThread(id, threadRowsPrefix(principal, thread));
  return id => ![...kv.list<ThreadRecord>({ prefix: THREAD })].some(([, record]) => onThread(id, threadRowsPrefix(principal, record.thread_id)));
};
// After a thread message's turn, the thread shows that it moved; the time only ever moves forward.
export const touchThread = (kv: Pick<DurableObjectStorage['kv'], 'get' | 'put'>, thread: string, at: number) => {
  const record = kv.get<ThreadRecord>(THREAD + thread);
  if (record && record.state !== 'deleted' && at > record.last_activity_at) kv.put(THREAD + thread, { ...record, last_activity_at: at });
};

export type AppThreadsHost = Readonly<{
  storage: Readonly<{ kv: Pick<DurableObjectStorage['kv'], 'get' | 'put' | 'list'>; transactionSync<T>(work: () => T): T }>;
  now(): number;
  principal: string;
  messages: Readonly<{
    // Admits a message into the owner's inbox; `assertCurrent` runs inside the admission and throws to refuse it.
    admit(conversationRef: string, clientId: string, text: string, assertCurrent: () => void, revision: number): Promise<Admitted>;
    receipt(conversationRef: string, clientId: string): unknown;
    cancel(conversationRef: string, clientId: string): unknown;
    history(thread: string, cursor: string | null, limit: number): Promise<ReturnType<typeof appTranscriptPage>>;
    preview(thread: string): string | null;
    // Erases the thread's transcript, recall, earlier tool results and messages inside the delete's transaction, and
    // answers how many messages went.
    erase(thread: string): number;
    // Stops the thread's running reply now; its own fence would stop it at its next step anyway.
    stop(thread: string): void;
  }>;
}>;

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const problem = (status: number, error: string) => answer({ error }, status);
const view = (host: AppThreadsHost, thread: ThreadRecord): AppThreadV1 => ({ ...thread, preview: host.messages.preview(thread.thread_id) });
const threads = (host: AppThreadsHost) => [...host.storage.kv.list<ThreadRecord>({ prefix: THREAD })].map(([, thread]) => thread);
const bodyOf = async (request: Request): Promise<unknown> => { try { return await request.json(); } catch { return undefined; } };
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

class ThreadRefusal extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const refusal = (thread: ThreadRecord | undefined): ThreadRefusal | null =>
  !thread ? new ThreadRefusal(404, 'thread_not_found') : thread.state === 'deleted' ? new ThreadRefusal(410, 'thread_deleted') : null;

type Outcome = Readonly<{ thread: ThreadRecord; erase?: boolean }> | Readonly<{ status: number; error: string }>;
// An operation commits with its record, so repeating it returns its first result and a different request under the same
// id is refused. A refused operation records nothing, so the client may retry it once the conflict is resolved.
const operate = async (host: AppThreadsHost, route: string, threadId: string | null, body: Readonly<{ operation_id: string }>, apply: (now: number) => Outcome): Promise<Response> => {
  const digest = await sha256Hex(stableJson({ route, thread_id: threadId, body }));
  return host.storage.transactionSync(() => {
    const prior = host.storage.kv.get<OperationRecord>(OPERATION + body.operation_id);
    if (prior) return prior.digest === digest ? answer(prior.result) : problem(409, 'operation_conflict');
    const outcome = apply(host.now());
    if ('error' in outcome) return problem(outcome.status, outcome.error);
    const { thread } = outcome;
    host.storage.kv.put(THREAD + thread.thread_id, thread);
    const erased = outcome.erase ? host.messages.erase(thread.thread_id) : undefined;
    const result: AppThreadOperationResultV1 = { operation_id: body.operation_id, state: 'recorded', thread_id: thread.thread_id, revision: thread.revision,
      title_revision: thread.title_revision, thread_state: thread.state, ...(erased === undefined ? {} : { erased_messages: erased }) };
    host.storage.kv.put(OPERATION + body.operation_id, { digest, result } satisfies OperationRecord);
    return answer(result);
  });
};
const existing = (host: AppThreadsHost, threadId: string, change: (thread: ThreadRecord) => Outcome) => (): Outcome => {
  const thread = host.storage.kv.get<ThreadRecord>(THREAD + threadId);
  const refused = refusal(thread);
  return refused ? { status: refused.status, error: refused.code } : change(thread!);
};

const messages = async (request: Request, host: AppThreadsHost, id: string, rest: readonly string[]): Promise<Response> => {
  const ref = threadChainRef(host.principal, id);
  if (rest.length === 0) {
    if (request.method !== 'POST') return problem(405, 'method_not_allowed');
    const sent = appThreadSendV1Schema.safeParse(await bodyOf(request));
    if (!sent.success) return problem(400, 'invalid_request');
    const { client_message_id: clientId, text, expected_revision: expected } = sent.data;
    let result: Admitted;
    try {
      result = await host.messages.admit(ref, clientId, text, () => {
        const thread = host.storage.kv.get<ThreadRecord>(THREAD + id);
        const refused = refusal(thread);
        if (refused) throw refused;
        if (thread!.state === 'archived') throw new ThreadRefusal(409, 'thread_archived');
        if (thread!.revision !== expected) throw new ThreadRefusal(409, 'thread_revision_conflict');
      }, expected);
    } catch (error) {
      if (error instanceof ThreadRefusal) return problem(error.status, error.code);
      throw error;
    }
    if (!('record' in result)) return problem(result.kind === 'conflict' ? 409 : 503, result.kind);
    if (result.kind === 'admitted') host.storage.transactionSync(() => touchThread(host.storage.kv, id, host.now()));
    return answer({ accepted: true, message_id: result.record.id, state: result.record.state }, 202);
  }
  const [clientId, verb, ...more] = rest;
  if (!CLIENT_MESSAGE_ID.test(clientId!) || more.length || (verb !== undefined && verb !== 'cancel')) return problem(404, 'not_found');
  if (verb === undefined ? request.method !== 'GET' : request.method !== 'POST') return problem(405, 'method_not_allowed');
  const refused = refusal(host.storage.kv.get<ThreadRecord>(THREAD + id));
  if (refused) return problem(refused.status, refused.code);
  const receipt = verb === undefined ? host.messages.receipt(ref, clientId!) : host.messages.cancel(ref, clientId!);
  return receipt ? answer(receipt) : problem(404, 'message_not_found');
};

export const appThreadsRequest = async (request: Request, host: AppThreadsHost): Promise<Response> => {
  const url = new URL(request.url);
  const [first, action, ...rest] = url.pathname.slice(APP_THREADS_PATH.length).split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams);
  if (first === undefined) {
    if (request.method === 'GET') {
      const listed = appThreadListQueryV1Schema.safeParse(query);
      if (!listed.success) return problem(400, 'invalid_request');
      const wanted = listed.data.state ?? 'all';
      const shown = threads(host).filter(thread => thread.state !== 'deleted' && (wanted === 'all' || thread.state === wanted))
        .sort((a, b) => b.last_activity_at - a.last_activity_at || (a.thread_id < b.thread_id ? -1 : 1));
      return answer({ threads: shown.map(thread => view(host, thread)) });
    }
    if (request.method !== 'POST') return problem(405, 'method_not_allowed');
    const created = appThreadCreateV1Schema.safeParse(await bodyOf(request));
    if (!created.success) return problem(400, 'invalid_request');
    return operate(host, 'create', null, created.data, now => threads(host).filter(thread => thread.state !== 'deleted').length >= APP_THREAD_MAX_V1
      ? { status: 429, error: 'thread_capacity' }
      : { thread: { thread_id: `thr_${crypto.randomUUID()}`, title: created.data.title ?? null, revision: 1, title_revision: 1, state: 'active', created_at: now, last_activity_at: now } });
  }
  if (first === 'operations') {
    if (request.method !== 'GET' || action === undefined || rest.length) return problem(404, 'not_found');
    const recorded = host.storage.kv.get<OperationRecord>(OPERATION + action);
    return recorded ? answer(recorded.result) : problem(404, 'thread_not_found');
  }
  const threadId = appThreadIdV1Schema.safeParse(first);
  if (!threadId.success) return problem(404, 'not_found');
  const id = threadId.data;
  if (action === 'messages') return messages(request, host, id, rest);
  if (rest.length) return problem(404, 'not_found');
  if (action === undefined) {
    if (request.method !== 'GET') return problem(405, 'method_not_allowed');
    const page = appThreadReadQueryV1Schema.safeParse(query);
    if (!page.success) return problem(400, 'invalid_request');
    const thread = host.storage.kv.get<ThreadRecord>(THREAD + id);
    const refused = refusal(thread);
    if (refused) return problem(refused.status, refused.code);
    const history = await host.messages.history(id, page.data.cursor ?? null, page.data.limit ?? 20);
    return answer({ thread: view(host, thread!), history });
  }
  if (request.method !== 'POST' || !['rename', 'archive', 'delete'].includes(action)) return problem(404, 'not_found');
  const raw = await bodyOf(request);
  if (action === 'rename') {
    const rename = appThreadRenameV1Schema.safeParse(raw);
    if (!rename.success) return problem(400, 'invalid_request');
    return operate(host, 'rename', id, rename.data, existing(host, id, thread => thread.title_revision !== rename.data.expected_title_revision
      ? { status: 409, error: 'title_revision_conflict' }
      : { thread: { ...thread, title: rename.data.title, title_revision: thread.title_revision + 1 } }));
  }
  if (action === 'archive') {
    const archive = appThreadArchiveV1Schema.safeParse(raw);
    if (!archive.success) return problem(400, 'invalid_request');
    const state: ThreadState = archive.data.archived ? 'archived' : 'active';
    // Archiving an archived thread changes nothing, so it does not move the revision a running reply is fenced on.
    const response = await operate(host, 'archive', id, archive.data, existing(host, id, thread => thread.revision !== archive.data.expected_revision
      ? { status: 409, error: 'thread_revision_conflict' }
      : { thread: thread.state === state ? thread : { ...thread, state, revision: thread.revision + 1 } }));
    if (response.ok) host.messages.stop(id);
    return response;
  }
  const removal = appThreadDeleteV1Schema.safeParse(raw);
  if (!removal.success) return problem(400, 'invalid_request');
  const response = await operate(host, 'delete', id, removal.data, existing(host, id, thread => thread.revision !== removal.data.expected_revision
    ? { status: 409, error: 'thread_revision_conflict' }
    : { thread: { ...thread, state: 'deleted', revision: thread.revision + 1 }, erase: true }));
  if (response.ok) host.messages.stop(id);
  return response;
};
