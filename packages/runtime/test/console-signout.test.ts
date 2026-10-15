import { describe, expect, it, vi } from 'vitest';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';
import { linkCodeHash } from '../src/identity/owner-directory';

const SESSION = 'd'.repeat(32);
const COOKIE = `waldo_console=ticket; waldo_owner=do-a.${SESSION}.sig`;
const OTHER = 'e'.repeat(64);
const SECRET = 'fictional-router-secret-00000000000000000';

// The owner object as the console sees it: sign-out answers clear the console cookie; every call is recorded in order.
const owner = (answer: (request: Request) => Response) => {
  const calls: string[] = [];
  const ns = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    calls.push(request.headers.get('x-waldo-fence-sig') ? `fence:${request.headers.get('x-waldo-app-session-hash')}` : `do:${path}`);
    return request.headers.get('x-waldo-fence-sig') ? Response.json({ fenced: 1 }) : answer(request);
  } }) } as unknown as DurableObjectNamespace;
  return { ns, calls };
};
const signedOutText = () => new Response('Signed out.', { headers: { 'set-cookie': 'waldo_console=; Path=/console; Max-Age=0' } });
const auth = (calls: string[], overrides: Partial<ConsoleAuth> = {}): ConsoleAuth => ({
  readOwnerCookie: vi.fn(async () => 'do-a'),
  revokeSession: vi.fn(async (_name: string, hash: string) => { calls.push(`revoke:${hash}`); return true; }),
  listSessions: vi.fn(async () => { calls.push('list'); return [{ session: OTHER, created_at: '2026-10-15T00:00:00Z', last_seen_at: '2026-10-15T00:00:00Z' }]; }),
  signOutAll: vi.fn(async () => { calls.push('signOutAll'); return 2; }),
  ...overrides,
} as unknown as ConsoleAuth);
const post = (path: string, action: string) => new Request(`https://w.test${path}`, { method: 'POST', headers: { cookie: COOKIE }, body: new URLSearchParams({ action, csrf: 'c' }) });

describe('console sign-out ends the console session’s chat work', () => {
  it('one browser: revokes and stops this session before the owner object signs out, and clears the owner cookie', async () => {
    const own = await linkCodeHash(SESSION);
    const { ns, calls } = owner(() => signedOutText());
    const response = (await handleConsole(post('/console/action', 'session.signout'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, auth(calls)))!;
    expect(calls).toEqual([`revoke:${own}`, `fence:${own}`, 'do:/console/action']);
    expect(response.headers.get('set-cookie')).toMatch(/waldo_owner=; Path=\/console; HttpOnly; Secure; SameSite=Strict; Max-Age=0/);
  });

  it('one browser: a revoke the directory cannot confirm leaves everything signed in and says so', async () => {
    const { ns, calls } = owner(() => signedOutText());
    const failing = auth(calls, { revokeSession: vi.fn(async () => { throw new Error('session revocation unavailable'); }) });
    const legacy = (await handleConsole(post('/console/action', 'session.signout'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, failing))!;
    expect([legacy.status, await legacy.text()]).toEqual([503, 'Signing out did not finish. This browser is still signed in; go back and try again.']);
    const dashboard = (await handleConsole(post('/console/dashboard/api/v1/actions', 'session.signout'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, failing))!;
    expect(dashboard.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('everywhere: lists the sessions first and stops each one only after the owner object signed out', async () => {
    const { ns, calls } = owner(() => Response.json({ receipt: { state: 'recorded', signed_out: true } }, { headers: { 'set-cookie': 'waldo_console=; Path=/console; Max-Age=0, waldo_owner=; Path=/console; Max-Age=0' } }));
    await handleConsole(post('/console/dashboard/api/v1/actions', 'session.signout.all'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, auth(calls));
    expect(calls).toEqual(['list', 'do:/console/dashboard/api/v1/actions', `fence:${OTHER}`]);
  });

  it('everywhere: stops nothing when the owner object could not confirm the sign-out', async () => {
    const { ns, calls } = owner(() => Response.json({ receipt: { state: 'unconfirmed', message: 'Signing out everywhere did not finish.' } }));
    await handleConsole(post('/console/dashboard/api/v1/actions', 'session.signout.all'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, auth(calls));
    expect(calls).toEqual(['list', 'do:/console/dashboard/api/v1/actions']);
  });

  it('the sign-out-everywhere page stops every session the directory revoked', async () => {
    const { ns, calls } = owner(() => new Response('unused'));
    const response = (await handleConsole(new Request('https://w.test/console/signout-all', { method: 'POST', headers: { cookie: COOKIE } }), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, auth(calls)))!;
    expect(response.status).toBe(303);
    expect(calls).toEqual(['list', 'signOutAll', `fence:${OTHER}`]);
  });

  it('leaves every other console action alone', async () => {
    const { ns, calls } = owner(() => new Response(null, { status: 303, headers: { location: '/console' } }));
    await handleConsole(post('/console/action', 'timezone.set'), { OWNER_DO: ns, WALDO_ROUTER_HMAC_SECRET: SECRET }, auth(calls));
    expect(calls).toEqual(['do:/console/action']);
  });
});
