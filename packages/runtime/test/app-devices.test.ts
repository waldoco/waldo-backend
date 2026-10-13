import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appDeviceMutationResultV1Schema, appDevicesResultV1Schema } from '../../contracts/src/app/devices';
import { handleApp } from '../src/channels/app-api';
import { consoleAuth } from '../src/identity/console-auth';
import { linkCodeHash, routerSignature } from '../src/identity/owner-directory';

const SECRET = 'fictional-devices-router-secret-0000000000', DIRECTORY = 'https://devices.fixture.invalid', NAME = 'devices-owner', SESSION = 'c'.repeat(32);
const INSTALLATION = '43000000-0000-4000-8000-000000000001', EXPO = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const env = { SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) }, TELEGRAM_OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('', { status: 500 }) }) } } as never;
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const view = (epoch: number, state: 'active' | 'revoked') => ({ installation_id: INSTALLATION, provider: 'expo', environment: 'production', device_epoch: epoch, state, registered_at: 1_791_700_000_000, delivery: 'native_ack_unverified' });
const directory = { calls: [] as { fn: string; args: Record<string, unknown> }[], answer: undefined as unknown };

beforeEach(() => {
  directory.calls = []; directory.answer = undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const fn = url.pathname.split('/').at(-1)!; const a = JSON.parse(String(init?.body)) as Record<string, string>;
    const hash = await linkCodeHash(SESSION);
    if (fn === 'console_session_touch') return Response.json(a.p_do_name === NAME && a.p_session_hash === hash);
    directory.calls.push({ fn, args: a });
    const signed: Record<string, string> = {
      app_push_list: `app.push.list.${a.p_do_name}.${a.p_session_hash}`,
      app_push_register: `app.push.register.${a.p_do_name}.${a.p_session_hash}.${a.p_installation_id}.${a.p_provider}.${a.p_environment}.${a.p_expected_epoch}.${a.p_operation_id}.${await sha256(a.p_token ?? '')}`,
      app_push_revoke: `app.push.revoke.${a.p_do_name}.${a.p_session_hash}.${a.p_installation_id}.${a.p_expected_epoch}.${a.p_operation_id}`,
    };
    expect(a.p_sig).toBe(await routerSignature(SECRET, Number(a.p_at), signed[fn]!));
    expect(a.p_session_hash).toBe(hash);
    return Response.json(directory.answer);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const credential = async () => `${NAME}.${SESSION}.${await routerSignature(SECRET, 0, `appbearer.${NAME}.${SESSION}`)}`;
const call = async (path: string, body?: unknown) => (await handleApp(new Request(`https://app.fixture.invalid/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${await credential()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, consoleAuth(env)))!;
const register = { operation_id: 'register-0001', installation_id: INSTALLATION, provider: 'expo', environment: 'production', token: EXPO, expected_device_epoch: 0 };

it('registers an Expo device for the signed-in session, and the answer never carries the token', async () => {
  directory.answer = { device: view(1, 'active'), result: 'registered' };
  const response = await call('/devices/register', register);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(appDeviceMutationResultV1Schema.parse(body)).toEqual({ device: { installation_id: INSTALLATION, provider: 'expo', environment: 'production', device_epoch: 1, state: 'active', registered_at: 1_791_700_000_000 }, result: 'registered' });
  expect(JSON.stringify(body)).not.toContain('ExponentPushToken');
  expect(directory.calls.map(c => c.fn)).toEqual(['app_push_register']);
  expect(directory.calls[0]!.args).toMatchObject({ p_do_name: NAME, p_installation_id: INSTALLATION, p_provider: 'expo', p_environment: 'production', p_expected_epoch: 0, p_operation_id: 'register-0001', p_token: EXPO });
});

it('lists and revokes the session\'s devices', async () => {
  directory.answer = [view(1, 'active')];
  const listed = await call('/devices');
  expect(listed.status).toBe(200);
  expect(appDevicesResultV1Schema.parse(await listed.json()).devices).toHaveLength(1);
  directory.answer = { device: view(2, 'revoked'), result: 'revoked' };
  const revoked = await call('/devices/revoke', { operation_id: 'revoke-00001', installation_id: INSTALLATION, expected_device_epoch: 1 });
  expect(revoked.status).toBe(200);
  expect(appDeviceMutationResultV1Schema.parse(await revoked.json()).result).toBe('revoked');
});

it('a stale epoch or a refused registration answers 409, an invalid request 400, and the directory being down 503', async () => {
  directory.answer = null;
  expect((await call('/devices/register', register)).status).toBe(409);
  expect((await call('/devices/revoke', { operation_id: 'revoke-00001', installation_id: INSTALLATION, expected_device_epoch: 1 })).status).toBe(409);
  const before = directory.calls.length;
  for (const invalid of [{ ...register, token: 'a'.repeat(64) }, { ...register, provider: 'webpush' }, { ...register, secret: 'x' }]) expect((await call('/devices/register', invalid)).status).toBe(400);
  expect(directory.calls.length).toBe(before);
  directory.answer = { device: { ...view(1, 'active'), token: EXPO }, result: 'registered' };
  expect((await call('/devices/register', register)).status).toBe(503);
  expect((await call('/devices/register', undefined)).status).toBe(405);
});
