import { constantTimeEqual } from './constant-time';

// Ties an OAuth callback to the browser that started the connect. A signed state proves which owner started an
// attempt, not who finishes it: without this, someone can forward the provider sign-in page of their own attempt so
// another person's account lands in their Waldo, or land a callback carrying their own code in the owner's browser
// (RFC 9700 §4.5, §4.7). The first-party hop that redirects to the provider sets a cookie for that attempt, and the
// callback requires it before any owner object wakes. Only Waldo's host sets cookies for itself, so a browser that
// did not take the hop has none.
//
// This stops a callback that lands in a browser that did not start the attempt. It does not stop a code injected into
// the browser that did: for Google and MCP the PKCE verifier, held server-side, makes such a code unredeemable; WHOOP
// has no PKCE, so its starting browser is trusted with its own callback.
//
// Everything that names an attempt (the provider and its nonce) is in the authorize or start address, so the value is a
// MAC keyed with the OAuth state secret: holding the link is not enough to build it. With no secret there is no binding,
// and every hop and callback that needs one refuses.
//
// One cookie per attempt, so two connects started side by side in one browser both finish. It is path-scoped to the
// callback so it rides no other request, which rules out the __Host- prefix (that requires Path=/). It is
// SameSite=Lax because the provider's redirect back is a cross-site top-level GET, which a Strict cookie does not ride.
// handoff binds the start hop itself, for a link a session-holding surface opened (channels/connect-confirm.ts).
export type BoundProvider = 'google' | 'mcp' | 'whoop' | 'handoff' | 'photon';
export type BrowserCheck = 'bound' | 'missing' | 'expired' | 'mismatch';

const PREFIX = '__Secure-waldo-oauth-';
const encoder = new TextEncoder();
const b64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const hmac = async (key: Uint8Array | ArrayBuffer, text: string) =>
  crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(text));
// The secret is narrowed to this use first, so nothing the state signer produces under the same secret is a binding.
const mac = async (secret: string, key: string, expires: string) => b64url(await hmac(await hmac(encoder.encode(secret), 'waldo-oauth-browser.v2'), `${key}|${expires}`));
const attemptKey = async (provider: BoundProvider, nonce: string) => b64url(await crypto.subtle.digest('SHA-256', encoder.encode(`waldo-oauth-browser.v1|${provider}|${nonce}`)));
const cookieName = (key: string) => `${PREFIX}${key.slice(0, 16)}`;

export const bindBrowser = async (secret: string, provider: BoundProvider, nonce: string, callbackPath: string, ttlMs: number, now: number): Promise<string> => {
  const key = await attemptKey(provider, nonce), expires = String(now + ttlMs);
  return `${cookieName(key)}=${expires}.${await mac(secret, key, expires)}; Path=${callbackPath}; Max-Age=${Math.floor(ttlMs / 1000)}; HttpOnly; Secure; SameSite=Lax`;
};

// The expiry inside the value is checked here too, so a binding ends on time even in a browser that kept the cookie
// past its Max-Age.
export const checkBrowser = async (request: Request, secret: string, provider: BoundProvider, nonce: string, now: number): Promise<BrowserCheck> => {
  const key = await attemptKey(provider, nonce), name = cookieName(key);
  const value = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (value === undefined) return 'missing';
  const [expires, sent] = value.split('.');
  if (!expires || !sent || !/^\d{1,16}$/.test(expires) || !constantTimeEqual(sent, await mac(secret, key, expires))) return 'mismatch';
  return Number(expires) > now ? 'bound' : 'expired';
};

// The start hop's answer: the browser goes to the provider and carries the binding for that attempt's callback.
export const startRedirect = async (secret: string, provider: BoundProvider, nonce: string, location: string, callbackPath: string, ttlMs: number): Promise<Response> => new Response(null, {
  status: 303,
  headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': await bindBrowser(secret, provider, nonce, callbackPath, ttlMs, Date.now()) },
});

// Sent with every callback answer that reached the owner object: the attempt is settled there, so its binding is spent.
export const releaseBrowser = async (provider: BoundProvider, nonce: string, callbackPath: string): Promise<string> =>
  `${cookieName(await attemptKey(provider, nonce))}=; Path=${callbackPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
