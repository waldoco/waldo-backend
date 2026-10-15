// The console chat is the app's main chat (app.v1), reached through the console's own route. This module reads the
// app's message shape strictly enough to draw it, and keeps only the fields it draws.
export const CHAT_URL = '/console/dashboard/api/v1/chat';
export const CHAT_TEXT_MAX = 4000;
const HEADERS = { Accept: 'application/json', 'x-waldo-console': '1' } as const;

export type ChatReceiptItem = { kind: string; target: string | null; outcome: 'accepted' | 'failed' | 'unconfirmed'; at: number };
export type ChatStepState = 'done' | 'current' | 'todo';
// Structured content Waldo showed beside its words. Every field is the model's own text, drawn as text, never as markup.
export type ChatView =
  | { kind: 'options'; title: string | null; items: { title: string; subtitle: string | null; facts: { label: string; value: string }[]; note: string | null; link: string | null; pick: boolean }[] }
  | { kind: 'table'; title: string | null; columns: string[]; rows: string[][] }
  | { kind: 'steps'; title: string | null; items: { title: string; detail: string | null; state: ChatStepState | null }[] }
  | { kind: 'timeline'; title: string | null; items: { when: string; title: string; detail: string | null }[] };
export type ChatPart =
  | { type: 'quick_replies'; choices: { id: string; label: string }[] }
  | { type: 'approval'; approval_id: string; kind: string; review: string; question: string | null; expires_at: number; fallback_text: string }
  | { type: 'receipt'; items: ChatReceiptItem[]; more: number; fallback_text: string }
  | { type: 'operation'; state: RunState }
  | { type: 'artifact'; title: string }
  | { type: 'view'; view: ChatView; fallback_text: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; parts: ChatPart[]; channel: string; parent_id: string | null; created_at: number | null };
export type ChatPage = { messages: ChatMessage[]; next_cursor: string | null };
export type RunState = 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked';
export type ChatReceipt = { message_id: string; state: RunState; closed_reason: string | null; effects_unconfirmed: boolean };

export class ChatSignInRequired extends Error { constructor() { super('Sign in to chat with Waldo.'); } }
// status 0 is the network; retryAfter is in seconds when the server named one.
export class ChatRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null, readonly retryAfter: number | null = null) { super(message); }
}

const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const RUN_STATES: readonly RunState[] = ['admitted', 'running', 'completed', 'interrupted', 'revoked'];
const runState = (v: unknown): v is RunState => RUN_STATES.includes(v as RunState);
const epoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const words = (v: unknown): v is string => str(v) && v.trim() !== '';
const optional = (v: unknown): string | null => (words(v) ? v : null);
const entries = <T>(v: unknown, read: (item: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? v.flatMap(item => { const out = obj(item) ? read(item) : null; return out === null ? [] : [out]; }) : [];
// Only a link the owner can open as given: https, no spaces, and one the browser parses. Anything else is left off,
// never repaired, so drawing it can never throw.
const openable = (v: unknown): string | null => {
  if (!str(v) || !/^https:\/\/[^\s<>"]+$/.test(v)) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
};
const STEP_STATES: readonly ChatStepState[] = ['done', 'current', 'todo'];

const readView = (raw: unknown): ChatView | null => {
  if (!obj(raw)) return null;
  const title = optional(raw.title);
  if (raw.kind === 'options') {
    const items = entries(raw.items, item => words(item.title) ? {
      title: item.title, subtitle: optional(item.subtitle), note: optional(item.note), link: openable(item.link), pick: item.pick === true,
      facts: entries(item.facts, fact => words(fact.label) && words(fact.value) ? { label: fact.label, value: fact.value } : null),
    } : null);
    return items.length ? { kind: 'options', title, items } : null;
  }
  if (raw.kind === 'table' && Array.isArray(raw.columns) && raw.columns.every(words) && raw.columns.length > 0 && Array.isArray(raw.rows)) {
    const columns = raw.columns as string[];
    const rows = raw.rows.filter((row): row is string[] => Array.isArray(row) && row.length === columns.length && row.every(str));
    return rows.length ? { kind: 'table', title, columns, rows } : null;
  }
  if (raw.kind === 'steps') {
    const items = entries(raw.items, item => words(item.title) ? { title: item.title, detail: optional(item.detail), state: STEP_STATES.includes(item.state as ChatStepState) ? item.state as ChatStepState : null } : null);
    return items.length ? { kind: 'steps', title, items } : null;
  }
  if (raw.kind === 'timeline') {
    const items = entries(raw.items, item => words(item.when) && words(item.title) ? { when: item.when, title: item.title, detail: optional(item.detail) } : null);
    return items.length ? { kind: 'timeline', title, items } : null;
  }
  return null;
};

// A part this console cannot draw is dropped; the message's text always carries what it says.
const readPart = (raw: unknown): ChatPart | null => {
  if (!obj(raw)) return null;
  if (raw.type === 'quick_replies' && Array.isArray(raw.choices)) {
    const choices = raw.choices.filter((c): c is { id: string; label: string } => obj(c) && str(c.id) && str(c.label) && c.label.trim() !== '').map(c => ({ id: c.id, label: c.label }));
    return choices.length ? { type: 'quick_replies', choices } : null;
  }
  if (raw.type === 'approval' && str(raw.approval_id) && str(raw.kind) && str(raw.review) && epoch(raw.expires_at) && str(raw.fallback_text))
    return { type: 'approval', approval_id: raw.approval_id, kind: raw.kind, review: raw.review, question: str(raw.question) ? raw.question : null, expires_at: raw.expires_at, fallback_text: raw.fallback_text };
  if (raw.type === 'receipt' && Array.isArray(raw.items) && epoch(raw.more) && str(raw.fallback_text)) {
    const items = raw.items.filter((i): i is Record<string, unknown> => obj(i) && str(i.kind) && (i.target === null || str(i.target)) && ['accepted', 'failed', 'unconfirmed'].includes(String(i.outcome)) && epoch(i.at))
      .map(i => ({ kind: i.kind as string, target: i.target as string | null, outcome: i.outcome as ChatReceiptItem['outcome'], at: i.at as number }));
    return items.length ? { type: 'receipt', items, more: raw.more, fallback_text: raw.fallback_text } : null;
  }
  if (raw.type === 'operation' && runState(raw.state)) return { type: 'operation', state: raw.state };
  if (raw.type === 'artifact' && str(raw.title)) return { type: 'artifact', title: raw.title };
  if (raw.type === 'view' && str(raw.fallback_text)) { const view = readView(raw.view); return view ? { type: 'view', view, fallback_text: raw.fallback_text } : null; }
  return null;
};

export const readChatPage = (value: unknown): ChatPage => {
  if (!obj(value) || !Array.isArray(value.messages) || !(value.next_cursor === null || str(value.next_cursor))) throw new ChatRequestError(200, 'Waldo sent a conversation this console cannot read. Refresh to try again.');
  const messages = value.messages.map((m): ChatMessage => {
    if (!obj(m) || !str(m.id) || (m.role !== 'user' && m.role !== 'assistant') || !str(m.text) || !Array.isArray(m.parts) || !str(m.channel) || !(m.parent_id === null || str(m.parent_id)) || !(m.created_at === undefined || epoch(m.created_at)))
      throw new ChatRequestError(200, 'Waldo sent a conversation this console cannot read. Refresh to try again.');
    return { id: m.id, role: m.role, text: m.text, parts: m.parts.map(readPart).filter((p): p is ChatPart => p !== null), channel: m.channel, parent_id: m.parent_id, created_at: m.created_at ?? null };
  });
  // The app pages newest first; the console draws oldest first.
  return { messages: messages.reverse(), next_cursor: value.next_cursor };
};

export const readReceipt = (value: unknown): ChatReceipt => {
  if (!obj(value) || value.accepted !== true || !str(value.message_id) || !runState(value.state)) throw new ChatRequestError(200, 'Waldo sent a message status this console cannot read.');
  return { message_id: value.message_id, state: value.state, closed_reason: str(value.closed_reason) ? value.closed_reason : null, effects_unconfirmed: value.effects_unconfirmed === true };
};

const CHANGED = 'This chat changed in another window. Try again.';
const BY_CODE: Record<string, string> = {
  inbox_full: 'Waldo’s inbox is full for the moment. Try again shortly.', capacity: 'Waldo’s inbox is full for the moment. Try again shortly.',
  conflict: 'This message clashed with an earlier one. Send it again.', client_message_id_reused: 'This message clashed with an earlier one. Send it again.',
  thread_archived: 'This chat is archived. Unarchive it to keep talking here.',
  thread_deleted: 'This chat was deleted.',
  thread_not_found: 'This chat doesn’t exist.',
  thread_revision_conflict: CHANGED, title_revision_conflict: CHANGED, operation_conflict: CHANGED,
  thread_capacity: 'You’ve reached the most chats Waldo keeps. Delete one you no longer need first.',
};

const failure = async (response: Response): Promise<ChatRequestError> => {
  let code: string | null = null;
  try { const body: unknown = await response.json(); if (obj(body) && str(body.code)) code = body.code; else if (obj(body) && str(body.error) && body.error !== 'unavailable') code = body.error; } catch { /* no body */ }
  const after = Number(response.headers.get('retry-after'));
  const retryAfter = Number.isFinite(after) && after > 0 ? after : null;
  // The server's code says why; the status only says how, so a code is read first (thread_capacity also arrives as 429).
  const message = (code !== null && Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : null)
    ?? (response.status === 429 ? 'Waldo is getting a lot of messages from you right now. Try again in a minute.'
      : response.status === 413 ? 'That message is too long to send.'
        : response.status === 410 ? 'This chat was deleted.'
          : response.status === 403 ? 'This browser can’t send to Waldo. Reload the console and try again.'
            : 'Waldo couldn’t be reached. Try again.');
  return new ChatRequestError(response.status, message, code, retryAfter);
};

const request = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { ...HEADERS, ...(init.headers ?? {}) } }); }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new ChatRequestError(0, 'Can’t reach Waldo. Check your connection.'); }
  if (response.status === 401) throw new ChatSignInRequired();
  if (!response.ok) throw await failure(response);
  try { return await response.json(); } catch { throw new ChatRequestError(response.status, 'Waldo sent a reply this console cannot read.'); }
};

// A conversation is main (null) or one of the owner's threads, each at its own base path.
const base = (thread: string | null) => thread === null ? CHAT_URL : `${CHAT_URL}/threads/${encodeURIComponent(thread)}`;
const pageQuery = (cursor: string | null, limit: number) => { const query = new URLSearchParams({ limit: String(limit) }); if (cursor) query.set('cursor', cursor); return query; };
const json = (body: object): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const fetchChatPage = async (cursor: string | null, limit: number, signal?: AbortSignal): Promise<ChatPage> =>
  readChatPage(await request(`${CHAT_URL}?${pageQuery(cursor, limit)}`, { signal }));
export const fetchThreadPage = async (thread: string, cursor: string | null, limit: number): Promise<{ thread: ChatThread; page: ChatPage }> => {
  const value = await request(`${base(thread)}?${pageQuery(cursor, limit)}`);
  if (!obj(value)) throw new ChatRequestError(200, 'Waldo sent a chat this console cannot read.');
  return { thread: readThread(value.thread), page: readChatPage(value.history) };
};
// A thread message names the thread revision it was written against, so archiving or deleting the thread stops it.
export const sendChatMessage = async (clientId: string, text: string, thread: string | null = null, revision?: number): Promise<ChatReceipt> => {
  const value = await request(`${base(thread)}/messages`, json({ client_message_id: clientId, text, ...(thread === null ? {} : { expected_revision: revision }) }));
  if (!obj(value) || value.accepted !== true || !str(value.message_id)) throw new ChatRequestError(202, 'Waldo took the message but its receipt was unreadable.');
  return { message_id: value.message_id, state: runState(value.state) ? value.state : 'admitted', closed_reason: null, effects_unconfirmed: false };
};
export const fetchReceipt = async (clientId: string, thread: string | null = null): Promise<ChatReceipt> => readReceipt(await request(`${base(thread)}/messages/${encodeURIComponent(clientId)}`));
export const cancelChatMessage = async (clientId: string, thread: string | null = null): Promise<ChatReceipt> => readReceipt(await request(`${base(thread)}/messages/${encodeURIComponent(clientId)}/cancel`, { method: 'POST' }));

// The owner's chats beside main. Titles and previews are owner or model text and render as plain text.
export type ChatThread = { thread_id: string; title: string | null; preview: string | null; revision: number; title_revision: number; state: 'active' | 'archived' | 'deleted'; created_at: number; last_activity_at: number };
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
export const readThread = (value: unknown): ChatThread => {
  if (!obj(value) || !str(value.thread_id) || !/^thr_[0-9a-f-]{36}$/.test(value.thread_id) || !(value.title === null || str(value.title)) || !(value.preview === null || str(value.preview))
    || !revision(value.revision) || !revision(value.title_revision) || !['active', 'archived', 'deleted'].includes(String(value.state)) || !epoch(value.created_at) || !epoch(value.last_activity_at))
    throw new ChatRequestError(200, 'Waldo sent a chat this console cannot read.');
  return { thread_id: value.thread_id, title: value.title, preview: value.preview, revision: value.revision, title_revision: value.title_revision, state: value.state as ChatThread['state'], created_at: value.created_at, last_activity_at: value.last_activity_at };
};
export const fetchThreads = async (): Promise<ChatThread[]> => {
  const value = await request(`${CHAT_URL}/threads?state=all`);
  if (!obj(value) || !Array.isArray(value.threads)) throw new ChatRequestError(200, 'Waldo sent a chat list this console cannot read.');
  return value.threads.map(readThread);
};
// A repeated operation id returns the first result, so a retry after a lost answer never acts twice.
const operate = async (path: string, body: object): Promise<string> => {
  const value = await request(path, json({ operation_id: crypto.randomUUID(), ...body }));
  if (!obj(value) || value.state !== 'recorded' || !str(value.thread_id)) throw new ChatRequestError(200, 'Waldo recorded the change but its receipt was unreadable.');
  return value.thread_id;
};
export const createThread = (title?: string): Promise<string> => operate(`${CHAT_URL}/threads`, title ? { title } : {});
export const renameThread = (thread: ChatThread, title: string): Promise<string> => operate(`${base(thread.thread_id)}/rename`, { expected_title_revision: thread.title_revision, title });
export const archiveThread = (thread: ChatThread, archived: boolean): Promise<string> => operate(`${base(thread.thread_id)}/archive`, { expected_revision: thread.revision, archived });
export const deleteThread = (thread: ChatThread): Promise<string> => operate(`${base(thread.thread_id)}/delete`, { expected_revision: thread.revision });

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const newClientId = (): string => `console-${[...crypto.getRandomValues(new Uint8Array(20))].map(byte => ALPHABET[byte % ALPHABET.length]).join('')}`;

// The text a reply shows once its typed parts are drawn. `text` ends with each view's fallback, in order, then the
// receipt line; each is taken off the end only where it is there exactly, so text a part does not repeat stays. A reply
// whose only text is its approval cards' fallbacks says nothing the cards don't.
export const visibleText = (message: ChatMessage): string => {
  let text = message.text;
  const trailing = [...message.parts.filter(part => part.type === 'receipt'), ...message.parts.filter(part => part.type === 'view').reverse()];
  for (const part of trailing) if (text.trimEnd().endsWith(part.fallback_text.trim())) text = text.trimEnd().slice(0, -part.fallback_text.trim().length);
  const approvals = message.parts.filter((p): p is Extract<ChatPart, { type: 'approval' }> => p.type === 'approval');
  if (approvals.length && text.trim() === approvals.map(a => a.fallback_text).join('\n\n').trim()) return '';
  return text.trim();
};
