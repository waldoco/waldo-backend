import { expect, it } from 'vitest';
import * as candidate from '../src/channels/public-fixture-browser';

const manifest = { origin: 'https://fixture.example', pagePath: '/form', submitPath: '/submit', receiptPrefix: '/receipt/', runId: 'run-one', fields: ['value'], formSelector: '#form', submitSelector: '#submit', resultSelector: '#result' };
const harness = (m = manifest, onSubmit?: () => void) => {
  const calls: Array<{ method: string; value?: unknown }> = [];
  let currentUrl = `${m.origin}${m.pagePath}`, pages = 1, closed = false, clicks = 0;
  class Input { tagName = 'INPUT'; name = 'value'; type = 'text'; disabled = false; private text = 'synthetic initial'; get value() { return this.text; } set value(value: string) { this.text = value; } dispatchEvent() { return true; } }
  const input = new Input();
  const overrides = new Map<string, string>();
  class Element { click() { clicks++; onSubmit?.(); } }
  const submit = Object.assign(new Element(), { tagName: 'BUTTON', type: 'submit', disabled: false, form: undefined as unknown, getAttribute: (name: string) => overrides.get(name) ?? null });
  const form = { elements: [input, submit], target: '', enctype: 'application/x-www-form-urlencoded', id: 'form', tagName: 'FORM', method: 'post', action: `${m.origin}${m.submitPath}`, ownerDocument: { defaultView: { HTMLElement: Element, HTMLInputElement: Input, location: { get href() { return currentUrl; } } } }, querySelectorAll: () => [input], querySelector: () => submit };
  submit.form = form;
  const page = { url: () => currentUrl, setDefaultTimeout: () => {}, goto: async (url: string) => { calls.push({ method: 'navigate' }); currentUrl = url; }, locator: () => ({ evaluate: async (fn: (form: unknown, args: unknown) => unknown, args: unknown) => { calls.push({ method: 'evaluate' }); return fn(form, args); } }) };
  const context = { pages: () => Array(pages).fill(page), newPage: async () => page, route: async () => {}, unroute: async () => {} };
  const sdk = { acquire: async (_binding: unknown, options: unknown) => { calls.push({ method: 'acquire', value: options }); return { sessionId: 'retained-session' }; }, endpointURLString: (_binding: unknown, options: { sessionId: string }) => `http://fake.host/v1/devtools/browser/${options.sessionId}?browser_binding=BROWSER`, connect: async (url: URL) => { calls.push({ method: 'connect', value: String(url) }); return { contexts: () => [context], close: async () => { calls.push({ method: 'disconnect' }); }, newBrowserCDPSession: async () => ({ send: async (method: string) => { calls.push({ method }); closed = true; } }) }; }, sessions: async () => closed ? [] : [{ sessionId: 'retained-session' }] };
  return { calls, sdk, input, overrideSubmit: (name: string, value: string) => overrides.set(name, value), poisonClick: () => Object.defineProperty(submit, 'click', { get() { throw Error('page-owned click accessor'); } }), clicks: () => clicks, setUrl: (url: string) => { currentUrl = url; }, setPages: (count: number) => { pages = count; } };
};
it('acquires once with latched guards, then reconnects the exact dedicated ID through public connect', async () => {
  const f = harness();
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never, fetcher: (async () => new Response('not issued', { status: 404 })) as typeof fetch });
  const id = await driver.start(10000);
  const observed = await driver.inspect(id);
  expect(observed).toMatchObject({ url: 'https://fixture.example/form', binding: { value: 'synthetic initial' } });
  expect(f.calls).toEqual([{ method: 'acquire', value: { recording: false, keep_alive: 10000, guardrails: { allowedDomains: ['fixture.example'] } } }, { method: 'connect', value: 'http://fake.host/v1/devtools/browser/retained-session?browser_binding=BROWSER&persistent=true' }, { method: 'evaluate' }, { method: 'disconnect' }]);
});

it('the actual pinned SDK does not acquire on retained-ID expiry or transport error', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  for (const status of [404, 503]) {
    const output = execFileSync(process.execPath, ['--no-warnings', '--experimental-loader', fileURLToPath(new URL('./fixtures/cloudflare-sdk-loader.mjs', import.meta.url)), fileURLToPath(new URL('./fixtures/cloudflare-sdk-connect-probe.mjs', import.meta.url)), String(status)], { encoding: 'utf8', timeout: 10000 });
    expect(JSON.parse(output)).toEqual([{ url: 'http://fake.host/v1/devtools/browser/retained-session?persistent=true', method: 'GET', body: null }]);
  }
});

it('keeps SDK-load, endpoint and connection diagnostics private', async () => {
  const secret = 'private-session https://internal.example/credential';
  for (const phase of ['load', 'endpoint', 'connect']) {
    const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => {
      if (phase === 'load') throw Error(secret);
      return { endpointURLString: () => { if (phase === 'endpoint') throw Error(secret); return 'http://fake.host/v1/devtools/browser/retained-session?browser_binding=BROWSER'; }, connect: async () => { throw Error(secret); } } as never;
    } });
    await expect(driver.inspect('retained-session')).rejects.toThrow(/^browser fixture operation unavailable$/);
  }
});

it('fills native state across reconnects and refuses an empty fill before any DOM change', async () => {
  const f = harness();
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never, fetcher: (async () => new Response('not issued', { status: 404 })) as typeof fetch });
  const snapshot = await driver.inspect('retained-session');
  await driver.fill('retained-session', 'value', 'synthetic filled', snapshot.stateDigest, async () => {});
  expect(await driver.inspect('retained-session')).toMatchObject({ binding: { value: 'synthetic filled' } });
  const filled = await driver.inspect('retained-session');
  await expect(driver.fill('retained-session', 'value', '', filled.stateDigest, async () => {})).rejects.toThrow('browser fixture fill rejected');
  expect(f.input.value).toBe('synthetic filled');
});

it('checks the exact URL in the final native submit turn after async host approval', async () => {
  const f = harness();
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never, fetcher: (async () => new Response('not issued', { status: 404 })) as typeof fetch });
  const snapshot = await driver.inspect('retained-session');
  await expect(driver.submit('retained-session', snapshot.stateDigest, async () => { f.setUrl('https://fixture.example/other'); })).rejects.toThrow('browser fixture operation unavailable');
  expect(f.clicks()).toBe(0);
});

it('rechecks approval synchronously after the last source await before native submit', async () => {
  const f = harness(); let approved = true, afterBefore = false;
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never });
  const snapshot = await driver.inspect('retained-session');
  await expect(driver.submit('retained-session', snapshot.stateDigest, async () => { afterBefore = true; },
    async () => { if (afterBefore) queueMicrotask(() => { approved = false; }); },
    () => { if (!approved) throw Error('approval withdrawn'); })).rejects.toThrow('browser fixture operation unavailable');
  expect(approved).toBe(false); expect(f.clicks()).toBe(0);
});

it('terminates the retained browser even when unexpected pages violate inspection', async () => {
  const f = harness(); f.setPages(2);
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never, fetcher: (async () => new Response('not issued', { status: 404 })) as typeof fetch });
  await expect(driver.inspect('retained-session')).rejects.toThrow('browser fixture operation unavailable');
  await driver.end('retained-session');
  expect(f.calls.filter(call => call.method === 'Browser.close')).toHaveLength(1);
  expect(f.calls.filter(call => call.method === 'acquire')).toHaveLength(0);
});

it('refuses submit-control destination overrides and bypasses a page-owned click accessor', async () => {
  const f = harness();
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never, fetcher: (async () => new Response('not issued', { status: 404 })) as typeof fetch });
  const snapshot = await driver.inspect('retained-session');
  f.overrideSubmit('formaction', '/unapproved');
  await expect(driver.submit('retained-session', snapshot.stateDigest, async () => {})).rejects.toThrow('browser fixture operation unavailable');
  expect(f.clicks()).toBe(0);
});

it('uses the native click method rather than invoking a page-owned click accessor', async () => {
  const f = harness();
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never, fetcher: (async () => new Response('not issued', { status: 404 })) as typeof fetch });
  const snapshot = await driver.inspect('retained-session'); f.poisonClick();
  await driver.submit('retained-session', snapshot.stateDigest, async () => {});
  expect(f.clicks()).toBe(1);
});

it('verifies only the authoritative task-scoped synthetic receipt, without trusting page text', async () => {
  const { createFixture } = await import('./fixtures/browser-workspace-server');
  const host = await createFixture({ runId: 'run-one', approvedBinding: { value: 'synthetic filled' }, nonceFactory: () => crypto.randomUUID(), clock: () => new Date('2026-10-03T12:00:00Z') });
  try {
    const html = await (await fetch(host.pageUrl)).text();
    const state = JSON.parse(html.match(/<script id="fixture-state" type="application\/json">(.*?)<\/script>/s)![1]!);
    const m = { ...manifest, pagePath: '/fixture/run-one/page', submitPath: '/fixture/run-one/submit', receiptPrefix: '/fixture/run-one/receipt/' };
    const f = harness();
    const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest: m, loadSdk: async () => f.sdk as never, fetcher: (async (url, init) => fetch(String(url).replace(m.origin, host.baseUrl), init as never)) as typeof fetch });
    const digest = await candidate.fixtureDigest([['value', 'synthetic filled']]);
    expect(await driver.verify(digest)).toBeNull();
    await fetch(`${host.baseUrl}/fixture/run-one/submit`, { method: 'POST', headers: { origin: host.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify(state) });
    expect(await driver.verify(digest)).toMatchObject({ source: 'controlled_fixture', binding_digest: digest });
    expect(await driver.verify(`sha256:${'f'.repeat(64)}`)).toBeNull();
    await expect(driver.start(10000)).rejects.toThrow('browser fixture session unavailable');
    expect(f.calls.filter(call => call.method === 'acquire')).toHaveLength(0);
  } finally { await host.close(); }
});

it('rejects malformed or oversized receipt bodies without exposing provider diagnostics', async () => {
  for (const response of [new Response('x'.repeat(5000)), Response.json({ state: 'acknowledged_fixture', bindingDigest: 'a'.repeat(64), secret: 'provider-private' }), new Response('provider-private', { status: 502 })]) {
    const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, fetcher: (async () => response.clone()) as typeof fetch, loadSdk: async () => { throw Error('must not connect for receipt'); } });
    await expect(driver.verify(`sha256:${'a'.repeat(64)}`)).rejects.toThrow(/^browser fixture receipt unavailable$/);
  }
});

it('runs the durable inspect/fill/approve/submit/readback slice through native DOM functions and a real fixture ledger', async () => {
  const { createFixture } = await import('./fixtures/browser-workspace-server');
  const { browserTaskContinuity } = await import('../src/channels/browser-task-continuity');
  const host = await createFixture({ runId: 'run-one', approvedBinding: { value: 'synthetic approved' }, nonceFactory: () => crypto.randomUUID(), clock: () => new Date('2026-10-03T12:00:00Z') });
  try {
    const html = await (await fetch(host.pageUrl)).text();
    const privateState = JSON.parse(html.match(/<script id="fixture-state" type="application\/json">(.*?)<\/script>/s)![1]!);
    const m = { ...manifest, pagePath: '/fixture/run-one/page', submitPath: '/fixture/run-one/submit', receiptPrefix: '/fixture/run-one/receipt/' };
    let sending: Promise<Response> | undefined;
    const f = harness(m, () => { sending = fetch(`${host.baseUrl}${m.submitPath}`, { method: 'POST', headers: { origin: host.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ runId: privateState.runId, token: privateState.token, binding: { value: f.input.value } }) }); });
    const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest: m, loadSdk: async () => f.sdk as never, fetcher: (async (url, init) => fetch(String(url).replace(m.origin, host.baseUrl), init as never)) as typeof fetch });
    let stored: unknown = null, lock: Promise<unknown> = Promise.resolve();
    const store: import('../src/channels/browser-task-continuity').BrowserTaskStore = { exclusive: async work => { const next = lock.then(work); lock = next.catch(() => undefined); return next; }, load: async () => stored, save: async row => { stored = structuredClone(row); } };
    const options = { enabled: true, ownerId: 'owner-a', taskId: 'run-one', manifestDigest: await candidate.fixtureDigest(m), driver, store, now: () => 100, newId: () => crypto.randomUUID(), admit: async () => 'host-scoped-grant' };
    const first = browserTaskContinuity(options);
    await first.open('owner-a', 10000); await first.fill('owner-a', 'value', 'synthetic approved');
    const resumed = browserTaskContinuity(options); const proposal = await resumed.propose('owner-a');
    const initial = await resumed.submit('owner-a', proposal.id, 'exact-owner-approval');
    expect(['verified_with_receipt', 'uncertain']).toContain(initial.status);
    await sending;
    expect(await resumed.reconcile('owner-a')).toMatchObject({ status: 'verified_with_receipt', receipt: { binding_digest: proposal.bindingDigest, action_digest: proposal.actionDigest } });
    expect(f.clicks()).toBe(1);
    expect(f.calls.filter(call => call.method === 'acquire')).toHaveLength(1);
    expect(JSON.stringify(proposal)).not.toContain('retained-session');
    expect(JSON.stringify(stored)).not.toContain(privateState.token);
  } finally { await host.close(); }
});

it.each(['start', 'navigate', 'inspect', 'fill', 'submit'])('fences %s after SDK load before any acquire/connect/DOM operation', async operation => {
  const f = harness(); let allowed = true;
  const source = async () => { if (!allowed) throw Error('source withdrawn'); };
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => { allowed = false; return f.sdk as never; }, fetcher: (async () => new Response('', { status: 404 })) as typeof fetch });
  const digest = await candidate.fixtureDigest('synthetic');
  const action = operation === 'start' ? driver.start(10000, source) : operation === 'navigate' ? driver.navigate('retained-session', source) : operation === 'inspect' ? driver.inspect('retained-session', source) : operation === 'fill' ? driver.fill('retained-session', 'value', 'new', digest, async () => {}, source) : driver.submit('retained-session', digest, async () => {}, source);
  await expect(action).rejects.toThrow('unavailable'); expect(f.calls).toEqual([]); expect(f.input.value).toBe('synthetic initial'); expect(f.clicks()).toBe(0);
  await driver.end('retained-session'); expect(f.calls.some(call => call.method === 'Browser.close')).toBe(true);
});
it('denies receipt HTTP reads when the captured source is withdrawn', async () => {
  let reads = 0;
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, fetcher: (async () => { reads++; return new Response('', { status: 404 }); }) as typeof fetch });
  await expect(driver.verify(`sha256:${'a'.repeat(64)}`, async () => { throw Error('source withdrawn'); })).rejects.toThrow('unavailable'); expect(reads).toBe(0);
});
it('does not extract DOM after scope changes during provider connection and disconnects the known browser', async () => {
  const f = harness(); let allowed = true; const connect = f.sdk.connect;
  f.sdk.connect = async url => { const browser = await connect(url); allowed = false; return browser; };
  const driver = candidate.publicFixtureBrowser({ binding: {} as never, manifest, loadSdk: async () => f.sdk as never });
  await expect(driver.inspect('retained-session', async () => { if (!allowed) throw Error('source withdrawn'); })).rejects.toThrow('unavailable');
  expect(f.calls.map(c => c.method)).toEqual(['connect', 'disconnect']);
});
