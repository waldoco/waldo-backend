import { expect, it, vi } from 'vitest';
import { browsePageArgsSchema } from '@waldo/contracts';
import { browsePageHandler } from '../src/tools/live/browser';
import { cloudflarePublicRead } from '../src/channels/cloudflare-public-read';

const args = { url: 'https://example.com/menu', instruction: 'Find vegetarian options', provider: 'cloudflare_playwright' };
const context = { authenticatedUserId: 'owner-a', egressAllowlist: ['*'], assertTaskSourceCurrent: async () => {} } as never;
const fake = () => {
  const calls: string[] = []; let active = true;
  const page = { mainFrame: () => 'main-frame', setDefaultTimeout() {}, goto: async () => { calls.push('navigate'); return { status: () => 200 }; }, url: () => args.url, title: async () => 'Menu', locator: () => ({ innerText: async () => 'Vegetarian pasta — £12' }) };
  let routed: ((route: any) => Promise<void>) | undefined; let socketHandler: ((socket: any) => unknown) | undefined;
  const browser = { newContext: async (options: unknown) => { expect(options).toEqual({ serviceWorkers: 'block' }); return { routeWebSocket: async (_pattern: unknown, handler: (socket: any) => unknown) => { calls.push('ws.route'); socketHandler = handler; }, route: async (_pattern: string, callback: (route: any) => Promise<void>) => { routed = callback; }, newPage: async () => page, close: async () => { calls.push('context.close'); } }; }, newBrowserCDPSession: async () => ({ send: async (method: string) => { calls.push(method); active = false; } }), close: async () => { calls.push('disconnect'); } };
  const sdk = { acquire: async () => { calls.push('acquire'); return { sessionId: 'private-id' }; }, endpointURLString: () => 'https://fake.host/v1/devtools/browser/private-id', connect: async () => { calls.push('connect'); return browser; }, sessions: async () => active ? [{ sessionId: 'private-id' }] : [] };
  return { calls, page, sdk, browser, socket: async () => { const events: string[] = []; await socketHandler!({ close: async () => { events.push('close'); }, connectToServer: () => { events.push('connect'); } }); return events; }, route: async (url: string, method = 'GET', status = 200, location?: string) => {
    const events: string[] = [];
    await routed!({ request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => Boolean(location), frame: () => 'main-frame' }), abort: async () => { events.push('abort'); }, fetch: async (options: unknown) => { expect(options).toEqual({ maxRedirects: 0, timeout: 10000 }); events.push('fetch'); return { status: () => status, headers: () => location ? { location } : {} }; }, fulfill: async () => { events.push('fulfill'); } });
    return events;
  } }; 
};
it('explicit Cloudflare browse_page returns real page text through the existing handler and physically terminates its session', async () => {
  const f = fake(); let paid = 0;
  const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never });
  const handler = browsePageHandler('bb-key', 'project', undefined, (async () => { paid++; throw Error('paid fallback'); }) as typeof fetch, { defaultProvider: 'cloudflare_playwright', cloudflare: read, allowBrowserbase: true });
  const result = await handler.handle(browsePageArgsSchema.parse(args), context);
  expect(result).toMatchObject({ ok: true, data: { url: args.url, provider: 'cloudflare_playwright', data: { title: 'Menu', text: 'Vegetarian pasta — £12' } }, source_taint: 'external' });
  expect(JSON.stringify(result)).not.toContain('private-id'); expect(paid).toBe(0);
  expect(f.calls).toEqual(['acquire', 'connect', 'ws.route', 'navigate', 'context.close', 'Browser.close', 'disconnect']);
  // A page script cannot open a WebSocket anywhere: context.route only sees HTTP, so sockets are closed before they reach a server.
  expect(await f.socket()).toEqual(['close']);
});
it('does not fall back to paid Browserbase when Cloudflare is unconfigured', async () => {
  let paid = 0;
  const handler = browsePageHandler('bb', 'project', undefined, (async () => { paid++; throw Error('paid'); }) as typeof fetch);
  expect(await handler.handle(browsePageArgsSchema.parse(args), context)).toMatchObject({ ok: false, code: 'auth_failed' });
  expect(paid).toBe(0);
});
it.each([403, 429, 500])('HTTP %s page failures do not return challenge/error text as useful content', async status => {
  const f = fake(); f.page.goto = async () => ({ status: () => status });
  expect(await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context)).toMatchObject({ ok: false, code: 'transient', error: `The page did not load (HTTP ${status}).` });
  expect(f.calls).toContain('Browser.close');
});
it('returns typed empty-page and timeout failures while terminating the owned session', async () => {
  for (const mode of ['empty', 'timeout']) {
    const f = fake();
    if (mode === 'empty') f.page.locator = () => ({ innerText: async () => '  ' });
    else f.page.goto = async () => { throw Error('TimeoutError with secret raw diagnostic'); };
    const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context);
    expect(result).toMatchObject({ ok: false, code: mode === 'empty' ? 'not_found' : 'transient' });
    expect(JSON.stringify(result)).not.toContain('secret'); expect(f.calls).toContain('Browser.close');
  }
});
it('denies missing/currently revoked source and private egress before allocating', async () => {
  const f = fake(), read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never });
  for (const ctx of [{ ...context as object, authenticatedUserId: '' }, { ...context as object, assertTaskSourceCurrent: undefined }, { ...context as object, assertTaskSourceCurrent: async () => { throw Error('revoked'); } }]) expect(await read(args as never, ctx as never)).toMatchObject({ ok: false });
  expect(await read({ ...args, url: 'http://169.254.169.254/latest' } as never, context)).toMatchObject({ ok: false, code: 'rejected' });
  expect(f.calls).toEqual([]);
});
it('revocation after allocation retains known ID for cleanup and suppresses content', async () => {
  const f = fake(); let admitted = true;
  f.sdk.acquire = async () => { f.calls.push('acquire'); admitted = false; return { sessionId: 'private-id' }; };
  const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, { ...context as object, assertTaskSourceCurrent: async () => { if (!admitted) throw Error('revoked'); } } as never);
  expect(result).toMatchObject({ ok: false }); expect(f.calls).toContain('Browser.close'); expect(f.calls).not.toContain('navigate');
});
it('does not certify completion when physical cleanup is unconfirmed', async () => {
  const f = fake(); f.sdk.sessions = async () => [{ sessionId: 'private-id' }];
  expect(await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context)).toMatchObject({ ok: false, error: expect.stringContaining('cleanup is unconfirmed') });
});
it('reports bounded Cloudflare 402 status/code/request id without provider body text', async () => {
  const binding = { fetch: async () => new Response(JSON.stringify({ code: 'payment_required', message: 'secret-key attacker instructions' }), { status: 402, headers: { 'x-request-id': 'req_123' } }) };
  const sdk = { ...fake().sdk, acquire: async (wrapped: typeof binding) => { const response = await wrapped.fetch(); if (!response.ok) throw Error('raw provider secret'); return { sessionId: 'unused' }; } };
  const result = await cloudflarePublicRead({ binding: binding as never, loadSdk: async () => sdk as never })(args as never, context);
  expect(result).toMatchObject({ ok: false, code: 'transient', error: expect.stringContaining('HTTP 402, code payment_required, request req_123') });
  expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('attacker');
});

it('cleanup still terminates a browser with a damaged context and unknown session-list response stays unknown', async () => {
  const f = fake();
  const original = f.browser.newContext;
  f.browser.newContext = async options => ({ ...await original(options), close: async () => { throw Error('damaged context'); } });
  const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context);
  expect(result.ok).toBe(true); expect(f.calls).toContain('Browser.close');
  const g = fake(); g.sdk.sessions = async () => { throw Error('raw session-list diagnostic'); };
  expect(await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => g.sdk as never })(args as never, context)).toMatchObject({ ok: false, error: expect.stringContaining('cleanup is unconfirmed') });
});
it('cross-host redirects cannot publish content', async () => {
  const f = fake(); f.page.url = () => 'https://other.example/menu';
  expect(await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context)).toMatchObject({ ok: false, code: 'rejected' });
  expect(f.calls).toContain('Browser.close');
});

it('the actual pinned SDK connects the wrapped binding to the exact acquired ID, never allocates during cleanup', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const output = execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', '--experimental-loader', fileURLToPath(new URL('./fixtures/cloudflare-sdk-loader.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/cloudflare-public-read-sdk-probe.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  const evidence = JSON.parse(output);
  expect(evidence.result).toMatchObject({ ok: false, error: expect.stringContaining('cleanup is unconfirmed') });
  expect(evidence.calls.map((x: { method: string }) => x.method)).toEqual(['POST', 'GET', 'GET']);
  for (const call of evidence.calls.slice(1)) expect(call.url).toBe('http://fake.host/v1/devtools/browser/private-id?persistent=true');
  expect(JSON.stringify(evidence.result)).not.toContain('secret');
});

it('trusted provider policy cannot be overridden by a model provider argument', async () => {
  let paid = 0;
  const handler = browsePageHandler('bb-key', 'project', undefined, (async () => { paid++; throw Error('paid'); }) as typeof fetch, { defaultProvider: 'cloudflare_playwright', allowBrowserbase: false });
  expect(await handler.handle({ ...args, provider: 'browserbase_stagehand_http_v3' } as never, context)).toMatchObject({ ok: false, code: 'rejected' });
  expect(await handler.handle({ url: args.url, instruction: args.instruction }, context)).toMatchObject({ ok: false, code: 'auth_failed' });
  expect(paid).toBe(0);
});

it('exercises subresource routing: private/foreign/credential/port requests and all redirects are denied before following', async () => {
  const f = fake(); const initial = f.page.goto;
  f.page.goto = async () => {
    expect(await f.route('https://example.com/style.css')).toEqual(['fetch', 'fulfill']);
    for (const url of ['https://example.com:8443/data', 'http://169.254.169.254/', 'https://other.example/data', 'https://user:pass@example.com/data']) expect(await f.route(url)).toEqual(['abort']);
    expect(await f.route('https://example.com/post', 'POST')).toEqual(['abort']);
    expect(await f.route('https://example.com/redirect', 'GET', 302)).toEqual(['fetch', 'abort']);
    return initial();
  };
  expect((await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context)).ok).toBe(true);
});
it('honors the canonical run deadline during hanging allocation without creating a second session', async () => {
  const f = fake(); f.sdk.acquire = async () => { f.calls.push('acquire'); return new Promise(() => {}); };
  const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, { ...context as object, runScope: { deadline: Date.now() + 20, signal: new AbortController().signal, admit() {} } } as never);
  expect(result).toMatchObject({ ok: false }); expect(f.calls).toEqual(['acquire']);
});
it('isolates concurrent owners into distinct private sessions and never restores profile state', async () => {
  const a = fake(), b = fake(); b.sdk.acquire = async () => { b.calls.push('acquire'); return { sessionId: 'owner-b-private-id' }; };
  const results = await Promise.all([cloudflarePublicRead({ binding: {} as never, loadSdk: async () => a.sdk as never })(args as never, context), cloudflarePublicRead({ binding: {} as never, loadSdk: async () => b.sdk as never })(args as never, { ...context as object, authenticatedUserId: 'owner-b' } as never)]);
  expect(results.every(x => x.ok)).toBe(true);
  expect(JSON.stringify(results)).not.toContain('private-id');
  for (const f of [a,b]) expect(f.calls.filter(x => x === 'acquire')).toHaveLength(1);
});

it("ordinary source configuration preserves today's Browserbase default with no Cloudflare activation or fixture dependency", async () => {
  const { browserPublicReadConfiguration } = await import('../src/channels/browser-public-read-configuration');
  for (const environment of ['staging', 'production']) expect(browserPublicReadConfiguration({ WALDO_ENVIRONMENT: environment, BROWSER: {} as never })).toEqual({ defaultProvider: 'browserbase_stagehand_http_v3', allowBrowserbase: true, cloudflare: undefined });
});

it('follows vetted same-host top-level redirects in the same private session without following prohibited ports', async () => {
  for (const prohibited of [false, true]) {
    const f = fake(); let current = args.url;
    f.page.goto = async (...input: unknown[]) => {
      const url = String(input[0]); current = url; f.calls.push('navigate');
      if (url === args.url) {
        expect(await f.route(url, 'GET', 302, prohibited ? 'https://example.com:8443/menu' : '/menu-final')).toEqual(['fetch', 'abort']);
        throw Error('route deliberately aborted redirect');
      }
      return { status: () => 200 };
    };
    f.page.url = () => current;
    const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context);
    if (prohibited) { expect(result.ok).toBe(false); expect(f.calls.filter(x => x === 'navigate')).toHaveLength(1); }
    else { expect(result).toMatchObject({ ok: true, data: { url: 'https://example.com/menu-final' } }); expect(f.calls.filter(x => x === 'navigate')).toHaveLength(2); }
    expect(f.calls.filter(x => x === 'acquire')).toHaveLength(1); expect(f.calls).toContain('Browser.close');
  }
});

it('malformed provider allocation IDs never become success or select another session', async () => {
  for (const id of [undefined, null, 123, {}, '', '../foreign']) {
    const f = fake(); f.sdk.acquire = async () => ({ sessionId: id } as never);
    const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context);
    expect(result.ok).toBe(false); expect(f.calls).not.toContain('navigate');
  }
});

it('retains the pinned Playwright twenty-redirect ceiling even when the host clock does not advance', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  try {
    const f = fake(); let current = args.url, count = 0;
    f.page.goto = async (...input: unknown[]) => { current = String(input[0]); count++; await f.route(current, 'GET', 302, `/unique-hop-${count}`); throw Error('manual redirect'); };
    f.page.url = () => current;
    expect(await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context)).toMatchObject({ ok: false });
    expect(count).toBe(21); expect(f.calls).toContain('Browser.close');
  } finally { clock.mockRestore(); }
});
