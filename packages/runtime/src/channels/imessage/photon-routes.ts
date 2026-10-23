import { bindBrowser, checkBrowser, releaseBrowser } from '../../connectors/oauth-browser-binding';
import { oauthStateSecret, type OAuthStateEnv } from '../../connectors/oauth-state-secret';
import { consoleAuth } from '../../identity/console-auth';
import { callbackPage } from '../google-oauth';
import type { IMessageEnv } from './bridge-do';
import { photonConnectFinish, photonConnectStart } from './enrollment';
import { PHOTON_ATTEMPT_TTL_MS, PHOTON_CALLBACK_PATH, type PhotonFinish } from './photon';

// An operator connects Waldo's Photon account: the signed-in console start binds the attempt to this browser and
// sends it to Photon; Photon redirects back to the callback, which needs that binding before the Photon object wakes.

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const COPY: Record<PhotonFinish | 'unbound', Readonly<{ status: number; title: string; body: string }>> = {
  linked: { status: 200, title: 'Photon connected', body: 'Owners can now get their Waldo iMessage number from the console. You can close this tab.' },
  denied: { status: 400, title: 'Photon was not connected', body: 'Access was not granted. Connect it again from the iMessage page.' },
  expired: { status: 410, title: 'This link has expired', body: 'Connect links last 15 minutes. Start again from the iMessage page.' },
  invalid: { status: 400, title: 'This link is not valid', body: 'It may have been used already. Start again from the iMessage page.' },
  failed: { status: 502, title: 'Photon could not be connected', body: 'Photon\'s sign-in did not complete. Start again from the iMessage page.' },
  unbound: { status: 403, title: 'Start the connection again', body: 'This sign-in came back to a different browser, or took too long, so nothing was connected.' },
};

/** Operator only: any other owner gets a 404, as if the route did not exist. */
export async function photonStart(env: IMessageEnv & OAuthStateEnv, owner: string, origin: string): Promise<Response> {
  const admin = await consoleAuth(env)?.adminOverview(owner).then((v) => v !== null).catch(() => false) ?? false;
  if (!admin) return new Response('not found', { status: 404, headers: TEXT });
  const bindingSecret = oauthStateSecret(env);
  const started = bindingSecret ? await photonConnectStart(env, owner, origin, PHOTON_CALLBACK_PATH).catch(() => null) : null;
  if (!started || !bindingSecret) return new Response('Photon is not configured on this server.', { status: 503, headers: TEXT });
  return new Response(null, { status: 303, headers: { location: started.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'set-cookie': await bindBrowser(bindingSecret, 'photon', started.nonce, PHOTON_CALLBACK_PATH, PHOTON_ATTEMPT_TTL_MS, Date.now()) } });
}

export async function photonCallback(request: Request, env: IMessageEnv & OAuthStateEnv): Promise<Response> {
  const bindingSecret = oauthStateSecret(env);
  if (request.method !== 'GET' || !bindingSecret) return new Response('not found', { status: 404, headers: TEXT });
  const url = new URL(request.url), nonce = url.searchParams.get('state') ?? '';
  if (!NONCE.test(nonce)) return callbackPage(false, COPY.invalid);
  if (await checkBrowser(request, bindingSecret, 'photon', nonce, Date.now()) !== 'bound') return callbackPage(false, COPY.unbound);
  const outcome = await photonConnectFinish(env, nonce, url.searchParams.toString()).catch(() => 'failed' as const);
  const page = callbackPage(outcome === 'linked', COPY[outcome]);
  page.headers.append('set-cookie', await releaseBrowser('photon', nonce, PHOTON_CALLBACK_PATH));
  return page;
}
