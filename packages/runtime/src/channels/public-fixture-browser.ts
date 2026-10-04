import type { Browser, BrowserWorker, Page } from '@cloudflare/playwright';
import { browserBoundedJson } from './browser-bounded-body';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';

export type FixtureManifest = Readonly<{
  origin: string; pagePath: string; submitPath: string; receiptPrefix: string; runId: string;
  fields: readonly string[]; formSelector: string; submitSelector: string; resultSelector: string;
}>;
type Sdk = Pick<typeof import('@cloudflare/playwright'), 'acquire' | 'connect' | 'endpointURLString' | 'sessions'>;
export type BrowserSourceGuard = () => Promise<void>;
const admitted: BrowserSourceGuard = async () => {};
export type FixtureState = Readonly<{ url: string; values: Record<string, string>; target: string; method: string; disabled: boolean }>;
export type FixtureObservation = Readonly<{ url: string; stateDigest: string; binding: Readonly<Record<string, string>> }>;
export const fixtureDigest = async (value: unknown) => `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(x => x.toString(16).padStart(2, '0')).join('')}`;

// This function is trusted host code evaluated against a configured synthetic
// form. It is not an arbitrary model evaluate tool or an account/login driver.
function nativeForm(form: any, args: { manifest: FixtureManifest; expected?: string; action?: { kind: 'fill'; field: string; value: string } | { kind: 'submit' } }): FixtureState {
  const m = args.manifest;
  if (!form || form.tagName !== 'FORM' || form.id !== m.formSelector.slice(1)) throw Error('fixture form changed');
  const controls = Array.from(form.elements) as any[];
  const inputs = controls.filter(control => control.tagName === 'INPUT');
  if (inputs.length !== m.fields.length) throw Error('fixture fields changed');
  const values: Record<string, string> = {};
  for (const name of m.fields) {
    const matches = inputs.filter(input => input.name === name);
    if (matches.length !== 1 || !['text', 'email'].includes(matches[0].type) || matches[0].disabled || !matches[0].value || matches[0].value.length > 1000) throw Error('fixture field changed');
    values[name] = matches[0].value;
  }
  const submit = form.querySelector(m.submitSelector);
  if (!submit || submit.tagName !== 'BUTTON' || submit.type !== 'submit' || submit.form !== form || controls.length !== m.fields.length + 1 || !controls.includes(submit) || !['', '_self'].includes(form.target) || form.enctype !== 'application/x-www-form-urlencoded' || ['formaction', 'formmethod', 'formtarget', 'formenctype'].some(name => submit.getAttribute(name) !== null)) throw Error('fixture submit changed');
  const state = { url: form.ownerDocument.defaultView.location.href, values, target: form.action, method: form.method.toLowerCase(), disabled: submit.disabled };
  if (state.url !== `${m.origin}${m.pagePath}` || state.target !== `${m.origin}${m.submitPath}` || state.method !== 'post') throw Error('fixture target changed');
  if (args.action) {
    if (state.disabled || JSON.stringify(state) !== args.expected) throw Error('fixture state changed');
    if (args.action.kind === 'fill') {
      const action = args.action;
      const input = inputs.find(input => input.name === action.field);
      if (!input || !m.fields.includes(args.action.field) || !args.action.value || args.action.value.length > 1000) throw Error('fixture fill changed');
      const setter = Object.getOwnPropertyDescriptor(form.ownerDocument.defaultView.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw Error('fixture input unavailable');
      setter.call(input, args.action.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const click = Object.getOwnPropertyDescriptor(form.ownerDocument.defaultView.HTMLElement.prototype, 'click')?.value;
      if (typeof click !== 'function') throw Error('fixture submit unavailable');
      click.call(submit);
    }
  }
  return state;
}
export function publicFixtureBrowser(options: Readonly<{ binding: BrowserWorker; manifest: FixtureManifest; loadSdk?: () => Promise<Sdk>; fetcher?: typeof fetch }>) {
  const m = Object.freeze({ ...options.manifest, fields: [...options.manifest.fields] });
  const origin = new URL(m.origin);
  if (origin.protocol !== 'https:' || origin.origin !== m.origin || origin.username || origin.password || !m.fields.length || m.fields.length > 24 || new Set(m.fields).size !== m.fields.length || m.fields.some(x => !/^[a-z][a-z0-9_]{0,79}$/.test(x) || ['constructor', 'prototype', '__proto__'].includes(x)) || [m.formSelector, m.submitSelector, m.resultSelector].some(x => !/^#[a-z][a-z0-9_-]{0,79}$/.test(x)) || !/^[a-z][a-z0-9-]{0,79}$/.test(m.runId)) throw Error('browser fixture manifest rejected');
  for (const path of [m.pagePath, m.submitPath, m.receiptPrefix]) {
    const url = new URL(path, origin);
    if (path.length > 300 || !path.startsWith('/') || url.origin !== m.origin || url.pathname !== path || url.search || url.hash) throw Error('browser fixture route rejected');
  }
  cloudflareBrowserGuardOptions([origin.hostname]);
  const fetcher = options.fetcher ?? fetch;
  const receiptRead = async (source: BrowserSourceGuard = admitted): Promise<Record<string, unknown> | null> => {
    await source();
    const response = await fetcher(`${m.origin}${m.receiptPrefix}current`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    await source();
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw Error('fixture receipt unavailable');
    const receipt = await browserBoundedJson(response) as Record<string, unknown>;
    await source();
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).sort().join(',') !== 'bindingDigest,downloadDigest,observedAt,opaqueId,provenance,runId,state,version' || receipt.version !== 1 || receipt.provenance !== 'synthetic_only' || receipt.runId !== m.runId || receipt.state !== 'acknowledged_fixture' || typeof receipt.opaqueId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(receipt.opaqueId) || typeof receipt.bindingDigest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.bindingDigest) || typeof receipt.observedAt !== 'string' || !Number.isFinite(Date.parse(receipt.observedAt))) throw Error('fixture receipt invalid');
    return receipt;
  };
  const loadSdk = options.loadSdk ?? (() => import('@cloudflare/playwright'));
  const sessionId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw Error('browser fixture session rejected'); return id; };
  // Public connect(URL) parses the retained ID from its path. The pinned SDK's
  // connectOverCDP wrapper can allocate instead, so never use it here.
  const connection = async <T>(id: string, work: (browser: Browser) => Promise<T>, source: BrowserSourceGuard = admitted): Promise<T> => {
    sessionId(id); let browser: Browser | undefined;
    try {
      const sdk = await loadSdk();
      const endpoint = new URL(sdk.endpointURLString(options.binding, { sessionId: id }));
      endpoint.searchParams.set('persistent', 'true');
      await source();
      browser = await sdk.connect(endpoint);
      await source();
      return await work(browser);
    } catch { throw Error('browser fixture operation unavailable'); }
    finally { if (browser) { try { await browser.close(); } catch { throw Error('browser fixture disconnect unavailable'); } } }
  };
  const pageWork = <T>(id: string, source: BrowserSourceGuard, work: (page: Page) => Promise<T>) => connection(id, async browser => {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw Error('fixture context changed');
    const context = contexts[0]!;
    await source();
    await context.unroute('**/*');
    await source();
    await context.route('**/*', async route => {
      try { await source(); } catch { await route.abort('blockedbyclient'); return; }
      const url = new URL(route.request().url());
      if (url.origin === m.origin && !url.username && !url.password) await route.continue(); else await route.abort('blockedbyclient');
    });
    await source();
    const pages = context.pages();
    if (pages.length > 1) throw Error('fixture page changed');
    const page = pages[0] ?? await context.newPage();
    page.setDefaultTimeout(10000);
    await source();
    return work(page);
  }, source);
  const exactUrl = (page: Page) => { const url = page.url(); if (url !== `${m.origin}${m.pagePath}`) throw Error('fixture URL changed'); return url; };
  return {
    provider: 'cloudflare_playwright' as const,
    origin: m.origin,
    runId: m.runId,
    submitRef: m.submitSelector,
    pageUrl: `${m.origin}${m.pagePath}`,
    async start(lifetimeMs: number, source: BrowserSourceGuard = admitted) {
      try { if (await receiptRead(source) !== null) throw Error('fixture already used'); const sdk = await loadSdk(); await source(); const started = await sdk.acquire(options.binding, cloudflareBrowserGuardOptions([origin.hostname], lifetimeMs)); return sessionId(started.sessionId); }
      catch { throw Error('browser fixture session unavailable'); }
    },
    async verify(expectedBindingDigest: string, source: BrowserSourceGuard = admitted) {
      if (!/^sha256:[0-9a-f]{64}$/.test(expectedBindingDigest)) throw Error('browser fixture digest rejected');
      try { const receipt = await receiptRead(source); return receipt && `sha256:${receipt.bindingDigest}` === expectedBindingDigest ? { id: receipt.opaqueId as string, observed_at: receipt.observedAt as string, source: 'controlled_fixture' as const, binding_digest: expectedBindingDigest } : null; }
      catch { throw Error('browser fixture receipt unavailable'); }
    },
    async navigate(id: string, source: BrowserSourceGuard = admitted) { return pageWork(id, source, async page => { await source(); await page.goto(`${m.origin}${m.pagePath}`, { timeout: 10000, waitUntil: 'domcontentloaded' }); await source(); exactUrl(page); }); },
    async end(id: string) {
      sessionId(id);
      try {
        const sdk = await loadSdk();
        if (!(await sdk.sessions(options.binding)).some(row => row.sessionId === id)) return;
        try { await connection(id, async browser => { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); }); } catch { /* close may disconnect before its response */ }
        if ((await sdk.sessions(options.binding)).some(row => row.sessionId === id)) throw Error('fixture still active');
      } catch { throw Error('browser fixture cleanup unavailable'); }
    },
    async submit(id: string, expectedDigest: string, beforeAction: () => Promise<void>, source: BrowserSourceGuard = admitted, assertApproval?: () => void) {
      return pageWork(id, source, async page => {
        await source();
        const state = await page.locator(m.formSelector).evaluate(nativeForm, { manifest: m });
        await source();
        exactUrl(page);
        if (await fixtureDigest(state) !== expectedDigest) throw Error('fixture state changed');
        await beforeAction();
        await source();
        assertApproval?.();
        await page.locator(m.formSelector).evaluate(nativeForm, { manifest: m, expected: JSON.stringify(state), action: { kind: 'submit' as const } });
      });
    },
    async fill(id: string, field: string, value: string, expectedDigest: string, beforeAction: () => Promise<void>, source: BrowserSourceGuard = admitted) {
      if (!m.fields.includes(field) || !value || value.length > 1000) throw Error('browser fixture fill rejected');
      return pageWork(id, source, async page => {
        await source();
        const state = await page.locator(m.formSelector).evaluate(nativeForm, { manifest: m });
        await source();
        exactUrl(page);
        if (await fixtureDigest(state) !== expectedDigest) throw Error('fixture state changed');
        await beforeAction();
        await source();
        await page.locator(m.formSelector).evaluate(nativeForm, { manifest: m, expected: JSON.stringify(state), action: { kind: 'fill' as const, field, value } });
      });
    },
    async inspect(id: string, source: BrowserSourceGuard = admitted): Promise<FixtureObservation> {
      return pageWork(id, source, async page => {
        await source();
        const state = await page.locator(m.formSelector).evaluate(nativeForm, { manifest: m });
        await source();
        const url = exactUrl(page);
        if (state.url !== url) throw Error('fixture URL changed');
        const stateDigest = await fixtureDigest(state);
        await source();
        return { url, stateDigest, binding: state.values };
      });
    },
  };
}
