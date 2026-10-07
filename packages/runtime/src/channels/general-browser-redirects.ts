import type { Page, Route } from '@cloudflare/playwright';

// Match the installed Playwright request redirect default; this is not a retry.
export const GENERAL_BROWSER_REDIRECT_LIMIT = 20;
export class GeneralRedirectError extends Error {
  readonly code = 'rejected';
  constructor() { super('browser_redirect_rejected'); }
}
type Routing = Readonly<{ authorize(url: string, method: string): Promise<void>; timeout(): number; admit(): Promise<void>; redirect(page: Page, url: string): void; denied(page: Page, status: number): void }>;

// Neither continue nor fulfill(302) re-intercepts the complete Chromium chain.
// Fetch each response without redirects; main documents re-enter page.goto so
// their final URL/base origin are real, while assets receive only a final body.
export async function guardGeneralBrowserRoute(route: Route, options: Routing): Promise<void> {
  const request = route.request();
  let url = request.url(), method = request.method();
  let headers: Record<string, string> | undefined;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(url) || visited.size > GENERAL_BROWSER_REDIRECT_LIMIT) throw new GeneralRedirectError();
    visited.add(url); await options.authorize(url, method);
    const response = await route.fetch({ maxRedirects: 0, timeout: options.timeout(), ...(visited.size > 1 ? { url, method, headers, ...(method !== request.method() ? { postData: '' } : {}) } : {}) });
    await options.admit();
    const status = response.status();
    const mainDocument = request.isNavigationRequest() && !request.frame().parentFrame();
    if (status >= 400 && mainDocument) { options.denied(request.frame().page(), status); await route.abort('blockedbyclient'); return; }
    if (![301, 302, 303, 307, 308].includes(status)) { await route.fulfill({ response }); return; }
    const location = response.headers()['location'];
    if (!location) throw new GeneralRedirectError();
    const next = new URL(location, url).href;
    // Follow installed SDK's POST->GET semantics without replaying its body.
    const nextMethod = ((status === 301 || status === 302) && method === 'POST' || status === 303 && !['GET', 'HEAD'].includes(method)) ? 'GET' : method;
    if (!['GET', 'HEAD'].includes(nextMethod)) throw new GeneralRedirectError();
    if (mainDocument) {
      if (nextMethod !== 'GET') throw new GeneralRedirectError();
      await options.authorize(next, nextMethod);
      options.redirect(request.frame().page(), next);
      // A blank host bridge settles this navigation without a redirect or a
      // racing chrome-error document; caller immediately navigates the vetted URL.
      await route.fulfill({ status: 200, contentType: 'text/html', body: '' }); return;
    }
    headers ??= { ...await request.allHeaders() };
    for (const key of Object.keys(headers)) {
      const name = key.toLowerCase();
      if (name === 'cookie' || name === 'host' || nextMethod !== method && name.startsWith('content-')
        || new URL(next).origin !== new URL(url).origin && ['authorization', 'proxy-authorization'].includes(name)) delete headers[key];
    }
    url = next; method = nextMethod;
  }
}
