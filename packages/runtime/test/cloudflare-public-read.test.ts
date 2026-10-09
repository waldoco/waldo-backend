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
  expect(evidence.result.error).toContain('HTTP 503');
  expect(evidence.result.error).toContain('Read stage: connection.');
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

it('settles only measured duration from before acquire through validated absence readback',async()=>{
 const f=fake(),settle=vi.fn();let now=1700000000000;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
 const acquire=f.sdk.acquire,sessions=f.sdk.sessions;
 f.sdk.acquire=async()=>{now+=1500;return acquire();};
 f.sdk.sessions=async()=>{now+=2500;return sessions();};
 try{
  expect(await cloudflarePublicRead({binding:{} as never,loadSdk:async()=>f.sdk as never,reserveAllocation:async()=>({settle})})(args as never,context)).toMatchObject({ok:true});
  expect(settle).toHaveBeenCalledExactlyOnceWith(4000);expect(f.calls).toContain('Browser.close');
 }finally{clock.mockRestore();}
});
it.each([undefined,null,{},[{}],[null],[{sessionId:123}],[{sessionId:'../bad'}],[{sessionId:'other'},{sessionId:'other'}]])('malformed session-list evidence cannot certify absence or settle a reserve: %j',async response=>{
 const f=fake(),settle=vi.fn();f.sdk.sessions=async()=>response as never;
 expect(await cloudflarePublicRead({binding:{} as never,loadSdk:async()=>f.sdk as never,reserveAllocation:async()=>({settle})})(args as never,context)).toMatchObject({ok:false,error:expect.stringContaining('cleanup is unconfirmed')});
 expect(settle).not.toHaveBeenCalled();
});
it('an owned session still listed after cleanup never settles, while a valid foreign session does not prevent exact absence',async()=>{
 for(const id of ['private-id','other-id']){
  const f=fake(),settle=vi.fn();f.sdk.sessions=async()=>[{sessionId:id}];
  const result=await cloudflarePublicRead({binding:{} as never,loadSdk:async()=>f.sdk as never,reserveAllocation:async()=>({settle})})(args as never,context);
  expect(result.ok).toBe(id==='other-id');expect(settle).toHaveBeenCalledTimes(id==='other-id'?1:0);
 }
});
it('lost allocation identity and late acquire completion retain the full reserve without false zero settlement',async()=>{
 vi.useFakeTimers();
 try{
  const f=fake(),settle=vi.fn();let finish:((session:{sessionId:string})=>void)|undefined;
  f.sdk.acquire=async()=>{f.calls.push('acquire');return new Promise(resolve=>{finish=resolve;});};
  const read=cloudflarePublicRead({binding:{} as never,loadSdk:async()=>f.sdk as never,reserveAllocation:async()=>({settle})})(args as never,{...context as object,runScope:{deadline:Date.now()+20,admit(){}}} as never);
  await vi.advanceTimersByTimeAsync(21);expect(await read).toMatchObject({ok:false});
  expect(f.calls).toEqual(['acquire']);expect(settle).not.toHaveBeenCalled();
  finish!({sessionId:'private-id'});await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls).toEqual(['acquire']);expect(settle).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});
it('a late absence readback cannot settle after cleanup has timed out',async()=>{
 vi.useFakeTimers();
 try{
  const f=fake(),settle=vi.fn();let finish:((sessions:never[])=>void)|undefined;
  f.sdk.sessions=async()=>new Promise(resolve=>{finish=resolve;});
  const read=cloudflarePublicRead({binding:{} as never,loadSdk:async()=>f.sdk as never,reserveAllocation:async()=>({settle})})(args as never,context);
  await vi.advanceTimersByTimeAsync(10001);expect(await read).toMatchObject({ok:false,error:expect.stringContaining('cleanup is unconfirmed')});
  finish!([]);await vi.advanceTimersByTimeAsync(1);expect(settle).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});
it('malformed allocation IDs never settle and settlement failure is not reported as completion',async()=>{
 const f=fake(),settle=vi.fn();f.sdk.acquire=async()=>({sessionId:undefined} as never);
 expect(await cloudflarePublicRead({binding:{} as never,loadSdk:async()=>f.sdk as never,reserveAllocation:async()=>({settle})})(args as never,context)).toMatchObject({ok:false});expect(settle).not.toHaveBeenCalled();
 const g=fake();expect(await cloudflarePublicRead({binding:{} as never,loadSdk:async()=>g.sdk as never,reserveAllocation:async()=>({settle(){throw Error('private storage detail');}})})(args as never,context)).toMatchObject({ok:false,error:'The Cloudflare browser cost settlement is unconfirmed.'});
});

it('waits for delayed session disappearance before releasing content or settling duration', async () => {
  vi.useFakeTimers();
  try {
    const f = fake(), settle = vi.fn(), observations: number[] = [];
    const startedAt = Date.now();
    f.sdk.sessions = async () => { observations.push(Date.now() - startedAt); return observations.length < 3 ? [{ sessionId: 'private-id' }] : []; };
    let completed = false;
    const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle }) })(args as never, context).then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false); expect(settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(observations).toEqual([0]); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(251);
    expect(await read).toMatchObject({ ok: true });
    expect(observations).toEqual([0, 250, 500]); expect(settle).toHaveBeenCalledExactlyOnceWith(500);
    expect(f.calls.filter(call => call === 'acquire')).toHaveLength(1);
    expect(f.calls.filter(call => call === 'connect')).toHaveLength(1);
    expect(f.calls.filter(call => call === 'Browser.close')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it.each(['http', 'empty', 'thrown'] as const)('preserves the original safe %s failure separately from unconfirmed cleanup', async mode => {
  vi.useFakeTimers();
  try {
    const f = fake(), settle = vi.fn();
    f.sdk.sessions = async () => [{ sessionId: 'private-id' }];
    if (mode === 'http') f.page.goto = async () => ({ status: () => 403 });
    if (mode === 'empty') f.page.locator = () => ({ innerText: async () => '' });
    if (mode === 'thrown') f.page.goto = async () => { throw Error('secret-provider https://private.example/private-id'); };
    const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle }) })(args as never, context);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await read;
    expect(result).toMatchObject({ ok: false, code: mode === 'empty' ? 'not_found' : 'transient' });
    expect(result).toMatchObject({ error: expect.stringContaining(mode === 'http' ? 'HTTP 403' : mode === 'empty' ? 'no readable content' : 'browser read failed') });
    expect(result).toMatchObject({ error: expect.stringContaining(`Read stage: ${mode === 'empty' ? 'content' : 'navigation'}.`) });
    expect(result).toMatchObject({ error: expect.stringContaining('cleanup is unconfirmed') });
    expect(JSON.stringify(result)).not.toMatch(/secret-provider|private\.example|private-id|Vegetarian|https:/);
    expect(settle).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('rejects absence returned after the cleanup deadline even before the timeout callback runs', async () => {
  const f = fake(), settle = vi.fn(); let now = 1700000000000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  f.sdk.sessions = async () => { now += 10000; return []; };
  try {
    const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle }) })(args as never, context);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cleanup is unconfirmed') });
    expect(settle).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it('bounds valid still-present observations and retains the full reservation', async () => {
  vi.useFakeTimers();
  try {
    const f = fake(), settle = vi.fn(), observations: number[] = []; const startedAt = Date.now();
    f.sdk.sessions = async () => { observations.push(Date.now() - startedAt); return [{ sessionId: 'private-id' }]; };
    const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle }) })(args as never, context);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await read).toMatchObject({ ok: false, error: expect.stringContaining('cleanup is unconfirmed') });
    expect(observations).toEqual([0, 250, 500, 750]); expect(settle).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call === 'acquire')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('does not extend the cleanup deadline to finish an absence retry wait', async () => {
  vi.useFakeTimers();
  try {
    const f = fake(), settle = vi.fn(); let observations = 0, completed = false;
    f.sdk.sessions = async () => { observations++; await new Promise(resolve => setTimeout(resolve, 9900)); return [{ sessionId: 'private-id' }]; };
    const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle }) })(args as never, context).then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(9900); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await read).toMatchObject({ ok: false, error: expect.stringContaining('cleanup is unconfirmed') });
    expect(observations).toBe(1); expect(settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(observations).toBe(1);
  } finally { vi.useRealTimers(); }
});

it('rechecks the original source and run fence after delayed absence without releasing stale content', async () => {
  vi.useFakeTimers();
  try {
    for (const fence of ['source', 'deadline']) {
      const f = fake(), settle = vi.fn(); let observations = 0, current = true;
      const deadline = Date.now() + 100;
      f.sdk.sessions = async () => { if (++observations === 1) return [{ sessionId: 'private-id' }]; current = false; return []; };
      const read = cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle }) })(args as never, {
        ...context as object,
        assertTaskSourceCurrent: async () => { if (fence === 'source' && !current) throw Error('private source error'); },
        runScope: { deadline: fence === 'deadline' ? deadline : Infinity, admit() {} },
      } as never);
      await vi.advanceTimersByTimeAsync(250);
      const result = await read;
      expect(result).toMatchObject({ ok: false, code: 'rejected', error: 'The browser source permission changed before the result was returned.' });
      expect(JSON.stringify(result)).not.toMatch(/private-id|private source|Vegetarian|https:/);
      expect(settle).toHaveBeenCalledExactlyOnceWith(250);
      expect(f.calls.filter(call => call === 'acquire')).toHaveLength(1);
    }
  } finally { vi.useRealTimers(); }
});

it('preserves a rejected read and its stage when physical absence is valid but settlement fails', async () => {
  const f = fake(); f.page.url = () => 'https://other.example/menu';
  const result = await cloudflarePublicRead({ binding: {} as never, loadSdk: async () => f.sdk as never, reserveAllocation: async () => ({ settle() { throw Error('private storage details'); } }) })(args as never, context);
  expect(result).toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining('outside the selected public browser target') });
  expect(result).toMatchObject({ error: expect.stringContaining('Read stage: navigation.') });
  expect(result).toMatchObject({ error: expect.stringContaining('cost settlement is unconfirmed') });
  expect(JSON.stringify(result)).not.toMatch(/private storage|private-id|other\.example/);
});
