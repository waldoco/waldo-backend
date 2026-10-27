import { APP_CONTRACT_HEADER, APP_SEND_MAX_WIRE_BYTES, appContractHeaderV1Schema, appSendRequestV1Schema } from '../../../contracts/src/app/core';
import { appThreadArchiveV1Schema, appThreadCreateV1Schema, appThreadDeleteV1Schema, appThreadIdV1Schema, appThreadRenameV1Schema, appThreadSendV1Schema } from '../../../contracts/src/app/threads';
import { APP_CHAT_PATH, APP_CHAT_SEND_PATH, APP_THREADS_PATH, readBoundedBody } from './app-api';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { consoleAuth, type ConsoleAuth } from '../identity/console-auth';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { ownerCookies, ownerSessionHash } from './session-fence';
import { publicOrigin, type PublicOriginEnv } from '../connectors/public-origin';

// Chat in the console is the app's main chat and its threads, reached with the console sign-in. The console's signed owner cookie
// is a row in the same revocable session table the app bearer uses, and the owner object's app route accepts any live
// row there, so a console message is admitted, run, stored and shown exactly as an app message: one Waldo, one history.
export const CONSOLE_CHAT_PATH = '/console/dashboard/api/v1/chat';
// The dashboard sends this on every chat call. A page on another site cannot add a custom header to a credentialed
// request without a CORS preflight, which this route never answers.
export const CONSOLE_CHAT_HEADER = 'x-waldo-console';

type ChatEnv = OwnerDirectoryEnv & PublicOriginEnv & Readonly<{ OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;

const answer = (status: number, body: object, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...DASHBOARD_OVERVIEW_HEADERS, ...extra } });

// Forged requests: the cookies are SameSite=Lax, so a cross-site read could carry them; a credentialed call must also
// come from this origin and carry the console header. Origin is required on a write, since browsers always send it there.
const sameSite = (request: Request, url: URL): boolean => {
  if (request.headers.get(CONSOLE_CHAT_HEADER) !== '1') return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === url.origin;
  return request.method === 'GET';
};

type Checked = Readonly<{ safeParse(value: unknown): Readonly<{ success: boolean }> }>;
type Route = Readonly<{ target: string; bucket: 'app-read' | 'app-chat-send'; method: 'GET' | 'POST'; body?: Checked }>;
const CLIENT = /^[A-Za-z0-9_-]{8,64}$/;
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only the query keys the app route reads pass through.
const withQuery = (path: string, url: URL, keys: readonly string[]) => {
  const query = new URLSearchParams();
  for (const key of keys) { const value = url.searchParams.get(key); if (value !== null) query.set(key, value.slice(0, 600)); }
  return `${path}${query.size ? `?${query}` : ''}`;
};
// A chat's send, receipt and stop. A stop controls a message already paid for, so it spends the read budget, as in the app.
const messageRoute = (base: string, rest: readonly string[], method: string, send: Checked): Route | null => {
  const [client, action, extra] = rest;
  if (client === undefined) return method === 'POST' ? { target: base, bucket: 'app-chat-send', method: 'POST', body: send } : null;
  if (!CLIENT.test(client) || extra !== undefined) return null;
  if (action === undefined) return method === 'GET' ? { target: `${base}/${client}`, bucket: 'app-read', method: 'GET' } : null;
  return action === 'cancel' && method === 'POST' ? { target: `${base}/${client}/cancel`, bucket: 'app-read', method: 'POST' } : null;
};
// Each console chat path is one app.v1 chat route: main chat, or a thread beside it. Anything else, including the wrong
// method on a known path, has no route.
const route = (url: URL, method: string): Route | null => {
  const segments = url.pathname === CONSOLE_CHAT_PATH ? [] : url.pathname.slice(CONSOLE_CHAT_PATH.length + 1).split('/');
  const [head, id, action, ...rest] = segments;
  if (head === undefined) return method === 'GET' ? { target: withQuery(APP_CHAT_PATH, url, ['cursor', 'limit']), bucket: 'app-read', method: 'GET' } : null;
  if (head === 'messages') return messageRoute(APP_CHAT_SEND_PATH, segments.slice(1), method, appSendRequestV1Schema);
  if (head !== 'threads') return null;
  if (id === undefined) return method === 'GET' ? { target: withQuery(APP_THREADS_PATH, url, ['state']), bucket: 'app-read', method: 'GET' }
    : method === 'POST' ? { target: APP_THREADS_PATH, bucket: 'app-chat-send', method: 'POST', body: appThreadCreateV1Schema } : null;
  if (id === 'operations') return action !== undefined && OPERATION.test(action) && !rest.length && method === 'GET' ? { target: `${APP_THREADS_PATH}/operations/${action}`, bucket: 'app-read', method: 'GET' } : null;
  if (!appThreadIdV1Schema.safeParse(id).success) return null;
  const thread = `${APP_THREADS_PATH}/${id}`;
  if (action === 'messages') return messageRoute(`${thread}/messages`, rest, method, appThreadSendV1Schema);
  if (rest.length) return null;
  if (action === undefined) return method === 'GET' ? { target: withQuery(thread, url, ['cursor', 'limit']), bucket: 'app-read', method: 'GET' } : null;
  const operations: Readonly<Record<string, Checked>> = { rename: appThreadRenameV1Schema, archive: appThreadArchiveV1Schema, delete: appThreadDeleteV1Schema };
  const body = Object.hasOwn(operations, action) ? operations[action] : undefined;
  return body && method === 'POST' ? { target: `${thread}/${action}`, bucket: 'app-chat-send', method: 'POST', body } : null;
};

// Returns null for paths outside the console chat, so the caller keeps routing.
export const handleConsoleChat = async (request: Request, env: ChatEnv, auth: ConsoleAuth | null = consoleAuth(env)): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== CONSOLE_CHAT_PATH && !url.pathname.startsWith(`${CONSOLE_CHAT_PATH}/`)) return null;
  const owners = env.OWNER_DO;
  if (!auth || !owners) return answer(404, { error: 'chat_unavailable' });
  const chosen = route(url, request.method);
  if (!chosen) return route(url, request.method === 'GET' ? 'POST' : 'GET') ? answer(405, { error: 'method_not_allowed' }) : answer(404, { error: 'not_found' });
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
  if (chosen.body) {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return answer(415, { error: 'unsupported_media_type' });
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > APP_SEND_MAX_WIRE_BYTES)) return answer(413, { error: 'too_large' });
    const bytes = await readBoundedBody(request, APP_SEND_MAX_WIRE_BYTES);
    if (!bytes) return answer(413, { error: 'too_large' });
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return answer(400, { error: 'invalid_message' }); }
    if (!chosen.body.safeParse(parsed).success) return answer(400, { error: 'invalid_message' });
    body = bytes;
  }

  const contract = request.headers.get(APP_CONTRACT_HEADER);
  const forwarded = new Request(`https://telegram-owner${chosen.target}`, {
    method: chosen.method,
    headers: { 'x-waldo-do-name': doName, 'x-waldo-app-session-hash': sessionHash, 'x-waldo-app-origin': publicOrigin(env, url), 'content-type': 'application/json',
      // The contract revisions the dashboard reads, as the app passes its own.
      ...(appContractHeaderV1Schema.safeParse(contract).success ? { [APP_CONTRACT_HEADER]: contract! } : {}) },
    ...(body ? { body } : {}),
  });
  let response: Response;
  try { response = await owners.get(owners.idFromName(doName)).fetch(forwarded); } catch { return answer(503, { error: 'chat_unavailable' }); }
  // The owner object refuses a session that has ended or was revoked since the cookie check: to the console that is a sign-in.
  if (response.status === 403) return answer(401, { error: 'sign_in_required' });
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
};
