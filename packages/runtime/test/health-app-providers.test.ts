import { describe, expect, it } from 'vitest';
import { APP_PROVIDERS_PATH, handleAppHealthProviders } from '../src/health/providers/app-providers';

const SECRET = 'fictional-router-secret-00000000000000000';
const connect = { request_id: 'provider-connect-1', provider: 'whoop' };

// The owner object's answer to the Worker, scripted per operation.
const run = async (method: string, route: string, over: { body?: unknown; headers?: Record<string, string>; answer?: (op: string) => Response | Promise<Response>; secret?: string | undefined; query?: string; recent?: boolean } = {}) => {
  const sent: { op: string; text: string; doName: string }[] = [];
  const owners = { idFromName: (name: string) => name as never, get: (name: never) => ({ fetch: async (request: Request) => {
    sent.push({ op: request.headers.get('x-waldo-provider-op')!, text: await request.text(), doName: name as string });
    return (over.answer ?? (() => Response.json({})))(request.headers.get('x-waldo-provider-op')!);
  } }) };
  const url = new URL(`https://w.test${APP_PROVIDERS_PATH}${route}${over.query ?? ''}`);
  const response = await handleAppHealthProviders({
    request: new Request(url, { method, headers: { 'x-waldo-app-contract': 'health=2', ...(over.body === undefined ? {} : { 'content-type': 'application/json' }), ...over.headers }, ...(over.body === undefined ? {} : { body: typeof over.body === 'string' ? over.body : JSON.stringify(over.body) }) }),
    url, doName: 'owner-1', owners: owners as never, secret: 'secret' in over ? over.secret : SECRET, signedInRecently: async () => over.recent ?? true,
  });
  return { response, sent, json: await response.clone().json().catch(() => null) };
};
const status = { provider: 'whoop', state: 'connected', last_sync_at: '2026-10-21T06:00:00.000Z' };

describe('the app provider routes', () => {
  it('lists each provider\'s state from the owner object, for the authenticated owner only', async () => {
    const { response, json, sent } = await run('GET', '', { answer: () => Response.json({ providers: [status] }) });
    expect([response.status, json]).toEqual([200, { providers: [status] }]);
    expect(sent).toEqual([{ op: 'status', text: '{}', doName: 'owner-1' }]);
  });

  it('starts a connection and answers with the provider\'s page and an expiry', async () => {
    const answer = { provider: 'whoop', authorize_url: 'https://api.prod.whoop.com/oauth/oauth2/auth?client_id=x&state=AbCd1234', expires_at: 1_790_000_000_000 };
    const { response, json, sent } = await run('POST', '/connect', { body: connect, headers: { 'idempotency-key': connect.request_id }, answer: () => Response.json(answer) });
    expect([response.status, json]).toEqual([200, answer]);
    expect(sent[0]).toMatchObject({ op: 'connect', text: '{}' });
  });

  it('starts no connection for a session signed in over two hours ago, and still disconnects for it', async () => {
    const { response, json, sent } = await run('POST', '/connect', { body: connect, recent: false });
    expect([response.status, json, sent]).toEqual([403, { error: 'step_up_required' }, []]);
    const off = await run('POST', '/disconnect', { body: connect, recent: false, answer: () => Response.json({ provider: 'whoop', state: 'not_connected', revoked_at_provider: true }) });
    expect(off.response.status).toBe(200);
  });

  it('disconnects and answers with the state and whether WHOOP confirmed', async () => {
    const answer = { provider: 'whoop', state: 'not_connected', revoked_at_provider: true };
    const { response, json } = await run('POST', '/disconnect', { body: connect, answer: () => Response.json(answer) });
    expect([response.status, json]).toEqual([200, answer]);
  });

  it('names the reason a connection cannot start, in closed codes', async () => {
    const refused = (error: string, status: number) => () => Response.json({ error }, { status });
    expect((await run('POST', '/connect', { body: connect, answer: refused('consent_required', 403) })).json).toEqual({ error: 'consent_required' });
    const missing = (list: unknown) => () => Response.json({ error: 'consent_required', missing: list }, { status: 403 });
    expect((await run('POST', '/connect', { body: connect, answer: missing(['model_processing']) })).json).toEqual({ error: 'consent_required', missing: ['model_processing'] });
    expect((await run('POST', '/connect', { body: connect, answer: missing(['storage_compute', 'model_processing']) })).json).toEqual({ error: 'consent_required', missing: ['storage_compute', 'model_processing'] });
    expect((await run('POST', '/connect', { body: connect, answer: missing(['provider_terms', 'a token']) })).json).toEqual({ error: 'consent_required' });
    expect((await run('POST', '/connect', { body: connect, answer: refused('not_configured', 503) })).json).toEqual({ error: 'not_configured' });
    const odd = await run('POST', '/connect', { body: connect, answer: refused('something internal with detail', 500) });
    expect([odd.response.status, odd.json]).toEqual([503, { error: 'unavailable' }]);
  });

  it('refuses a request that does not fit the contract before it reaches the owner object', async () => {
    const bad: { method: string; route: string; body?: unknown; headers?: Record<string, string> }[] = [
      { method: 'POST', route: '/connect', body: { ...connect, provider: 'oura' } },
      { method: 'POST', route: '/connect', body: { ...connect, owner_id: 'someone-else' } },
      { method: 'POST', route: '/connect', body: { provider: 'whoop' } },
      { method: 'POST', route: '/disconnect', body: 'not json' },
      { method: 'POST', route: '/connect', body: connect, headers: { 'idempotency-key': 'another-key-01' } },
      { method: 'POST', route: '/connect', body: connect, headers: { 'content-type': 'text/plain' } },
      { method: 'POST', route: '/connect', body: { ...connect, pad: 'x'.repeat(2_000) } },
    ];
    for (const { method, route, ...over } of bad) {
      const { response, sent } = await run(method, route, over);
      expect([JSON.stringify(over.body).slice(0, 40), response.status, sent.length]).toEqual([JSON.stringify(over.body).slice(0, 40), 400, 0]);
    }
  });

  it('refuses the wrong method or path, and a build that does not name health revision 2, without calling the owner object', async () => {
    for (const [method, route] of [['POST', ''], ['GET', '/connect'], ['PUT', '/connect'], ['GET', '/other']] as const) {
      const { response, sent } = await run(method, route, { body: method === 'POST' ? connect : undefined });
      expect([method, route, response.status >= 400, sent.length]).toEqual([method, route, true, 0]);
    }
    for (const header of ['health=1', 'approvals=2', '']) {
      const { response, sent } = await run('GET', '', { headers: { 'x-waldo-app-contract': header } });
      expect([header, response.status, sent.length]).toEqual([header, 404, 0]);
    }
    expect((await run('GET', '', { query: '?x=1' })).response.status).toBe(405);
  });

  it('answers unavailable when the owner object is unreachable, answers in a shape the contract does not declare, or the Worker has no signing secret', async () => {
    expect((await run('GET', '', { answer: () => { throw new Error('away'); } })).response.status).toBe(503);
    const drifted = await run('GET', '', { answer: () => Response.json({ providers: [{ provider: 'whoop', state: 'syncing', last_sync_at: null }] }) });
    expect([drifted.response.status, drifted.json]).toEqual([503, { error: 'unavailable' }]);
    expect((await run('GET', '', { secret: undefined })).response.status).toBe(503);
  });
});
