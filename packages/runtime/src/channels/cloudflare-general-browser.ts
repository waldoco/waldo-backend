import type { Browser, BrowserContext, BrowserWorker, Page } from '@cloudflare/playwright';
import { browserSessionSchema, type BrowserSession } from '@waldo/contracts';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { generalDigest, generalPageState, type GeneralSnapshot } from './general-browser-observation';
import { parseGeneralBrowserAction, type GeneralBrowserAction } from './general-browser-actions';
export type { GeneralBrowserAction } from './general-browser-actions';
import { generalBrowserDiagnostic, type GeneralBrowserDiagnostic } from './general-browser-diagnostic';

export class GeneralBrowserError extends Error {
  constructor(readonly code: 'rejected' | 'session_lost' | 'provider_unavailable' | 'empty_content' | 'image_oversize' | 'cleanup_unconfirmed' | 'stale_observation' | 'outcome_uncertain', readonly diagnostic?: GeneralBrowserDiagnostic) { super(`browser_${code}`); }
}
type Options = Readonly<{ ownerId: string; binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader; now(): number; admit(): Promise<void>; authorizeRequest(url: string, method: string): Promise<boolean>; maxScreenshotBytes: number }>;

// The owner host owns the durable checkpoint, authority and serialization. This
// driver never allocates on attach failure and never creates a second ledger.
export function cloudflareGeneralBrowser(options: Options) {
  if (!options.ownerId || !Number.isSafeInteger(options.maxScreenshotBytes) || options.maxScreenshotBytes <= 0) throw new GeneralBrowserError('rejected');
  const binding = { fetch: async (...args: Parameters<BrowserWorker['fetch']>) => {
    const response = await options.binding.fetch(...args);
    if (!response.ok && response.status !== 101) throw new GeneralBrowserError('provider_unavailable', await generalBrowserDiagnostic(response));
    return response;
  } } as BrowserWorker;
  const identity = (input: BrowserSession, cleanup = false) => {
    const row = browserSessionSchema.parse(input);
    if (row.ownerId !== options.ownerId || row.provider !== 'cloudflare_playwright' || row.providerSessionId === 'pending'
      || !cleanup && (row.mode !== 'public' || row.state !== 'active' || row.expiresAt <= options.now())) throw new GeneralBrowserError('rejected');
    return row;
  };
  const admit = async (session: BrowserSession) => { identity(session); await options.admit(); identity(session); };
  const allowed = async (session: BrowserSession, url: string, method = 'GET') => {
    await admit(session);
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || !await options.authorizeRequest(url, method)) throw new GeneralBrowserError('rejected');
    await admit(session);
  };
  const tabRef = (session: BrowserSession, target: string) => generalDigest(JSON.stringify([session.ownerId, session.id, session.generation, target])).then(value => `tab:${value.slice(0, 24)}`);
  const targetId = async (context: BrowserContext, page: Page) => {
    const cdp = await context.newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await cdp.detach(); }
  };
  const attached = async <T>(session: BrowserSession, work: (browser: Browser, context: BrowserContext) => Promise<T>): Promise<T> => {
    await admit(session); let browser: Browser | undefined;
    try {
      const sdk = await options.loadSdk(); await admit(session);
      // Runtime 1.3.6 supports persistent, although its declaration omits it.
      const connectOptions = { sessionId: session.providerSessionId, persistent: true };
      browser = await sdk.connect(binding, connectOptions); await admit(session);
      // newContext uses disposeOnDetach:true. Reuse the dedicated session's
      // persistent default context rather than recreating an incognito context.
      const contexts = browser.contexts();
      if (contexts.length !== 1) throw new GeneralBrowserError('session_lost');
      const context = contexts[0]!;
      await context.unroute('**/*'); await admit(session);
      await context.route('**/*', async route => {
        try {
          await allowed(session, route.request().url(), route.request().method());
          // continue follows redirects without re-running this authorization.
          // Fail closed on redirects until a separately vetted navigation path
          // exists; never follow a chain through an unchecked target.
          const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
          await admit(session);
          if (response.status() >= 300 && response.status() < 400) await route.abort('blockedbyclient');
          else await route.fulfill({ response });
        }
        catch { await route.abort('blockedbyclient'); }
      });
      const result = await work(browser, context); await admit(session); return result;
    } catch (error) {
      if (error instanceof GeneralBrowserError) throw error;
      throw new GeneralBrowserError('provider_unavailable');
    } finally {
      // Release this connection, retaining tabs/context; physical end is separate.
      if (browser) try { await browser.close(); } catch { throw new GeneralBrowserError('provider_unavailable'); }
    }
  };
  const select = async (session: BrowserSession, context: BrowserContext, reference?: string) => {
    const pages = context.pages();
    if (!reference) return pages[0] ?? await context.newPage();
    for (const page of pages) if (await tabRef(session, await targetId(context, page)) === reference) return page;
    throw new GeneralBrowserError('stale_observation');
  };
  const observe = async (session: BrowserSession, context: BrowserContext, page: Page): Promise<GeneralSnapshot> => {
    await allowed(session, page.url());
    const state = await page.evaluate(generalPageState); await admit(session);
    if (!state.text.trim()) throw new GeneralBrowserError('empty_content');
    const bytes = new Uint8Array(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css' })); await admit(session);
    if (bytes.byteLength > options.maxScreenshotBytes) throw new GeneralBrowserError('image_oversize');
    const current = await page.evaluate(generalPageState); await admit(session);
    if (JSON.stringify(current) !== JSON.stringify(state)) throw new GeneralBrowserError('stale_observation');
    const target = await targetId(context, page);
    const digest = await generalDigest(JSON.stringify({ state, image: await generalDigest(bytes) }));
    const revision = await generalDigest(JSON.stringify([session.ownerId, session.id, session.generation, target, digest]));
    const tabs = [];
    for (const tab of context.pages()) tabs.push({ ref: await tabRef(session, await targetId(context, tab)), url: tab.url(), title: await tab.title() });
    return { ownerId: session.ownerId, sessionId: session.id, generation: session.generation, targetId: target, digest, state,
      observation: { revision, tab_ref: await tabRef(session, target), url: state.url, title: state.title, text: state.text, viewport: { width: state.width, height: state.height },
        elements: state.elements.map((element, index) => ({ ref: `e:${revision.slice(0, 24)}:${index}`, role: element.role, name: element.name, tag: element.tag, disabled: element.disabled })), tabs },
      image: { mime_type: 'image/png', bytes } };
  };
  const terminateId = async (id: string): Promise<void> => {
    let browser: Browser | undefined;
    try {
      const sdk = await options.loadSdk();
      if (!(await sdk.sessions(binding)).some(row => row.sessionId === id)) return;
      try {
        const connectOptions = { sessionId: id, persistent: true };
        browser = await sdk.connect(binding, connectOptions);
        const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close');
      } catch { /* termination may sever the connection before acknowledgement */ }
      if ((await sdk.sessions(binding)).some(row => row.sessionId === id)) throw new GeneralBrowserError('cleanup_unconfirmed');
    } catch { throw new GeneralBrowserError('cleanup_unconfirmed'); }
    finally { try { await browser?.close(); } catch { /* physical absence is authoritative */ } }
  };
  return {
    async start(allowedDomains: readonly string[], lifetimeMs: number,
      beforeAllocate: (allocation: Readonly<{ allowedDomains: readonly string[]; lifetimeMs: number }>) => Promise<void>,
      recordAllocation: (providerSessionId: string) => Promise<void>): Promise<string> {
      let id: string | undefined;
      try {
        const domains = [...allowedDomains], guard = cloudflareBrowserGuardOptions(domains, lifetimeMs);
        await options.admit();
        // The existing host reserves its actual hard grant/budget before any I/O.
        await beforeAllocate({ allowedDomains: domains, lifetimeMs }); await options.admit();
        const sdk = await options.loadSdk(); await options.admit();
        const allocated = await sdk.acquire(binding, guard);
        if (typeof allocated.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(allocated.sessionId)) throw new GeneralBrowserError('provider_unavailable');
        id = allocated.sessionId;
        // Record even if authority expired while acquire was in flight, so the
        // host has a durable cleanup obligation instead of an orphan session.
        await recordAllocation(id); await options.admit();
        return id;
      } catch (error) {
        if (id) await terminateId(id);
        if (error instanceof GeneralBrowserError) throw error;
        throw new GeneralBrowserError('provider_unavailable');
      }
    },
    act: (session: BrowserSession, snapshot: GeneralSnapshot, input: GeneralBrowserAction, beforeAction: (actionDigest: string) => Promise<void>) => attached(session, async (_, context) => {
      const action = parseGeneralBrowserAction(input);
      if (!action) throw new GeneralBrowserError('rejected');
      if (snapshot.ownerId !== session.ownerId || snapshot.sessionId !== session.id || snapshot.generation !== session.generation) throw new GeneralBrowserError('stale_observation');
      const page = await select(session, context, snapshot.observation.tab_ref);
      const checked = async () => {
        const current = await observe(session, context, page);
        if (current.targetId !== snapshot.targetId || current.digest !== snapshot.digest) throw new GeneralBrowserError('stale_observation');
      };
      const index = action.operation === 'scroll' ? -1 : snapshot.observation.elements.findIndex(element => element.ref === action.element_ref);
      const element = snapshot.state.elements[index];
      if (action.operation !== 'scroll' && (!element || element.disabled)) throw new GeneralBrowserError('stale_observation');
      if (element?.href) await allowed(session, element.href);
      if (action.operation === 'fill' && (!['input', 'textarea'].includes(element!.tag) || ['password', 'file', 'hidden'].includes(element!.type))) throw new GeneralBrowserError('rejected');
      if (action.operation === 'select' && element!.tag !== 'select') throw new GeneralBrowserError('rejected');
      await checked();
      // Host durably records action intent/consumes the observation and checks
      // exact approval evidence here. This callback is never model/page code.
      await beforeAction(await generalDigest(JSON.stringify({ revision: snapshot.observation.revision, action })));
      await admit(session); await checked();
      try {
        if (action.operation === 'scroll') {
          const x = action.direction === 'left' ? -snapshot.state.width : action.direction === 'right' ? snapshot.state.width : 0;
          const y = action.direction === 'up' ? -snapshot.state.height : action.direction === 'down' ? snapshot.state.height : 0;
          await page.evaluate(({ x, y }) => (globalThis as any).scrollBy(x, y), { x, y });
        } else {
          const locator = page.locator(element!.selector);
          switch (action.operation) {
            case 'click': await locator.click(); break;
            case 'fill': await locator.fill(action.value); break;
            case 'select': await locator.selectOption(action.value); break;
            case 'press': await locator.press(action.key); break;
          }
        }
        return await observe(session, context, page);
      }
      catch { throw new GeneralBrowserError('outcome_uncertain'); }
    }),
    observe: (session: BrowserSession, reference?: string) => attached(session, async (_, context) => observe(session, context, await select(session, context, reference))),
    navigate: (session: BrowserSession, url: string, reference?: string) => attached(session, async (_, context) => {
      await allowed(session, url); const page = await select(session, context, reference); page.setDefaultTimeout(10000);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }); await admit(session);
      if (!response || response.status() >= 400) throw new GeneralBrowserError('provider_unavailable');
      return observe(session, context, page);
    }),
    openTab: (session: BrowserSession, url: string) => attached(session, async (_, context) => {
      await allowed(session, url); const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 }); await admit(session);
      if (!response || response.status() >= 400) throw new GeneralBrowserError('provider_unavailable');
      return observe(session, context, page);
    }),
    closeTab: (session: BrowserSession, reference: string, beforeAction: (actionDigest: string) => Promise<void>) => attached(session, async (_, context) => {
      const page = await select(session, context, reference);
      await beforeAction(await generalDigest(JSON.stringify({ operation: 'close_tab', tab_ref: reference })));
      await admit(session);
      await page.close();
    }),
    async terminate(input: BrowserSession): Promise<void> {
      return terminateId(identity(input, true).providerSessionId);
    },
  };
}
