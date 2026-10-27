import { withRequestTimeout } from './request-timeout';

// Sign in with Apple's REST API, for the one thing Waldo needs from it beyond the identity token: a refresh token kept at
// sign-in, so account deletion can revoke the grant (App Store Review Guideline 5.1.1(v); Apple's "Revoke tokens").
// Requests to Apple authenticate with a client secret: an ES256 JWT signed by the team's Sign in with Apple key, with the
// client id as its subject. The key never leaves the Worker; tokens are never logged.
export type AppleSignInEnv = Readonly<{ APPLE_SIGNIN_P8?: string; APPLE_KEY_ID?: string; APPLE_TEAM_ID?: string }>;
export type AppleSignInKey = Readonly<{ teamId: string; keyId: string; key: CryptoKey }>;
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_AUDIENCE = 'https://appleid.apple.com';
// Apple accepts a client secret for up to six months; each one here is minted for one request.
const CLIENT_SECRET_SECONDS = 5 * 60;

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const jsonPart = (value: object) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

// The .p8 as Apple downloads it (PEM), with its newlines kept, escaped as \n, or dropped. null when any part is missing or
// the key does not import as a P-256 signing key.
export const appleSignInKey = async (env: AppleSignInEnv): Promise<AppleSignInKey | null> => {
  const { APPLE_SIGNIN_P8: pem, APPLE_KEY_ID: keyId, APPLE_TEAM_ID: teamId } = env;
  if (!pem || !keyId || !teamId) return null;
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replaceAll('\\n', '').replace(/\s+/g, '');
  try {
    const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { teamId, keyId, key };
  } catch {
    console.error(JSON.stringify({ hop: 'apple_signin_key', ok: false, code: 'key_unreadable' }));
    return null;
  }
};

// WebCrypto's ECDSA signature is already the raw r||s that JWS ES256 uses (RFC 7518 §3.4), so no DER conversion is needed.
export const appleClientSecret = async ({ teamId, keyId, key }: AppleSignInKey, clientId: string, now: number): Promise<string> => {
  const iat = Math.floor(now / 1000);
  const input = `${jsonPart({ alg: 'ES256', kid: keyId })}.${jsonPart({ iss: teamId, iat, exp: iat + CLIENT_SECRET_SECONDS, aud: APPLE_AUDIENCE, sub: clientId })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
  return `${input}.${base64Url(signature)}`;
};

const subjectOf = (idToken: unknown): string | null => {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = idToken.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const { sub } = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4))) as { sub?: unknown };
    return typeof sub === 'string' && sub.length > 0 && sub.length <= 255 ? sub : null;
  } catch { return null; }
};

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

// The refresh token for a sign-in's one-time authorization code, with the subject of the identity token Apple returns
// beside it: it comes straight from Apple over TLS, so the caller can check the code belongs to the identity that signed
// in. null when Apple refuses the code (it is single-use and lives five minutes); throws when Apple is unreachable.
export const exchangeAppleCode = async (fetcher: typeof fetch, key: AppleSignInKey, clientId: string, code: string, now: number, redirectUri?: string) =>
  withRequestTimeout(async signal => {
    const response = await fetcher(APPLE_TOKEN_URL, {
      method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form({ client_id: clientId, client_secret: await appleClientSecret(key, clientId, now), code, grant_type: 'authorization_code', ...(redirectUri ? { redirect_uri: redirectUri } : {}) }),
    });
    if (response.status === 429 || response.status >= 500) throw new Error(`apple token ${response.status}`);
    if (!response.ok) { void response.body?.cancel(); return null; }
    const { refresh_token: refreshToken, id_token: idToken } = (await response.json()) as { refresh_token?: unknown; id_token?: unknown };
    const subject = subjectOf(idToken);
    return typeof refreshToken === 'string' && /^[A-Za-z0-9._-]{16,4096}$/.test(refreshToken) && subject ? { refreshToken, subject } : null;
  });

// revoked, or failed: Apple refused it (an invalid token or client) or did not answer within the request bound. Apple
// answers 200 for a token it has already revoked.
export const revokeAppleGrant = async (fetcher: typeof fetch, key: AppleSignInKey, clientId: string, token: string, now: number): Promise<'revoked' | 'failed'> => {
  try {
    return await withRequestTimeout(async signal => {
      const response = await fetcher(APPLE_REVOKE_URL, {
        method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ client_id: clientId, client_secret: await appleClientSecret(key, clientId, now), token, token_type_hint: 'refresh_token' }),
      });
      void response.body?.cancel();
      return response.status === 200 ? 'revoked' : 'failed';
    });
  } catch {
    return 'failed';
  }
};
