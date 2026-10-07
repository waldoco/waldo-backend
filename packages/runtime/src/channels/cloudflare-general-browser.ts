import type { Browser, BrowserContext, BrowserWorker, Page } from '@cloudflare/playwright';
import { browserSessionSchema, type BrowserSession } from '@waldo/contracts';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { generalDigest, generalPageState, type GeneralSnapshot } from './general-browser-observation';
import { parseGeneralBrowserAction, type GeneralBrowserAction } from './general-browser-actions';
export type { GeneralBrowserAction } from './general-browser-actions';
import { generalBrowserDiagnostic, type GeneralBrowserDiagnostic } from './general-browser-diagnostic';
import { captureGeneralBrowserFile, GeneralFileError, type GeneralFileControl } from './general-browser-files';
import { generalBrowserHandoff, GeneralHandoffError, type GeneralHandoffRequest, type GeneralHandoffControl } from './cloudflare-general-handoff';
import { GENERAL_BROWSER_REDIRECT_LIMIT, GeneralRedirectError, guardGeneralBrowserRoute } from './general-browser-redirects';

export class GeneralBrowserError extends Error {
  release_failed?: true;
  cleanup_failed?: true;
  constructor(readonly code: 'rejected' | 'session_lost' | 'provider_unavailable' | 'page_unavailable' | 'empty_content' | 'image_oversize' | 'cleanup_unconfirmed' | 'stale_observation' | 'outcome_uncertain' | 'file_unavailable' | 'file_oversize', readonly diagnostic?: GeneralBrowserDiagnostic) { super(`browser_${code}`); }
}
type Options = Readonly<{ ownerId: string; binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader; now(): number; deadline(): number; admit(): Promise<void>; authorizeRequest(url: string, method: string): Promise<boolean>; maxScreenshotBytes: number }>;
type Navigation = Readonly<{ goto(page: Page, url: string): Promise<void>; finish(page: Page): Promise<void>; pending(page: Page): boolean; dispatched(): void }>;

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
    const parsed = browserSessionSchema.safeParse(input);
    if (!parsed.success) throw new GeneralBrowserError('rejected');
    const row = parsed.data;
    if (row.ownerId !== options.ownerId || row.provider !== 'cloudflare_playwright' || row.providerSessionId === 'pending'
      || !cleanup && (row.mode !== 'public' || row.state !== 'active' || row.expiresAt <= options.now())) throw new GeneralBrowserError('rejected');
    return row;
  };
  const hostAdmit = async () => {
    try { await options.admit(); }
    catch (error) { if (error instanceof GeneralBrowserError) throw error; throw new GeneralBrowserError('rejected'); }
  };
  const admit = async (session: BrowserSession) => { identity(session); await hostAdmit(); identity(session); };
  const actionTimeout = (session: BrowserSession) => {
    const remaining = Math.min(session.expiresAt, options.deadline()) - options.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new GeneralBrowserError('rejected');
    return Math.min(10000, remaining);
  };
  const allowed = async (session: BrowserSession, url: string, method = 'GET') => {
    await admit(session);
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || !await options.authorizeRequest(url, method)) throw new GeneralBrowserError('rejected');
    await admit(session);
  };
  const tabRef = (session: BrowserSession, target: string) => generalDigest(JSON.stringify([session.ownerId, session.id, session.generation, target])).then(value => `tab:${value.slice(0, 24)}`);
  // Cleanup has no new retry allowance or lifetime. Stop awaiting at the actual
  // host deadline; existing durable cleanup custody must continue unconfirmed work.
  const cleanupAwait = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = options.deadline() - options.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new GeneralBrowserError('cleanup_unconfirmed');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GeneralBrowserError('cleanup_unconfirmed')), remaining); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const targetId = async (context: BrowserContext, page: Page) => {
    const cdp = await context.newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await cdp.detach(); }
  };
  const attached = async <T>(session: BrowserSession, work: (browser: Browser, context: BrowserContext, navigation: Navigation) => Promise<T>): Promise<T> => {
    let browser: Browser | undefined, primary: GeneralBrowserError | undefined, documentFailure: GeneralBrowserError | undefined;
    let mutationDispatched = false;
    const redirects = new Map<Page, string>();
    const invalidDocuments = new Set<Page>();
    const navigation: Navigation = {
      async goto(page, initialUrl) {
        let url = initialUrl; const visited = new Set<string>();
        for (;;) {
          if (documentFailure) throw documentFailure;
          if (visited.has(url) || visited.size > GENERAL_BROWSER_REDIRECT_LIMIT) throw new GeneralBrowserError('rejected');
          visited.add(url); await allowed(session, url); redirects.delete(page);
          let response: Awaited<ReturnType<Page['goto']>> = null;
          try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: actionTimeout(session) }); }
          catch (error) { if (!redirects.has(page)) throw error; }
          await admit(session);
          const next = redirects.get(page); redirects.delete(page);
          if (next) { url = next; continue; }
          if (!response || response.status() >= 400) {
            const failure = new GeneralBrowserError('page_unavailable', response ? { status: response.status() } : undefined);
            try { await cleanupAwait(() => page.close()); }
            catch { try { await terminateId(session.providerSessionId); } catch { failure.cleanup_failed = true; } }
            throw failure;
          }
          return;
        }
      },
      async finish(page) { const next = redirects.get(page); if (next) await navigation.goto(page, next); },
      pending: page => redirects.has(page),
      dispatched: () => { mutationDispatched = true; },
    };
    try {
      await admit(session);
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
          await guardGeneralBrowserRoute(route, { authorize: (url, method) => allowed(session, url, method), timeout: () => actionTimeout(session), admit: () => admit(session),
            redirect: (page, url) => { redirects.set(page, url); }, denied: (page, status) => { invalidDocuments.add(page); documentFailure = new GeneralBrowserError('page_unavailable', { status }); } });
          await admit(session);
        }
        catch (error) {
          if (route.request().isNavigationRequest() && !route.request().frame().parentFrame()) {
            invalidDocuments.add(route.request().frame().page());
            documentFailure = error instanceof GeneralBrowserError ? error : new GeneralBrowserError('rejected');
          }
          try { await route.abort('blockedbyclient'); } catch { /* route may already have settled; discard invalid main document below */ }
        }
      });
      const result = await work(browser, context, navigation); await admit(session);
      if (documentFailure) throw documentFailure;
      return result;
    } catch (error) {
      primary = mutationDispatched || error instanceof GeneralBrowserError && error.code === 'outcome_uncertain'
        ? new GeneralBrowserError('outcome_uncertain', (error instanceof GeneralBrowserError ? error.diagnostic : undefined) ?? documentFailure?.diagnostic)
        : documentFailure ?? (error instanceof GeneralBrowserError ? error : new GeneralBrowserError(error instanceof GeneralRedirectError ? 'rejected' : 'provider_unavailable'));
      if (error instanceof GeneralBrowserError) {
        if (error.cleanup_failed) primary.cleanup_failed = true;
        if (error.release_failed) primary.release_failed = true;
      }
      throw primary;
    } finally {
      // Aborted main navigations can retain a Chromium error document. Discard
      // independently of expired/revoked action authority before releasing custody.
      for (const page of invalidDocuments) try { await cleanupAwait(() => page.close()); } catch {
        try { await terminateId(session.providerSessionId); } catch {
          if (primary) primary.cleanup_failed = true;
          else throw new GeneralBrowserError('cleanup_unconfirmed');
        }
      }
      // Release this connection, retaining tabs/context; physical end is separate.
      if (browser) try { await cleanupAwait(() => browser!.close()); } catch {
        if (primary) primary.release_failed = true;
        else {
          const failure = new GeneralBrowserError(mutationDispatched ? 'outcome_uncertain' : 'provider_unavailable');
          failure.release_failed = true; throw failure;
        }
      }
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
    await admit(session);
    return { ownerId: session.ownerId, sessionId: session.id, generation: session.generation, targetId: target, digest, state,
      observation: { revision, tab_ref: await tabRef(session, target), url: state.url, title: state.title, text: state.text, viewport: { width: state.width, height: state.height },
        elements: state.elements.map((element, index) => ({ ref: `e:${revision.slice(0, 24)}:${index}`, role: element.role, name: element.name, tag: element.tag, disabled: element.disabled, ...(element.options ? { options: element.options } : {}) })), tabs },
      image: { mime_type: 'image/png', bytes } };
  };
  const terminateId = async (id: string): Promise<void> => {
    let browser: Browser | undefined;
    try {
      const sdk = await cleanupAwait(options.loadSdk);
      if (!(await cleanupAwait(() => sdk.sessions(binding))).some(row => row.sessionId === id)) return;
      try {
        const connectOptions = { sessionId: id, persistent: true };
        browser = await cleanupAwait(() => sdk.connect(binding, connectOptions));
        const cdp = await cleanupAwait(() => browser!.newBrowserCDPSession()); await cleanupAwait(() => cdp.send('Browser.close'));
      } catch { /* termination may sever the connection before acknowledgement */ }
      if ((await cleanupAwait(() => sdk.sessions(binding))).some(row => row.sessionId === id)) throw new GeneralBrowserError('cleanup_unconfirmed');
    } catch { throw new GeneralBrowserError('cleanup_unconfirmed'); }
    finally { try { if (browser) await cleanupAwait(() => browser!.close()); } catch { /* physical absence is authoritative */ } }
  };
  return {
    async start(allowedDomains: readonly string[], lifetimeMs: number,
      beforeAllocate: (allocation: Readonly<{ allowedDomains: readonly string[]; lifetimeMs: number }>) => Promise<void>,
      recordAllocation: (providerSessionId: string) => Promise<void>): Promise<string> {
      let id: string | undefined;
      try {
        const domains = [...allowedDomains], guard = cloudflareBrowserGuardOptions(domains, lifetimeMs);
        await hostAdmit();
        // The existing host reserves its actual hard grant/budget before any I/O.
        await beforeAllocate({ allowedDomains: domains, lifetimeMs }); await hostAdmit();
        const sdk = await options.loadSdk(); await hostAdmit();
        const allocated = await sdk.acquire(binding, guard);
        if (typeof allocated.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(allocated.sessionId)) throw new GeneralBrowserError('provider_unavailable');
        id = allocated.sessionId;
        // Record even if authority expired while acquire was in flight, so the
        // host has a durable cleanup obligation instead of an orphan session.
        await recordAllocation(id); await hostAdmit();
        return id;
      } catch (error) {
        if (id) await terminateId(id);
        if (error instanceof GeneralBrowserError) throw error;
        throw new GeneralBrowserError('provider_unavailable');
      }
    },
    act: (session: BrowserSession, snapshot: GeneralSnapshot, input: GeneralBrowserAction, beforeAction: (actionDigest: string) => Promise<void>) => attached(session, async (_, context, navigation) => {
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
      if (action.operation === 'select' && !element!.options?.some(option => option.value === action.value && !option.disabled)) throw new GeneralBrowserError('rejected');
      await checked();
      // Host durably records action intent/consumes the observation and checks
      // exact approval evidence here. This callback is never model/page code.
      await beforeAction(await generalDigest(JSON.stringify({ revision: snapshot.observation.revision, action })));
      await admit(session); await checked(); await admit(session); identity(session);
      const timeout = actionTimeout(session);
      navigation.dispatched();
      try {
        if (action.operation === 'scroll') {
          const x = action.direction === 'left' ? -snapshot.state.width : action.direction === 'right' ? snapshot.state.width : 0;
          const y = action.direction === 'up' ? -snapshot.state.height : action.direction === 'down' ? snapshot.state.height : 0;
          await page.evaluate(({ x, y }) => (globalThis as any).scrollBy(x, y), { x, y });
        } else {
          const locator = page.locator(element!.selector);
          try {
            switch (action.operation) {
              case 'click': await locator.click({ timeout }); break;
              case 'fill': await locator.fill(action.value, { timeout }); break;
              case 'select': await locator.selectOption(action.value, { timeout }); break;
              case 'press': await locator.press(action.key, { timeout }); break;
            }
          } catch (error) { if (!navigation.pending(page)) throw error; }
        }
        await navigation.finish(page);
        return await observe(session, context, page);
      }
      catch { throw new GeneralBrowserError('outcome_uncertain'); }
    }),
    retrieveFile: (session: BrowserSession, snapshot: GeneralSnapshot, elementRef: string, control: GeneralFileControl) => attached(session, async (_, context, navigation) => {
      if (snapshot.ownerId !== session.ownerId || snapshot.sessionId !== session.id || snapshot.generation !== session.generation || control.signal.aborted) throw new GeneralBrowserError('rejected');
      const page = await select(session, context, snapshot.observation.tab_ref);
      const checked = async () => {
        const current = await observe(session, context, page);
        if (current.targetId !== snapshot.targetId || current.digest !== snapshot.digest) throw new GeneralBrowserError('stale_observation');
      };
      const index = snapshot.observation.elements.findIndex(element => element.ref === elementRef), element = snapshot.state.elements[index];
      if (!element || element.tag !== 'a' || element.disabled || !element.href) throw new GeneralBrowserError('rejected');
      await checked(); await allowed(session, element.href);
      try {
        return await captureGeneralBrowserFile({ ...control,
          scope: { ownerId: session.ownerId, sessionId: session.id, generation: session.generation, targetId: snapshot.targetId, observationRevision: snapshot.observation.revision }, sourceUrl: element.href,
          now: options.now, deadline: () => Math.min(session.expiresAt, options.deadline()), admit: () => admit(session), authorize: url => allowed(session, url, 'GET'), onPersistAttempt: navigation.dispatched,
          beforeFileCapture: async (intent, signal) => { await control.beforeFileCapture(await generalDigest(JSON.stringify({ revision: snapshot.observation.revision, intent })), signal); await checked(); },
        });
      } catch (error) { throw new GeneralBrowserError(error instanceof GeneralFileError ? error.code : 'file_unavailable', error instanceof GeneralFileError ? error.diagnostic : undefined); }
    }),
    handoff: (session: BrowserSession, snapshot: GeneralSnapshot, request: GeneralHandoffRequest,
      control: Pick<GeneralHandoffControl, 'beforeHandoff' | 'storeOwnerView' | 'signal'>) => attached(session, async (browser, context, navigation) => {
      if (snapshot.ownerId !== session.ownerId || snapshot.sessionId !== session.id || snapshot.generation !== session.generation) throw new GeneralBrowserError('stale_observation');
      const page = await select(session, context, snapshot.observation.tab_ref);
      const checked = async () => {
        const current = await observe(session, context, page);
        if (current.targetId !== snapshot.targetId || current.digest !== snapshot.digest) throw new GeneralBrowserError('stale_observation');
      };
      await checked();
      const cdp = await browser.newBrowserCDPSession();
      let primary: GeneralBrowserError | undefined;
      try {
        return await generalBrowserHandoff(cdp, request, { ...control,
          scope: { ownerId: session.ownerId, sessionId: session.id, generation: session.generation, providerSessionId: session.providerSessionId, targetId: snapshot.targetId },
          now: options.now, deadline: () => Math.min(session.expiresAt, options.deadline()), admit: () => admit(session), onMintAttempt: navigation.dispatched,
          beforeHandoff: async (digest, signal) => { await control.beforeHandoff(digest, signal); await checked(); },
        });
      } catch (error) {
        const failure = primary = new GeneralBrowserError(error instanceof GeneralHandoffError ? error.code : 'provider_unavailable');
        if (error instanceof GeneralHandoffError && error.view_mint_attempted) try { await terminateId(session.providerSessionId); } catch { failure.cleanup_failed = true; }
        throw failure;
      } finally {
        try { await cleanupAwait(() => cdp.detach()); }
        catch {
          if (primary) primary.release_failed = true;
          else { const failure = new GeneralBrowserError('outcome_uncertain'); failure.release_failed = true; throw failure; }
        }
      }
    }),
    observe: (session: BrowserSession, reference?: string) => attached(session, async (_, context) => observe(session, context, await select(session, context, reference))),
    navigate: (session: BrowserSession, url: string, reference?: string) => attached(session, async (_, context, navigation) => {
      await allowed(session, url); const page = await select(session, context, reference); page.setDefaultTimeout(10000);
      await navigation.goto(page, url);
      return observe(session, context, page);
    }),
    openTab: (session: BrowserSession, url: string) => attached(session, async (_, context, navigation) => {
      await allowed(session, url); const page = await context.newPage();
      await navigation.goto(page, url);
      return observe(session, context, page);
    }),
    closeTab: (session: BrowserSession, reference: string, beforeAction: (actionDigest: string) => Promise<void>) => attached(session, async (_, context, navigation) => {
      const page = await select(session, context, reference);
      await beforeAction(await generalDigest(JSON.stringify({ operation: 'close_tab', tab_ref: reference })));
      await admit(session);
      navigation.dispatched();
      try { await page.close(); }
      catch { throw new GeneralBrowserError('outcome_uncertain'); }
    }),
    async terminate(input: BrowserSession): Promise<void> {
      return terminateId(identity(input, true).providerSessionId);
    },
  };
}
