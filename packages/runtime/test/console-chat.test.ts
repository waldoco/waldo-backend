import { describe, expect, it, vi } from 'vitest';
import { CONSOLE_CHAT_HEADER, CONSOLE_CHAT_PATH, handleConsoleChat } from '../src/channels/console-chat';
import type { ConsoleAuth } from '../src/identity/console-auth';
import { linkCodeHash } from '../src/identity/owner-directory';

const ORIGIN = 'https://w.test';
const SESSION = 'b'.repeat(32);
const COOKIE = `waldo_console=ticket; waldo_owner=owner-1.${SESSION}.sig`;

// First match, as the real reader parses it.
const firstOwnerCookie = (request: Request) => (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('waldo_owner='));
const fakeAuth = (readOwnerCookie: ConsoleAuth['readOwnerCookie'] = async (request) => (firstOwnerCookie(request) === `waldo_owner=owner-1.${SESSION}.sig` ? 'owner-1' : null)) =>
  ({ readOwnerCookie } as unknown as ConsoleAuth);
const setup = (allowed = true) => {
  const forwards: Request[] = [], keys: string[] = [];
  const env = {
    OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => { forwards.push(request); return Response.json({ forwarded: true }, { status: 202 }); } }) },
    RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allowed }; } },
  } as never;
  return { env, forwards, keys };
};
const call = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const method = init.method ?? 'GET';
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { cookie: COOKIE, [CONSOLE_CHAT_HEADER]: '1', 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...init.headers },
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
};
const send = { client_message_id: 'console-0001', text: 'What is on my calendar tomorrow?' };
const THREAD = 'thr_0b9e7f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const OPERATION = '7d4c2b1a-0e9f-4a8b-9c7d-6e5f4a3b2c1d';

describe('console chat', () => {
  it('leaves every other path to the caller', async () => {
    const { env } = setup();
    expect(await handleConsoleChat(new Request(`${ORIGIN}/console/dashboard/api/v1/overview`), env, fakeAuth())).toBeNull();
    expect(await handleConsoleChat(new Request(`${ORIGIN}/app/v1/chat/main`), env, fakeAuth())).toBeNull();
  });

  it('admits a console message on the app send path of the cookie owner, under the cookie session', async () => {
    const { env, forwards, keys } = setup();
    const response = await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send }), env, fakeAuth());
    expect(response!.status).toBe(202);
    expect(await response!.json()).toEqual({ forwarded: true });
    const forwarded = forwards[0]!;
    expect(new URL(forwarded.url).pathname).toBe('/app/v1/chat/main/messages');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('x-waldo-do-name')).toBe('owner-1');
    expect(forwarded.headers.get('x-waldo-app-session-hash')).toBe(await linkCodeHash(SESSION));
    // The app's message format, byte for byte.
    expect(JSON.parse(await forwarded.text())).toEqual(send);
    expect(keys).toEqual(['app-chat-send:owner-1']);
    expect(response!.headers.get('cache-control')).toBe('private, no-store');
  });

  it('forwards the configured public origin, not the host the console was opened on', async () => {
    const { env, forwards } = setup();
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send }), { ...(env as object), WALDO_PUBLIC_ORIGIN: 'https://staging.fixture.invalid' } as never, fakeAuth());
    expect(forwards[0]!.headers.get('x-waldo-app-origin')).toBe('https://staging.fixture.invalid');
  });

  it('reads the main chat with only the cursor and limit the app takes', async () => {
    const { env, forwards, keys } = setup();
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}?cursor=before%3Aapp-8&limit=30&owner=someone-else`), env, fakeAuth());
    const target = new URL(forwards[0]!.url);
    expect(target.pathname).toBe('/app/v1/chat/main');
    expect([...target.searchParams.keys()].sort()).toEqual(['cursor', 'limit']);
    expect(target.searchParams.get('cursor')).toBe('before:app-8');
    expect(keys).toEqual(['app-read:owner-1']);
  });

  it('maps a receipt and a stop to the app routes, on the read budget', async () => {
    const { env, forwards, keys } = setup();
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages/console-0001`), env, fakeAuth());
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages/console-0001/cancel`, { method: 'POST' }), env, fakeAuth());
    expect(forwards.map(request => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['GET /app/v1/chat/main/messages/console-0001', 'POST /app/v1/chat/main/messages/console-0001/cancel']);
    expect(keys).toEqual(['app-read:owner-1', 'app-read:owner-1']);
  });

  it('passes on the chat contract revision the dashboard reads, and drops a header that does not parse', async () => {
    const { env, forwards } = setup();
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages/console-0001`, { headers: { 'x-waldo-app-contract': 'chat=3' } }), env, fakeAuth());
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages/console-0001`, { headers: { 'x-waldo-app-contract': 'chat=two' } }), env, fakeAuth());
    await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages/console-0001`), env, fakeAuth());
    expect(forwards.map(request => request.headers.get('x-waldo-app-contract'))).toEqual(['chat=3', null, null]);
  });

  it('refuses unknown paths, odd client ids and the wrong method', async () => {
    const { env, forwards } = setup();
    for (const path of [`${CONSOLE_CHAT_PATH}/folders`, `${CONSOLE_CHAT_PATH}/threads/thr_not-a-uuid`, `${CONSOLE_CHAT_PATH}/threads/${THREAD}/pin`, `${CONSOLE_CHAT_PATH}/threads/operations/x`, `${CONSOLE_CHAT_PATH}/messages/short`, `${CONSOLE_CHAT_PATH}/messages/console-0001/rating`, `${CONSOLE_CHAT_PATH}/messages/console-0001/cancel/x`]) {
      expect((await handleConsoleChat(call(path), env, fakeAuth()))!.status).toBe(404);
    }
    expect((await handleConsoleChat(call(CONSOLE_CHAT_PATH, { method: 'POST', body: send }), env, fakeAuth()))!.status).toBe(405);
    expect((await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages`), env, fakeAuth()))!.status).toBe(405);
    expect(forwards).toHaveLength(0);
  });

  it('reaches every thread route the app has, one to one, on the app budgets', async () => {
    const { env, forwards, keys } = setup();
    const calls: [string, string, unknown?][] = [
      ['GET', `${CONSOLE_CHAT_PATH}/threads?state=archived&owner=x`],
      ['POST', `${CONSOLE_CHAT_PATH}/threads`, { operation_id: OPERATION, title: 'Goa trip' }],
      ['GET', `${CONSOLE_CHAT_PATH}/threads/operations/${OPERATION}`],
      ['GET', `${CONSOLE_CHAT_PATH}/threads/${THREAD}?cursor=before%3Aapp-3&limit=30`],
      ['POST', `${CONSOLE_CHAT_PATH}/threads/${THREAD}/rename`, { operation_id: OPERATION, expected_title_revision: 1, title: 'Goa' }],
      ['POST', `${CONSOLE_CHAT_PATH}/threads/${THREAD}/archive`, { operation_id: OPERATION, expected_revision: 2, archived: true }],
      ['POST', `${CONSOLE_CHAT_PATH}/threads/${THREAD}/delete`, { operation_id: OPERATION, expected_revision: 3 }],
      ['POST', `${CONSOLE_CHAT_PATH}/threads/${THREAD}/messages`, { ...send, expected_revision: 1 }],
      ['GET', `${CONSOLE_CHAT_PATH}/threads/${THREAD}/messages/console-0001`],
      ['POST', `${CONSOLE_CHAT_PATH}/threads/${THREAD}/messages/console-0001/cancel`],
    ];
    for (const [method, path, body] of calls) expect((await handleConsoleChat(call(path, { method, ...(body === undefined ? {} : { body }) }), env, fakeAuth()))!.status, path).toBe(202);
    expect(forwards.map(request => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      'GET /app/v1/threads?state=archived',
      'POST /app/v1/threads',
      `GET /app/v1/threads/operations/${OPERATION}`,
      `GET /app/v1/threads/${THREAD}?cursor=before%3Aapp-3&limit=30`,
      `POST /app/v1/threads/${THREAD}/rename`,
      `POST /app/v1/threads/${THREAD}/archive`,
      `POST /app/v1/threads/${THREAD}/delete`,
      `POST /app/v1/threads/${THREAD}/messages`,
      `GET /app/v1/threads/${THREAD}/messages/console-0001`,
      `POST /app/v1/threads/${THREAD}/messages/console-0001/cancel`,
    ]);
    expect(keys).toEqual(['app-read:owner-1', 'app-chat-send:owner-1', 'app-read:owner-1', 'app-read:owner-1', 'app-chat-send:owner-1', 'app-chat-send:owner-1', 'app-chat-send:owner-1', 'app-chat-send:owner-1', 'app-read:owner-1', 'app-read:owner-1']);
    expect(JSON.parse(await forwards[7]!.text())).toEqual({ ...send, expected_revision: 1 });
  });

  it('checks each thread write against its app schema before the owner object sees it', async () => {
    const { env, forwards } = setup();
    const status = async (path: string, body: unknown) => (await handleConsoleChat(call(path, { method: 'POST', body }), env, fakeAuth()))!.status;
    expect(await status(`${CONSOLE_CHAT_PATH}/threads/${THREAD}/messages`, send)).toBe(400);
    expect(await status(`${CONSOLE_CHAT_PATH}/threads/${THREAD}/rename`, { operation_id: OPERATION, expected_title_revision: 1, title: '' })).toBe(400);
    expect(await status(`${CONSOLE_CHAT_PATH}/threads/${THREAD}/delete`, { operation_id: 'not-a-uuid', expected_revision: 1 })).toBe(400);
    expect(await status(`${CONSOLE_CHAT_PATH}/threads`, { operation_id: OPERATION, owner: 'someone-else' })).toBe(400);
    expect((await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/threads/${THREAD}/rename`), env, fakeAuth()))!.status).toBe(405);
    expect(forwards).toHaveLength(0);
  });

  it('refuses a request another site could have made, before reading the session', async () => {
    const { env, forwards } = setup();
    const readOwnerCookie = vi.fn(async () => 'owner-1');
    const forged = [
      call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send, headers: { [CONSOLE_CHAT_HEADER]: '' } }),
      call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send, headers: { origin: 'https://evil.test' } }),
      call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send, headers: { 'sec-fetch-site': 'cross-site' } }),
      call(CONSOLE_CHAT_PATH, { headers: { 'sec-fetch-site': 'same-site' } }),
    ];
    const noOrigin = call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send });
    noOrigin.headers.delete('origin');
    for (const request of [...forged, noOrigin]) expect((await handleConsoleChat(request, env, fakeAuth(readOwnerCookie)))!.status).toBe(403);
    expect(readOwnerCookie).not.toHaveBeenCalled();
    expect(forwards).toHaveLength(0);
  });

  it('asks for sign-in without a live owner cookie and fails closed when the check is down', async () => {
    const { env, forwards } = setup();
    expect((await handleConsoleChat(call(CONSOLE_CHAT_PATH, { headers: { cookie: 'waldo_console=ticket' } }), env, fakeAuth()))!.status).toBe(401);
    expect((await handleConsoleChat(call(CONSOLE_CHAT_PATH), env, fakeAuth(async () => null)))!.status).toBe(401);
    expect((await handleConsoleChat(call(CONSOLE_CHAT_PATH), env, fakeAuth(async () => { throw new Error('down'); })))!.status).toBe(503);
    expect(forwards).toHaveLength(0);
  });

  it('refuses a second owner cookie, which only another site could have set, without choosing one', async () => {
    const { env, forwards } = setup();
    const readOwnerCookie = vi.fn(async () => 'owner-1');
    const request = call(CONSOLE_CHAT_PATH, { headers: { cookie: `waldo_owner=attacker.${'c'.repeat(32)}.sig; ${COOKIE}` } });
    expect((await handleConsoleChat(request, env, fakeAuth(readOwnerCookie)))!.status).toBe(401);
    expect(readOwnerCookie).not.toHaveBeenCalled();
    expect(forwards).toHaveLength(0);
  });

  it('turns the owner object refusing an ended session into a sign-in', async () => {
    const env = { OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ error: 'unavailable' }, { status: 403 }) }) }, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } } as never;
    const response = await handleConsoleChat(call(CONSOLE_CHAT_PATH), env, fakeAuth());
    expect([response!.status, await response!.json()]).toEqual([401, { error: 'sign_in_required' }]);
  });

  it('answers a spent budget with 429 and a retry time, and sends nothing on', async () => {
    const { env, forwards } = setup(false);
    const response = await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body: send }), env, fakeAuth());
    expect([response!.status, response!.headers.get('retry-after')]).toEqual([429, '60']);
    expect(forwards).toHaveLength(0);
  });

  it('checks the message against the app send contract before the owner object sees it', async () => {
    const { env, forwards } = setup();
    const status = async (body: unknown, headers: Record<string, string> = {}) => (await handleConsoleChat(call(`${CONSOLE_CHAT_PATH}/messages`, { method: 'POST', body, headers }), env, fakeAuth()))!.status;
    expect(await status({ ...send, owner: 'someone-else' })).toBe(400);
    expect(await status({ ...send, text: '   ' })).toBe(400);
    expect(await status({ ...send, text: 'x'.repeat(4001) })).toBe(400);
    expect(await status('{not json')).toBe(400);
    expect(await status(send, { 'content-type': 'text/plain' })).toBe(415);
    expect(await status({ ...send, text: 'x'.repeat(40_000) })).toBe(413);
    expect(forwards).toHaveLength(0);
  });

  it('is unavailable, not open, without sign-in or the owner namespace', async () => {
    const { env } = setup();
    expect((await handleConsoleChat(call(CONSOLE_CHAT_PATH), env, null))!.status).toBe(404);
    expect((await handleConsoleChat(call(CONSOLE_CHAT_PATH), {} as never, fakeAuth()))!.status).toBe(404);
  });
});
