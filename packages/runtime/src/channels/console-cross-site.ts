import { fromAnotherSite } from '../identity/console-auth';
import { CONSOLE_PATH } from './console';
import { startsConsoleFlow } from './console-step-up';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const underConsole = (path: string) => path === CONSOLE_PATH || path.startsWith(`${CONSOLE_PATH}/`);

const refused = () => new Response('This request must come from the Waldo console.', {
  status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

// The console cookies are SameSite=Lax so that a link from another site opens the console signed in. Forgery is refused
// here, before any handler, rather than left to the cookie: every write under /console must come from the console's own
// origin, by Fetch Metadata where the browser sends it and by Origin otherwise (OWASP CSRF Prevention Cheat Sheet). That
// also covers the sign-in, code and ticket routes, which take no cookie, so no other site can sign a browser in or out.
// Same-site is refused too: a sibling subdomain is not the console. A form posted from a no-referrer page carries the
// literal Origin "null" (Fetch spec), so "null" names nobody and Sec-Fetch-Site decides. A flow-starting GET is refused
// only when the browser says another site sent it; typing the address or opening it from an app ("none") is the owner.
export const consoleCrossSiteRefusal = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (!underConsole(url.pathname)) return null;
  const site = request.headers.get('sec-fetch-site');
  if (SAFE.has(request.method)) return startsConsoleFlow(url.pathname) && fromAnotherSite(request) ? refused() : null;
  const header = request.headers.get('origin');
  const origin = header === 'null' ? null : header;
  if (origin !== null && origin !== url.origin) return refused();
  if (site !== null) return site === 'same-origin' ? null : refused();
  return origin === url.origin ? null : refused();
};

// Lax lets another site open a console page in a window it keeps a handle on, and that handle can tell a signed-in
// page from a signed-out one. Cross-Origin-Opener-Policy gives every console page its own browsing context group, so
// the opener's handle goes dead. No console flow relies on an opener: its own links open with noopener.
export const isolateConsolePage = (request: Request, response: Response): Response => {
  if (!underConsole(new URL(request.url).pathname) || !(response.headers.get('content-type') ?? '').startsWith('text/html')) return response;
  const isolated = new Response(response.body, response);
  isolated.headers.set('cross-origin-opener-policy', 'same-origin');
  return isolated;
};
