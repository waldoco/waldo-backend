import type { ConversationEntry } from '@waldo/contracts';
import { consoleAuth, OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import { linkCodeHash, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS, CONSOLE_OTP_SEND_LIMIT, CONSOLE_OTP_VERIFY_LIMIT } from './console-signin';

export const APP_PATH = '/app/v1';
export const APP_CHAT_PATH = `${APP_PATH}/chat/main`;
export const APP_CHAT_SEND_PATH = `${APP_CHAT_PATH}/messages`;
const MAX_BODY_BYTES = 8192;

type AppEnv = OwnerDirectoryEnv & Readonly<{ TELEGRAM_OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;

// Errors before authentication share one shape so the app cannot learn who is invited.
const fail = (status: 401 | 403 | 404 | 405 | 413 | 429 | 503) => Response.json({ error: 'unavailable' }, { status, headers: { 'cache-control': 'no-store' } });
const ok = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
};

const bearer = (request: Request): string | null => {
  const match = /^Bearer ([^\s]{20,512})$/.exec(request.headers.get('authorization') ?? '');
  return match ? match[1]! : null;
};

// The app credential is the console session artifact itself, so the same server-side session row backs it.
// The existing validator reads that artifact from a cookie header; the bearer value is handed to it unchanged.
const asCookieRequest = (credential: string) => new Request('https://app.invalid/', { headers: { cookie: `${OWNER_COOKIE}=${credential}` } });
const sessionIdOf = (credential: string): string | null => {
  const sigDot = credential.lastIndexOf('.');
  const sessionDot = sigDot > 0 ? credential.lastIndexOf('.', sigDot - 1) : -1;
  return sessionDot > 0 ? credential.slice(sessionDot + 1, sigDot) : null;
};

const authenticate = async (request: Request, auth: ConsoleAuth): Promise<{ doName: string; credential: string } | 'unauthenticated' | 'unavailable'> => {
  const credential = bearer(request);
  if (!credential) return 'unauthenticated';
  try {
    const doName = await auth.readOwnerCookie(asCookieRequest(credential));
    return doName ? { doName, credential } : 'unauthenticated';
  } catch { return 'unavailable'; }
};

const admit = async (env: AppEnv, auth: ConsoleAuth, request: Request, kind: 'send' | 'verify', address: string): Promise<'ok' | 'limited' | 'unavailable'> => {
  if (!env.RESPONSIBILITY_RATE_LIMITER) return 'unavailable';
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    const edgeEmail = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `app-${kind}:${address}` })).success;
    const edgeIp = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `app-${kind}-ip:${ip}` })).success;
    if (!edgeEmail || !edgeIp) return 'limited';
    const limit = kind === 'send' ? CONSOLE_OTP_SEND_LIMIT : CONSOLE_OTP_VERIFY_LIMIT;
    const durable = (await auth.throttle(`${kind}:${address}`, limit, CONSOLE_AUTH_WINDOW_SECONDS)) && (await auth.throttle(`ip:${ip}`, CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS));
    return durable ? 'ok' : 'limited';
  } catch { return 'unavailable'; }
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// App sign-in and the shared main chat. Returns null for paths outside /app/v1 so the caller keeps routing.
export const handleApp = async (request: Request, env: AppEnv, auth: ConsoleAuth | null = consoleAuth(env)): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== APP_PATH && !url.pathname.startsWith(`${APP_PATH}/`)) return null;
  const owners = env.TELEGRAM_OWNER_DO;
  if (!auth || !owners) return fail(404);

  if (url.pathname === `${APP_PATH}/auth/code`) {
    if (request.method !== 'POST') return fail(405);
    const body = await readJson(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) return fail(403);
    const gate = await admit(env, auth, request, 'send', email);
    if (gate === 'limited') return fail(429);
    if (gate === 'unavailable') return fail(503);
    // Unknown addresses get the same answer; sendCode itself only emails invited members.
    try { await auth.sendCode(email, ''); } catch { return fail(503); }
    return ok({ ok: true });
  }

  if (url.pathname === `${APP_PATH}/auth/verify`) {
    if (request.method !== 'POST') return fail(405);
    const body = await readJson(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!EMAIL.test(email) || !/^\d{4,10}$/.test(code)) return fail(403);
    const gate = await admit(env, auth, request, 'verify', email);
    if (gate === 'limited') return fail(429);
    if (gate === 'unavailable') return fail(503);
    let doName: string | null;
    try { doName = await auth.verify(email, code); } catch { return fail(503); }
    if (!doName) return ok({ state: 'needs_invite' });
    let credential: string | null;
    try { credential = await auth.ownerCookie(doName); } catch { credential = null; }
    if (!credential) return fail(503);
    const sessionId = sessionIdOf(credential);
    return ok({ state: 'active', credential, session_ref: sessionId ? (await linkCodeHash(sessionId)).slice(0, 16) : null, surface: 'app' });
  }

  const who = await authenticate(request, auth);
  if (who === 'unavailable') return fail(503);
  if (who === 'unauthenticated') return fail(401);

  if (url.pathname === `${APP_PATH}/session`) {
    if (request.method !== 'GET') return fail(405);
    const sessionId = sessionIdOf(who.credential);
    return ok({ state: 'active', session_ref: sessionId ? (await linkCodeHash(sessionId)).slice(0, 16) : null, surface: 'app' });
  }

  if (url.pathname === `${APP_PATH}/auth/signout`) {
    if (request.method !== 'POST') return fail(405);
    const sessionId = sessionIdOf(who.credential);
    if (!sessionId) return fail(401);
    let revoked: boolean;
    try { revoked = await auth.revokeSession(who.doName, await linkCodeHash(sessionId)); } catch { return fail(503); }
    return ok({ result: revoked ? 'revoked' : 'already_gone' });
  }

  if (url.pathname === APP_CHAT_PATH || url.pathname === APP_CHAT_SEND_PATH) {
    const sending = url.pathname === APP_CHAT_SEND_PATH;
    if (request.method !== (sending ? 'POST' : 'GET')) return fail(405);
    const body = sending ? await request.text() : '';
    if (body.length > MAX_BODY_BYTES) return fail(413);
    if (sending) {
      if (!env.RESPONSIBILITY_RATE_LIMITER) return fail(503);
      try { if (!(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `app-chat-send:${who.doName}` })).success) return fail(429); } catch { return fail(503); }
    }
    const forwarded = new Request(`https://telegram-owner${url.pathname}${url.search}`, {
      method: request.method,
      headers: { 'x-waldo-do-name': who.doName, 'content-type': 'application/json' },
      ...(sending ? { body } : {}),
    });
    try { return await owners.get(owners.idFromName(who.doName)).fetch(forwarded); } catch { return fail(503); }
  }
  return fail(404);
};

// `text` is always the plain-text form of the row. `parts` is the typed form: v1 emits only type 'text'. Later part types (cards)
// are added without changing existing fields, and a reader must ignore any part type it does not know and fall back to `text`.
export type AppMessage = Readonly<{ id: string; role: 'user' | 'assistant'; text: string; parts: readonly Readonly<{ type: string; text?: string }>[]; channel: string; parent_id: string | null }>;

// Newest-first page over the one shared transcript. The cursor is how many rows were already returned from the newest end.
export const appTranscriptPage = (entries: readonly ConversationEntry[], cursor: string | null, limit: number): Readonly<{ messages: readonly AppMessage[]; next_cursor: string | null }> => {
  const shown = entries.filter((entry): entry is ConversationEntry & { role: 'user' | 'assistant' } => entry.role === 'user' || entry.role === 'assistant');
  const taken = cursor !== null && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
  const size = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const end = Math.max(shown.length - taken, 0);
  const start = Math.max(end - size, 0);
  const messages = shown.slice(start, end).reverse().map(entry => ({ id: entry.id, role: entry.role, text: entry.appPayload, parts: [{ type: 'text', text: entry.appPayload }], channel: entry.surface, parent_id: entry.parentId }));
  return { messages, next_cursor: start > 0 ? String(taken + messages.length) : null };
};

// App turns reuse the telegram-shaped update pipeline. The owner id the pipeline sees is a stable number derived from the owner's directory name.
export const APP_UPDATE_BASE = 8_000_000_000_000;
export const appSubjectFor = (doName: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < doName.length; i += 1) { hash ^= doName.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return 7_000_000_000_000 + hash;
};

export const parseAppSend = (raw: string): Readonly<{ clientMessageId: string; text: string }> | null => {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const { client_message_id: id, text } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id) || typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 4000 ? { clientMessageId: id, text: trimmed } : null;
};

// Replies reach the app through the transcript, so outbound sends on this channel are accepted and not delivered anywhere else.
export const appSinkCaller = () => async (method: string, body: unknown): Promise<unknown> => {
  if (method === 'sendMessage') return { message_id: 1, chat: { id: (body as { chat_id?: number }).chat_id ?? 0 } };
  return undefined;
};
