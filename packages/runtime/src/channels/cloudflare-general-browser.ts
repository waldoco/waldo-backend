import {nativeBrowserHandoff} from './native-browser-handoff';
import {browserHttpAttachment} from './browser-http-attachment';
import type {BrowserDownloadMetadata} from './browser-download-workspace';
import {prepareGeneralPublicRead} from './general-browser-public-read';
import { LIMITS, validId, validatePath } from '@waldo/workspace';
import type { APIResponse,Browser, BrowserContext, BrowserWorker, Page, Route } from '@cloudflare/playwright';
import { browserSessionSchema, type BrowserSession } from '@waldo/contracts';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { generalDigest, generalPageState, type GeneralSnapshot, type GeneralActionSnapshot,type GeneralPageState } from './general-browser-observation';
import { parseGeneralBrowserAction, type GeneralBrowserAction } from './general-browser-actions';
export type { GeneralBrowserAction } from './general-browser-actions';
import { generalBrowserDiagnostic, type GeneralBrowserDiagnostic } from './general-browser-diagnostic';
import { GENERAL_BROWSER_REDIRECT_LIMIT, GeneralRedirectError, guardGeneralBrowserRoute } from './general-browser-redirects';

export class GeneralBrowserError extends Error {
  release_failed?: true;
  cleanup_failed?: true;
  constructor(readonly code: 'rejected' | 'session_lost' | 'provider_unavailable' | 'page_unavailable' | 'empty_content' | 'image_oversize' | 'observation_oversize' | 'cleanup_unconfirmed' | 'stale_observation' | 'outcome_uncertain', readonly diagnostic?: GeneralBrowserDiagnostic) { super(`browser_${code}`); }
}
type Options = Readonly<{ ownerId: string; binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader; cleanupBinding?(providerSessionId:string):BrowserWorker; publicRead?:boolean; retainConnection?:boolean; now(): number; deadline(): number; cleanupTimeoutMs?: number; admit(): Promise<void>; authorizeRequest(url: string, method: string): Promise<boolean>; maxScreenshotBytes: number; authorizeHumanRequest?(url:string,method:string):Promise<boolean> }>;
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
  const humanRequests=new Set<Promise<void>>();
  const humanRedirects=new WeakMap<Page,Set<string>>();
  let takeover: ReturnType<typeof nativeBrowserHandoff> | undefined;
  let attachmentCapture:{page:Page;url:string;complete:boolean;consume(response:APIResponse):Promise<void>}|undefined;
  let uploadAuthority:{sessionKey:string;destination:string;expiresAt:number;assertCurrent():Promise<void>;page?:Page;armed:boolean;postDispatched:boolean;consume(response:APIResponse):Promise<void>}|undefined;
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
    try { if(uploadAuthority)await uploadAuthority.assertCurrent();else await options.admit(); }
    catch (error) { if (error instanceof GeneralBrowserError) throw error; throw new GeneralBrowserError('rejected'); }
  };
  const admit = async (session: BrowserSession) => { identity(session);if(uploadAuthority&&(uploadAuthority.sessionKey!==connectionKey(session)||uploadAuthority.expiresAt<=options.now()))throw new GeneralBrowserError('rejected'); await hostAdmit(); identity(session);if(uploadAuthority&&uploadAuthority.expiresAt<=options.now())throw new GeneralBrowserError('rejected'); };
  const actionTimeout = (session: BrowserSession) => {
    const remaining = Math.min(session.expiresAt, uploadAuthority?.expiresAt??options.deadline()) - options.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new GeneralBrowserError('rejected');
    return Math.min(10000, remaining);
  };
  const allowed = async (session: BrowserSession, url: string, method = 'GET') => {
    await admit(session);
    const target = new URL(url);
    if (uploadAuthority&&(!['GET','HEAD'].includes(method)||target.origin!==new URL(uploadAuthority.destination).origin))throw new GeneralBrowserError('rejected');
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
    if(takeover)throw new GeneralBrowserError('rejected');
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
          const capture=attachmentCapture,request=route.request();
          if(uploadAuthority&&request.method()==='POST'){
            const held=uploadAuthority;
            if(!held.armed||held.postDispatched||request.url()!==held.destination||request.frame().parentFrame()||request.frame().page()!==held.page)throw new GeneralBrowserError('rejected');
            // Reserve one approved request before awaiting custody. Retained JS
            // cannot turn file selection into a second POST or another destination.
            held.postDispatched=true;await admit(session);
            if(!await options.authorizeRequest(request.url(),'GET'))throw new GeneralBrowserError('rejected');
            await admit(session);const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:actionTimeout(session)});await admit(session);
            await held.consume(response);await admit(session);await route.fulfill({response});return;
          }
          if(capture&&request.url()===capture.url&&request.isNavigationRequest()&&!request.frame().parentFrame()&&request.frame().page()===capture.page){
            await guardGeneralBrowserRoute(route,{authorize:(url,method)=>allowed(session,url,method),timeout:()=>actionTimeout(session),admit:()=>admit(session),redirect:()=>{throw new GeneralBrowserError('rejected');},denied:(page,status)=>{invalidDocuments.add(page);documentFailure=new GeneralBrowserError('page_unavailable',{status});},attachment:async response=>{await capture.consume(response);capture.complete=true;}});
            return;
          }
          if(takeover){
            const request=route.request(),page=request.frame().page();
            const authorize=async(url:string,method:string)=>{identity(session);if(!takeover||!options.authorizeHumanRequest||!await options.authorizeHumanRequest(url,method))throw new GeneralBrowserError('rejected');identity(session);};
            // Preserve the existing 10s transport bound, using funded session
            // expiry rather than the model turn that has deliberately ended.
            const timeout=()=>{const remaining=session.expiresAt-options.now();if(remaining<=0)throw new GeneralBrowserError('rejected');return Math.min(10000,remaining);};
            let redirect:Readonly<{page:Page;url:string;committed:Promise<unknown>}>|undefined;
            await guardGeneralBrowserRoute(route,{authorize,timeout,admit:()=>authorize(request.url(),request.method()),redirect:(page,url)=>{const committed=page.waitForEvent('domcontentloaded',{timeout:timeout()});void committed.catch(()=>undefined);redirect={page,url,committed};},denied:(page,status)=>{invalidDocuments.add(page);documentFailure=new GeneralBrowserError('page_unavailable',{status});}});
            if(redirect){
              const visited=humanRedirects.get(page)??new Set<string>();visited.add(request.url());
              if(visited.has(redirect.url)||visited.size>GENERAL_BROWSER_REDIRECT_LIMIT)throw new GeneralBrowserError('rejected');humanRedirects.set(page,visited);
              await redirect.committed;if(page.url()!==request.url())throw new GeneralBrowserError('rejected');
              await authorize(redirect.url,'GET');await redirect.page.goto(redirect.url,{waitUntil:'domcontentloaded',timeout:timeout()});
            }else if(request.isNavigationRequest()&&!request.frame().parentFrame())humanRedirects.delete(page);
            return;
          }
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
        await context.route('**/*', route => {
          // Once Done has been consumed, reject new viewer requests while any
          // admitted human transport settles before fresh agent observation.
          if(takeover?.ready())return route.abort('blockedbyclient');
          const human=takeover,pending=currentRouteGuard!(route);
          if(human){humanRequests.add(pending);const settled=()=>{humanRequests.delete(pending);};void pending.then(settled,settled);}
          return pending;
        });
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
  const semanticSnapshot = async (session: BrowserSession, context: BrowserContext, page: Page,state:GeneralPageState) => {
    const cdp = await boundedSemanticRead(session,()=>context.newCDPSession(page));
    try {
      await admit(session);
      const {nodes} = await boundedSemanticRead(session,()=>cdp.send('Accessibility.getFullAXTree')); await admit(session);
      // Correlate marked secret DOM controls by backend ID rather than role:
      // numeric OTPs and overridden ARIA roles are still credential fields.
      const secretBackends=new Set<number>();
      if(state.elements.some(element=>element.secret)){
        const {root}=await boundedSemanticRead(session,()=>cdp.send('DOM.getDocument',{depth:-1,pierce:true}));await admit(session);
        const domNodes=[root];
        while(domNodes.length){
          const node=domNodes.pop()!,attributes=new Map<string,string>();
          for(let i=0;i<(node.attributes?.length??0);i+=2)attributes.set(node.attributes![i]!.toLowerCase(),node.attributes![i+1]!);
          if(['INPUT','TEXTAREA'].includes(node.nodeName)&&(attributes.get('type')?.toLowerCase()==='password'||(attributes.get('autocomplete')??'').toLowerCase().split(/\s+/).includes('one-time-code')))secretBackends.add(node.backendNodeId);
          domNodes.push(...(node.children??[]),...(node.shadowRoots??[]));if(node.contentDocument)domNodes.push(node.contentDocument);
        }
      }
      const secretNodes=new Set(nodes.filter(node=>node.backendDOMNodeId!==undefined&&secretBackends.has(node.backendDOMNodeId)).map(node=>node.nodeId));
      const matchedBackends=new Set(nodes.filter(node=>node.backendDOMNodeId!==undefined&&secretBackends.has(node.backendDOMNodeId)).map(node=>node.backendDOMNodeId));
      if(matchedBackends.size<state.elements.filter(element=>element.secret).length)throw new GeneralBrowserError('stale_observation');
      const byId=new Map(nodes.map(node=>[node.nodeId,node])),secretChildren=new Set<string>();
      const pending=nodes.filter(node=>secretNodes.has(node.nodeId)).flatMap(node=>node.childIds??[]);
      while(pending.length){const id=pending.pop()!;if(secretChildren.has(id))continue;secretChildren.add(id);pending.push(...(byId.get(id)?.childIds??[]));}
      const visible=nodes.filter(node=>!node.ignored&&!secretChildren.has(node.nodeId));
      const indexes=new Map(visible.map((node,index)=>[node.nodeId,index]));
      return JSON.stringify(visible.map(node=>({
        role:node.role?.value, name:secretNodes.has(node.nodeId)?'[owner credential field]':node.name?.value, ...(node.description&&!secretNodes.has(node.nodeId)?{description:node.description.value}:{}),
        ...(node.value&&!secretNodes.has(node.nodeId)?{value:node.value.value}:{}),
        states:Object.fromEntries((node.properties??[]).filter(property=>['disabled','expanded','checked','selected','readonly','required','invalid','multiselectable','level','modal','orientation'].includes(property.name)).map(property=>[property.name,property.value.value])),
        children:(node.childIds??[]).flatMap(id=>indexes.has(id)?[indexes.get(id)!]:[]),
      })));
    } finally { await cleanup(step=>step(()=>cdp.detach())); }
  };
  const observe = async (session: BrowserSession, context: BrowserContext, page: Page): Promise<GeneralSnapshot> => {
    await allowed(session, page.url());
    const state = await page.evaluate(generalPageState); await admit(session);
    const semantic = await semanticSnapshot(session,context,page,state); await admit(session);
    if (!state.text.trim()) throw new GeneralBrowserError('empty_content');
    const bytes = new Uint8Array(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css',mask:[page.locator('input[type="password"],input[autocomplete~="one-time-code" i],textarea[autocomplete~="one-time-code" i]')] })); await admit(session);
    if (bytes.byteLength > options.maxScreenshotBytes) throw new GeneralBrowserError('image_oversize');
    const current = await page.evaluate(generalPageState); await admit(session);
    const currentSemantic = await semanticSnapshot(session,context,page,current); await admit(session);
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
      try{await takeover?.dispose();}finally{takeover=undefined;}
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
    async beginOwnerHandoff(session:BrowserSession,snapshot:GeneralActionSnapshot,reason:string,assertCustody:()=>Promise<void>){
      await assertCustody();identity(session);if(takeover||!connected||connected.sessionKey!==connectionKey(session))throw new GeneralBrowserError('session_lost');
      const page=await select(session,connected.context,snapshot.observation.tab_ref);
      if(await targetId(connected.context,page)!==snapshot.targetId)throw new GeneralBrowserError('stale_observation');
      const cdp=await connected.context.newCDPSession(page);
      takeover=nativeBrowserHandoff({cdp,providerSessionId:session.providerSessionId,targetId:snapshot.targetId,expiresAt:session.expiresAt,now:options.now,assertCustody});
      return {controller:takeover,handoffId:await takeover.start(reason),origin:new URL(page.url()).origin};
    },
    async finishOwnerHandoff(session:BrowserSession,reference:string){
      if(!takeover?.ready())throw new GeneralBrowserError('rejected');
      const held=takeover;await Promise.all([...humanRequests]);if(!held.ready())throw new GeneralBrowserError('rejected');held.complete();await held.dispose();takeover=undefined;
      return attached(session,async(_,context)=>observe(session,context,await select(session,context,reference)));
    },
    upload:async(session:BrowserSession,snapshot:GeneralActionSnapshot,reference:string,file:Readonly<{name:string;mimeType:string;buffer:Uint8Array}>,authority:Readonly<{destination:string;expiresAt:number;assertCurrent():Promise<void>}>,beforeExposure:()=>Promise<void>)=>{
      if(uploadAuthority||takeover||attachmentCapture||snapshot.ownerId!==session.ownerId||snapshot.sessionId!==session.id||snapshot.generation!==session.generation||authority.expiresAt>session.expiresAt||authority.expiresAt<=options.now()||!file.buffer.length||file.buffer.length>LIMITS.fileBytes)throw new GeneralBrowserError('rejected');
      validatePath(file.name);if(file.name.includes('/')||file.name.includes('\\'))throw new GeneralBrowserError('rejected');
      const destination=new URL(authority.destination);if(destination.origin!==new URL(snapshot.observation.url).origin||destination.username||destination.password||destination.hash)throw new GeneralBrowserError('rejected');
      file={...file,buffer:new Uint8Array(file.buffer)};const sha256=await generalDigest(file.buffer);let resolve!:(receipt:BrowserDownloadMetadata)=>void,reject!:(error:unknown)=>void;
      const received=new Promise<BrowserDownloadMetadata>((yes,no)=>{resolve=yes;reject=no;});void received.catch(()=>{});
      if(uploadAuthority)throw new GeneralBrowserError('rejected');
      uploadAuthority={...authority,sessionKey:connectionKey(session),armed:false,postDispatched:false,consume:async response=>{
        try{
          if(response.status()!==200||(response.headers()['content-type']??'').split(';')[0]!.trim().toLowerCase()!=='application/json')throw new GeneralBrowserError('outcome_uncertain');
          const bytes=await boundedSemanticRead(session,async()=>new Uint8Array(await response.body()));if(bytes.length>LIMITS.fileBytes)throw new GeneralBrowserError('outcome_uncertain');
          const body=JSON.parse(new TextDecoder().decode(bytes));
          if(body?.filename!==file.name||body?.byte_size!==file.buffer.length||body?.sha256!==sha256)throw new GeneralBrowserError('outcome_uncertain');
          await admit(session);resolve({filename:file.name,mime:file.mimeType,byte_size:file.buffer.length,sha256});
        }catch(error){reject(error);throw error;}
      }};
      // This origin fence remains after completion or uncertainty. Clearing an
      // input cannot revoke bytes already retained by page JavaScript.
      return attached(session,async(_,context)=>{
        const page=await select(session,context,snapshot.observation.tab_ref);uploadAuthority!.page=page;
        const fresh=await observe(session,context,page);
        if(fresh.targetId!==snapshot.targetId||fresh.digest!==snapshot.digest)throw new GeneralBrowserError('stale_observation');
        const element=snapshot.state.elements[snapshot.observation.elements.findIndex(element=>element.ref===reference)];
        if(!element||element.tag!=='input'||element.type!=='file'||element.disabled||!element.inForm||element.formMethod?.toLowerCase()!=='post'||element.formAction!==authority.destination)throw new GeneralBrowserError('rejected');
        const input=await page.locator(element.selector).elementHandle();if(!input)throw new GeneralBrowserError('stale_observation');
        try{
          await beforeExposure();await admit(session);
          const current=await observe(session,context,page);
          if(current.targetId!==snapshot.targetId||current.digest!==snapshot.digest)throw new GeneralBrowserError('stale_observation');
          // Keep the exact native node rather than resolving CSS again after
          // consent/checkpoint awaits; replaced or adopted nodes fail admission.
          const valid=await input.evaluate((node,args)=>{const root=globalThis as any,element=node as any;return element.isConnected&&element.ownerDocument===root.document&&element.ownerDocument.URL===args.url&&element.tagName==='INPUT'&&element.type==='file'&&!element.disabled&&element.form?.method.toLowerCase()==='post'&&element.form.action===args.destination;},{url:snapshot.observation.url,destination:authority.destination});
          if(!valid)throw new GeneralBrowserError('stale_observation');await admit(session);uploadAuthority!.armed=true;
          // Wrangler supplies Buffer for the activated Node-compatible browser
          // entrypoint; an eager node:buffer import breaks the ordinary Worker.
          await input.setInputFiles({name:file.name,mimeType:file.mimeType,buffer:Buffer.from(file.buffer)},{timeout:actionTimeout(session)});
        }finally{await input.dispose();}
        return boundedSemanticRead(session,()=>received);
      });
    },
    download:(session:BrowserSession,snapshot:GeneralActionSnapshot,reference:string,beforeDispatch:()=>Promise<void>,consume:(metadata:BrowserDownloadMetadata,bytes:Uint8Array)=>Promise<void>)=>attached(session,async(_,context)=>{
      if(attachmentCapture||snapshot.ownerId!==session.ownerId||snapshot.sessionId!==session.id||snapshot.generation!==session.generation)throw new GeneralBrowserError('stale_observation');
      const page=await select(session,context,snapshot.observation.tab_ref),fresh=await observe(session,context,page);
      if(fresh.targetId!==snapshot.targetId||fresh.digest!==snapshot.digest)throw new GeneralBrowserError('stale_observation');
      const element=snapshot.state.elements[snapshot.observation.elements.findIndex(element=>element.ref===reference)];
      if(!element||element.disabled||element.tag!=='a'||!element.href)throw new GeneralBrowserError('rejected');
      await allowed(session,element.href);await beforeDispatch();await admit(session);
      const capture=attachmentCapture={page,url:element.href,complete:false,consume:async response=>{
        const attachment=await browserHttpAttachment(response,()=>boundedSemanticRead(session,async()=>new Uint8Array(await response.body())));
        await admit(session);await consume(attachment.metadata,attachment.bytes);await admit(session);
      }};
      try{
        try{await page.goto(element.href,{waitUntil:'domcontentloaded',timeout:actionTimeout(session)});}
        catch(error){if(!capture.complete||!(error instanceof Error)||!error.message.startsWith(`page.goto: net::ERR_ABORTED at ${element.href}\n`))throw error;}
        if(!capture.complete)throw new GeneralBrowserError('page_unavailable');
      }finally{if(attachmentCapture===capture)attachmentCapture=undefined;}
    }),
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
      if (action.operation === 'fill' && (!['input', 'textarea'].includes(element!.tag) && !element!.editable || element!.readOnly || element!.secret || ['password', 'file', 'hidden', 'checkbox', 'radio'].includes(element!.type))) throw new GeneralBrowserError('rejected');
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
