import { CONSOLE_PATH } from './console';
import { DASHBOARD_OVERVIEW_HEADERS, DASHBOARD_OVERVIEW_PATH } from './dashboard-overview';

export const DASHBOARD_SHELL_PATH = `${CONSOLE_PATH}/dashboard`;
const ASSET_PREFIX = `${DASHBOARD_SHELL_PATH}/assets/`;
// Only Vite's content-hashed JS/CSS assets can be read without a session. They contain
// program code/styles, never per-owner data. The index and JSON API stay owner-gated.
const HASHED_ASSET = /^\/console\/dashboard\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;
const headers = (response: Response, extra: Record<string, string>) => {
  const copy = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) copy.set(key, value);
  return new Response(response.body, { status: response.status, headers: copy });
};

export const serveDashboard = async (
  request: Request,
  assets: Fetcher | undefined,
  verifyOwner: (request: Request) => Promise<Response>,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const isShell = url.pathname === DASHBOARD_SHELL_PATH || url.pathname === `${DASHBOARD_SHELL_PATH}/`;
  const isAsset = url.pathname.startsWith(ASSET_PREFIX);
  if (!isShell && !isAsset) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: DASHBOARD_OVERVIEW_HEADERS });
  if (isAsset && !HASHED_ASSET.test(url.pathname)) return new Response('not found', { status: 404, headers: DASHBOARD_OVERVIEW_HEADERS });
  if (!assets) return new Response('dashboard unavailable', { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS });
  if (isShell) {
    // Ask the same owner-session path as the read API. A successful narrow read proves
    // the signed owner routing and DO session, without making a second auth authority.
    let auth: Response;
    try { auth = await verifyOwner(new Request(new URL(DASHBOARD_OVERVIEW_PATH, url), request)); }
    catch { return new Response('dashboard unavailable', { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }); }
    if (!auth.ok) return new Response(auth.status === 401 ? 'Sign in to see your dashboard.' : 'dashboard unavailable', {
      status: auth.status === 401 ? 401 : 503,
      headers: { ...DASHBOARD_OVERVIEW_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const assetPath = isShell ? `${DASHBOARD_SHELL_PATH}/index.html` : url.pathname;
  let response: Response;
  try { response = await assets.fetch(new Request(new URL(assetPath, url), { method: request.method })); }
  catch { return new Response('dashboard unavailable', { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }); }
  if (!response.ok) return new Response('not found', { status: response.status === 404 ? 404 : 503, headers: DASHBOARD_OVERVIEW_HEADERS });
  return headers(response, isShell ? { ...DASHBOARD_OVERVIEW_HEADERS, 'content-type': 'text/html; charset=utf-8' } : {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
};
