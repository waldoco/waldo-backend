import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess, CONSOLE_COOKIE } from '../src/channels/console';
import { consoleAuth, OWNER_COOKIE } from '../src/identity/console-auth';
import { linkCodeHash } from '../src/identity/owner-directory';
import { OWNER_CONTROLS_ACTION_PATH, OWNER_CONTROLS_PATH } from '../src/channels/dashboard-owner-controls';

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
  const rpcState = { open: true, failOpen: false, live: true, revoke: true as boolean | null, cap: true as boolean | null };
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const opened: string[] = [];
  // A revoked row ends at once; a capped row stays live, since no test here outlives its 5 minutes.
  const ended = new Set<string>();
  const messages: string[] = [];
  // Every external request fails except these fictional directory/session RPCs.
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === 'https://api.telegram.org' && url.pathname.endsWith('/sendMessage')) {
      messages.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.origin !== 'https://directory.invalid') throw new Error('unexpected external request');
    const args = JSON.parse(String(init?.body));
    if (url.pathname === '/auth/v1/verify') return Response.json(args.token === '246810' ? { user: { id: 'synthetic-auth-user', email: args.email } } : {}, { status: args.token === '246810' ? 200 : 400 });
    rpcCalls.push({ name: url.pathname.split('/rpc/')[1]!, args });
    if (url.pathname.endsWith('/assert_channel_presence')) return Response.json(true);
    if (url.pathname.endsWith('/console_auth_throttle')) return Response.json(true);
    if (url.pathname.endsWith('/owner_for_auth')) return Response.json(owner);
    if (url.pathname.endsWith('/member_invites')) return Response.json([]);
    if (url.pathname.endsWith('/issue_member_invite')) return Response.json(true);
    if (url.pathname.endsWith('/console_session_revoke')) { ended.add(String(args.p_session_hash)); return Response.json(rpcState.revoke); }
    if (url.pathname.endsWith('/console_session_cap')) return Response.json(rpcState.cap);
    if (url.pathname.endsWith('/console_session_inventory')) {
      const at = new Date().toISOString();
      return Response.json(rpcState.live ? opened.filter(session => !ended.has(session)).map(session => ({ session, created_at: at, last_seen_at: at, expires_at: new Date(Date.parse(at) + 12 * 60 * 60_000).toISOString(), rotated_to: null })) : []);
    }
    if (url.pathname.endsWith('/route_presence')) {
      expect(args.p_subject).toBe(SUBJECT);
      return Response.json([{ do_name: DEPLOY, subject: SUBJECT, timezone: null }]);
    }
    if (url.pathname.endsWith('/console_session_open_for') || url.pathname.endsWith('/console_session_touch')) {
      expect([DEPLOY, MEMBER]).toContain(args.p_do_name);
      if (url.pathname.endsWith('/console_session_open_for')) {
        if (rpcState.failOpen) throw new Error('synthetic session-open failure');
        if (rpcState.open) opened.push(String(args.p_session_hash));
        return Response.json(rpcState.open);
      }
      return Response.json(rpcState.live && !ended.has(String(args.p_session_hash)));
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
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  });
  return { member, bindings, selected, link, post, deploySession, token, rpcState, rpcCalls, messages };
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

// The owner cookie outlives its row (30 days against 7 idle, and sign-out everywhere), so a cookie that does not name a
// live session is no account to protect: the link signs the browser in and the new cookie replaces it.
it('replaces an owner cookie that names no live session instead of refusing the link', async () => {
  const f = await fixture();
  const response = await worker.fetch(f.post(`${OWNER_COOKIE}=invalid`), f.bindings);
  expect(response.status).toBe(303);
  expect(response.headers.get('set-cookie')).toContain(`${OWNER_COOKIE}=${MEMBER}.`);
  expect(f.rpcCalls.map(call => call.name)).not.toContain('console_session_revoke');
  expect(f.rpcCalls.map(call => call.name)).not.toContain('console_session_cap');
});

it('redeems a link in a browser whose own owner session has ended', async () => {
  const f = await fixture();
  const ended = await consoleAuth(directoryEnv)!.ownerCookie(MEMBER);
  f.rpcState.live = false;
  const response = await worker.fetch(f.post(`${OWNER_COOKIE}=${ended}`), f.bindings);
  expect(response.status).toBe(303);
  expect(response.headers.get('set-cookie')).toContain(`${OWNER_COOKIE}=${MEMBER}.`);
});

it('caps both sessions of a signed-in browser that redeems a link, so the old ones run out instead of ending mid-turn', async () => {
  const f = await fixture();
  const presented = (await consoleAuth(directoryEnv)!.ownerCookie(MEMBER))!;
  let oldConsole = '';
  await runInDurableObject(f.member, async (_instance, state) => { oldConsole = await consoleAccess(state.storage).grant(); });
  f.rpcCalls.length = 0;
  const response = await worker.fetch(f.post(`${OWNER_COOKIE}=${presented}; ${CONSOLE_COOKIE}=${oldConsole}`), f.bindings);
  expect(response.status).toBe(303);
  const issued = Object.fromEntries(cookies(response).split('; ').map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
  expect(issued[OWNER_COOKIE]).toBeTruthy();
  expect(issued[OWNER_COOKIE]).not.toBe(presented);
  expect(issued[CONSOLE_COOKIE]).toBeTruthy();
  expect(issued[CONSOLE_COOKIE]).not.toBe(oldConsole);
  expect(f.rpcCalls.map(call => call.name)).not.toContain('console_session_revoke');
  const capped = f.rpcCalls.filter(call => call.name === 'console_session_cap');
  expect(capped).toHaveLength(1);
  expect(capped[0]!.args).toMatchObject({ p_do_name: MEMBER, p_session_hash: await linkCodeHash(presented.split('.')[1]!) });
  await runInDurableObject(f.member, async (_instance, state) => {
    const access = consoleAccess(state.storage);
    const old = await access.session(oldConsole, false);
    expect(old?.expires ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(old?.verified_at).toBeUndefined();
    expect(await access.session(issued[CONSOLE_COOKIE]!)).not.toBeNull();
  });
});

it('signs no one in when the presented owner session cannot be capped', async () => {
  const f = await fixture();
  const presented = (await consoleAuth(directoryEnv)!.ownerCookie(MEMBER))!;
  f.rpcState.cap = null;
  const response = await worker.fetch(f.post(`${OWNER_COOKIE}=${presented}`), f.bindings);
  expect(response.status).toBe(503);
  expect(response.headers.get('set-cookie')).toBeNull();
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

it.each([true, false])('actual Telegram /console command issues a routed ticket only with an issuer (%s)', async withIssuer => {
  const f = await fixture();
  const subject = 999000002;
  await runInDurableObject(f.member, async (instance, state) => {
    const runtime = instance as unknown as { env: Cloudflare.Env; fetch(request: Request): Promise<Response> };
    const previous = runtime.env;
    runtime.env = { ...previous, ...directoryEnv } as Cloudflare.Env;
    await state.storage.put('origin', ORIGIN);
    await state.storage.put('telegram_subject', String(subject));
    if (withIssuer) await state.storage.put('do_name', MEMBER);
    else await state.storage.delete('do_name');
    const previousGrant = await state.storage.get('console:link');
    try {
      expect((await runtime.fetch(new Request('https://telegram-owner/turn', {
        method: 'POST', body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: subject }, chat: { id: subject, type: 'private' }, text: '/console' } }),
      }))).status).toBe(200);
      if (!withIssuer) expect(await state.storage.get('console:link')).toEqual(previousGrant);
    } finally { runtime.env = previous; }
  });
  if (!withIssuer) {
    expect(f.messages).toHaveLength(0);
    return;
  }
  expect(f.messages).toHaveLength(1);
  const link = f.messages[0]!.match(/https:\/\/\S+/)![0];
  expect(new URL(link).searchParams.get('t')).toMatch(/^c1\./);
  const token = new URL(link).searchParams.get('t')!;
  const response = await worker.fetch(new Request(`${ORIGIN}/console`, { method: 'POST', redirect: 'manual', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: token }).toString() }), f.bindings);
  expect(response.status).toBe(303);
  expect(f.selected).toEqual([MEMBER]);
});

describe('the cross-site guard, through the Worker', () => {
  const GUARD = 'This request must come from the Waldo console.';

  it('refuses a sign-in posted from another site', async () => {
    const f = await fixture();
    const response = await worker.fetch(new Request(`${ORIGIN}/console/verify`, {
      method: 'POST', redirect: 'manual',
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'owner@example.test', code: '123456' }).toString(),
    }), f.bindings);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(GUARD);
    expect(f.selected).toEqual([]);
  });

  it('refuses a Photon start that another site sends', async () => {
    const f = await fixture();
    const response = await worker.fetch(new Request(`${ORIGIN}/console/imessage/photon/start`, { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } }), f.bindings);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(GUARD);
  });

  it('lets the console page post its own form', async () => {
    const f = await fixture();
    const post = f.post();
    post.headers.set('sec-fetch-site', 'same-origin');
    const response = await worker.fetch(post, f.bindings);
    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toContain(`${OWNER_COOKIE}=`);
  });
});

describe('console pages and session clocks, through the Worker', () => {
  const html = { ASSETS: { fetch: async () => new Response('<!doctype html><title>shell</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) } };

  it('isolates every console page from the windows of other sites', async () => {
    const f = await fixture();
    const bindings = { ...f.bindings, ...html } as unknown as Cloudflare.Env;
    const signedIn = cookies(await worker.fetch(f.post(), f.bindings));
    for (const request of [new Request(`${ORIGIN}/console/signin`), new Request(f.link), new Request(`${ORIGIN}/console`, { headers: { cookie: signedIn } })]) {
      const response = await worker.fetch(request, bindings);
      expect(response.status, request.url).toBe(200);
      expect(response.headers.get('content-type'), request.url).toContain('text/html');
      expect(response.headers.get('cross-origin-opener-policy'), request.url).toBe('same-origin');
    }
  });

  it('a page another site opens renews neither clock; the same page from the console renews both', async () => {
    const f = await fixture();
    const bindings = { ...f.bindings, ...html } as unknown as Cloudflare.Env;
    const signedIn = cookies(await worker.fetch(f.post(), f.bindings));
    const consoleToken = signedIn.split('; ').find(pair => pair.startsWith(`${CONSOLE_COOKIE}=`))!.slice(CONSOLE_COOKIE.length + 1);
    const expiry = async () => {
      let expires = 0;
      await runInDurableObject(f.member, async (_instance, state) => {
        expires = (await state.storage.get<Record<string, { expires: number }>>('console:sessions'))![consoleToken]!.expires;
      });
      return expires;
    };
    const soon = Date.now() + 24 * 60 * 60_000;
    await runInDurableObject(f.member, async (_instance, state) => {
      const sessions = (await state.storage.get<Record<string, { expires: number }>>('console:sessions'))!;
      sessions[consoleToken]!.expires = soon;
      await state.storage.put('console:sessions', sessions);
    });
    f.rpcCalls.length = 0;
    const fromElsewhere = await worker.fetch(new Request(`${ORIGIN}/console`, { headers: { cookie: signedIn, 'sec-fetch-site': 'cross-site' } }), bindings);
    expect(fromElsewhere.status).toBe(200);
    expect(f.rpcCalls.map(call => call.name)).not.toContain('console_session_touch');
    expect(await expiry()).toBe(soon);
    const fromConsole = await worker.fetch(new Request(`${ORIGIN}/console`, { headers: { cookie: signedIn, 'sec-fetch-site': 'same-origin' } }), bindings);
    expect(fromConsole.status).toBe(200);
    expect(f.rpcCalls.map(call => call.name)).toContain('console_session_touch');
    expect(await expiry()).toBeGreaterThan(soon);
  });
});

describe('a fresh email code before lasting access, through the Worker', () => {
  it('the cookies a confirm replaced keep ordinary access for now, but not the code', async () => {
    const f = await fixture();
    await runInDurableObject(f.member, async (instance) => { Object.assign((instance as unknown as { env: Record<string, unknown> }).env, directoryEnv); });
    const bindings = { ...f.bindings, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Cloudflare.Env;
    const confirm = async (cookie: string) => {
      const verified = await worker.fetch(new Request(`${ORIGIN}/console/verify`, {
        method: 'POST', redirect: 'manual', headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'member@example.test', code: '246810' }),
      }), bindings);
      expect(verified.status).toBe(303);
      return cookies(verified);
    };
    const invite = async (cookie: string, requestId: string) => {
      const read = await worker.fetch(new Request(`${ORIGIN}${OWNER_CONTROLS_PATH}?view=invites`, { headers: { cookie, accept: 'application/json' } }), bindings);
      expect(read.status, 'an ordinary read').toBe(200);
      const current = await read.json() as { csrf: string; revision: string };
      return worker.fetch(new Request(`${ORIGIN}${OWNER_CONTROLS_ACTION_PATH}`, {
        method: 'POST', headers: { cookie, origin: ORIGIN, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'invites', action: 'invite.member', value: 'friend@example.test', request_id: requestId }),
      }), bindings);
    };
    const proved = await confirm(cookies(await worker.fetch(f.post(), bindings)));
    const confirmed = await confirm(proved);
    const replaced = await invite(proved, 'replaced-cookie-invite');
    expect(replaced.status).toBe(403);
    expect(await replaced.json()).toEqual({ error: 'step_up_required' });
    expect(f.rpcCalls.map(call => call.name)).not.toContain('issue_member_invite');
    expect((await invite(confirmed, 'confirmed-cookie-invite')).status).toBe(200);
    expect(f.rpcCalls.map(call => call.name)).toContain('issue_member_invite');
  });


  it('a link sign-in is asked for a code before inviting someone, and the same invite runs after the code', async () => {
    const f = await fixture();
    await runInDurableObject(f.member, async (instance) => { Object.assign((instance as unknown as { env: Record<string, unknown> }).env, directoryEnv); });
    const bindings = { ...f.bindings, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Cloudflare.Env;
    let signedIn = cookies(await worker.fetch(f.post(), bindings));
    const invite = async () => {
      const read = await worker.fetch(new Request(`${ORIGIN}${OWNER_CONTROLS_PATH}?view=invites`, { headers: { cookie: signedIn, accept: 'application/json' } }), bindings);
      expect(read.status).toBe(200);
      const current = await read.json() as { csrf: string; revision: string };
      return worker.fetch(new Request(`${ORIGIN}${OWNER_CONTROLS_ACTION_PATH}`, {
        method: 'POST', headers: { cookie: signedIn, origin: ORIGIN, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'invites', action: 'invite.member', value: 'friend@example.test', request_id: 'step-up-invite-request' }),
      }), bindings);
    };
    const refused = await invite();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'step_up_required' });
    expect(f.rpcCalls.map(call => call.name)).not.toContain('issue_member_invite');
    const verified = await worker.fetch(new Request(`${ORIGIN}/console/verify`, {
      method: 'POST', redirect: 'manual', headers: { cookie: signedIn, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'member@example.test', code: '246810' }),
    }), bindings);
    expect(verified.status).toBe(303);
    signedIn = cookies(verified);
    const done = await invite();
    expect(done.status).toBe(200);
    expect(f.rpcCalls.map(call => call.name)).toContain('issue_member_invite');
  });
});
