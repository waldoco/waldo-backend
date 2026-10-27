import { openValue, sealValue } from './sealed-value';

// Console sign-in with Apple or Google on the web, by identity token: the provider's own authorize page with
// response_mode=form_post posts the token straight back to the console's callback, and the token then goes through the
// same Supabase id_token grant and trust rules as the app's (signInWithIdToken). Supabase needs only the client among the
// provider's client IDs, never a client secret. The raw nonce and the state stay in this browser, sealed in a cookie
// scoped to the callback; the token carries the nonce's SHA-256, so a token minted for any other attempt is refused.
//
// The provider's post is a cross-site POST, which never carries a SameSite=Lax cookie, so this cookie is SameSite=None.
// It is HttpOnly, Secure, scoped to the callback path, sealed and short-lived, and it names no one.
export type WebIdProvider = 'apple' | 'google';
const PROVIDERS = {
  // Apple answers code and id_token together for a web client; the scope asks for the email the owner resolves from.
  apple: { authorize: 'https://appleid.apple.com/auth/authorize', responseType: 'code id_token', scope: 'email', extra: {} },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', responseType: 'id_token', scope: 'openid email', extra: { prompt: 'select_account' } },
} as const;
const LIFETIME_SECONDS = 10 * 60;
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const sha256Hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const cookieName = (provider: WebIdProvider) => `waldo_${provider}_signin`;
const purpose = (provider: WebIdProvider) => `${provider}signin`;

export const webIdCookie = (provider: WebIdProvider, path: string, value: string, maxAge = LIFETIME_SECONDS): string =>
  `${cookieName(provider)}=${value}; Path=${path}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;

export const startWebIdSignIn = async (provider: WebIdProvider, secret: string, clientId: string, callback: string, target: string | null, now: number) => {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const sealed = await sealValue(secret, purpose(provider), { nonce, state, target, expires: Math.floor(now / 1000) + LIFETIME_SECONDS });
  const { authorize, responseType, scope, extra } = PROVIDERS[provider];
  const location = new URL(authorize);
  location.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: responseType, response_mode: 'form_post', scope, state, nonce: await sha256Hex(nonce), ...extra }).toString();
  return { location: location.toString(), cookie: webIdCookie(provider, new URL(callback).pathname, sealed) };
};

// The raw nonce, state and return target this browser started with; null when the cookie is missing, altered or expired.
export const readWebIdSignIn = async (provider: WebIdProvider, secret: string, request: Request, now: number): Promise<Readonly<{ nonce: string; state: string; target: string | null }> | null> => {
  const name = cookieName(provider);
  const raw = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const sealed = await openValue(secret, purpose(provider), raw, now, LIFETIME_SECONDS);
  if (!sealed) return null;
  const { nonce, state, target } = sealed;
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || typeof state !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(state)
    || (target !== null && typeof target !== 'string')) return null;
  return { nonce, state, target };
};
