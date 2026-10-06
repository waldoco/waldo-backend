import type { Browser, BrowserContext, BrowserWorker, Page } from '@cloudflare/playwright';
import type { BrowsePageArgs, ToolResult } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { EGRESS_TARGET_PATHS, OPEN_PUBLIC, evaluateDeclaredEgress } from '../hooks/egress-policy';
import { cloudflareBrowserGuardOptions } from './cloudflare-browser-adapter';
import { browserBoundedJson } from './browser-bounded-body';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

export type CloudflarePageReader = (args: BrowsePageArgs, context: ToolDispatcherContext) => Promise<ToolResult<Readonly<{ url: string; provider: 'cloudflare_playwright'; data: { title: string; text: string } }>>>;
// Preserve the pinned Playwright request default while vetting each hop manually.
const PLAYWRIGHT_REDIRECT_LIMIT = 20;
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
export function cloudflarePublicRead(options: Readonly<{ binding: BrowserWorker; loadSdk: CloudflareBrowserSdkLoader }>): CloudflarePageReader {
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
    let result: Awaited<ReturnType<CloudflarePageReader>> = failure('transient', 'The Cloudflare browser request failed.');
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
      const guard = cloudflareBrowserGuardOptions([target.hostname]);
      await admit();
      sdk = await bounded(options.loadSdk);
      await admit();
      const session = await bounded(() => sdk!.acquire(binding, guard));
      if (typeof session?.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sessionId)) throw Error('invalid provider session');
      id = session.sessionId;
      await admit();
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
      let nextUrl = args.url, response: Awaited<ReturnType<Page['goto']>> = null;
      const visited = new Set<string>();
      for (;;) {
        if (!allowed(nextUrl) || new URL(nextUrl).hostname !== target.hostname || visited.has(nextUrl) || visited.size > PLAYWRIGHT_REDIRECT_LIMIT) throw Error('browser redirect rejected');
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
      if (!allowed(url) || new URL(url).hostname !== target.hostname) result = failure('rejected', 'The page moved outside the selected public browser target.');
      else if (!response || response.status() >= 400) result = failure('transient', `The page did not load${response ? ` (HTTP ${response.status()})` : ''}.`);
      else {
        const title = await bounded(() => page!.title());
        await admit();
        const text = await bounded(() => page!.locator('body').innerText());
        await admit();
        if (page.url() !== url) result = failure('rejected', 'The page moved during the read.');
        else if (!text.trim()) result = failure('not_found', 'The page returned no readable content.');
        else result = { ok: true, data: { url, provider: 'cloudflare_playwright', data: { title, text } }, source_taint: 'external' };
      }
    } catch (cause) { result = failure('transient', cause instanceof ProviderFailure ? cause.message : 'The Cloudflare browser read failed or its source permission changed.'); }
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
        if (!terminated) result = failure('transient', 'The Cloudflare browser cleanup is unconfirmed. No browser read is reported as complete.');
      }
    }
    if (result.ok) {
      try { await admit(); } catch { return failure('rejected', 'The browser source permission changed before the result was returned.'); }
    }
    return result;
  };
}
