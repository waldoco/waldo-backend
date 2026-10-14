import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
import { consoleAuth, OWNER_COOKIE } from '../src/identity/console-auth';
import { mintConsoleLink } from '../src/channels/console-link';

const DEPLOY = 'owner-synthetic-console-deploy';
const MEMBER = 'owner-synthetic-console-member';
const SUBJECT = '999000001';
const ORIGIN = 'https://waldo.invalid';
const directoryEnv = {
  SUPABASE_PROJECT_URL: 'https://directory.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key',
  WALDO_ROUTER_HMAC_SECRET: 'synthetic-console-routing-secret',
};

afterEach(() => vi.unstubAllGlobals());

async function fixture(owner = MEMBER, issuedAt?: number) {
  const rpcState = { open: true, failOpen: false };
  // Every external request fails except these fictional directory/session RPCs.
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://directory.invalid') throw new Error('unexpected external request');
    const args = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('/assert_channel_presence')) return Response.json(true);
    if (url.pathname.endsWith('/route_presence')) {
      expect(args.p_subject).toBe(SUBJECT);
      return Response.json([{ do_name: DEPLOY, subject: SUBJECT, timezone: null }]);
    }
    if (url.pathname.endsWith('/console_session_open') || url.pathname.endsWith('/console_session_touch')) {
      expect([DEPLOY, MEMBER]).toContain(args.p_do_name);
      if (url.pathname.endsWith('/console_session_open')) {
        if (rpcState.failOpen) throw new Error('synthetic session-open failure');
        return Response.json(rpcState.open);
      }
      return Response.json(true);
    }
    throw new Error('unexpected directory RPC');
  }));
  const namespace = env.OWNER_DO!;
  const member = namespace.get(namespace.idFromName(owner));
  const deploy = namespace.get(namespace.idFromName(DEPLOY));
  let link = '';
  let deploySession = '';
  await runInDurableObject(member, async (_instance, state) => {
    link = await consoleAccess(state.storage, issuedAt === undefined ? Date.now : () => issuedAt).mintLink(ORIGIN, { owner, secret: directoryEnv.WALDO_ROUTER_HMAC_SECRET });
  });
  await runInDurableObject(deploy, async (_instance, state) => {
    deploySession = await consoleAccess(state.storage).grant();
  });
  const selected: string[] = [];
  const bindings = {
    ...env, ...directoryEnv, WALDO_OWNER_TELEGRAM_ID: SUBJECT,
    OWNER_DO: {
      idFromName: (name: string) => { selected.push(name); return namespace.idFromName(name); },
      get: namespace.get.bind(namespace),
    },
  } as unknown as Cloudflare.Env;
  const token = new URL(link).searchParams.get('t')!;
  const post = (cookie?: string) => new Request(`${ORIGIN}/console`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ t: token }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  });
  return { member, bindings, selected, link, post, deploySession, token, rpcState };
}

it('redeems a fresh member ticket through the Worker in a fresh browser', async () => {
  const f = await fixture();
  const landing = await worker.fetch(new Request(f.link), f.bindings);
  expect(landing.status).toBe(200);
  expect(await landing.text()).toContain('Open console');
  const response = await worker.fetch(f.post(), f.bindings);
  expect(response.status).toBe(303);
  expect(response.headers.get('set-cookie')).toContain(`${CONSOLE_COOKIE}=`);
  expect(response.headers.get('set-cookie')).toContain(`${OWNER_COOKIE}=`);
  expect(f.selected).toEqual([MEMBER, MEMBER]);
});

it('redeems a fresh member ticket with an existing other-owner legacy ticket cookie', async () => {
  const f = await fixture();
  const response = await worker.fetch(f.post(`${CONSOLE_COOKIE}=${f.deploySession}`), f.bindings);
  expect(response.status).toBe(303);
  expect(f.selected).toEqual([MEMBER]);
});

it('does not silently switch an existing signed other-owner browser session', async () => {
  const f = await fixture();
  const signedOwner = await consoleAuth(directoryEnv)!.ownerCookie(DEPLOY);
  const cookie = `${OWNER_COOKIE}=${signedOwner}; ${CONSOLE_COOKIE}=${f.deploySession}`;
  expect((await worker.fetch(new Request(f.link, { headers: { cookie } }), f.bindings)).status).toBe(403);
  const response = await worker.fetch(f.post(cookie), f.bindings);
  expect(response.status).toBe(403);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(f.selected).toEqual([]);
  expect((await f.member.fetch(f.post())).status).toBe(303);
});

const cookies = (response: Response) => (response.headers.get('set-cookie') ?? '').split(/,\s*(?=waldo_)/).map(value => value.split(';')[0]).join('; ');

it('keeps configured-owner links working with tenant and console cookies', async () => {
  const f = await fixture(DEPLOY);
  expect((await worker.fetch(new Request(f.link), f.bindings)).status).toBe(200);
  const response = await worker.fetch(f.post(), f.bindings);
  expect(response.status).toBe(303);
  expect(await consoleAuth(directoryEnv)!.readOwnerCookie(new Request(ORIGIN, { headers: { cookie: cookies(response) } }))).toBe(DEPLOY);
});

it('routes the subsequent member shell and API to the issuing DO using the returned cookies', async () => {
  const f = await fixture();
  const response = await worker.fetch(f.post(), f.bindings);
  expect(response.status).toBe(303);
  const cookie = cookies(response);
  expect(await consoleAuth(directoryEnv)!.readOwnerCookie(new Request(ORIGIN, { headers: { cookie } }))).toBe(MEMBER);
  const bindings = { ...f.bindings, ASSETS: { fetch: async () => new Response('synthetic dashboard shell') } } as unknown as Cloudflare.Env;
  f.selected.length = 0;
  const api = await worker.fetch(new Request(`${ORIGIN}/console/dashboard/api/v1/overview`, { headers: { cookie } }), bindings);
  expect(api.status).toBe(200);
  const shell = await worker.fetch(new Request(`${ORIGIN}/console`, { headers: { cookie } }), bindings);
  expect(shell.status).toBe(200);
  expect(await shell.text()).toBe('synthetic dashboard shell');
  expect(f.selected).toEqual([MEMBER, MEMBER]);
});

it('rejects replay and simultaneous redemption after one successful use', async () => {
  const f = await fixture();
  const responses = await Promise.all([worker.fetch(f.post(), f.bindings), worker.fetch(f.post(), f.bindings)]);
  expect(responses.map(r => r.status).sort()).toEqual([303, 403]);
  expect((await worker.fetch(f.post(), f.bindings)).status).toBe(403);
});

it('rejects expired member tickets without selecting any owner DO', async () => {
  const f = await fixture(MEMBER, Date.now() - 11 * 60_000);
  expect((await worker.fetch(new Request(f.link), f.bindings)).status).toBe(403);
  expect((await worker.fetch(f.post(), f.bindings)).status).toBe(403);
  expect(f.selected).toEqual([]);
});

it('rejects tampered ticket payload, signature, version and routing header', async () => {
  const f = await fixture();
  const parts = f.token.split('.');
  const tampered = [
    `c1.${parts[1]!.slice(0, -1)}A.${parts[2]}`,
    `c1.${parts[1]}.${parts[2]!.slice(0, -1)}${parts[2]!.endsWith('0') ? '1' : '0'}`,
    f.token.replace('c1.', 'c2.'),
  ];
  for (const token of tampered) {
    const request = new Request(`${ORIGIN}/console?t=${token}`, { headers: { 'x-waldo-do-name': DEPLOY } });
    expect((await worker.fetch(request, f.bindings)).status).toBe(403);
  }
  expect(f.selected).toEqual([]);
  const request = f.post(); request.headers.set('x-waldo-do-name', DEPLOY);
  expect((await worker.fetch(request, f.bindings)).status).toBe(303);
  expect(f.selected).toEqual([MEMBER]);
});

it('rejects an invalid signed owner cookie without spending the member ticket', async () => {
  const f = await fixture();
  expect((await worker.fetch(f.post(`${OWNER_COOKIE}=invalid`), f.bindings)).status).toBe(403);
  expect(f.selected).toEqual([]);
  expect((await worker.fetch(f.post(), f.bindings)).status).toBe(303);
});

it.each(['false', 'throw'])('fails closed when owner session open returns %s and recovers with a new link', async failure => {
  const f = await fixture();
  if (failure === 'false') f.rpcState.open = false; else f.rpcState.failOpen = true;
  const response = await worker.fetch(f.post(), f.bindings);
  expect(response.status).toBe(503);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect((await worker.fetch(f.post(), f.bindings)).status).toBe(403);
  const fresh = await fixture();
  expect((await worker.fetch(fresh.post(), fresh.bindings)).status).toBe(303);
});

it.each([true, false])('the console link Waldo mints for a member is a routed ticket only with an issuer (%s)', async withIssuer => {
  const f = await fixture();
  // send_console_link mints through this one rule; its delivery on each surface is tested with the tool.
  const link = await runInDurableObject(f.member, async (_instance, state) => {
    await state.storage.put('origin', ORIGIN);
    if (withIssuer) await state.storage.put('do_name', MEMBER);
    else await state.storage.delete('do_name');
    const previousGrant = await state.storage.get('console:link');
    const minted = await mintConsoleLink(state.storage, { ...env, ...directoryEnv });
    if (!withIssuer) expect(await state.storage.get('console:link')).toEqual(previousGrant);
    return minted;
  });
  if (!withIssuer) {
    expect(link).toBeNull();
    return;
  }
  expect(new URL(link!).searchParams.get('t')).toMatch(/^c1\./);
  const token = new URL(link!).searchParams.get('t')!;
  const response = await worker.fetch(new Request(`${ORIGIN}/console`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: token }).toString() }), f.bindings);
  expect(response.status).toBe(303);
  expect(f.selected).toEqual([MEMBER]);
});
