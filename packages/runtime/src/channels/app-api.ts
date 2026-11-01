import type { ConversationEntry } from '@waldo/contracts';
import { iMessageSendUrl } from './imessage/send-url';
import { APP_CONTRACT_HEADER, APP_SEND_MAX_WIRE_BYTES, appCodeRequestSchema, appContractHeaderV1Schema, appIdTokenRequestV1Schema, appIMessageLinkCodeV1Schema, appVerifyRequestV1Schema, appSendRequestV1Schema, appSessionV1Schema, type AppMessageV1 } from '../../../contracts/src/app/core';
import type { AppApprovalCards } from './approvals';
import { consoleAuth, sessionFamily, signedInRecently, type ConsoleAuth } from '../identity/console-auth';
import { readOwnerDemand } from '../health/calendar-demand-route';
import { notifyOwnerHealthSamples, notifyOwnerZoneChange } from '../health/zone-change-route';
import { linkCodeHash, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { signedRpc } from '../identity/owner-directory';
import { dailyScoresFor } from '../health/scores';
import { APP_HEALTH_PATH, handleAppHealth } from './app-health';
import { APP_CALENDAR_DAY_PATH } from './app-calendar-day';
import { appDeviceMutationResultV1Schema, appDeviceRegisterV1Schema, appDeviceRevokeV1Schema, appDevicesResultV1Schema } from '../../../contracts/src/app/devices';
import { APP_ONBOARDING_PATHS } from './app-onboarding';
import { APP_PROVIDERS_PATH, handleAppHealthProviders } from '../health/providers/app-providers';
import { fenceSession } from './session-fence';
import { CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS, CONSOLE_OTP_SEND_LIMIT, CONSOLE_OTP_VERIFY_LIMIT } from './console-signin';
import { publicOrigin, type PublicOriginEnv } from '../connectors/public-origin';
import { APP_RATING_SUFFIX } from './app-rating';
import { openSignupFor, type OpenSignupEnv } from '../identity/open-signup';

export const APP_PATH = '/app/v1';
const APP_IMESSAGE_LINK_CODE_PATH = `${APP_PATH}/channels/imessage/link-code`;
export const APP_CHAT_PATH = `${APP_PATH}/chat/main`;
export const APP_THREADS_PATH = `${APP_PATH}/threads`;
export const APP_CHAT_SEND_PATH = `${APP_CHAT_PATH}/messages`;
export const APP_APPROVALS_PATH = `${APP_PATH}/approvals`;
export const APP_APPROVAL_DECISIONS_PATH = `${APP_APPROVALS_PATH}/decisions`;
export const APP_DEVICES_PATH = `${APP_PATH}/devices`;
const MAX_BODY_BYTES = 8192;

// APP_ID_TOKEN_SIGNIN "1" serves Sign in with Apple and Google; otherwise the route answers 404 and the app offers the email code.
type AppEnv = OwnerDirectoryEnv & PublicOriginEnv & OpenSignupEnv & Readonly<{ OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit; IMESSAGE_WALDO_ADDRESS?: string; APP_ID_TOKEN_SIGNIN?: string; HEALTH_PROVISIONAL_SCORES?: string; HEALTH_TRAINING_LOAD?: string; HEALTH_COACHING?: string }>;

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
export const readBoundedBody = async (request:Request, max:number):Promise<Uint8Array|null> => {
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

// An identity token is keyed by its digest: the throttle table keeps its keys.
const admit = async (env: AppEnv, auth: ConsoleAuth, request: Request, kind: 'send' | 'verify' | 'id_token', address: string): Promise<'ok' | 'limited' | 'unavailable'> => {
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

// The app renews a day into a 30-day session and halfway through a shorter one. Only /auth/renew says so: installed apps
// read GET /session and /auth/verify with a strict parser that refuses any key they were not built with.
const renewAfter = (created: number, expires: number) => created + Math.min(24 * 60 * 60_000, Math.floor((expires - created) / 2));
const sessionView = async (auth: ConsoleAuth, doName: string, credential: string, renewal = false) => {
  const sessionId = sessionIdOf(credential);
  if (!sessionId) throw new Error('invalid session');
  const hash = await linkCodeHash(sessionId);
  const row = (await auth.listSessions(doName)).find(value => value.session === hash);
  const created = row ? Date.parse(row.created_at) : NaN, expires = row ? Date.parse(row.expires_at) : NaN;
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('expired session');
  return appSessionV1Schema.parse({ state: 'active', session_ref: `sess_${hash}`, account_ref: `acct_${await linkCodeHash(doName)}`, surface: 'app',
    absolute_expires_at: expires, ...(renewal ? { renew_after: renewAfter(created, expires) } : {}) });
};

// The installation's push registration, held in the directory's Vault custody for this session. A token goes to the
// directory once and never comes back: answers carry the device without it.
const sha256Hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const withoutDelivery = (row: unknown) => { const { delivery: _delivery, ...device } = (row ?? {}) as Record<string, unknown>; return device; };
const devicesRequest = async (request: Request, path: string, who: { doName: string; credential: string }, call: ReturnType<typeof signedRpc>): Promise<Response> => {
  const sessionId = sessionIdOf(who.credential);
  if (!call || !sessionId) return fail(503);
  const hash = await linkCodeHash(sessionId), doName = who.doName;
  const stale = () => Response.json({ error: 'conflict', code: 'stale_read' }, { status: 409, headers: { 'cache-control': 'no-store' } });
  let answer: unknown;
  if (path === APP_DEVICES_PATH) {
    if (request.method !== 'GET') return fail(405);
    try { answer = await call('app_push_list', `app.push.list.${doName}.${hash}`, { p_do_name: doName, p_session_hash: hash }); } catch { return fail(503); }
    if (answer === null) return fail(401);
    const listed = appDevicesResultV1Schema.safeParse({ devices: Array.isArray(answer) ? answer.map(withoutDelivery) : answer });
    return listed.success ? ok(listed.data) : fail(503);
  }
  if (request.method !== 'POST') return fail(405);
  const body = await readJson(request);
  if (path === `${APP_DEVICES_PATH}/register`) {
    const asked = appDeviceRegisterV1Schema.safeParse(body);
    if (!asked.success) return Response.json({ error: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'no-store' } });
    const { installation_id: installation, provider, environment, expected_device_epoch: epoch, operation_id: operation, token } = asked.data;
    try {
      answer = await call('app_push_register', `app.push.register.${doName}.${hash}.${installation}.${provider}.${environment}.${epoch}.${operation}.${await sha256Hex(token)}`,
        { p_do_name: doName, p_session_hash: hash, p_installation_id: installation, p_provider: provider, p_environment: environment, p_expected_epoch: epoch, p_operation_id: operation, p_token: token });
    } catch { return fail(503); }
  } else {
    const asked = appDeviceRevokeV1Schema.safeParse(body);
    if (!asked.success) return Response.json({ error: 'invalid_request' }, { status: 400, headers: { 'cache-control': 'no-store' } });
    const { installation_id: installation, expected_device_epoch: epoch, operation_id: operation } = asked.data;
    try { answer = await call('app_push_revoke', `app.push.revoke.${doName}.${hash}.${installation}.${epoch}.${operation}`,
      { p_do_name: doName, p_session_hash: hash, p_installation_id: installation, p_expected_epoch: epoch, p_operation_id: operation }); } catch { return fail(503); }
  }
  if (answer === null) return stale();
  const mutation = answer as { device?: unknown; result?: unknown };
  const parsed = appDeviceMutationResultV1Schema.safeParse({ device: withoutDelivery(mutation.device), result: mutation.result });
  return parsed.success ? ok(parsed.data) : fail(503);
};

// The answer to a sign-in that resolved an owner: the same session whichever way the owner proved their email.
const appSignIn = async (auth: ConsoleAuth, doName: string): Promise<Response> => {
  let credential: string | null;
  try { credential = await auth.ownerAppCredential(doName); } catch { credential = null; }
  if (!credential) return fail(503);
  // A new credential opens a 12-hour session; renewing it at once makes it a 30-day one. A directory that cannot renew
  // yet leaves the 12-hour credential.
  const sessionId = sessionIdOf(credential);
  try { credential = (sessionId ? await auth.renewAppCredential(doName, sessionId) : null) ?? credential; }
  catch { console.error(JSON.stringify({ hop: 'app_session_renew', ok: false, code: 'renew_unavailable' })); }
  try { return ok({ ...await sessionView(auth, doName, credential), credential }); } catch { return fail(503); }
};

// App sign-in and the shared main chat. Returns null for paths outside /app/v1 so the caller keeps routing.
export const handleApp = async (request: Request, env: AppEnv, auth: ConsoleAuth | null = consoleAuth(env), defer?: (work: Promise<unknown>) => void): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== APP_PATH && !url.pathname.startsWith(`${APP_PATH}/`)) return null;
  const owners = env.OWNER_DO;
  if (!auth || !owners) return fail(404);

  if (url.pathname === `${APP_PATH}/auth/code`) {
    if (request.method !== 'POST') return fail(405);
    const body = await readJson(request);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!appCodeRequestSchema.safeParse(body).success) return fail(403);
    const gate = await admit(env, auth, request, 'send', email);
    if (gate === 'limited') return fail(429);
    if (gate === 'unavailable') return fail(503);
    // Unknown addresses get the same answer; sendCode itself only emails members, holders of a matching invite and, with
    // open sign-up, anyone while a join could still fit.
    try { await auth.sendCode(email, typeof body?.invite === 'string' ? body.invite : '', openSignupFor(env, request)); } catch { return fail(503); }
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
    try { doName = await auth.verifyOrJoin(email, code, typeof body?.invite === 'string' ? body.invite : '', typeof body?.phone === 'string' ? body.phone : '', typeof body?.link === 'string' ? body.link : '', openSignupFor(env, request)); } catch { return fail(503); }
    if (!doName) return ok({ state: 'needs_invite' });
    return appSignIn(auth, doName);
  }

  if (url.pathname === `${APP_PATH}/auth/id_token`) {
    if (env.APP_ID_TOKEN_SIGNIN !== '1' || !auth.signInWithIdToken) return fail(404);
    if (request.method !== 'POST') return fail(405);
    const asked = appIdTokenRequestV1Schema.safeParse(await readJson(request));
    if (!asked.success) return fail(403);
    const { provider, id_token: token, nonce, invite, phone } = asked.data;
    const gate = await admit(env, auth, request, 'id_token', await sha256Hex(token));
    if (gate === 'limited') return fail(429);
    if (gate === 'unavailable') return fail(503);
    let signedIn: Awaited<ReturnType<NonNullable<ConsoleAuth['signInWithIdToken']>>>;
    try { signedIn = await auth.signInWithIdToken(provider, token, nonce ?? '', invite ?? '', phone ?? '', openSignupFor(env, request)); } catch { return fail(503); }
    if (signedIn.state === 'refused') {
      console.error(JSON.stringify({ hop: 'app_id_token', ok: false, code: signedIn.reason === 'token' ? 'id_token_refused' : 'id_token_no_email', provider }));
      return fail(403);
    }
    if (signedIn.state === 'needs_invite') return ok({ state: 'needs_invite' });
    if (signedIn.state === 'confirm') {
      // Each confirm emails the owner, so it spends the same per-address send budget as /auth/code.
      const sending = await admit(env, auth, request, 'send', signedIn.email);
      if (sending === 'limited') return fail(429);
      if (sending === 'unavailable') return fail(503);
      try { if (!(await auth.sendCode(signedIn.email))) return fail(503); } catch { return fail(503); }
      return ok({ state: 'confirm_with_email_code', email: signedIn.email, link: signedIn.link });
    }
    return appSignIn(auth, signedIn.doName);
  }

  const who = await authenticate(request, auth);
  if (who === 'unavailable') return fail(503);
  if (who === 'unauthenticated') return fail(401);
  if (!env.RESPONSIBILITY_RATE_LIMITER) return fail(503);
  // A link code or a provider connection outlives this session, so it needs a sign-in from the last two hours. Throws when
  // the directory cannot list the sessions.
  const signedIn = async () => { const hash = await linkCodeHash(sessionIdOf(who.credential) ?? ''); return signedInRecently((await auth.listSessions(who.doName)).find(row => row.session === hash)?.signed_in_at, Date.now()); };
  // Health uploads can arrive in long runs, so they spend their own per-owner budget and never the chat one.
  if (url.pathname === APP_HEALTH_PATH || url.pathname.startsWith(`${APP_HEALTH_PATH}/`)) {
    try { if (!(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `app-health:${who.doName}` })).success) return fail(429); } catch { return fail(503); }
    const secret = env.WALDO_ROUTER_HMAC_SECRET, doName = who.doName;
    if (url.pathname === APP_PROVIDERS_PATH || url.pathname.startsWith(`${APP_PROVIDERS_PATH}/`)) return handleAppHealthProviders({ request, url, doName, owners, secret, signedInRecently: signedIn });
    return handleAppHealth({ request, url, doName, rpc: signedRpc(env), readBody: readBoundedBody, defer, compute: dailyScoresFor(env.HEALTH_PROVISIONAL_SCORES), trainingLoad: env.HEALTH_TRAINING_LOAD === '1', coaching: env.HEALTH_COACHING === '1',
      ...(secret ? { readDemand: (range: { from: string; to: string; timezone: string }) => readOwnerDemand(owners, secret, doName, range),
        notifyZoneChange: (day: string) => notifyOwnerZoneChange(owners, secret, doName, day),
        notifySamples: () => notifyOwnerHealthSamples(owners, secret, doName),
        notifySettings: () => notifyOwnerHealthSamples(owners, secret, doName, 'settings') } : {}) });
  }
  // A stop is a control on a message already paid for, so it counts as a read, not a send. Anything but a POST already does.
  const stop = url.pathname.startsWith(`${APP_CHAT_SEND_PATH}/`) && url.pathname.endsWith('/cancel');
  const rating = url.pathname.startsWith(`${APP_CHAT_SEND_PATH}/`) && url.pathname.endsWith(APP_RATING_SUFFIX);
  const linkCode = url.pathname === APP_IMESSAGE_LINK_CODE_PATH;
  const onboarding = APP_ONBOARDING_PATHS.includes(url.pathname);
  const bucket = request.method !== 'POST' || stop || linkCode ? 'app-read' : url.pathname === APP_APPROVAL_DECISIONS_PATH ? 'app-approval-decision' : onboarding ? 'app-onboarding' : url.pathname === `${APP_PATH}/auth/renew` ? 'app-renew' : url.pathname.startsWith(APP_DEVICES_PATH) ? 'app-devices' : 'app-chat-send';
  try { if (!(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `${bucket}:${who.doName}` })).success) return fail(429); } catch { return fail(503); }

  if (url.pathname === `${APP_PATH}/session`) {
    if (request.method !== 'GET') return fail(405);
    try { return ok(await sessionView(auth, who.doName, who.credential)); } catch { return fail(503); }
  }

  if (linkCode) {
    if (request.method !== 'POST') return fail(405);
    if (!auth.issueProviderLinkCode) return fail(503);
    try {
      // With Photon, each owner texts their own assigned number; an owner not yet enrolled has none.
      // Loaded lazily: this module also runs in plain Node, where the Durable Object classes behind it cannot load.
      const { iMessageNumberView } = await import('./imessage/enrollment');
      if (!await signedIn()) return ok({ error: 'step_up_required', code: 'step_up_required' }, 403);
      const address = (await iMessageNumberView(env as never, who.doName)).number;
      if (!address) return fail(503);
      const code = await auth.issueProviderLinkCode(who.doName, 'imessage');
      if (!code) return fail(503);
      return ok(appIMessageLinkCodeV1Schema.parse({ code, text: `waldo ${code}`, address, send_url: iMessageSendUrl(address, code), expires_in_seconds: 600 }));
    } catch { return fail(503); }
  }

  if (url.pathname === `${APP_PATH}/auth/signout`) {
    if (request.method !== 'POST') return fail(405);
    const sessionId = sessionIdOf(who.credential);
    if (!sessionId) return fail(401);
    let revoked = false;
    // The device's sessions are the one in hand and those a renewal links to it: a turn admitted before a renewal still
    // runs under the earlier one, and a renewal whose answer was lost left a later one holding the device's push.
    try {
      const hash=await linkCodeHash(sessionId); const call=signedRpc(env); if(!call) return fail(503);
      const family=sessionFamily(await auth.listSessions(who.doName),hash);
      for(const session of family) if(!(await fenceSession(env,owners,who.doName,session))) return fail(503);
      for(const session of family){ const push=await call('app_push_revoke_session', `app.push.revoke-session.${who.doName}.${session}`, {p_do_name:who.doName,p_session_hash:session}); if(typeof push!=='number'||!Number.isSafeInteger(push)||push<0)return fail(503); }
      for(const session of family) revoked=await auth.revokeSession(who.doName,session)||revoked;
      if((await auth.listSessions(who.doName)).some(row=>family.includes(row.session)))return fail(503);
      for(const session of family) await fenceSession(env,owners,who.doName,session);
    } catch { return fail(503); }
    return ok({ result: revoked ? 'revoked' : 'already_gone' });
  }

  if (url.pathname === APP_DEVICES_PATH || url.pathname === `${APP_DEVICES_PATH}/register` || url.pathname === `${APP_DEVICES_PATH}/revoke`) {
    return devicesRequest(request, url.pathname, who, signedRpc(env));
  }

  if (url.pathname === `${APP_PATH}/auth/renew`) {
    if (request.method !== 'POST') return fail(405);
    const sessionId = sessionIdOf(who.credential);
    if (!sessionId) return fail(401);
    let credential: string | null;
    try { credential = await auth.renewAppCredential(who.doName, sessionId); } catch { return fail(503); }
    if (!credential) return fail(401);
    try { return ok({ ...await sessionView(auth, who.doName, credential, true), credential }); } catch { return fail(503); }
  }

  if (url.pathname === APP_CHAT_PATH || url.pathname === APP_CHAT_SEND_PATH || url.pathname.startsWith(`${APP_CHAT_SEND_PATH}/`) || url.pathname === APP_THREADS_PATH || url.pathname.startsWith(`${APP_THREADS_PATH}/`) || url.pathname === `${APP_PATH}/controls` || url.pathname === `${APP_PATH}/actions` || url.pathname.startsWith(`${APP_PATH}/actions/`) || url.pathname === APP_APPROVALS_PATH || url.pathname === APP_APPROVAL_DECISIONS_PATH || url.pathname === APP_CALENDAR_DAY_PATH || onboarding) {
    const sending = url.pathname === APP_CHAT_SEND_PATH;
    if ((rating ? request.method !== 'PUT' : !['GET', 'POST'].includes(request.method)) || ((url.pathname === APP_CHAT_PATH || url.pathname === APP_APPROVALS_PATH || url.pathname === APP_CALENDAR_DAY_PATH) && request.method !== 'GET') || ((sending || url.pathname === APP_APPROVAL_DECISIONS_PATH) && request.method !== 'POST')) return fail(405);
    const mutating = request.method === 'POST' || request.method === 'PUT';
    const maxBytes = APP_SEND_MAX_WIRE_BYTES;
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > (sending ? APP_SEND_MAX_WIRE_BYTES : maxBytes))) return fail(413);
    const body=mutating?await readBoundedBody(request,sending?APP_SEND_MAX_WIRE_BYTES:maxBytes):new Uint8Array();if(!body)return fail(413);
    const contract = request.headers.get(APP_CONTRACT_HEADER);
    const forwarded = new Request(`https://telegram-owner${url.pathname}${url.search}`, {
      method: request.method,
      headers: { 'x-waldo-do-name': who.doName, 'x-waldo-app-session-hash': await linkCodeHash(sessionIdOf(who.credential)!), 'x-waldo-app-origin': publicOrigin(env, url), 'content-type': request.headers.get('content-type') ?? 'application/json',
        ...(appContractHeaderV1Schema.safeParse(contract).success ? { [APP_CONTRACT_HEADER]: contract! } : {}) },
      ...(mutating ? { body: body } : {}),
    });
    try { return await owners.get(owners.idFromName(who.doName)).fetch(forwarded); } catch { return fail(503); }
  }
  return fail(404);
};

// `text` is the row's plain text, or for a reply with none of its own, the fallback text of every approval card presented
// for its run. `parts` is the typed form: that text, plus a part for each approval still live. A reader must ignore any part
// it cannot read and show `text`.
export type AppMessage = AppMessageV1;

// Newest-first immutable row cursor. New arrivals cannot shift an older page. The newest assistant reply
// to a run also carries the approval cards presented for that run.
const NO_CARDS: AppApprovalCards = { live: [], fallbacks: [] };
// consoleLink is the one-time console link sent in answer to a message (channels/console-link.ts), shown under the newest reply
// to it and before that reply's receipt line, which stays last.
export const appTranscriptPage = (entries: readonly ConversationEntry[], cursor: string | null, limit: number, cards: (parentId: string) => AppApprovalCards = () => NO_CARDS,
  consoleLink: (parentId: string) => string | null = () => null, rating: (messageId: string) => 'up' | 'down' | undefined = () => undefined): Readonly<{ messages: readonly AppMessage[]; next_cursor: string | null }> => {
  const shown = entries.filter((entry): entry is ConversationEntry & { role: 'user' | 'assistant' } => entry.role === 'user' || entry.role === 'assistant');
  const taken = cursor !== null && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0; // old consumers can finish an offset page
  const size = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const before = cursor?.startsWith('before:') ? shown.findIndex(entry => entry.id === cursor.slice(7)) : -1;
  const end = cursor?.startsWith('before:') ? Math.max(before, 0) : Math.max(shown.length - taken, 0);
  const start = Math.max(end - size, 0);
  const newestReply = new Map(shown.filter(entry => entry.role === 'assistant' && entry.parentId).map(entry => [entry.parentId!, entry.id]));
  const messages = shown.slice(start, end).reverse().map(entry => {
    const newest = entry.parentId && newestReply.get(entry.parentId) === entry.id ? entry.parentId : null;
    const presented = newest ? cards(newest) : NO_CARDS, link = newest ? consoleLink(newest) : null;
    // `text` keeps the receipt line at its end: a reader without the receipt part shows the line in the text, and a reader with the
    // part hides that one line, which the part repeats as its fallback byte for byte. Changing what `text` carries would change
    // what installed builds show, which the additive app.v1 rule forbids.
    // A reader that cannot parse a part shows only `text`, and a decided card is no longer a part, so a reply that presented cards is never textless.
    const stored = entry.appPayload.trim() || !presented.fallbacks.length ? entry.appPayload : presented.fallbacks.join('\n\n');
    const tail = entry.receipt && stored.endsWith(`\n\n${entry.receipt.line}`) ? `\n\n${entry.receipt.line}` : '', body = stored.slice(0, stored.length - tail.length);
    const text = link ? `${body.trim() ? `${body}\n\n` : ''}${link}${tail}` : stored;
    const operation = entry.operation ? [{ type: 'operation' as const, operation_id: entry.operation.id, state: entry.operation.state, message: text }] : [];
    const receipt = entry.receipt ? [{ type: 'receipt' as const, items: [...entry.receipt.items], more: entry.receipt.more, fallback_text: entry.receipt.line }] : [];
    const rated = entry.role === 'assistant' ? rating(entry.id) : undefined;
    return { id: entry.id, role: entry.role, text, parts: [{ type: 'text' as const, text }, ...operation, ...presented.live, ...receipt], channel: entry.surface, parent_id: entry.parentId,
      ...(entry.createdAt === undefined ? {} : { created_at: entry.createdAt }), ...(rated === undefined ? {} : { rating: rated }) };
  });
  return { messages, next_cursor: start > 0 ? `before:${shown[start]!.id}` : null };
};

// The owner's stable principal ref, independent of which surface they arrive on.
export const ownerPrincipalRef = (ownerId: string): string => `prn_${ownerId.toLowerCase().replaceAll('-', '')}`;

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
