import type { Browser, BrowserContext, BrowserWorker, Page, Request, WorkersLaunchOptions } from '@cloudflare/playwright';
import type { BrowsePageArgs, ToolResult } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { EGRESS_TARGET_PATHS, OPEN_PUBLIC, evaluateDeclaredEgress } from '../hooks/egress-policy';
import { browserBoundedJson } from './browser-bounded-body';
import { prepareGeneralPublicRead } from './general-browser-public-read';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

export type CloudflarePageReader = (args: BrowsePageArgs, context: ToolDispatcherContext) => Promise<ToolResult<Readonly<{ url: string; provider: 'cloudflare_playwright'; data: { title: string; text: string } }>>>;
// Existing 30s work, 10s cleanup and 10s provider idle expiry after disconnect.
export const PUBLIC_READ_RESERVED_BROWSER_MS=50000;
export type PublicReadReservation = Readonly<{ settle(durationMs: number): void }>;
// A reservation refusal no retry changes, reported as rejected. Its message reaches the model as written, so it names
// what to do next and carries no identifiers.
export class PublicReadRefusal extends Error {}
// Preserve the pinned Playwright request default while vetting each hop manually.
const PLAYWRIGHT_REDIRECT_LIMIT = 20;
const CLEANUP_ABSENCE_ATTEMPTS = 4;
const CLEANUP_ABSENCE_INTERVAL_MS = 250;
// Pages that render with script need more than domcontentloaded. The settle waits follow Cloudflare's playwright-mcp
// (load, up to 5 s) and Stagehand (500 ms with no request in flight, capped at 5 s, a stalled request stops counting
// after 2 s). Each stops early enough to leave the content read its share of the 30 s work deadline.
const NAVIGATION_TIMEOUT_MS = 20000;
const LOAD_WAIT_MS = 5000;
const QUIET_WINDOW_MS = 500;
const QUIET_CAP_MS = 5000;
const STALLED_REQUEST_MS = 2000;
const SCROLL_QUIET_CAP_MS = 2000;
const EMPTY_TEXT_RECHECK_MS = 3000;
const SETTLE_RESERVE_MS = 5000;
const UNREAD_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const STREAMING_RESOURCE_TYPES = new Set(['websocket', 'eventsource']);
type ReadStage = 'setup' | 'allocation' | 'connection' | 'context' | 'navigation' | 'content';
class ProviderFailure extends Error {}
const diagnostic = async (response: Response) => {
  const token = (raw: unknown) => { const value = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw; return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined; };
  let code: string | undefined;
  try {
    const body = await browserBoundedJson(response) as { code?: unknown; error?: { code?: unknown }; errors?: { code?: unknown }[] };
    code = token(body?.code) ?? token(body?.error?.code) ?? token(body?.errors?.[0]?.code);
  } catch { /* provider text never becomes instructions or diagnostics */ }
  const request = token(response.headers.get('x-request-id')) ?? token(response.headers.get('cf-ray'));
  return `The Cloudflare browser provider failed (HTTP ${response.status}${code ? `, code ${code}` : ''}${request ? `, request ${request}` : ''}).`;
};
const failure = (code: 'rejected' | 'transient' | 'not_found', error: string) => ({ ok: false as const, code, error, source_taint: 'external' as const });

// Same public-read capability and source custody as browse_page. Each invocation
// owns a fresh private session; no owner profile, credentials or fixture grants.
export function cloudflarePublicRead(options: Readonly<{ binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader; reserveAllocation?():Promise<PublicReadReservation | void> }>): CloudflarePageReader {
  return async (args, context) => {
    const allowed = (url: string) => evaluateDeclaredEgress({ url }, EGRESS_TARGET_PATHS.browse_page!, context.egressAllowlist,
      { openPublic: context.egressAllowlist?.includes(OPEN_PUBLIC) === true }).ok;
    if (!context.authenticatedUserId || !context.assertTaskSourceCurrent || !allowed(args.url)) return failure('rejected', 'The public browser read is not currently authorized.');
    const workDeadline = Math.min(context.runScope?.deadline ?? Infinity, Date.now() + 30000);
    let cleanupDeadline: number | undefined;
    const bounded = async <T>(work: () => Promise<T>, cleanup = false): Promise<T> => {
      const deadline = cleanup ? cleanupDeadline! : workDeadline;
      if (deadline <= Date.now()) throw Error('browser deadline elapsed');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('browser deadline elapsed')), Math.max(0, deadline - Date.now())); })]);
      } finally { clearTimeout(timer); }
    };
    const admit = async () => { context.runScope?.admit(); await bounded(() => context.assertTaskSourceCurrent!()); context.runScope?.admit(); };
    let page: Page | undefined, navigationRedirect: string | undefined;
    let browser: Browser | undefined, privateContext: BrowserContext | undefined, id: string | undefined;
    let sdk: Awaited<ReturnType<CloudflareBrowserSdkLoader>> | undefined;
    let reservation: PublicReadReservation | void = undefined, acquiredAt: number | undefined;
    let result: Awaited<ReturnType<CloudflarePageReader>> = failure('transient', 'The Cloudflare browser request failed.');
    let readStage: ReadStage = 'setup';
    const cleanupFailure = (error: string) => {
      // Only our already-sanitized failure and fixed stage label survive cleanup.
      result = result.ok ? failure('transient', `Read stage: content; page text was read but discarded. ${error}`) : { ...result, error: `${result.error} Read stage: ${readStage}. ${error}` };
    };
    // Intercept HTTP failures before the SDK turns raw response bodies into Error text.
    const binding = { fetch: async (...inputArgs: Parameters<BrowserWorker['fetch']>) => {
      if (cleanupDeadline === undefined) context.runScope?.admit();
      const [input, init] = inputArgs;
      const timeout = AbortSignal.timeout(Math.max(1, (cleanupDeadline ?? workDeadline) - Date.now()));
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await options.binding.fetch(input, { ...init, signal });
      if (!response.ok && response.status !== 101) throw new ProviderFailure(await diagnostic(response));
      return response;
    } } as BrowserWorker;
    const connect = () => {
      // The pinned runtime supports persistent, though 1.3.6's declaration omits it.
      const connectOptions = { sessionId: id!, persistent: true };
      return sdk!.connect(binding, connectOptions);
    };
    try {
      const target = new URL(args.url);
      // No provider host guardrail: it would refuse every other host before the per-request egress check below could
      // admit a page's public resources. The retained public session acquires the same way.
      const guard: WorkersLaunchOptions = { recording: false, keep_alive: 10000 };
      await admit();
      sdk = await bounded(options.loadSdk);
      await admit();
      // The existing 30s work +10s cleanup +10s idle window is reserved by the
      // authenticated owner host before allocation. Uncertainty never refunds it.
      if(options.reserveAllocation)reservation=await bounded(options.reserveAllocation);
      await admit();
      readStage = 'allocation';
      acquiredAt = Date.now();
      const session = await bounded(() => sdk!.acquire(binding, guard));
      if (typeof session?.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sessionId)) throw Error('invalid provider session');
      id = session.sessionId;
      await admit();
      readStage = 'connection';
      browser = await bounded(connect);
      await admit();
      readStage = 'context';
      privateContext = await bounded(() => browser!.newContext({ serviceWorkers: 'block' }));
      if (!await bounded(() => prepareGeneralPublicRead(privateContext!))) throw Error('browser context is not private');
      await bounded(() => privateContext!.route('**/*', async route => {
        try {
          await admit();
          const request = route.request(), url = new URL(request.url());
          // Top-level navigation, a popup's included, stays on the requested host: moving elsewhere takes a new
          // owner-authorized read. Scripts, styles, frames and XHR may come from any host that passes egress.
          const topLevel = request.isNavigationRequest() && !request.frame().parentFrame();
          if (allowed(url.href) && !UNREAD_RESOURCE_TYPES.has(request.resourceType()) && (!topLevel || (url.hostname === target.hostname && request.method() === 'GET'))) {
            // route.continue only checks the first URL in a redirect chain. Fetch
            // without following redirects so a redirect to a private host cannot bypass egress.
            const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
            await admit();
            if (response.status() >= 300 && response.status() < 400) {
              const location = response.headers()['location'];
              if (location && request.isNavigationRequest() && request.frame() === page?.mainFrame()) navigationRedirect = new URL(location, url).href;
              await route.abort('blockedbyclient');
            }
            else await route.fulfill({ response });
          }
          else await route.abort('blockedbyclient');
        } catch { await route.abort('blockedbyclient'); }
      }));
      await admit();
      page = await bounded(() => privateContext!.newPage());
      page.setDefaultTimeout(10000);
      const inFlight = new Map<Request, number>();
      let lastActivity = -Infinity;
      page.on('request', request => { if (!STREAMING_RESOURCE_TYPES.has(request.resourceType())) { inFlight.set(request, Date.now()); lastActivity = Date.now(); } });
      const settled = (request: Request) => { if (inFlight.delete(request)) lastActivity = Date.now(); };
      page.on('requestfinished', settled); page.on('requestfailed', settled);
      const settleBy = (capMs: number) => Math.min(Date.now() + capMs, workDeadline - SETTLE_RESERVE_MS);
      const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
      // A wait that runs out is not a failure: the read goes ahead with whatever the page has rendered.
      const waitUpTo = async (capMs: number, work: () => Promise<unknown>) => {
        const stop = settleBy(capMs);
        if (stop <= Date.now()) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([work().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, stop - Date.now()); })]); }
        finally { clearTimeout(timer); }
      };
      const networkQuiet = async (capMs: number) => {
        const stop = settleBy(capMs);
        for (;;) {
          const now = Date.now();
          for (const [request, startedAt] of inFlight) if (now - startedAt >= STALLED_REQUEST_MS) inFlight.delete(request);
          const quietFor = now - lastActivity;
          if ((!inFlight.size && quietFor >= QUIET_WINDOW_MS) || now >= stop) return;
          await pause(Math.min(inFlight.size ? 100 : QUIET_WINDOW_MS - quietFor, stop - now));
        }
      };
      await admit();
      readStage = 'navigation';
      let nextUrl = args.url, response: Awaited<ReturnType<Page['goto']>> = null;
      const visited = new Set<string>();
      for (;;) {
        if (!allowed(nextUrl) || new URL(nextUrl).hostname !== target.hostname || visited.has(nextUrl) || visited.size > PLAYWRIGHT_REDIRECT_LIMIT) throw Error('browser redirect rejected');
        visited.add(nextUrl); navigationRedirect = undefined;
        await admit();
        try { response = await bounded(() => page!.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(NAVIGATION_TIMEOUT_MS, workDeadline - Date.now())) })); }
        catch (cause) { if (!navigationRedirect) throw cause; }
        if (!navigationRedirect) break;
        // A new top-level navigation checks each target before I/O; no fresh
        // session, grant or transport retry. The original run deadline bounds chains.
        nextUrl = navigationRedirect;
      }
      await admit();
      await waitUpTo(LOAD_WAIT_MS, () => page!.waitForLoadState('load'));
      await networkQuiet(QUIET_CAP_MS);
      // One scroll brings in content that loads as it comes into view.
      await waitUpTo(SCROLL_QUIET_CAP_MS, () => page!.evaluate(() => { const view = globalThis as any; view.scrollTo(0, view.document.body.scrollHeight); }));
      await networkQuiet(SCROLL_QUIET_CAP_MS);
      await admit();
      const url = page.url();
      if (!allowed(url) || new URL(url).hostname !== target.hostname) result = failure('rejected', 'The page moved outside the selected public browser target.');
      else if (!response || response.status() >= 400) result = failure('transient', `The page did not load${response ? ` (HTTP ${response.status()})` : ''}.`);
      else {
        readStage = 'content';
        const title = await bounded(() => page!.title());
        await admit();
        let text = await bounded(() => page!.locator('body').innerText());
        await admit();
        // A page that is still rendering can show an empty body after the waits; look once more before calling it empty.
        if (!text.trim() && settleBy(EMPTY_TEXT_RECHECK_MS) - Date.now() >= EMPTY_TEXT_RECHECK_MS) {
          await pause(EMPTY_TEXT_RECHECK_MS);
          await admit();
          text = await bounded(() => page!.locator('body').innerText());
          await admit();
        }
        if (page.url() !== url) result = failure('rejected', 'The page moved during the read.');
        else if (!text.trim()) result = failure('not_found', 'The page returned no readable content.');
        else result = { ok: true, data: { url, provider: 'cloudflare_playwright', data: { title, text } }, source_taint: 'external' };
      }
    } catch (cause) {
      result = cause instanceof PublicReadRefusal ? failure('rejected', cause.message)
        : failure('transient', cause instanceof ProviderFailure ? cause.message : 'The Cloudflare browser read failed or its source permission changed.');
    }
    finally {
      // Cleanup does not depend on source admission. connect.close only disconnects;
      // Browser.close and an absence readback are required to certify termination.
      cleanupDeadline = Date.now() + 10000;
      if (id && sdk) {
        let terminated = false, absenceAt: number | undefined;
        try {
          try { await bounded(async () => { await privateContext?.close(); }, true); } catch { /* terminate the browser even if its context is damaged */ }
          browser ??= await bounded(connect, true);
          try { await bounded(async () => { const cdp = await browser!.newBrowserCDPSession(); await cdp.send('Browser.close'); }, true); } catch { /* termination can disconnect before acknowledgement */ }
          // Closing the transport is not an absence barrier. Observe the same ID
          // a bounded few times; never retry allocation or accept malformed proof.
          for (let attempt = 0; attempt < CLEANUP_ABSENCE_ATTEMPTS; attempt++) {
            if (attempt > 0) await bounded(() => new Promise<void>(resolve => setTimeout(resolve, CLEANUP_ABSENCE_INTERVAL_MS)), true);
            const sessions = await bounded(() => sdk!.sessions(binding), true);
            if (!Array.isArray(sessions)) throw Error('invalid provider sessions');
            const ids = new Set<string>();
            for (const session of sessions) {
              if (typeof session?.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sessionId) || ids.has(session.sessionId)) throw Error('invalid provider sessions');
              ids.add(session.sessionId);
            }
            const observedAt = Date.now();
            if (observedAt >= cleanupDeadline) throw Error('browser deadline elapsed');
            if (!ids.has(id)) { terminated = true; absenceAt = observedAt; break; }
          }
        } catch { /* keep honest cleanup uncertainty */ }
        try { await bounded(async () => { await browser?.close(); }, true); } catch { /* absence is the termination proof */ }
        if (terminated && reservation && acquiredAt !== undefined && absenceAt !== undefined) {
          try { reservation.settle(absenceAt - acquiredAt); }
          catch { cleanupFailure('The Cloudflare browser cost settlement is unconfirmed.'); }
        }
        if (!terminated) cleanupFailure('The Cloudflare browser cleanup is unconfirmed. No browser read is reported as complete.');
      }
    }
    if (result.ok) {
      try { await admit(); } catch { return failure('rejected', 'The browser source permission changed before the result was returned.'); }
    }
    return result;
  };
}
