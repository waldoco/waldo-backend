import { routerSignature } from './owner-directory';

// Console Google sign-in through Supabase's web OAuth with PKCE (RFC 7636, S256). The verifier stays in this browser, in a
// signed cookie scoped to the callback: a code Supabase hands back is worthless without it, so the callback can finish even
// though it arrives as a top-level visit from Supabase's site, and no other browser's code can be finished here.
export const GOOGLE_PKCE_COOKIE = 'waldo_google_pkce';
const LIFETIME_SECONDS = 10 * 60;
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const sign = (secret: string, payload: string) => routerSignature(secret, 0, `googlepkce.${payload}`);

export const googlePkceCookie = (path: string, value: string, maxAge = LIFETIME_SECONDS): string =>
  `${GOOGLE_PKCE_COOKIE}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const startGoogleSignIn = async (secret: string, supabase: string, callback: string, cookiePath: string, target: string | null, now: number) => {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ verifier, target, expires: Math.floor(now / 1000) + LIFETIME_SECONDS })));
  const authorize = new URL(`${supabase}/auth/v1/authorize`);
  authorize.search = new URLSearchParams({ provider: 'google', redirect_to: callback, code_challenge: challenge, code_challenge_method: 's256' }).toString();
  return { location: authorize.toString(), cookie: googlePkceCookie(cookiePath, `${payload}.${await sign(secret, payload)}`) };
};

// The verifier and return target this browser started with; null when the cookie is missing, altered or expired.
export const readGoogleSignIn = async (secret: string, request: Request, now: number): Promise<Readonly<{ verifier: string; target: string | null }> | null> => {
  const raw = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${GOOGLE_PKCE_COOKIE}=`))?.slice(GOOGLE_PKCE_COOKIE.length + 1);
  const [payload, signature, extra] = raw && raw.length <= 2048 ? raw.split('.') : [];
  if (!payload || !signature || extra !== undefined) return null;
  const expected = await sign(secret, payload);
  let diff = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const sealed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)))) as Record<string, unknown>;
    const { verifier, target, expires } = sealed;
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(verifier) || (target !== null && typeof target !== 'string')
      || typeof expires !== 'number' || expires <= Math.floor(now / 1000)) return null;
    return { verifier, target };
  } catch { return null; } // A signed payload this module wrote always parses; anything else is not ours.
};
