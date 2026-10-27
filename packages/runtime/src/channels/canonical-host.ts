import { configuredPublicOrigin, type PublicOriginEnv } from '../connectors/public-origin';
import { CONSOLE_PATH } from './console';
import { CONSOLE_GOOGLE_CALLBACK_PATH } from './console-signin';
import { CONNECT_LINK_PREFIX } from './connect-link';

// A browser that opens a connect ticket or a console page on another host than WALDO_PUBLIC_ORIGIN goes there first, so
// its browser binding, console cookie and OAuth callback all land on one host. The app opens tickets on the host it calls,
// and older links name the old host; browsers keep an invite's #fragment across the redirect. Only top-level page loads
// move: a form post or page script call stays where its page was, and the sign-in callback stays with its binding.
export const canonicalRedirect = (request: Request, env: PublicOriginEnv): Response | null => {
  const configured = configuredPublicOrigin(env);
  const url = new URL(request.url);
  if (!configured || url.origin === configured || !['GET', 'HEAD'].includes(request.method)) return null;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode !== null && mode !== 'navigate') return null;
  const consolePage = url.pathname === CONSOLE_PATH || url.pathname.startsWith(`${CONSOLE_PATH}/`);
  if (!(consolePage && url.pathname !== CONSOLE_GOOGLE_CALLBACK_PATH) && !url.pathname.startsWith(CONNECT_LINK_PREFIX)) return null;
  return new Response(null, { status: 307, headers: { location: `${configured}${url.pathname}${url.search}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
};
