import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_CALENDAR_MAX_REQUEST_BYTES_V1 } from '../../contracts/src/app/device-context';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// The Worker's side of the phone-calendar routes: off unless DEVICE_CALENDAR is "1", a credential before anything, its own
// budget, a size bound, and a forward to the session owner's object, which answers. Synthetic credential and owner.
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const forwarded: Request[] = [];
const limiterKeys: string[] = [];
const env = (deviceCalendar?: string) => ({
  ...(deviceCalendar === undefined ? {} : { DEVICE_CALENDAR: deviceCalendar }),
  OWNER_DO: { idFromName: (n: string) => n, get: (name: string) => ({ fetch: async (request: Request) => { forwarded.push(request); return Response.json({ owner: name }); } }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { limiterKeys.push(key); return { success: true }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret-00000000000000000',
}) as never;
const call = (path: string, init: RequestInit = {}, on = '1') => handleApp(new Request(`https://w.test${path}`, { ...init, headers: { authorization: `Bearer ${CREDENTIAL}`, ...init.headers as Record<string, string> } }), env(on), auth) as Promise<Response>;
afterEach(() => { forwarded.length = 0; limiterKeys.length = 0; vi.restoreAllMocks(); });

describe('app phone-calendar routes', () => {
  it('are not there while DEVICE_CALENDAR is off', async () => {
    for (const off of [undefined, '0', '']) expect((await handleApp(new Request('https://w.test/app/v1/device/calendar/consents', { headers: { authorization: `Bearer ${CREDENTIAL}` } }), env(off), auth))!.status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it('need a credential, and forward to the session owner\'s object on their own budget', async () => {
    expect((await handleApp(new Request('https://w.test/app/v1/device/calendar'), env('1'), auth))!.status).toBe(401);
    const response = await call('/app/v1/device/calendar', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'dcal-0001-abcd' }, body: '{"request_id":"dcal-0001-abcd"}' });
    expect(await response.json()).toEqual({ owner: 'owner-1' });
    expect(limiterKeys).toEqual(['app-device-calendar:owner-1']);
    const [request] = forwarded;
    expect([request!.method, new URL(request!.url).pathname, request!.headers.get('x-waldo-do-name'), request!.headers.get('idempotency-key')]).toEqual(['POST', '/app/v1/device/calendar', 'owner-1', 'dcal-0001-abcd']);
    expect(await request!.text()).toBe('{"request_id":"dcal-0001-abcd"}');
  });

  it('refuses a body past the snapshot bound before it reaches the object, and any method but GET and POST', async () => {
    expect((await call('/app/v1/device/calendar', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(DEVICE_CALENDAR_MAX_REQUEST_BYTES_V1 + 1) }, body: 'x' })).status).toBe(413);
    expect((await call('/app/v1/device/calendar', { method: 'DELETE' })).status).toBe(405);
    expect(forwarded).toEqual([]);
  });
});
