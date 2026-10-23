import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { CONSOLE_ACTION_PATH, consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { OWNER_CONTROLS_ACTION_PATH, OWNER_CONTROLS_PATH } from '../src/channels/dashboard-owner-controls';

const root = 'https://telegram-owner';
const HOUR = 60 * 60_000;
const directoryEnv = { SUPABASE_PROJECT_URL: 'https://directory.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key', WALDO_ROUTER_HMAC_SECRET: 'synthetic-step-up-secret' };
type Read = { csrf: string; revision: string };

afterEach(() => vi.unstubAllGlobals());

// A fictional directory: every RPC is recorded, so a test can tell whether an action's executor ran.
const directory = () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== directoryEnv.SUPABASE_PROJECT_URL) return new Response('unreachable in this test', { status: 502 });
    const name = url.pathname.split('/rpc/')[1] ?? url.pathname;
    calls.push(name);
    if (name === 'list_devices' || name === 'member_invites') return Response.json([]);
    if (name === 'issue_device_pairing_code_owned') return Response.json('41000000-0000-0000-0000-000000000001');
    return Response.json(true);
  }));
  return calls;
};

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, async (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, {
      TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key', ...directoryEnv,
      GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', WALDO_OAUTH_STATE_SECRET: 'synthetic-state-secret',
    });
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', root);
    return consoleAccess(state.storage).grant();
  });
  const codeAge = (age: number) => runInDurableObject(stub, async (_instance, state) => {
    const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
    sessions[token] = { ...sessions[token]!, verified_at: Date.now() - age };
    await state.storage.put('console:sessions', sessions);
  });
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `waldo_console=${token}`, accept: 'application/json', ...extra });
  const read = async (path: string): Promise<Read> => {
    const response = await stub.fetch(root + path, { headers: headers() });
    expect(response.status, path).toBe(200);
    const body = await response.json() as Read & { controls?: Read };
    return body.controls ?? body;
  };
  const post = (path: string, fields: Record<string, string>, extra: Record<string, string> = {}) =>
    stub.fetch(root + path, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded', ...extra }), body: new URLSearchParams(fields) });
  return { stub, codeAge, read, post };
};

// Each action posts the same request twice, once with a code older than two hours and once with a fresh one.
const actions: ReadonlyArray<{ name: string; path: string; read: string; fields: Record<string, string>; ran: (calls: readonly string[], body: Record<string, unknown>) => boolean }> = [
  { name: 'device.pair', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=devices`, fields: { view: 'devices', action: 'device.pair' },
    ran: calls => calls.includes('issue_device_pairing_code_owned') },
  { name: 'google.connect', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=connections`, fields: { view: 'connections', action: 'google.connect', value: 'calendar' },
    ran: (_calls, body) => typeof body.receipt === 'object' && body.receipt !== null },
  { name: 'mcp.connect', path: CONTROL_ACTION_PATH, read: `${CONTROLS_PATH}?view=connections`, fields: { view: 'connections', action: 'mcp.connect', value: 'https://mcp.example.test/mcp' },
    ran: (_calls, body) => typeof body.receipt === 'object' && body.receipt !== null },
  { name: 'invite.member', path: OWNER_CONTROLS_ACTION_PATH, read: `${OWNER_CONTROLS_PATH}?view=invites`, fields: { view: 'invites', action: 'invite.member', value: 'friend@example.test' },
    ran: calls => calls.includes('issue_member_invite') },
  { name: 'account.delete', path: OWNER_CONTROLS_ACTION_PATH, read: `${OWNER_CONTROLS_PATH}?view=account`, fields: { view: 'account', action: 'account.delete', confirmation: 'DELETE' },
    ran: calls => calls.includes('delete_owner') },
];

describe('a fresh email code before an action that creates lasting access', () => {
  for (const action of actions) {
    for (const [age, fresh] of [[3 * HOUR, false], [60_000, true]] as const) {
      it(`${action.name} ${fresh ? 'runs with a code from the last two hours' : 'is refused once the code is over two hours old'}`, async () => {
        const calls = directory();
        const o = await owner(`step-up-${action.name}-${fresh ? 'fresh' : 'stale'}`);
        await o.codeAge(age);
        const current = await o.read(action.read);
        calls.length = 0;
        const response = await o.post(action.path, { csrf: current.csrf, revision: current.revision, request_id: `step-up-${action.name.replace('.', '-')}-request`, ...action.fields });
        const body = await response.json() as Record<string, unknown>;
        if (fresh) {
          expect(body.error, action.name).not.toBe('step_up_required');
          expect(action.ran(calls, body), action.name).toBe(true);
        } else {
          expect(response.status, action.name).toBe(403);
          expect(body).toEqual({ error: 'step_up_required' });
          expect(action.ran(calls, body), action.name).toBe(false);
        }
      });
    }
  }

  it('refuses the same actions on the classic console form and the admin invite, with a way to confirm', async () => {
    const calls = directory();
    const o = await owner('step-up-classic');
    await o.codeAge(3 * HOUR);
    for (const fields of [{ action: 'device.pair' }, { action: 'google.connect', value: 'calendar' }, { action: 'invite.create', value: 'friend@example.test' }, { action: 'account.delete', value: 'DELETE' }] as Record<string, string>[]) {
      const page = await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', ...fields }, { accept: 'text/html' });
      expect(page.status, fields.action).toBe(403);
      expect(await page.text(), fields.action).toContain('/console/signin?confirm=1');
    }
    const admin = await o.post(CONSOLE_ACTION_PATH, { csrf: 'any', action: 'invite.create', value: 'friend@example.test' });
    expect(admin.status).toBe(403);
    expect(await admin.json()).toEqual({ error: 'step_up_required' });
    expect(calls.filter(name => ['issue_device_pairing_code', 'issue_device_pairing_code_owned', 'admin_invite', 'delete_owner'].includes(name))).toEqual([]);
  });

  it('leaves ordinary console actions alone when the code is old', async () => {
    directory();
    const o = await owner('step-up-ordinary');
    await o.codeAge(3 * HOUR);
    const current = await o.read(`${CONTROLS_PATH}?view=day`);
    const response = await o.post(CONTROL_ACTION_PATH, { csrf: current.csrf, revision: current.revision, request_id: 'ordinary-pin', view: 'day', action: 'card.pin', id: 'card:close', value: '22:15' });
    expect(response.status).toBe(200);
  });
});
