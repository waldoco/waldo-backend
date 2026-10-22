import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess, CONSOLE_ACTION_PATH, CONSOLE_GOOGLE_START_PATH } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { GOOGLE_CALLBACK_PATH, readConsentState } from '../src/connectors/google';
import { checkBrowser } from '../src/connectors/oauth-browser-binding';
import { cookieJar, setCookies } from './support/cookie-jar';

const STATE_SECRET = 'fictional-console-start-state-secret';
const root = 'https://telegram-owner';

// An owner signed in to the console, with Google configured and no connect-session directory: the console start must not
// need one, because it never mints a bearer link.
const open = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, async (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, {
      TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key', WALDO_OAUTH_STATE_SECRET: STATE_SECRET,
      GOOGLE_CLIENT_ID: 'fictional-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fictional-client-secret',
      SUPABASE_PROJECT_URL: undefined, WALDO_ROUTER_HMAC_SECRET: undefined,
    });
    state.storage.kv.put('do_name', name);
    await state.storage.put('origin', 'https://waldo.example');
    const granted = await consoleAccess(state.storage).grant();
    return { granted, csrf: (await state.storage.get<Record<string, { csrf: string }>>('console:sessions'))![granted]!.csrf };
  });
  return { stub, cookie: `waldo_console=${token.granted}`, csrf: token.csrf };
};

const dashboardConnect = async (stub: DurableObjectStub, cookie: string) => {
  const read = await stub.fetch(`${root}${CONTROLS_PATH}?view=connections`, { headers: { cookie } });
  expect(read.status).toBe(200);
  const { csrf, revision } = await read.json() as { csrf: string; revision: string };
  const response = await stub.fetch(`${root}${CONTROL_ACTION_PATH}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, revision, view: 'connections', action: 'google.connect', value: 'calendar', request_id: `google-start-${crypto.randomUUID().slice(0, 8)}` }) });
  return (await response.json() as { receipt: { state: string; navigation?: string } }).receipt;
};

describe('Google connect from the console starts behind the console session', () => {
  it('hands the dashboard a console start path, never a bearer /c/ link, and asks no connect-session directory for one', async () => {
    const { stub, cookie } = await open('google-console-start-a');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 503 }));
    try {
      const receipt = await dashboardConnect(stub, cookie);
      expect(receipt.state).toBe('recorded');
      expect(receipt.navigation).toMatch(new RegExp(`^${CONSOLE_GOOGLE_START_PATH}[A-Za-z0-9_-]{43}$`));
      expect(fetcher.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/rpc/'))).toEqual([]);
    } finally { fetcher.mockRestore(); }
  });

  it('redirects the signed-in owner straight to Google and binds the callback to that browser, once', async () => {
    const { stub, cookie } = await open('google-console-start-b');
    const path = (await dashboardConnect(stub, cookie)).navigation!;
    const nonce = path.slice(CONSOLE_GOOGLE_START_PATH.length);
    const jar = cookieJar();
    const start = jar.take(await stub.fetch(`${root}${path}`, { headers: { cookie }, redirect: 'manual' }));
    expect(start.status).toBe(303);
    const location = new URL(start.headers.get('location')!);
    expect(location.origin).toBe('https://accounts.google.com');
    expect(await readConsentState(STATE_SECRET, location.searchParams.get('state')!)).toMatchObject({ nonce, surface: 'dashboard' });
    const [bound] = setCookies(start);
    expect(bound).toContain(`Path=${GOOGLE_CALLBACK_PATH}`);
    expect(start.headers.get('referrer-policy')).toBe('no-referrer');
    const callback = new Request(`https://waldo.example${GOOGLE_CALLBACK_PATH}?state=x`, { headers: { cookie: jar.header() } });
    expect(await checkBrowser(callback, 'google', nonce, Date.now())).toBe('bound');

    const replay = await stub.fetch(`${root}${path}`, { headers: { cookie }, redirect: 'manual' });
    expect([replay.status, replay.headers.get('location'), setCookies(replay)]).toEqual([400, null, []]);
  });

  it('turns the start path into nothing for a browser without the console session', async () => {
    const { stub, cookie } = await open('google-console-start-c');
    const path = (await dashboardConnect(stub, cookie)).navigation!;
    const forwarded = await stub.fetch(`${root}${path}`, { redirect: 'manual' });
    expect(forwarded.headers.get('location') ?? '').not.toContain('accounts.google.com');
    expect(setCookies(forwarded).filter((line) => line.startsWith('__Secure-waldo-oauth-'))).toEqual([]);
    // The owner's own browser still finishes the attempt the forwarded copy could not.
    expect((await stub.fetch(`${root}${path}`, { headers: { cookie }, redirect: 'manual' })).status).toBe(303);
  });

  it('sends the classic console form straight on to the same start path', async () => {
    const { stub, cookie, csrf } = await open('google-console-start-d');
    const response = await stub.fetch(`${root}${CONSOLE_ACTION_PATH}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, action: 'google.connect', value: 'calendar' }) });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(new RegExp(`^${CONSOLE_GOOGLE_START_PATH}[A-Za-z0-9_-]{43}$`));
  });
});
