import type { ConversationEntry } from '@waldo/contracts';
import { APP_SEND_MAX_WIRE_BYTES, appCodeRequestSchema, appVerifyRequestV1Schema, appSendRequestV1Schema, appSessionV1Schema, type AppMessageV1 } from '../../../contracts/src/app/core';
import { consoleAuth, type ConsoleAuth } from '../identity/console-auth';
import { APP_SESSION_FENCE_PATH, appSessionFenceSignature } from '../identity/app-session-fence';
import { linkCodeHash, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { signedRpc } from '../identity/owner-directory';
import { CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS, CONSOLE_OTP_SEND_LIMIT, CONSOLE_OTP_VERIFY_LIMIT } from './console-signin';

export const APP_PATH = '/app/v1';
export const APP_CHAT_PATH = `${APP_PATH}/chat/main`;
export const APP_CHAT_SEND_PATH = `${APP_CHAT_PATH}/messages`;
const MAX_BODY_BYTES = 8192;

type AppEnv = OwnerDirectoryEnv & Readonly<{ TELEGRAM_OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;

// Errors before authentication share one shape so the app cannot learn who is invited.
const fail = (status: 401 | 403 | 404 | 405 | 413 | 429 | 503) => Response.json({ error: 'unavailable' }, { status, headers: { 'cache-control': 'no-store', ...(status === 429 ? { 'retry-after': '60' } : {}) } });
const ok = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const bytes = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!bytes) return null;
  let text: string; try { text = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(bytes); } catch { return null; }
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
};
const readBoundedBody = async (request:Request, max:number):Promise<Uint8Array|null> => {
  if (!request.body) return new Uint8Array();
  const reader=request.body.getReader(), chunks:Uint8Array[]=[]; let size=0, expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel();},5000);
  try { for(;;){const part=await reader.read();if(expired)return null;if(part.done)break;size+=part.value.byteLength;if(size>max){await reader.cancel();return null;}chunks.push(part.value);} }
  catch{return null;} finally{clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}return bytes;
};

const bearer = (request: Request): string | null => {
  const match = /^Bearer ([^\s]{20,512})$/.exec(request.headers.get('authorization') ?? '');
  return match ? match[1]! : null;
};

// The app credential is its own signed artifact backed by a server-side session row; it is never a console cookie.
const sessionIdOf = (credential: string): string | null => {
  const sigDot = credential.lastIndexOf('.');
  const sessionDot = sigDot > 0 ? credential.lastIndexOf('.', sigDot - 1) : -1;
  return sessionDot > 0 ? credential.slice(sessionDot + 1, sigDot) : null;
};

const authenticate = async (request: Request, auth: ConsoleAuth): Promise<{ doName: string; credential: string } | 'unauthenticated' | 'unavailable'> => {
  const credential = bearer(request);
  if (!credential) return 'unauthenticated';
  try {
    const doName = await auth.readAppCredential(credential);
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

const sessionView = async (auth: ConsoleAuth, doName: string, credential: string) => {
  const sessionId = sessionIdOf(credential);
  if (!sessionId) throw new Error('invalid session');
  const hash = await linkCodeHash(sessionId);
  const row = (await auth.listSessions(doName)).find(value => value.session === hash);
  const created = row ? Date.parse(row.created_at) : NaN;
  if (!Number.isFinite(created) || created + 12 * 60 * 60_000 <= Date.now()) throw new Error('expired session');
  return appSessionV1Schema.parse({ state: 'active', session_ref: `sess_${hash}`, account_ref: `acct_${await linkCodeHash(doName)}`, surface: 'app', absolute_expires_at: created + 12 * 60 * 60_000 });
};

// Closes the session's queued work and stops its running turn in the owner Durable Object; false when it cannot be confirmed.
// Signout calls it before the revoke, which makes a retry safe, and again after it for work admitted in between.
const fenceSession = async (env: AppEnv, owners: NonNullable<AppEnv['TELEGRAM_OWNER_DO']>, doName: string, sessionHash: string): Promise<boolean> => {
  const secret = env.WALDO_ROUTER_HMAC_SECRET;
  if (!secret) return false;
  try {
    const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${APP_SESSION_FENCE_PATH}`, {
      method: 'POST',
      headers: { 'x-waldo-do-name': doName, 'x-waldo-app-session-hash': sessionHash, 'x-waldo-fence-sig': await appSessionFenceSignature(secret, doName, sessionHash) },
    }));
    if (response.ok) return true;
  } catch { /* reported below */ }
  console.error('app session fence unavailable');
  return false;
};

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
    if (!appCodeRequestSchema.safeParse(body).success) return fail(403);
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
    if (!appVerifyRequestV1Schema.safeParse(body).success) return fail(403);
    const gate = await admit(env, auth, request, 'verify', email);
    if (gate === 'limited') return fail(429);
    if (gate === 'unavailable') return fail(503);
    let doName: string | null;
    try { doName = await auth.verify(email, code); } catch { return fail(503); }
    if (!doName) return ok({ state: 'needs_invite' });
    let credential: string | null;
    try { credential = await auth.ownerAppCredential(doName); } catch { credential = null; }
    if (!credential) return fail(503);
    try { return ok({ ...await sessionView(auth, doName, credential), credential }); } catch { return fail(503); }
  }

  const who = await authenticate(request, auth);
  if (who === 'unavailable') return fail(503);
  if (who === 'unauthenticated') return fail(401);
  if (!env.RESPONSIBILITY_RATE_LIMITER) return fail(503);
  try { if (!(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `${request.method === 'POST' ? 'app-chat-send' : 'app-read'}:${who.doName}` })).success) return fail(429); } catch { return fail(503); }

  if (url.pathname === `${APP_PATH}/session`) {
    if (request.method !== 'GET') return fail(405);
    try { return ok(await sessionView(auth, who.doName, who.credential)); } catch { return fail(503); }
  }

  if (url.pathname === `${APP_PATH}/auth/signout`) {
    if (request.method !== 'POST') return fail(405);
    const sessionId = sessionIdOf(who.credential);
    if (!sessionId) return fail(401);
    let revoked: boolean;
    try { const hash=await linkCodeHash(sessionId); const call=signedRpc(env); if(!call) return fail(503); if(!(await fenceSession(env,owners,who.doName,hash))) return fail(503); const push=await call('app_push_revoke_session', `app.push.revoke-session.${who.doName}.${hash}`, {p_do_name:who.doName,p_session_hash:hash}); if(typeof push!=='number'||!Number.isSafeInteger(push)||push<0)return fail(503); revoked=await auth.revokeSession(who.doName,hash); if((await auth.listSessions(who.doName)).some(row=>row.session===hash))return fail(503); await fenceSession(env,owners,who.doName,hash); } catch { return fail(503); }
    return ok({ result: revoked ? 'revoked' : 'already_gone' });
  }

  if (url.pathname === APP_CHAT_PATH || url.pathname === APP_CHAT_SEND_PATH || url.pathname.startsWith(`${APP_CHAT_SEND_PATH}/`) || url.pathname === `${APP_PATH}/controls` || url.pathname === `${APP_PATH}/actions` || url.pathname.startsWith(`${APP_PATH}/actions/`)) {
    const sending = url.pathname === APP_CHAT_SEND_PATH;
    if (!['GET', 'POST'].includes(request.method) || (url.pathname === APP_CHAT_PATH && request.method !== 'GET') || (sending && request.method !== 'POST')) return fail(405);
    const mutating = request.method === 'POST';
    const maxBytes = APP_SEND_MAX_WIRE_BYTES;
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > (sending ? APP_SEND_MAX_WIRE_BYTES : maxBytes))) return fail(413);
    const body=mutating?await readBoundedBody(request,sending?APP_SEND_MAX_WIRE_BYTES:maxBytes):new Uint8Array();if(!body)return fail(413);
    const forwarded = new Request(`https://telegram-owner${url.pathname}${url.search}`, {
      method: request.method,
      headers: { 'x-waldo-do-name': who.doName, 'x-waldo-app-session-hash': await linkCodeHash(sessionIdOf(who.credential)!), 'x-waldo-app-origin': url.origin, 'content-type': request.headers.get('content-type') ?? 'application/json' },
      ...(mutating ? { body: body } : {}),
    });
    try { return await owners.get(owners.idFromName(who.doName)).fetch(forwarded); } catch { return fail(503); }
  }
  return fail(404);
};

// `text` is always the plain-text form of the row. `parts` is the typed form: v1 emits only type 'text'. Later part types (cards)
// are added without changing existing fields, and a reader must ignore any part type it does not know and fall back to `text`.
export type AppMessage = AppMessageV1;

// Newest-first immutable row cursor. New arrivals cannot shift an older page.
export const appTranscriptPage = (entries: readonly ConversationEntry[], cursor: string | null, limit: number): Readonly<{ messages: readonly AppMessage[]; next_cursor: string | null }> => {
  const shown = entries.filter((entry): entry is ConversationEntry & { role: 'user' | 'assistant' } => entry.role === 'user' || entry.role === 'assistant');
  const taken = cursor !== null && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0; // old consumers can finish an offset page
  const size = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const before = cursor?.startsWith('before:') ? shown.findIndex(entry => entry.id === cursor.slice(7)) : -1;
  const end = cursor?.startsWith('before:') ? Math.max(before, 0) : Math.max(shown.length - taken, 0);
  const start = Math.max(end - size, 0);
  const messages = shown.slice(start, end).reverse().map(entry => ({ id: entry.id, role: entry.role, text: entry.appPayload, parts: [{ type: 'text' as const, text: entry.appPayload }], channel: entry.surface, parent_id: entry.parentId }));
  return { messages, next_cursor: start > 0 ? `before:${shown[start]!.id}` : null };
};

// App turns reuse the telegram-shaped update pipeline. The owner id the pipeline sees is a stable number derived from the owner's directory name.
export const APP_UPDATE_BASE = 8_000_000_000_000;
export const appSubjectFor = (doName: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < doName.length; i += 1) { hash ^= doName.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return 7_000_000_000_000 + hash;
};

export const parseAppSend = (raw: string): (import('../../../contracts/src/app/core').AppSendV1 & Readonly<{ clientMessageId: string }>) | null => {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const parsed = appSendRequestV1Schema.safeParse(value);
  return parsed.success ? { ...parsed.data, clientMessageId: parsed.data.client_message_id } : null;
};

// Replies reach the app through the transcript, so outbound sends on this channel are accepted and not delivered anywhere else.
export const appSinkCaller = () => async (method: string, body: unknown): Promise<unknown> => {
  if (method === 'sendMessage') return { message_id: 1, chat: { id: (body as { chat_id?: number }).chat_id ?? 0 } };
  return undefined;
};
