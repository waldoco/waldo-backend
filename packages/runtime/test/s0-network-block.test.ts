import { afterEach, expect, it, vi } from 'vitest';
import { evaluateS0, evaluateS0Retained, handleS0, runS0, runS0Retained, S0_BLOCKED_PROBES, S0_PRIVATE_PROBES, S0_REDIRECT_TARGET, type S0Decision } from '../src/channels/s0-network-block';
import { publicBrowserRequestAuthorizer } from '../src/channels/public-browser-request-filter';

afterEach(() => vi.restoreAllMocks());

const blocked = S0_BLOCKED_PROBES.map(url => ({ url, reached: false, detail: 'blocked' }));
it('one-shot: passes only when the allowed host loads, every probe is blocked and the session ended', () => {
  expect(evaluateS0(true, blocked, true, 5).passed).toBe(true);
  expect(evaluateS0(false, blocked, true, 5).passed).toBe(false);
  expect(evaluateS0(true, blocked, false, 5).passed).toBe(false);
  expect(evaluateS0(true, blocked.slice(1), true, 5).passed).toBe(false);
  expect(evaluateS0(true, [{ ...blocked[0]!, reached: true }, ...blocked.slice(1)], true, 5).passed).toBe(false);
});
it('one-shot: a probe that merely timed out is not a network block', () => {
  const timedOut = S0_BLOCKED_PROBES.map(url => ({ url, reached: false, detail: 'blocked:TimeoutError: signal timed out' }));
  expect(evaluateS0(true, timedOut, true, 5).passed).toBe(false);
});

const log = (override: Partial<Record<string, boolean>> = {}, drop: string[] = []): S0Decision[] => [
  { url: 'https://s0.example/s0/probe-page', method: 'GET', allowed: true },
  { url: 'https://s0.example/s0/control', method: 'GET', allowed: true },
  ...S0_PRIVATE_PROBES.map(url => ({ url, method: 'GET', allowed: override[url] ?? false })),
  { url: S0_REDIRECT_TARGET, method: 'GET', allowed: override[S0_REDIRECT_TARGET] ?? false },
].filter(row => !drop.includes(row.url));
const evaluate = (decisions: readonly S0Decision[], extra: Partial<{ pageLoaded: boolean; redirectRejected: boolean; terminated: boolean }> = {}) =>
  evaluateS0Retained({ origin: 'https://s0.example', decisions, pageLoaded: true, redirectRejected: true, terminated: true, ...extra }).passed;
it('retained: passes only when the filter saw and denied every private probe and the redirect hop, and allowed the control', () => {
  expect(evaluate(log())).toBe(true);
  expect(evaluate(log({ [S0_PRIVATE_PROBES[0]]: true }))).toBe(false);
  expect(evaluate(log({ [S0_REDIRECT_TARGET]: true }))).toBe(false);
  expect(evaluate(log({}, [S0_PRIVATE_PROBES[2]]))).toBe(false);
  expect(evaluate(log({}, [S0_REDIRECT_TARGET]))).toBe(false);
  expect(evaluate(log({}, ['https://s0.example/s0/control']))).toBe(false);
  expect(evaluate(log(), { pageLoaded: false })).toBe(false);
  expect(evaluate(log(), { redirectRejected: false })).toBe(false);
  expect(evaluate(log(), { terminated: false })).toBe(false);
});

// A fake Cloudflare browser whose pages fire the requests the S0 probe page makes, through the
// route handler the real driver installs. The filter, redirect handling and cleanup are production code.
function fakeCloudflare(options: { sessionsLeft?: boolean } = {}) {
  let ended = false, handler: ((route: any) => Promise<void>) | undefined;
  const calls: string[] = [];
  const probeSubresources = (origin: string) => [`${origin}/s0/control`, ...S0_PRIVATE_PROBES];
  const request = (url: string, navigation: boolean, page: unknown) => ({ url: () => url, method: () => 'GET', isNavigationRequest: () => navigation, frame: () => ({ parentFrame: () => null, page: () => page }), allHeaders: async () => ({}) });
  const fire = async (url: string, navigation: boolean, page: unknown, respond: (url: string) => { status: number; location?: string }) => {
    const outcome = { aborted: false };
    await handler!({ request: () => request(url, navigation, page), fetch: async () => { const r = respond(url); return { status: () => r.status, headers: () => (r.location ? { location: r.location } : {}) }; }, fulfill: async () => {}, abort: async () => { outcome.aborted = true; } });
    return outcome;
  };
  const makePage = () => {
    let url = 'about:blank';
    const page: any = { url: () => url, title: async () => 'S0 probe page', setDefaultTimeout() {}, close: async () => {}, screenshot: async () => new Uint8Array([137, 80, 78, 71]), locator: () => ({}),
      evaluate: async () => ({ url, title: 'S0 probe page', text: 'S0 probe page', width: 1280, height: 720, scrollX: 0, scrollY: 0, elements: [] }),
      goto: async (target: string) => {
        const origin = new URL(target).origin, respond = (u: string) => (u.endsWith('/s0/redirect') ? { status: 302, location: S0_REDIRECT_TARGET } : { status: 200 });
        const main = await fire(target, true, page, respond);
        if (main.aborted) throw Error('net::ERR_BLOCKED_BY_CLIENT');
        url = target;
        if (target.endsWith('/s0/probe-page')) for (const sub of probeSubresources(origin)) await fire(sub, false, page, respond);
        return { status: () => 200 };
      } };
    return page;
  };
  const pages: any[] = [];
  const context: any = { pages: () => pages, serviceWorkers: () => [], addInitScript: async () => {}, routeWebSocket: async () => {}, route: async (_: string, h: any) => { handler = h; }, unroute: async () => {},
    newCDPSession: async (p: any) => ({ send: async (method: string) => (method === 'Accessibility.getFullAXTree' ? { nodes: [{ nodeId: '1', role: { value: 'heading' }, name: { value: 'S0 probe page' }, properties: [] }] } : { targetInfo: { targetId: p.id ?? 'T' } }), detach: async () => {} }) };
  const browser: any = { contexts: () => [context], newContext: async () => { const p = makePage(); pages.push(p); return context; }, isConnected: () => true, close: async () => {}, newBrowserCDPSession: async () => ({ send: async () => { ended = true; calls.push('browser-close'); } }) };
  context.newPage = async () => { const p = makePage(); pages.push(p); return p; };
  const sdk = {
    acquire: async (_b: unknown, o: unknown) => { calls.push(`acquire:${JSON.stringify(o)}`); return { sessionId: 's0-session-1' }; },
    connect: async () => browser,
    sessions: async () => (ended && !options.sessionsLeft ? [] : [{ sessionId: 's0-session-1' }]),
  };
  return { sdk, calls };
}
const ORIGIN = 'https://s0.example';

it('retained: drives the real driver with the production filter, sees every probe denied and closes the session', async () => {
  const f = fakeCloudflare();
  const result = await runS0Retained({} as never, (async () => f.sdk) as never, ORIGIN);
  expect(result.passed).toBe(true);
  expect(result.terminated).toBe(true);
  expect(f.calls[0]).toBe('acquire:{"recording":false,"keep_alive":30000}');
  for (const url of S0_PRIVATE_PROBES) expect(result.decisions.filter(d => d.url === url).every(d => !d.allowed) && result.decisions.some(d => d.url === url), url).toBe(true);
  expect(result.decisions).toContainEqual({ url: S0_REDIRECT_TARGET, method: 'GET', allowed: false });
  expect(result.decisions).toContainEqual({ url: `${ORIGIN}/s0/control`, method: 'GET', allowed: true });
});
it('retained: a filter that lets a private probe through fails the run', async () => {
  const f = fakeCloudflare();
  const production = publicBrowserRequestAuthorizer(['*']);
  const leaky = async (url: string, method: string) => url === S0_PRIVATE_PROBES[1] || await production(url, method);
  expect((await runS0Retained({} as never, (async () => f.sdk) as never, ORIGIN, leaky)).passed).toBe(false);
});
it('retained: a filter that denies everything fails the run, because the control never loaded', async () => {
  const f = fakeCloudflare();
  expect((await runS0Retained({} as never, (async () => f.sdk) as never, ORIGIN, async () => false)).passed).toBe(false);
});
it('retained: a session that is still listed after cleanup fails the run', async () => {
  const f = fakeCloudflare({ sessionsLeft: true });
  const result = await runS0Retained({} as never, (async () => f.sdk) as never, ORIGIN);
  expect([result.terminated, result.passed]).toEqual([false, false]);
});

const env = { WALDO_ENVIRONMENT: 'staging', S0_TOKEN: 't0ken', BROWSER: {} as never };
const never = (async () => { throw Error('must not load'); }) as never;
const post = (path = '/s0', auth?: string, method = 'POST') => new Request(`https://x${path}`, { method, headers: auth ? { authorization: auth } : {} });
it('is invisible without staging, a token, a binding and the exact bearer', async () => {
  for (const path of ['/s0', '/s0/retained'])
    for (const [r, e] of [[post(path, 'Bearer t0ken'), { ...env, WALDO_ENVIRONMENT: 'production' }], [post(path, 'Bearer t0ken'), { ...env, S0_TOKEN: undefined }], [post(path, 'Bearer t0ken'), { ...env, BROWSER: undefined }], [post(path), env], [post(path, 'Bearer wrong'), env], [post(path, 'Bearer t0ken!'), env], [post(path, 'Bearer t0ken', 'GET'), env]] as const)
      expect((await handleS0(r, e, never)).status, `${path} ${r.headers.get('authorization')}`).toBe(404);
});
it('serves no unauthenticated config ping', async () => {
  const res = await handleS0(new Request('https://x/s0/ping'), env, never);
  expect([res.status, res.headers.get('x-waldo-s0')]).toEqual([404, 'waldo-s0-staging;path']);
});
it('compares the bearer through a constant-time digest comparison', async () => {
  const spy = vi.spyOn(crypto.subtle, 'timingSafeEqual');
  await handleS0(post('/s0', 'Bearer wrong'), env, never);
  await handleS0(post('/s0', 'Bearer t0ken-and-more'), env, never);
  expect(spy).toHaveBeenCalledTimes(2);
  for (const [a, b] of spy.mock.calls) expect([(a as ArrayBuffer).byteLength, (b as ArrayBuffer).byteLength]).toEqual([32, 32]);
});
it('names the failed check in a header, serves authenticated readiness and reports a thrown run as 502', async () => {
  const bad = await handleS0(post('/s0', 'Bearer wrong'), env, (async () => { throw Error('x'); }) as never);
  expect([bad.status, bad.headers.get('x-waldo-s0')]).toEqual([404, 'waldo-s0-staging;auth']);
  const ready = await handleS0(new Request('https://x/s0/ready', { headers: { authorization: 'Bearer t0ken' } }), env, never);
  expect([ready.status, await ready.json()]).toEqual([200, { ready: true, version: 's0-gate-v4' }]);
  expect((await handleS0(new Request('https://x/s0/ready', { headers: { authorization: 'Bearer nope' } }), env, never)).status).toBe(404);
  const run = await handleS0(post('/s0', 'Bearer t0ken'), env, (async () => { throw Error('secret detail'); }) as never);
  expect([run.status, run.headers.get('x-waldo-s0'), await run.text()]).toEqual([502, 'waldo-s0-staging;error', '{"error":"Error"}']);
});
it('refuses to start a paid session while any provider session is live', async () => {
  const acquire = vi.fn();
  const sdk = { acquire, connect: vi.fn(), sessions: async () => [{ sessionId: 'someone-elses' }] };
  for (const path of ['/s0', '/s0/retained']) {
    const res = await handleS0(post(path, 'Bearer t0ken'), env, (async () => sdk) as never);
    expect([res.status, res.headers.get('x-waldo-s0')], path).toEqual([429, 'waldo-s0-staging;busy']);
  }
  expect(acquire).not.toHaveBeenCalled();
});
it('serves the static probe routes only on staging, with no bearer and no browser call', async () => {
  const page = await handleS0(new Request('https://s0.example/s0/probe-page'), { WALDO_ENVIRONMENT: 'staging' }, never);
  const html = await page.text();
  expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
  for (const url of [...S0_PRIVATE_PROBES, 'https://s0.example/s0/control']) expect(html).toContain(JSON.stringify(url));
  const redirect = await handleS0(new Request('https://s0.example/s0/redirect'), { WALDO_ENVIRONMENT: 'staging' }, never);
  expect([redirect.status, redirect.headers.get('location')]).toEqual([302, S0_REDIRECT_TARGET]);
  expect((await handleS0(new Request('https://s0.example/s0/control'), { WALDO_ENVIRONMENT: 'staging' }, never)).status).toBe(200);
  for (const path of ['/s0/probe-page', '/s0/redirect', '/s0/control']) expect((await handleS0(new Request(`https://s0.example${path}`), { WALDO_ENVIRONMENT: 'production' }, never)).status).toBe(404);
});

it('one-shot: a late-resolving acquire is closed by its exact id and the run fails', async () => {
  const calls: string[] = [];
  const sdk = {
    acquire: () => new Promise(resolve => setTimeout(() => resolve({ sessionId: 'late-1' }), 60)),
    connect: async (_b: unknown, o: { sessionId: string }) => { calls.push(`connect:${o.sessionId}`); return { newBrowserCDPSession: async () => ({ send: async () => { calls.push('close'); } }) }; },
    sessions: async () => { calls.push('list'); return []; },
  };
  await expect(runS0({} as never, (async () => sdk) as never, { load: 50, acquire: 10, work: 40, cleanup: 40 })).rejects.toThrow();
  await new Promise(r => setTimeout(r, 150));
  expect(calls).toEqual(['connect:late-1', 'close', 'list']);
});
