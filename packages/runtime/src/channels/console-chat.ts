import { APP_SEND_MAX_WIRE_BYTES, appSendRequestV1Schema } from '../../../contracts/src/app/core';
import { APP_CHAT_PATH, APP_CHAT_SEND_PATH, readBoundedBody } from './app-api';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { consoleAuth, type ConsoleAuth } from '../identity/console-auth';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { ownerCookies, ownerSessionHash } from './session-fence';

// Chat in the console is the app's main chat, reached with the console sign-in. The console's signed owner cookie
// is a row in the same revocable session table the app bearer uses, and the owner object's app route accepts any live
// row there, so a console message is admitted, run, stored and shown exactly as an app message: one Waldo, one history.
export const CONSOLE_CHAT_PATH = '/console/dashboard/api/v1/chat';
const CONSOLE_CHAT_SEND_PATH = `${CONSOLE_CHAT_PATH}/messages`;
// The dashboard sends this on every chat call. A page on another site cannot add a custom header to a credentialed
// request without a CORS preflight, which this route never answers.
export const CONSOLE_CHAT_HEADER = 'x-waldo-console';

type ChatEnv = OwnerDirectoryEnv & Readonly<{ OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;

const answer = (status: number, body: object, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });

// Forged requests: the cookies are SameSite=Strict already; a credentialed call must also come from this origin and
// carry the console header. Origin is required on a write, since browsers always send it there.
const sameSite = (request: Request, url: URL): boolean => {
  if (request.headers.get(CONSOLE_CHAT_HEADER) !== '1') return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === url.origin;
  return request.method === 'GET';
};

type Route = Readonly<{ target: string; bucket: 'app-read' | 'app-chat-send'; method: 'GET' | 'POST' }>;
const route = (url: URL): Route | null => {
  if (url.pathname === CONSOLE_CHAT_PATH) {
    const query = new URLSearchParams();
    for (const key of ['cursor', 'limit']) { const value = url.searchParams.get(key); if (value !== null) query.set(key, value.slice(0, 300)); }
    return { target: `${APP_CHAT_PATH}${query.size ? `?${query}` : ''}`, bucket: 'app-read', method: 'GET' };
  }
  if (url.pathname === CONSOLE_CHAT_SEND_PATH) return { target: APP_CHAT_SEND_PATH, bucket: 'app-chat-send', method: 'POST' };
  const rest = url.pathname.startsWith(`${CONSOLE_CHAT_SEND_PATH}/`) ? url.pathname.slice(CONSOLE_CHAT_SEND_PATH.length + 1) : null;
  const [client, action, extra] = rest?.split('/') ?? [];
  if (!client || !/^[A-Za-z0-9_-]{8,64}$/.test(client) || extra !== undefined) return null;
  // A stop controls a message already paid for, so it spends the read budget, as it does in the app.
  if (action === undefined) return { target: `${APP_CHAT_SEND_PATH}/${client}`, bucket: 'app-read', method: 'GET' };
  if (action === 'cancel') return { target: `${APP_CHAT_SEND_PATH}/${client}/cancel`, bucket: 'app-read', method: 'POST' };
  return null;
};

// Returns null for paths outside the console chat, so the caller keeps routing.
export const handleConsoleChat = async (request: Request, env: ChatEnv, auth: ConsoleAuth | null = consoleAuth(env)): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== CONSOLE_CHAT_PATH && !url.pathname.startsWith(`${CONSOLE_CHAT_PATH}/`)) return null;
  const owners = env.OWNER_DO;
  if (!auth || !owners) return answer(404, { error: 'chat_unavailable' });
  const chosen = route(url);
  if (!chosen) return answer(404, { error: 'not_found' });
  if (request.method !== chosen.method) return answer(405, { error: 'method_not_allowed' });
  if (!sameSite(request, url)) return answer(403, { error: 'forbidden' });

  // Two owner cookies mean another site set one (a sibling domain can, under a narrower path); never pick between them.
  if (ownerCookies(request).length > 1) return answer(401, { error: 'sign_in_required' });
  let doName: string | null;
  try { doName = await auth.readOwnerCookie(request); } catch { return answer(503, { error: 'chat_unavailable' }); }
  const sessionHash = doName ? await ownerSessionHash(request) : null;
  if (!doName || !sessionHash) return answer(401, { error: 'sign_in_required' });

  // The app's own per-owner buckets: chat from the app and the console shares one budget, sized for the app's polling.
  if (!env.RESPONSIBILITY_RATE_LIMITER) return answer(503, { error: 'chat_unavailable' });
  try { if (!(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `${chosen.bucket}:${doName}` })).success) return answer(429, { error: 'rate_limited' }, { 'retry-after': '60' }); }
  catch { return answer(503, { error: 'chat_unavailable' }); }

  let body: Uint8Array | undefined;
  if (chosen.bucket === 'app-chat-send') {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return answer(415, { error: 'unsupported_media_type' });
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > APP_SEND_MAX_WIRE_BYTES)) return answer(413, { error: 'too_large' });
    const bytes = await readBoundedBody(request, APP_SEND_MAX_WIRE_BYTES);
    if (!bytes) return answer(413, { error: 'too_large' });
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return answer(400, { error: 'invalid_message' }); }
    if (!appSendRequestV1Schema.safeParse(parsed).success) return answer(400, { error: 'invalid_message' });
    body = bytes;
  }

  const forwarded = new Request(`https://telegram-owner${chosen.target}`, {
    method: chosen.method,
    headers: { 'x-waldo-do-name': doName, 'x-waldo-app-session-hash': sessionHash, 'x-waldo-app-origin': url.origin, 'content-type': 'application/json' },
    ...(body ? { body } : {}),
  });
  let response: Response;
  try { response = await owners.get(owners.idFromName(doName)).fetch(forwarded); } catch { return answer(503, { error: 'chat_unavailable' }); }
  // The owner object refuses a session past its 12 hours or revoked since the cookie check: to the console that is a sign-in.
  if (response.status === 403) return answer(401, { error: 'sign_in_required' });
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
};
