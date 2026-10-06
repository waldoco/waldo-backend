import { expect, it, vi } from 'vitest';
import { browsePageArgsSchema } from '@waldo/contracts';
import { browsePageHandler } from '../src/tools/live/browser';
import { cloudflarePublicRead } from '../src/channels/cloudflare-public-read';

const args = { url: 'https://example.com/menu', instruction: 'Find vegetarian options', provider: 'cloudflare_playwright' };
const context = { authenticatedUserId: 'owner-a', egressAllowlist: ['*'], assertTaskSourceCurrent: async () => {} } as never;
const fake = () => {
  const calls: string[] = []; let active = true;
  const page = { mainFrame: () => 'main-frame', setDefaultTimeout() {}, goto: async () => { calls.push('navigate'); return { status: () => 200 }; }, url: () => args.url, title: async () => 'Menu', locator: () => ({ innerText: async () => 'Vegetarian pasta — £12' }) };
  let routed: ((route: any) => Promise<void>) | undefined;
  const browser = { newContext: async (options: unknown) => { expect(options).toEqual({ serviceWorkers: 'block' }); return { route: async (_pattern: string, callback: (route: any) => Promise<void>) => { routed = callback; }, newPage: async () => page, close: async () => { calls.push('context.close'); } }; }, newBrowserCDPSession: async () => ({ send: async (method: string) => { calls.push(method); active = false; } }), close: async () => { calls.push('disconnect'); } };
  const sdk = { acquire: async () => { calls.push('acquire'); return { sessionId: 'private-id' }; }, endpointURLString: () => 'https://fake.host/v1/devtools/browser/private-id', connect: async () => { calls.push('connect'); return browser; }, sessions: async () => active ? [{ sessionId: 'private-id' }] : [] };
  return { calls, page, sdk, browser, route: async (url: string, method = 'GET', status = 200, location?: string) => {
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
  expect(f.calls).toEqual(['acquire', 'connect', 'navigate', 'context.close', 'Browser.close', 'disconnect']);
});
it('does not fall back to paid Browserbase when Cloudflare is unconfigured', async () => {
  let paid = 0;
  const handler = browsePageHandler('bb', 'project', undefined, (async () => { paid++; throw Error('paid'); }) as typeof fetch);
  expect(await handler.handle(browsePageArgsSchema.parse(args), context)).toMatchObject({ ok: false, code: 'auth_failed' });
  expect(paid).toBe(0);
});
it('advertises only configured public browsers, with the actual default and no availability guarantee', () => {
  const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => fake().sdk as never });
  for (const [key, project, allowed, expected] of [
    ['key', 'project', true, true], [undefined, 'project', true, false],
    ['key', undefined, true, false], ['key', 'project', false, false],
  ] as const) {
    const handler = browsePageHandler(key, project, undefined, fetch, { defaultProvider: 'cloudflare_playwright', cloudflare: read, allowBrowserbase: allowed });
    expect(handler.description).toContain('Default provider: cloudflare_playwright');
    expect(handler.description.includes('Configured alternatives: browserbase_stagehand_http_v3')).toBe(expected);
    expect(handler.description).toContain('does not guarantee availability');
  }
  const handler = browsePageHandler('key', 'project', undefined);
  expect(handler.description).toContain('Default provider: browserbase_stagehand_http_v3');
  expect(handler.description).not.toContain('cloudflare_playwright');
});
it('reports observed Browserbase extraction without guessing login or blocking, and stamps useful short results', async () => {
  for (const value of ['  ', 'x', 'Please sign in']) {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const operation = String(input).split('/').pop()!; calls.push(operation);
      if (operation === 'start') return Response.json({ success: true, data: { sessionId: 'private-browserbase-session' } });
      if (operation === 'extract') return Response.json({ success: true, data: { result: value } });
      return Response.json({ success: true });
    }) as typeof fetch;
    const result = await browsePageHandler('key', 'project', undefined, fetcher).handle({ url: args.url, instruction: args.instruction }, context);
    if (!value.trim()) expect(result).toMatchObject({ ok: false, error: 'The page returned no readable content.' });
    else expect(result).toMatchObject({ ok: true, data: { provider: 'browserbase_stagehand_http_v3', data: value } });
    expect(result).toMatchObject({ browser_read: { provider: 'browserbase_stagehand_http_v3', phase: value.trim() ? 'complete' : 'extraction', reason: value.trim() ? 'completed' : 'empty_content', cleanup: 'confirmed' } });
    expect(JSON.stringify(result)).not.toContain('private-browserbase-session');
    expect(calls).toEqual(['start', 'navigate', 'extract', 'end']);
  }
});
it('retains observed Browserbase failure when ending the owned session fails', async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const operation = String(input).split('/').pop();
    if (operation === 'start') return Response.json({ success: true, data: { sessionId: 'private-session' } });
    if (operation === 'navigate') return new Response('private provider body', { status: 503 });
    return new Response('private cleanup body', { status: 500 });
  }) as typeof fetch;
  const result = await browsePageHandler('key', 'project', undefined, fetcher).handle({ url: args.url, instruction: args.instruction, provider: 'browserbase_stagehand_http_v3' }, context);
  expect(result).toMatchObject({ ok: false, code: 'rejected', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'navigation', reason: 'provider_http', http_status: 503, cleanup: 'unconfirmed' } });
  expect(JSON.stringify(result)).not.toContain('private');
});
it('offers configured Browserbase only after an eligible observed Cloudflare failure, never calls it', async () => {
  for (const configured of [true, false]) for (const unsafe of [true, false]) {
    const f = fake();
    if (unsafe) f.page.url = () => 'https://foreign.example/';
    else f.page.locator = () => ({ innerText: async () => '' });
    const fetcher = vi.fn(async () => { throw Error('must be explicit'); }) as typeof fetch;
    const handler = browsePageHandler(configured ? 'key' : undefined, 'project', undefined, fetcher, { defaultProvider: 'cloudflare_playwright', cloudflare: cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never }), allowBrowserbase: true });
    const result = await handler.handle(args as never, context);
    expect(result).toMatchObject({ ok: false, browser_read: { configured_alternatives: configured && !unsafe ? ['browserbase_stagehand_http_v3'] : [] } });
    expect(fetcher).not.toHaveBeenCalled();
  }
});
it.each(['deadline', 'cancelled', 'unknown_allocation', 'unconfirmed', 'source'] as const)('never offers or calls an alternative after %s', async mode => {
  const f = fake(); let revoked = false;
  if (mode === 'unknown_allocation') f.sdk.acquire = async () => { throw Error('lost'); };
  if (mode === 'unconfirmed') f.sdk.sessions = async () => [{ sessionId: 'private-id' }];
  if (mode === 'source') f.page.goto = async () => { revoked = true; throw Error('load'); };
  const fetcher = vi.fn(async () => { throw Error('automatic fallback'); }) as typeof fetch;
  const handler = browsePageHandler('key', 'project', undefined, fetcher, { defaultProvider: 'cloudflare_playwright', allowBrowserbase: true, cloudflare: cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never }) });
  const result = await handler.handle(args as never, { ...context as object, runScope: { deadline: mode === 'deadline' ? Date.now() - 1 : Date.now() + 30000, admit() { if (mode === 'cancelled') throw Error('closed'); } }, assertTaskSourceCurrent: async () => { if (revoked) throw Error('revoked'); } } as never);
  expect(result).toMatchObject({ ok: false, code: 'rejected', browser_read: { configured_alternatives: [] } });
  if (mode === 'deadline' || mode === 'cancelled') expect(result).toMatchObject({ browser_read: { reason: mode === 'deadline' ? 'deadline_elapsed' : 'run_closed', cleanup: 'not_started' } });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['x', 'Please sign in to continue'])('leaves nonempty Cloudflare content judgment to the model: %s', async text => {
  const f = fake(); f.page.locator = () => ({ innerText: async () => text });
  expect(await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context)).toMatchObject({ ok: true, data: { data: { text } }, browser_read: { phase: 'complete', reason: 'completed', cleanup: 'confirmed' } });
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
it('keeps the observed Cloudflare read failure distinct from unconfirmed cleanup', async () => {
  const f = fake(); f.page.goto = async () => ({ status: () => 403 });
  f.sdk.sessions = async () => [{ sessionId: 'private-id' }];
  const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, context);
  expect(result).toMatchObject({ ok: false, code: 'rejected', browser_read: {
    provider: 'cloudflare_playwright', phase: 'navigation', reason: 'page_http', http_status: 403, cleanup: 'unconfirmed',
  } });
  if (!result.ok) expect(result.error).toContain('HTTP 403');
  expect(JSON.stringify(result)).not.toContain('private-id');
});
it.each([
  ['empty', 'extraction', 'empty_content', 'confirmed'],
  ['navigate', 'navigation', 'navigation_failed', 'confirmed'],
  ['connect', 'connection', 'provider_failure', 'confirmed'],
  ['source', 'admission', 'source_rejected', 'confirmed'],
  ['redirect', 'navigation', 'unsafe_redirect', 'confirmed'],
  ['session', 'allocation', 'invalid_session', 'unknown_allocation'],
  ['lost', 'allocation', 'provider_failure', 'unknown_allocation'],
] as const)('classifies observed %s failure with phase and cleanup custody', async (mode, phase, reason, cleanup) => {
  const f = fake(); let revoked = false;
  if (mode === 'empty') f.page.locator = () => ({ innerText: async () => ' \t\n' });
  if (mode === 'navigate') f.page.goto = async () => { throw Error('PRIVATE_PROVIDER_BODY'); };
  if (mode === 'connect') { let attempts = 0; const connect = f.sdk.connect; f.sdk.connect = async () => { if (++attempts === 1) throw Error('PRIVATE_PROVIDER_BODY'); return connect(); }; }
  if (mode === 'source') f.page.goto = async () => { revoked = true; return { status: () => 200 }; };
  if (mode === 'redirect') f.page.url = () => 'http://127.0.0.1/private';
  if (mode === 'session') f.sdk.acquire = async () => ({ sessionId: '' });
  if (mode === 'lost') f.sdk.acquire = async () => { throw Error('PRIVATE_PROVIDER_BODY'); };
  const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never })(args as never, { ...context as object, assertTaskSourceCurrent: async () => { if (revoked) throw Error('PRIVATE_SOURCE_BODY'); } } as never);
  expect(result).toMatchObject({ ok: false, browser_read: { provider: 'cloudflare_playwright', phase, reason, cleanup } });
  if (['source', 'redirect', 'session', 'lost'].includes(mode)) expect(result).toMatchObject({ code: 'rejected' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
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
  const sdk = { ...fake().sdk, acquire: async (wrapped: { fetch: typeof fetch }) => { const response = await wrapped.fetch('http://fake.host/v1/devtools/browser', { method: 'POST' }); if (!response.ok) throw Error('raw provider secret'); return { sessionId: 'unused' }; } };
  const result = await cloudflarePublicRead({ binding: binding as never, loadSdk: async () => sdk as never })(args as never, context);
  expect(result).toMatchObject({ ok: false, code: 'transient', error: expect.stringContaining('HTTP 402, code payment_required, request req_123') });
  expect(result).toMatchObject({ browser_read: { provider: 'cloudflare_playwright', phase: 'allocation', reason: 'provider_http', http_status: 402, cleanup: 'allocation_refused' } });
  expect(JSON.stringify(result)).not.toContain('secret'); expect(JSON.stringify(result)).not.toContain('attacker');
});
it('retains an observed allocation refusal status when its diagnostic body stalls past the run deadline', async () => {
  const binding = { fetch: async () => new Response(new ReadableStream(), { status: 402 }) };
  const sdk = { ...fake().sdk, acquire: async (wrapped: { fetch: typeof fetch }) => { await wrapped.fetch('http://fake.host/v1/devtools/browser', { method: 'POST' }); return { sessionId: 'unreachable' }; } };
  const result = await cloudflarePublicRead({ binding: binding as never, loadSdk: async () => sdk as never })(args as never, { ...context as object, runScope: { deadline: Date.now() + 50, admit() {} } } as never);
  expect(result).toMatchObject({ ok: false, code: 'rejected', browser_read: { phase: 'allocation', reason: 'deadline_elapsed', http_status: 402, cleanup: 'allocation_refused' } });
});
it.each([202, 401, 402, 403, 408, 429, 500])('keeps acquire HTTP %s distinct from unknown allocation acknowledgement', async status => {
  const binding = { fetch: async () => new Response('provider body is not evidence', { status }) };
  const sdk = { ...fake().sdk, acquire: async (wrapped: { fetch: typeof fetch }) => {
    const response = await wrapped.fetch('http://fake.host/v1/devtools/browser', { method: 'POST' });
    if (response.status !== 200) throw Error('the pinned SDK rejects every non-200 acquire response');
    return { sessionId: 'unreachable' };
  } };
  const result = await cloudflarePublicRead({ binding: binding as never, loadSdk: async () => sdk as never })(args as never, context);
  expect(result).toMatchObject({ ok: false, browser_read: { phase: 'allocation', reason: 'provider_http', http_status: status, cleanup: [402, 429].includes(status) ? 'allocation_refused' : 'unknown_allocation' } });
  expect(JSON.stringify(result)).not.toContain('provider body is not evidence');
});
it('rechecks Browserbase source custody after cleanup before publishing content', async () => {
  let revoked = false;
  const fetcher = (async (input: RequestInfo | URL) => {
    const operation = String(input).split('/').pop();
    if (operation === 'start') return Response.json({ success: true, data: { sessionId: 'private-session' } });
    if (operation === 'extract') return Response.json({ success: true, data: { result: 'useful content' } });
    if (operation === 'end') revoked = true;
    return Response.json({ success: true });
  }) as typeof fetch;
  const result = await browsePageHandler('key', 'project', undefined, fetcher).handle({ url: args.url, instruction: args.instruction }, { ...context as object, assertTaskSourceCurrent: async () => { if (revoked) throw Error('revoked'); } } as never);
  expect(result).toMatchObject({ ok: false, code: 'rejected', browser_read: { phase: 'admission', reason: 'source_rejected', cleanup: 'confirmed' } });
  expect(JSON.stringify(result)).not.toContain('useful content');
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
