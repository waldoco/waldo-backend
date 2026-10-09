import {prepareGeneralPublicRead} from './general-browser-public-read';
import { LIMITS, validId, validatePath } from '@waldo/workspace';
import type { Browser, BrowserContext, BrowserWorker, Page, Route } from '@cloudflare/playwright';
import { browserSessionSchema, type BrowserSession } from '@waldo/contracts';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { generalDigest, generalPageState, type GeneralSnapshot, type GeneralActionSnapshot } from './general-browser-observation';
import { parseGeneralBrowserAction, type GeneralBrowserAction } from './general-browser-actions';
export type { GeneralBrowserAction } from './general-browser-actions';
import { generalBrowserDiagnostic, type GeneralBrowserDiagnostic } from './general-browser-diagnostic';
import { GENERAL_BROWSER_REDIRECT_LIMIT, GeneralRedirectError, guardGeneralBrowserRoute } from './general-browser-redirects';

export class GeneralBrowserError extends Error {
  release_failed?: true;
  cleanup_failed?: true;
  constructor(readonly code: 'rejected' | 'session_lost' | 'provider_unavailable' | 'page_unavailable' | 'empty_content' | 'image_oversize' | 'observation_oversize' | 'cleanup_unconfirmed' | 'stale_observation' | 'outcome_uncertain', readonly diagnostic?: GeneralBrowserDiagnostic) { super(`browser_${code}`); }
}
type Options = Readonly<{ ownerId: string; binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader; cleanupBinding?(providerSessionId:string):BrowserWorker; publicRead?:boolean; retainConnection?:boolean; now(): number; deadline(): number; cleanupTimeoutMs?: number; admit(): Promise<void>; authorizeRequest(url: string, method: string): Promise<boolean>; maxScreenshotBytes: number }>;
type Navigation = Readonly<{ goto(page: Page, url: string): Promise<void>; finish(page: Page): Promise<void>; pending(page: Page): boolean; dispatched(): void }>;

// The owner host owns the durable checkpoint, authority and serialization. This
// driver never allocates on attach failure and never creates a second ledger.
export function cloudflareGeneralBrowser(options: Options) {
  if (!options.ownerId || !Number.isSafeInteger(options.maxScreenshotBytes) || options.maxScreenshotBytes <= 0) throw new GeneralBrowserError('rejected');
  if (options.retainConnection && !options.publicRead) throw new GeneralBrowserError('rejected');
  let connected: Readonly<{ browser: Browser; context: BrowserContext; sessionKey: string }> | undefined;
  let documentFailure: GeneralBrowserError | undefined;
  const invalidDocuments = new Set<Page>();
  let guardedContext: BrowserContext | undefined;
  let currentRouteGuard: ((route: Route) => Promise<void>) | undefined;
  const connectionKey = (session: BrowserSession) => JSON.stringify([session.ownerId, session.id, session.generation, session.providerSessionId]);
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || cleanupTimeoutMs > 10000) throw new GeneralBrowserError('rejected');
  // A single cleanup budget, independent of expired action authority. Each
  // awaited phase races the same timer; no late phase may dispatch more I/O.
  const cleanup = async <T>(work: (step: <V>(run: () => Promise<V>, late?: (value: V) => void) => Promise<V>) => Promise<T>): Promise<T> => {
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new GeneralBrowserError('cleanup_unconfirmed')); }, cleanupTimeoutMs); });
    const step = async <V>(run: () => Promise<V>, late?: (value: V) => void): Promise<V> => {
      if (expired) throw new GeneralBrowserError('cleanup_unconfirmed');
      const pending = run().then(value => { if (expired) { late?.(value); throw new GeneralBrowserError('cleanup_unconfirmed'); } return value; });
      return Promise.race([pending, timeout]);
    };
    try { return await work(step); } finally { clearTimeout(timer!); }
  };
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
  const targetId = async (context: BrowserContext, page: Page) => {
    const cdp = await context.newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await cdp.detach(); }
  };
  const attached = async <T>(session: BrowserSession, work: (browser: Browser, context: BrowserContext, navigation: Navigation) => Promise<T>): Promise<T> => {
    let browser: Browser | undefined, context: BrowserContext | undefined, primary: GeneralBrowserError | undefined;
    let mutationDispatched = false, pageCleanupFailed = false;
    const redirects = new Map<Page, string>();
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
            try { await cleanup(step => step(() => page.close())); } catch { await terminateId(session.providerSessionId); }
            throw new GeneralBrowserError('page_unavailable', response ? { status: response.status() } : undefined);
          }
          return;
        }
      },
      async finish(page) { const next = redirects.get(page); if (next) await navigation.goto(page, next); },
      pending: page => redirects.has(page),
      dispatched: () => { mutationDispatched = true; },
    };
    try {
      // Capture only an exact existing connection before admission; if that
      // authority has expired, finally can still release its guarded documents.
      if (connected && connected.sessionKey === connectionKey(session)) {
        browser = connected.browser;
        context = connected.context;
        if(browser.isConnected?.()===false)throw new GeneralBrowserError('session_lost');
      }
      await admit(session);
      if (documentFailure) throw documentFailure;
      if (connected) {
        if (connected.sessionKey !== connectionKey(session)) throw new GeneralBrowserError('session_lost');
        browser = connected.browser;
      } else {
        const sdk = await options.loadSdk(); await admit(session);
        // Runtime 1.3.6 supports persistent, although its declaration omits it.
        const connectOptions = { sessionId: session.providerSessionId, persistent: true };
        browser = await sdk.connect(binding, connectOptions); await admit(session);

      }
      if (!context) {
        const contexts = browser.contexts();
        if (contexts.length !== 1) throw new GeneralBrowserError('session_lost');
        context = contexts[0]!;
        if (options.retainConnection) {
          // SDK1.3.6 creates this context with CDP disposeOnDetach:true. Running
          // documents never outlive the connection in the persistent default
          // context. A recreated host cannot reuse lost document handles.
          if (context.serviceWorkers().length) throw new GeneralBrowserError('session_lost');
          await cleanup(step => step(() => Promise.all(context!.pages().map(page => page.close()))));
          await admit(session);
          context = await browser.newContext({serviceWorkers:'block'}); await admit(session);
          connected = {browser,context,sessionKey:connectionKey(session)};
        }
      }
      if(options.publicRead&&guardedContext!==context){
        if(!await prepareGeneralPublicRead(context)){await terminateId(session.providerSessionId);throw new GeneralBrowserError('session_lost');}
        await admit(session);
      }
      // Switch operation bookkeeping without removing interception from live
      // documents. Between operations the previous guard still checks authority.
      currentRouteGuard = async route => {
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
      };
      if (guardedContext !== context) {
        await context.route('**/*', route => currentRouteGuard!(route));
        guardedContext = context;
      }
      const result = await work(browser, context, navigation); await admit(session);
      if (documentFailure) throw documentFailure;
      return result;
    } catch (error) {
      primary = mutationDispatched || error instanceof GeneralBrowserError && error.code === 'outcome_uncertain'
        ? new GeneralBrowserError('outcome_uncertain', (error instanceof GeneralBrowserError ? error.diagnostic : undefined) ?? documentFailure?.diagnostic)
        : documentFailure ?? (error instanceof GeneralBrowserError ? error : new GeneralBrowserError(error instanceof GeneralRedirectError ? 'rejected' : 'provider_unavailable'));
      throw primary;
    } finally {
      // Aborted main navigations can retain a Chromium error document. Discard
      // independently of expired/revoked action authority before releasing custody.
      for (const page of invalidDocuments) try { await cleanup(step => step(() => page.close())); } catch {
        try { await terminateId(session.providerSessionId); } catch {
          if (primary) primary.cleanup_failed = true;
          else throw new GeneralBrowserError('cleanup_unconfirmed');
        }
      }
      // Anonymous reads retain browser cookies/context, not running documents.
      // Closing all pages prevents polling and sockets from surviving detachment.
      if(options.publicRead&&context&&(!options.retainConnection||primary))try{
        await cleanup(async step=>{await step(()=>Promise.all(context!.pages().map(page=>page.close())));if(context!.pages().length||context!.serviceWorkers().length)throw new GeneralBrowserError('cleanup_unconfirmed');});
      }catch{
        try{await terminateId(session.providerSessionId);}catch{if(primary)primary.cleanup_failed=true;}
        if(!primary)primary=new GeneralBrowserError('cleanup_unconfirmed');
        pageCleanupFailed=true;
      }
      // Release this connection; physical browser termination is separate.
      if (browser&&(!options.retainConnection||primary)) try { connected=undefined; guardedContext=undefined; await cleanup(step => step(() => browser!.close())); } catch {
        if (primary) primary.release_failed = true;
        else {
          const failure = new GeneralBrowserError(mutationDispatched ? 'outcome_uncertain' : 'provider_unavailable');
          failure.release_failed = true; throw failure;
        }
      }
      if(pageCleanupFailed)throw primary!;
    }
  };
  const select = async (session: BrowserSession, context: BrowserContext, reference?: string) => {
    const pages = context.pages();
    if (!reference) return pages[0] ?? await context.newPage();
    for (const page of pages) if (await tabRef(session, await targetId(context, page)) === reference) return page;
    throw new GeneralBrowserError('stale_observation');
  };
  // Chromium's native accessibility tree masks password values. Playwright's
  // body ariaSnapshot currently serializes them; never publish that raw snapshot.
  const boundedSemanticRead = async <T>(session:BrowserSession, read:()=>Promise<T>):Promise<T> => {
    const timeout=actionTimeout(session);
    let timer:ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new GeneralBrowserError('provider_unavailable')),timeout);})]);
    } finally {clearTimeout(timer!);}
  };
  const semanticSnapshot = async (session: BrowserSession, context: BrowserContext, page: Page) => {
    const cdp = await boundedSemanticRead(session,()=>context.newCDPSession(page));
    try {
      await admit(session);
      const {nodes} = await boundedSemanticRead(session,()=>cdp.send('Accessibility.getFullAXTree')); await admit(session);
      const visible=nodes.filter(node=>!node.ignored);
      const indexes=new Map(visible.map((node,index)=>[node.nodeId,index]));
      return JSON.stringify(visible.map(node=>({
        role:node.role?.value, name:node.name?.value, ...(node.description?{description:node.description.value}:{}),
        ...(node.value?{value:node.value.value}:{}),
        states:Object.fromEntries((node.properties??[]).filter(property=>['disabled','expanded','checked','selected','readonly','required','invalid','multiselectable','level','modal','orientation'].includes(property.name)).map(property=>[property.name,property.value.value])),
        children:(node.childIds??[]).flatMap(id=>indexes.has(id)?[indexes.get(id)!]:[]),
      })));
    } finally { await cleanup(step=>step(()=>cdp.detach())); }
  };
  const observe = async (session: BrowserSession, context: BrowserContext, page: Page): Promise<GeneralSnapshot> => {
    await allowed(session, page.url());
    const state = await page.evaluate(generalPageState); await admit(session);
    const semantic = await semanticSnapshot(session,context,page); await admit(session);
    if (!state.text.trim()) throw new GeneralBrowserError('empty_content');
    const bytes = new Uint8Array(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css' })); await admit(session);
    if (bytes.byteLength > options.maxScreenshotBytes) throw new GeneralBrowserError('image_oversize');
    const current = await page.evaluate(generalPageState); await admit(session);
    const currentSemantic = await semanticSnapshot(session,context,page); await admit(session);
    if (currentSemantic !== semantic || JSON.stringify(current) !== JSON.stringify(state)) throw new GeneralBrowserError('stale_observation');
    const target = await targetId(context, page);
    const digest = await generalDigest(JSON.stringify({ state, semantic, image: await generalDigest(bytes) }));
    const revision = await generalDigest(JSON.stringify([session.ownerId, session.id, session.generation, target, digest]));
    const tabs = [];
    for (const tab of context.pages()) tabs.push({ ref: await tabRef(session, await targetId(context, tab)), url: tab.url(), title: await tab.title() });
    await admit(session);
    return { ownerId: session.ownerId, sessionId: session.id, generation: session.generation, targetId: target, digest, state,
      observation: { revision, tab_ref: await tabRef(session, target), url: state.url, title: state.title, text: state.text, accessibility_snapshot:semantic, viewport: { width: state.width, height: state.height },
        elements: state.elements.map((element, index) => ({ ref: `e:${revision.slice(0, 24)}:${index}`, role: element.role, name: element.name, tag: element.tag, disabled: element.disabled, ...(['checkbox','radio'].includes(element.type)?{checked:element.checked}:{}), ...(element.options ? { options: element.options } : {}) })), tabs },
      image: { mime_type: 'image/png', bytes } };
  };
  const terminateId = async (id: string): Promise<void> => cleanup(async step => {
    let browser: Browser | undefined;
    try {
      const sdk = await step(() => options.loadSdk());
      const cleanupBinding=options.cleanupBinding?.(id)??binding;
      const present=async()=>{
        const rows=await step(()=>sdk.sessions(cleanupBinding));
        if(!Array.isArray(rows))throw new GeneralBrowserError('cleanup_unconfirmed');
        const ids=new Set<string>();
        for(const row of rows){if(typeof row?.sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.sessionId)||ids.has(row.sessionId))throw new GeneralBrowserError('cleanup_unconfirmed');ids.add(row.sessionId);}
        return ids.has(id);
      };
      if(!await present())return;
      try {
        const connectOptions = { sessionId: id, persistent: true };
        browser = await step(() => sdk.connect(cleanupBinding, connectOptions), late => { void late.close().catch(() => {}); });
        const cdp = await step(() => browser!.newBrowserCDPSession());
        await step(() => cdp.send('Browser.close'));
      } catch { /* termination may sever the connection before acknowledgement */ }
      if(await present())throw new GeneralBrowserError('cleanup_unconfirmed');
    } catch { throw new GeneralBrowserError('cleanup_unconfirmed'); }
    finally {
      if (browser) await cleanup(release => release(async () => { try { await browser!.close(); } catch { /* physical readback remains authoritative */ } }));
    }
  });
  return {
    hasRetainedConnection:()=>connected!==undefined,
    async disconnect(): Promise<void> {
      const retained = connected; connected = undefined; guardedContext=undefined;
      if (!retained) return;
      // Leaving a turn disconnects only after closing active documents. Current
      // authority still guards requests while model calls wait between actions.
      let failure: GeneralBrowserError | undefined;
      try {
        await cleanup(async step => {
          const contexts = retained.browser.contexts();
          await step(() => Promise.all(contexts.flatMap(context => context.pages()).map(page => page.close())));
          if (contexts.some(context => context.pages().length || context.serviceWorkers().length)) throw new GeneralBrowserError('cleanup_unconfirmed');
        });
      } catch { failure = new GeneralBrowserError('cleanup_unconfirmed'); }
      try { await cleanup(step => step(() => retained.context.close())); } catch { failure ??= new GeneralBrowserError('cleanup_unconfirmed'); }
      try { await cleanup(step => step(() => retained.browser.close())); }
      catch { failure ??= new GeneralBrowserError('cleanup_unconfirmed'); failure.release_failed = true; }
      if (failure) throw failure;
    },
    async start(allowedDomains: readonly string[] | 'public', lifetimeMs: number,
      beforeAllocate: (allocation: Readonly<{ allowedDomains: readonly string[] | 'public'; lifetimeMs: number }>) => Promise<void>,
      recordAllocation: (providerSessionId: string) => Promise<void>,
      recordTermination?: () => void | Promise<void>): Promise<string> {
      let id: string | undefined;
      try {
        const domains = allowedDomains === 'public' ? 'public' as const : [...allowedDomains], guard = domains === 'public' ? { recording: false, keep_alive: lifetimeMs } as ReturnType<typeof cloudflareBrowserGuardOptions> : cloudflareBrowserGuardOptions(domains, lifetimeMs);
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
        if (id) {await terminateId(id);await recordTermination?.();}
        if (error instanceof GeneralBrowserError) throw error;
        throw new GeneralBrowserError('provider_unavailable');
      }
    },
    act: (session: BrowserSession, snapshot: GeneralActionSnapshot, input: GeneralBrowserAction, beforeAction: (actionDigest: string) => Promise<void>) => attached(session, async (_, context, navigation) => {
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
      if (action.operation === 'fill' && (!['input', 'textarea'].includes(element!.tag) && !element!.editable || element!.readOnly || ['password', 'file', 'hidden', 'checkbox', 'radio'].includes(element!.type))) throw new GeneralBrowserError('rejected');
      if (action.operation === 'set_checked' && (element!.tag!=='input' || !['checkbox','radio'].includes(element!.type) || element!.type==='radio' && !action.checked)) throw new GeneralBrowserError('rejected');
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
          const x = 'delta' in action ? 0 : action.direction === 'left' ? -snapshot.state.width : action.direction === 'right' ? snapshot.state.width : 0;
          const y = 'delta' in action ? action.delta : action.direction === 'up' ? -snapshot.state.height : action.direction === 'down' ? snapshot.state.height : 0;
          await page.evaluate(({ x, y }) => (globalThis as any).scrollBy(x, y), { x, y });
        } else {
          const locator = page.locator(element!.selector);
          try {
            switch (action.operation) {
              case 'set_checked': await locator.setChecked(action.checked, {timeout}); break;
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
