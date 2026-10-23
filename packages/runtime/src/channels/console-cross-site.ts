import { MCP_START_PATH } from '../connectors/mcp-connections';
import { BROWSER_TRIAL_PATH } from './browser-trial-consent';
import { CONSOLE_PATH } from './console';
import { CONSOLE_PHOTON_START_PATH } from './imessage/console';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// GETs that begin a flow rather than read. A new one belongs here, or behind a POST.
const startsFlow = (path: string) =>
  (path.startsWith(MCP_START_PATH) && path.length > MCP_START_PATH.length) || path === CONSOLE_PHOTON_START_PATH || path === BROWSER_TRIAL_PATH;

const refused = () => new Response('This request must come from the Waldo console.', {
  status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

// The console cookies are SameSite=Lax so that a link from another site opens the console signed in. Forgery is refused
// here, before any handler, rather than left to the cookie: every write under /console must come from the console's own
// origin, by Fetch Metadata where the browser sends it and by Origin otherwise (OWASP CSRF Prevention Cheat Sheet). That
// also covers the sign-in, code and ticket routes, which take no cookie, so no other site can sign a browser in or out.
// Same-site is refused too: a sibling subdomain is not the console. A flow-starting GET is refused only when the
// browser says another site sent it; typing the address or opening it from an app ("none") is the owner.
export const consoleCrossSiteRefusal = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.pathname !== CONSOLE_PATH && !url.pathname.startsWith(`${CONSOLE_PATH}/`)) return null;
  const site = request.headers.get('sec-fetch-site');
  if (SAFE.has(request.method)) return startsFlow(url.pathname) && (site === 'cross-site' || site === 'same-site') ? refused() : null;
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== url.origin) return refused();
  if (site !== null) return site === 'same-origin' ? null : refused();
  return origin === url.origin ? null : refused();
};
