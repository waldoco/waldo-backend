import type { Browser, BrowserContext, BrowserWorker, Page } from '@cloudflare/playwright';
import type { BrowsePageArgs, BrowserReadDiagnostic, ToolResult } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { EGRESS_TARGET_PATHS, OPEN_PUBLIC, evaluateDeclaredEgress } from '../hooks/egress-policy';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { browserBoundedJson } from './browser-bounded-body';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

export type CloudflarePageReader = (args: BrowsePageArgs, context: ToolDispatcherContext) => Promise<ToolResult<Readonly<{ url: string; provider: 'cloudflare_playwright'; data: { title: string; text: string } }>>>;
// Preserve the pinned Playwright request default while vetting each hop manually.
const PLAYWRIGHT_REDIRECT_LIMIT = 20;
class ProviderFailure extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
class ReadFailure extends Error {
  constructor(readonly reason: BrowserReadDiagnostic['reason'], readonly phase: BrowserReadDiagnostic['phase'], message: string) { super(message); }
}
const diagnostic = async (response: Response, deadline: number) => {
  const token = (raw: unknown) => { const value = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw; return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined; };
  let code: string | undefined;
  try {
    const body = await browserBoundedJson(response, 4096, Math.max(1, deadline - Date.now())) as { code?: unknown; error?: { code?: unknown }; errors?: { code?: unknown }[] };
    code = token(body?.code) ?? token(body?.error?.code) ?? token(body?.errors?.[0]?.code);
  } catch { /* provider text never becomes instructions or diagnostics */ }
  const request = token(response.headers.get('x-request-id')) ?? token(response.headers.get('cf-ray'));
  return `The Cloudflare browser provider failed (HTTP ${response.status}${code ? `, code ${code}` : ''}${request ? `, request ${request}` : ''}).`;
};
const failure = (code: 'rejected' | 'transient' | 'not_found', error: string, browser_read?: BrowserReadDiagnostic) => ({ ok: false as const, code, error, source_taint: 'external' as const, ...(browser_read ? { browser_read } : {}) });

// Same public-read capability and source custody as browse_page. Each invocation
// owns a fresh private session; no owner profile, credentials or fixture grants.
export function cloudflarePublicRead(options: Readonly<{ binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader }>): CloudflarePageReader {
  return async (args, context) => {
    let phase: BrowserReadDiagnostic['phase'] = 'admission';
    let cleanup: BrowserReadDiagnostic['cleanup'] = 'not_started';
    const failed = (code: 'rejected' | 'transient' | 'not_found', error: string, reason: BrowserReadDiagnostic['reason'], at = phase, http_status?: number) =>
      failure(code, error, { provider: 'cloudflare_playwright', phase: at, reason, cleanup, ...(http_status === undefined ? {} : { http_status }) });
    const allowed = (url: string) => evaluateDeclaredEgress({ url }, EGRESS_TARGET_PATHS.browse_page!, context.egressAllowlist,
      { openPublic: context.egressAllowlist?.includes(OPEN_PUBLIC) === true }).ok;
    if (!context.authenticatedUserId || !context.assertTaskSourceCurrent || !allowed(args.url)) return failed('rejected', 'The public browser read is not currently authorized.', 'source_rejected');
    const workDeadline = Math.min(context.runScope?.deadline ?? Infinity, Date.now() + 30000);
    let cleanupDeadline: number | undefined;
    const bounded = async <T>(work: () => Promise<T>, cleanup = false): Promise<T> => {
      const deadline = cleanup ? cleanupDeadline! : workDeadline;
      if (deadline <= Date.now()) throw new ReadFailure('deadline_elapsed', phase, 'The browser deadline elapsed.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadFailure('deadline_elapsed', phase, 'The browser deadline elapsed.')), Math.max(0, deadline - Date.now())); })]);
      } finally { clearTimeout(timer); }
    };
    const admitRun = () => {
      try { context.runScope?.admit(); }
      catch { throw new ReadFailure(workDeadline <= Date.now() ? 'deadline_elapsed' : 'run_closed', 'admission', 'The browser run is closed or expired.'); }
    };
    const admit = async () => {
      admitRun();
      try { await bounded(() => context.assertTaskSourceCurrent!()); }
      catch (cause) { if (cause instanceof ReadFailure) throw cause; throw new ReadFailure('source_rejected', 'admission', 'The browser source permission changed.'); }
      admitRun();
    };
    let page: Page | undefined, navigationRedirect: string | undefined;
    let providerHttpStatus: number | undefined;
    let browser: Browser | undefined, privateContext: BrowserContext | undefined, id: string | undefined;
    let sdk: Awaited<ReturnType<CloudflareBrowserSdkLoader>> | undefined;
    let result: Awaited<ReturnType<CloudflarePageReader>> = failed('transient', 'The Cloudflare browser request failed.', 'provider_failure');
    // Intercept HTTP failures before the SDK turns raw response bodies into Error text.
    const binding = { fetch: async (...inputArgs: Parameters<BrowserWorker['fetch']>) => {
      if (cleanupDeadline === undefined) admitRun();
      const [input, init] = inputArgs;
      const timeout = AbortSignal.timeout(Math.max(1, (cleanupDeadline ?? workDeadline) - Date.now()));
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await options.binding.fetch(input, { ...init, signal });
      if ((!response.ok && response.status !== 101) || (phase === 'allocation' && cleanupDeadline === undefined && response.status !== 200)) {
        providerHttpStatus = response.status;
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        // A documented admission refusal is not a lost allocation acknowledgement.
        if (!id && phase === 'allocation' && init?.method === 'POST' && url.pathname === '/v1/devtools/browser' && [402, 429].includes(response.status)) cleanup = 'allocation_refused';
        throw new ProviderFailure(await diagnostic(response, cleanupDeadline ?? workDeadline), response.status);
      }
      return response;
    } } as BrowserWorker;
    const connect = () => {
      // The pinned runtime supports persistent, though 1.3.6's declaration omits it.
      const connectOptions = { sessionId: id!, persistent: true };
      return sdk!.connect(binding, connectOptions);
    };
    try {
      const target = new URL(args.url);
      const guard = cloudflareBrowserGuardOptions([target.hostname]);
      await admit();
      phase = 'initialization';
      sdk = await bounded(options.loadSdk);
      await admit();
      phase = 'allocation'; cleanup = 'unknown_allocation';
      const session = await bounded(() => sdk!.acquire(binding, guard));
      if (typeof session?.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sessionId)) throw new ReadFailure('invalid_session', phase, 'The provider returned no valid browser session identity.');
      id = session.sessionId; cleanup = 'unconfirmed';
      await admit();
      phase = 'connection';
      browser = await bounded(connect);
      await admit();
      privateContext = await bounded(() => browser!.newContext({ serviceWorkers: 'block' }));
      await bounded(() => privateContext!.route('**/*', async route => {
        try {
          await admit();
          const url = new URL(route.request().url());
          // The provider guard remains pinned to the requested host. Cross-host
          // navigation requires a new owner-authorized read, never implicit widening.
          if (url.hostname === target.hostname && allowed(url.href) && route.request().method() === 'GET') {
            // route.continue only checks the first URL in a redirect chain. Fetch
            // without following redirects so a same-host private port cannot bypass egress.
            const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
            await admit();
            if (response.status() >= 300 && response.status() < 400) {
              const location = response.headers()['location'];
              if (location && route.request().isNavigationRequest() && route.request().frame() === page?.mainFrame()) navigationRedirect = new URL(location, url).href;
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
      await admit();
      phase = 'navigation';
      let nextUrl = args.url, response: Awaited<ReturnType<Page['goto']>> = null;
      const visited = new Set<string>();
      for (;;) {
        if (!allowed(nextUrl) || new URL(nextUrl).hostname !== target.hostname || visited.has(nextUrl) || visited.size > PLAYWRIGHT_REDIRECT_LIMIT) throw new ReadFailure('unsafe_redirect', phase, 'The browser redirect was rejected.');
        visited.add(nextUrl); navigationRedirect = undefined;
        await admit();
        try { response = await bounded(() => page!.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })); }
        catch (cause) { if (!navigationRedirect) throw cause; }
        if (!navigationRedirect) break;
        // A new top-level navigation checks each target before I/O; no fresh
        // session, grant or transport retry. The original run deadline bounds chains.
        nextUrl = navigationRedirect;
      }
      await admit();
      const url = page.url();
      if (!allowed(url) || new URL(url).hostname !== target.hostname) result = failed('rejected', 'The page moved outside the selected public browser target.', 'unsafe_redirect');
      else if (!response || response.status() >= 400) result = failed('transient', `The page did not load${response ? ` (HTTP ${response.status()})` : ''}.`, response ? 'page_http' : 'navigation_failed', phase, response?.status());
      else {
        phase = 'extraction';
        const title = await bounded(() => page!.title());
        await admit();
        const text = await bounded(() => page!.locator('body').innerText());
        await admit();
        if (page.url() !== url) result = failed('rejected', 'The page moved during the read.', 'unsafe_redirect');
        else if (!text.trim()) result = failed('not_found', 'The page returned no readable content.', 'empty_content');
        else result = { ok: true, data: { url, provider: 'cloudflare_playwright', data: { title, text } }, source_taint: 'external', browser_read: { provider: 'cloudflare_playwright', phase: 'complete', reason: 'completed', cleanup } };
      }
    } catch (cause) {
      result = cause instanceof ReadFailure ? failed('rejected', cause.message, cause.reason, cause.phase, providerHttpStatus)
        : Date.now() >= workDeadline ? failed('rejected', 'The browser deadline elapsed.', 'deadline_elapsed', phase, providerHttpStatus)
        : cause instanceof ProviderFailure ? failed('transient', cause.message, 'provider_http', phase, cause.status)
        : failed('transient', 'The Cloudflare browser request failed.', phase === 'navigation' ? 'navigation_failed' : 'provider_failure');
    }
    finally {
      // Cleanup does not depend on source admission. connect.close only disconnects;
      // Browser.close and an absence readback are required to certify termination.
      cleanupDeadline = Date.now() + 10000;
      if (id && sdk) {
        let terminated = false;
        try {
          try { await bounded(async () => { await privateContext?.close(); }, true); } catch { /* terminate the browser even if its context is damaged */ }
          browser ??= await bounded(connect, true);
          try { await bounded(async () => { const cdp = await browser!.newBrowserCDPSession(); await cdp.send('Browser.close'); }, true); } catch { /* termination can disconnect before acknowledgement */ }
          terminated = !(await bounded(() => sdk!.sessions(binding), true)).some(session => session.sessionId === id);
        } catch { /* keep honest cleanup uncertainty */ }
        try { await bounded(async () => { await browser?.close(); }, true); } catch { /* absence is the termination proof */ }
        cleanup = terminated ? 'confirmed' : 'unconfirmed';
      }
      if (cleanup === 'unconfirmed' || cleanup === 'unknown_allocation') result = failed('rejected', `${result.ok ? '' : `${result.error} `}The Cloudflare browser cleanup is unconfirmed. No browser read is reported as complete.`, result.ok ? 'cleanup_unconfirmed' : result.browser_read!.reason, result.ok ? 'cleanup' : result.browser_read!.phase, result.browser_read?.http_status);
      else result = { ...result, browser_read: { ...result.browser_read!, cleanup } };
    }
    if (result.ok) {
      try { await admit(); } catch (cause) { return failed('rejected', 'The browser source permission changed before the result was returned.', cause instanceof ReadFailure ? cause.reason : 'source_rejected', 'admission'); }
    }
    return result;
  };
}
